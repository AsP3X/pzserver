//! Typed jobs the panel drops for Knox Relay (`KR_Jobs`).
//!
//! `panel_jobs.json` is the inbox; `panel_results.json` is the ledger keyed by
//! id. Waiting on an id is how Refresh knows a snapshot landed, rather than
//! guessing from a username falling off `export_requests.json`.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const JOBS_FILE: &str = "panel_jobs.json";
pub const RESULTS_FILE: &str = "panel_results.json";

const RESULT_LIMIT: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum JobsError {
    #[error("panel jobs file {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PanelJobs {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub jobs: Vec<PanelJob>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelJob {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PanelResults {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub results: Vec<PanelResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelResult {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub processed_at: Option<String>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone)]
pub struct JobsChannel {
    dir: PathBuf,
}

impl JobsChannel {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub async fn enqueue(&self, job: PanelJob) -> Result<(), JobsError> {
        let path = self.dir.join(JOBS_FILE);
        let mut file = self.read_jobs().await?;
        if file.jobs.iter().any(|existing| existing.id == job.id) {
            return Ok(());
        }
        file.version = 1;
        file.jobs.push(job);
        write_json(&path, &file).await
    }

    pub async fn result_for(&self, id: &str) -> Result<Option<PanelResult>, JobsError> {
        let file = self.read_results().await?;
        Ok(file.results.into_iter().rev().find(|row| row.id == id))
    }

    /// Wait until the mod has written a result for this id, or time runs out.
    pub async fn await_result(
        &self,
        id: &str,
        timeout: Duration,
    ) -> Result<Option<PanelResult>, JobsError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(result) = self.result_for(id).await? {
                return Ok(Some(result));
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(None);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn read_jobs(&self) -> Result<PanelJobs, JobsError> {
        read_json(&self.dir.join(JOBS_FILE)).await
    }

    async fn read_results(&self) -> Result<PanelResults, JobsError> {
        let mut file: PanelResults = read_json(&self.dir.join(RESULTS_FILE)).await?;
        if file.results.len() > RESULT_LIMIT {
            let drop = file.results.len() - RESULT_LIMIT;
            file.results.drain(0..drop);
        }
        Ok(file)
    }
}

async fn read_json<T>(path: &std::path::Path) -> Result<T, JobsError>
where
    T: Default + serde::de::DeserializeOwned,
{
    match tokio::fs::read_to_string(path).await {
        Ok(contents) if !contents.trim().is_empty() => {
            Ok(serde_json::from_str(&contents).unwrap_or_default())
        }
        Ok(_) => Ok(T::default()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(source) => Err(JobsError::Write {
            path: path.to_path_buf(),
            source,
        }),
    }
}

async fn write_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), JobsError> {
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value).map_err(|source| JobsError::Write {
        path: path.to_path_buf(),
        source: std::io::Error::other(source),
    })?;
    tokio::fs::write(&temporary, &body)
        .await
        .map_err(|source| JobsError::Write {
            path: temporary.clone(),
            source,
        })?;
    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|source| JobsError::Write {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_job_contract_parses() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../game-server/tests/contracts/panel_job.json");
        let body = std::fs::read_to_string(&path).expect("contract");
        let job: PanelJob = serde_json::from_str(&body).expect("parse");
        assert_eq!(job.kind, "snapshot");
        assert_eq!(job.username, "Rook");
    }

    #[tokio::test]
    async fn enqueue_then_await_sees_a_result_the_mod_wrote() {
        let dir = tempfile::tempdir().expect("temp");
        let channel = JobsChannel::new(dir.path());

        channel
            .enqueue(PanelJob {
                id: "job-1".into(),
                kind: "snapshot".into(),
                username: "rook".into(),
                title: None,
                body: None,
            })
            .await
            .expect("enqueue");

        let inbox: PanelJobs =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(JOBS_FILE)).unwrap())
                .unwrap();
        assert_eq!(inbox.jobs.len(), 1);

        std::fs::write(
            dir.path().join(RESULTS_FILE),
            r#"{"version":1,"results":[{"id":"job-1","ok":true}]}"#,
        )
        .unwrap();

        let result = channel
            .await_result("job-1", Duration::from_millis(200))
            .await
            .expect("wait")
            .expect("present");
        assert!(result.ok);
    }

    #[tokio::test]
    async fn await_result_times_out_when_the_mod_is_silent() {
        let dir = tempfile::tempdir().expect("temp");
        let channel = JobsChannel::new(dir.path());
        let result = channel
            .await_result("missing", Duration::from_millis(60))
            .await
            .expect("wait");
        assert!(result.is_none());
    }
}
