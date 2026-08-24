//! Container state for the game server, read through the Docker socket proxy.
//!
//! The API never touches `/var/run/docker.sock` directly. It talks HTTP to the
//! `docker-socket-proxy` service, which is scoped to container reads and posts.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum DockerError {
    #[error("docker API request failed: {0}")]
    Request(#[from] reqwest::Error),

    #[error("docker API returned {status}")]
    Status { status: u16 },
}

/// Simplified lifecycle state of the game server container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainerState {
    NotFound,
    Created,
    Running,
    Paused,
    Restarting,
    Removing,
    Exited,
    Dead,
    Unknown,
}

impl ContainerState {
    fn from_docker(status: &str) -> Self {
        match status {
            "created" => Self::Created,
            "running" => Self::Running,
            "paused" => Self::Paused,
            "restarting" => Self::Restarting,
            "removing" => Self::Removing,
            "exited" => Self::Exited,
            "dead" => Self::Dead,
            _ => Self::Unknown,
        }
    }

    pub fn is_running(self) -> bool {
        matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ContainerStatus {
    pub state: ContainerState,
    pub running: bool,
    /// `healthy`/`unhealthy`/`starting`, or `None` when the image declares no
    /// healthcheck.
    pub health: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
}

impl ContainerStatus {
    /// What we report when the Docker API is unreachable: the panel keeps
    /// working, it just cannot see the container.
    pub fn unknown() -> Self {
        Self {
            state: ContainerState::Unknown,
            running: false,
            health: None,
            started_at: None,
        }
    }

    pub fn not_found() -> Self {
        Self {
            state: ContainerState::NotFound,
            running: false,
            health: None,
            started_at: None,
        }
    }

    /// How long the container has been up, if it is up.
    pub fn uptime(&self) -> Option<Duration> {
        let started_at = self.started_at?;
        if !self.running {
            return None;
        }

        Utc::now().signed_duration_since(started_at).to_std().ok()
    }
}

#[derive(Debug, Clone)]
pub struct DockerClient {
    http: reqwest::Client,
    base_url: String,
    container: String,
}

impl DockerClient {
    pub fn new(
        base_url: impl Into<String>,
        container: impl Into<String>,
        timeout: Duration,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .unwrap_or_default();

        Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            container: container.into(),
        }
    }

    pub fn container_name(&self) -> &str {
        &self.container
    }

    /// Inspect the game server container.
    ///
    /// A 404 is reported as [`ContainerState::NotFound`] rather than an error;
    /// only a proxy that is unreachable or misbehaving produces `Err`.
    pub async fn status(&self) -> Result<ContainerStatus, DockerError> {
        let url = format!("{}/containers/{}/json", self.base_url, self.container);
        let response = self.http.get(&url).send().await?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(ContainerStatus::not_found());
        }

        if !response.status().is_success() {
            return Err(DockerError::Status {
                status: response.status().as_u16(),
            });
        }

        let inspect: InspectResponse = response.json().await?;
        let state = inspect.state.unwrap_or_default();

        Ok(ContainerStatus {
            state: ContainerState::from_docker(&state.status),
            running: state.running,
            health: state.health.map(|health| health.status),
            started_at: state
                .started_at
                .as_deref()
                .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
                .map(|at| at.with_timezone(&Utc)),
        })
    }

    /// Start the container. A container that is already running is success.
    pub async fn start(&self) -> Result<(), DockerError> {
        self.post_lifecycle("start", None).await
    }

    /// Stop the container, waiting up to `timeout` seconds for a clean save.
    pub async fn stop(&self, timeout_secs: u64) -> Result<(), DockerError> {
        self.post_lifecycle("stop", Some(timeout_secs)).await
    }

    /// Restart the container, waiting up to `timeout` seconds for a clean save.
    pub async fn restart(&self, timeout_secs: u64) -> Result<(), DockerError> {
        self.post_lifecycle("restart", Some(timeout_secs)).await
    }

    async fn post_lifecycle(
        &self,
        action: &str,
        timeout_secs: Option<u64>,
    ) -> Result<(), DockerError> {
        let mut url = format!("{}/containers/{}/{action}", self.base_url, self.container);
        if let Some(seconds) = timeout_secs {
            url.push_str(&format!("?t={seconds}"));
        }

        let response = self.http.post(&url).send().await?;

        // Docker returns 204, or 304 when the container is already in that
        // state. Both mean the operator got what they asked for.
        if response.status().is_success() || response.status().as_u16() == 304 {
            return Ok(());
        }

        Err(DockerError::Status {
            status: response.status().as_u16(),
        })
    }

    /// Run a command inside the game container and return its exit code.
    ///
    /// Used to delete save trees the API user cannot chmod. The proxy must
    /// allow EXEC. A missing or denied API is reported as an error so the
    /// caller can fall back to the bind mount.
    pub async fn exec(&self, command: &[&str]) -> Result<i32, DockerError> {
        Ok(self.exec_output(command).await?.0)
    }

    /// Same as [`exec`], but keeps stdout/stderr so SteamCMD errors can be
    /// shown instead of a bare exit code.
    pub async fn exec_output(&self, command: &[&str]) -> Result<(i32, String), DockerError> {
        let create_url = format!("{}/containers/{}/exec", self.base_url, self.container);
        let create = self
            .http
            .post(&create_url)
            .json(&serde_json::json!({
                "AttachStdout": true,
                "AttachStderr": true,
                "Cmd": command,
            }))
            .send()
            .await?;

        if !create.status().is_success() {
            return Err(DockerError::Status {
                status: create.status().as_u16(),
            });
        }

        let created: ExecCreated = create.json().await?;
        let start_url = format!("{}/exec/{}/start", self.base_url, created.id);
        let start = self
            .http
            .post(&start_url)
            .json(&serde_json::json!({ "Detach": false, "Tty": false }))
            .send()
            .await?;

        if !start.status().is_success() {
            return Err(DockerError::Status {
                status: start.status().as_u16(),
            });
        }
        let raw = start.bytes().await?;
        let output = parse_docker_logs(&raw).join("\n");

        let inspect_url = format!("{}/exec/{}/json", self.base_url, created.id);
        let inspect = self.http.get(&inspect_url).send().await?;
        if !inspect.status().is_success() {
            return Err(DockerError::Status {
                status: inspect.status().as_u16(),
            });
        }
        let info: ExecInspect = inspect.json().await?;
        Ok((info.exit_code, output))
    }

