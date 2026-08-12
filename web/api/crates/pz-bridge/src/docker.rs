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
    fn deserialises_a_docker_inspect_payload() {
        let payload = r#"{"State":{"Status":"running","Running":true,
            "StartedAt":"2026-08-11T10:00:00.123456789Z","Health":{"Status":"healthy"}}}"#;

        let inspect: InspectResponse = serde_json::from_str(payload).expect("parse");
        let state = inspect.state.expect("state");

        assert!(state.running);
        assert_eq!(state.health.expect("health").status, "healthy");
    }
}