    /// Last `tail` lines of the container's stdout/stderr.
    ///
    /// This is what the old panel's Logs page shows. The game's own `Logs/`
    /// directory is empty until the dedicated server has booted, so the
    /// container stream is the only source during SteamCMD and startup.
    pub async fn logs(&self, tail: u32) -> Result<Vec<String>, DockerError> {
        let url = format!(
            "{}/containers/{}/logs?stdout=1&stderr=1&timestamps=1&tail={tail}",
            self.base_url, self.container
        );
        let response = self.http.get(&url).send().await?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }

        if !response.status().is_success() {
            return Err(DockerError::Status {
                status: response.status().as_u16(),
            });
        }

        let raw = response.bytes().await?;
        Ok(parse_docker_logs(&raw))
    }
}

/// Decode Docker's multiplexed log stream into lines.
///
/// Without a TTY, each chunk is an 8-byte header (stream type + big-endian
/// size) plus payload. With a TTY the body is raw text. We try the framed
/// form first and fall back if the sizes do not add up.
pub fn parse_docker_logs(raw: &[u8]) -> Vec<String> {
    if raw.is_empty() {
        return Vec::new();
    }

    if let Some(lines) = parse_multiplexed(raw) {
        return lines;
    }

    String::from_utf8_lossy(raw)
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn parse_multiplexed(raw: &[u8]) -> Option<Vec<String>> {
    let mut offset = 0;
    let mut chunks = Vec::new();

    while offset < raw.len() {
        if offset + 8 > raw.len() {
            return None;
        }

        let size = u32::from_be_bytes(raw[offset + 4..offset + 8].try_into().ok()?) as usize;
        // A frame larger than the remaining body means this is not multiplexed
        // — typical of a TTY stream whose first bytes just happen to look
        // like a header.
        if offset + 8 + size > raw.len() {
            return None;
        }

        if size > 0 {
            chunks.push(&raw[offset + 8..offset + 8 + size]);
        }
        offset += 8 + size;
    }

    let joined = chunks.concat();
    let text = String::from_utf8_lossy(&joined);
    Some(
        text.lines()
            .map(str::trim_end)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

#[derive(Debug, Deserialize)]
struct InspectResponse {
    #[serde(rename = "State")]
    state: Option<InspectState>,
}

#[derive(Debug, Default, Deserialize)]
struct InspectState {
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Running", default)]
    running: bool,
    #[serde(rename = "StartedAt", default)]
    started_at: Option<String>,
    #[serde(rename = "Health", default)]
    health: Option<InspectHealth>,
}

#[derive(Debug, Deserialize)]
struct InspectHealth {
    #[serde(rename = "Status", default)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct ExecCreated {
    #[serde(rename = "Id")]
    id: String,
}

#[derive(Debug, Deserialize)]
struct ExecInspect {
    #[serde(rename = "ExitCode", default)]
    exit_code: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_docker_status_strings() {
        assert_eq!(
            ContainerState::from_docker("running"),
            ContainerState::Running
        );
        assert_eq!(
            ContainerState::from_docker("exited"),
            ContainerState::Exited
        );
        assert_eq!(
            ContainerState::from_docker("nonsense"),
            ContainerState::Unknown
        );
    }

    #[test]
    fn a_stopped_container_reports_no_uptime() {
        let status = ContainerStatus {
            state: ContainerState::Exited,
            running: false,
            health: None,
            started_at: Some(Utc::now() - chrono::Duration::hours(2)),
        };

        assert!(status.uptime().is_none());
    }

    #[test]
    fn a_running_container_reports_uptime() {
        let status = ContainerStatus {
            state: ContainerState::Running,
            running: true,
            health: Some("healthy".to_owned()),
            started_at: Some(Utc::now() - chrono::Duration::hours(2)),
        };

        let uptime = status.uptime().expect("uptime");

        assert!(uptime.as_secs() >= 7100 && uptime.as_secs() <= 7300);
    }

    #[test]
    fn parses_a_multiplexed_stdout_frame() {
        let mut raw = vec![1, 0, 0, 0, 0, 0, 0, 5];
        raw.extend_from_slice(b"hello");

        assert_eq!(parse_docker_logs(&raw), vec!["hello".to_owned()]);
    }

    #[test]
    fn parses_raw_tty_text() {
        let raw = b"line one\nline two\n";

        assert_eq!(
            parse_docker_logs(raw),
            vec!["line one".to_owned(), "line two".to_owned()]
        );
    }

    #[test]
    fn an_empty_stream_is_no_lines() {
        assert!(parse_docker_logs(&[]).is_empty());
    }

    #[test]
    fn deserialises_a_docker_inspect_payload() {
        let payload = r#"{"State":{"Status":"running","Running":true,
            "StartedAt":"2026-08-11T10:00:00.123456789Z","Health":{"Status":"healthy"}}}"#;

        let inspect: InspectResponse = serde_json::from_str(payload).expect("parse");
        let state = inspect.state.expect("state");

        assert!(state.running);
        assert_eq!(state.health.expect("health").status, "healthy");
    }
}
