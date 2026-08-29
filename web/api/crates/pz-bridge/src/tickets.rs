//! The in-game `/report` channel.
//!
//! Same request/result idiom as registration: the mod writes
//! `report_requests.json`, this stack answers in `report_results.json`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const REPORT_REQUESTS_FILE: &str = "report_requests.json";
pub const REPORT_RESULTS_FILE: &str = "report_results.json";
pub const TICKETS_OUTBOX_FILE: &str = "tickets_outbox.json";
pub const TICKETS_INBOX_FILE: &str = "tickets_inbox.json";

const RESULT_LIMIT: usize = 200;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReportRequests {
    #[serde(default)]
    pub requests: Vec<ReportRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportRequest {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub accused: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub requested_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportResults {
    pub version: u32,
    pub updated_at: String,
    #[serde(default)]
    pub results: Vec<ReportResult>,
}

impl Default for ReportResults {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: String::new(),
            results: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportResult {
    pub id: String,
    pub username: String,
    /// `filed`, `invalid`, `too_short`, `self`, `error`.
    pub status: String,
    pub at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ReportChannelError {
    #[error("report file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("report file {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("report file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone)]
pub struct ReportChannel {
    dir: PathBuf,
}

impl ReportChannel {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub async fn requests(&self) -> Result<ReportRequests, ReportChannelError> {
        read_json(&self.dir.join(REPORT_REQUESTS_FILE)).await
    }

    pub async fn results(&self) -> Result<ReportResults, ReportChannelError> {
        read_json(&self.dir.join(REPORT_RESULTS_FILE)).await
    }

    pub async fn write_results(
        &self,
        mut results: ReportResults,
    ) -> Result<(), ReportChannelError> {
        if results.results.len() > RESULT_LIMIT {
            let excess = results.results.len() - RESULT_LIMIT;
            results.results.drain(..excess);
        }

        let path = self.dir.join(REPORT_RESULTS_FILE);
        let temporary = self.dir.join(format!("{REPORT_RESULTS_FILE}.tmp"));
        let body =
            serde_json::to_string_pretty(&results).map_err(|source| ReportChannelError::Parse {
                path: path.clone(),
                source,
            })?;

        tokio::fs::write(&temporary, &body)
            .await
            .map_err(|source| ReportChannelError::Write {
                path: temporary.clone(),
                source,
            })?;

        tokio::fs::rename(&temporary, &path)
            .await
            .map_err(|source| ReportChannelError::Write { path, source })
    }

    pub async fn outbox(&self) -> Result<TicketOutbox, ReportChannelError> {
        read_json(&self.dir.join(TICKETS_OUTBOX_FILE)).await
    }

    pub async fn write_outbox(&self, mut box_: TicketOutbox) -> Result<(), ReportChannelError> {
        if box_.requests.len() > RESULT_LIMIT {
            let excess = box_.requests.len() - RESULT_LIMIT;
            box_.requests.drain(..excess);
        }

        write_json(&self.dir.join(TICKETS_OUTBOX_FILE), &box_).await
    }

    pub async fn write_inbox(&self, inbox: &TicketInbox) -> Result<(), ReportChannelError> {
        write_json(&self.dir.join(TICKETS_INBOX_FILE), inbox).await
    }

    pub async fn inbox(&self) -> Result<TicketInbox, ReportChannelError> {
        read_json(&self.dir.join(TICKETS_INBOX_FILE)).await
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TicketOutbox {
    #[serde(default)]
    pub requests: Vec<TicketAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketAction {
    pub id: String,
    pub username: String,
    /// `reply`, `create`, or `read`.
    pub action: String,
    #[serde(default)]
    pub report_id: Option<i64>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub accused: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TicketInbox {
    pub version: u32,
    pub updated_at: String,
    #[serde(default)]
    pub players: std::collections::BTreeMap<String, TicketPlayerInbox>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TicketPlayerInbox {
    pub unread: i64,
    pub updated_at: String,
    #[serde(default)]
    pub reports: Vec<TicketSnapshot>,
    #[serde(default)]
    pub notices: Vec<DeskNotice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeskNotice {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub unread: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketSnapshot {
    pub id: i64,
    pub kind: String,
    pub subject: String,
    pub status: String,
    pub accused: Option<String>,
    pub unread: bool,
    pub updated_at: String,
    pub messages: Vec<TicketMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketMessage {
    pub id: i64,
    pub role: String,
    pub author: String,
    pub body: String,
    pub at: String,
}

async fn write_json<T: Serialize>(
    path: &std::path::Path,
    value: &T,
) -> Result<(), ReportChannelError> {
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value).map_err(|source| ReportChannelError::Parse {
        path: path.to_path_buf(),
        source,
    })?;

    tokio::fs::write(&temporary, &body)
        .await
        .map_err(|source| ReportChannelError::Write {
            path: temporary.clone(),
            source,
        })?;

    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|source| ReportChannelError::Write {
            path: path.to_path_buf(),
            source,
        })
}

async fn read_json<T>(path: &std::path::Path) -> Result<T, ReportChannelError>
where
    T: Default + serde::de::DeserializeOwned,
{
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(T::default());
        }
        Err(source) => {
            return Err(ReportChannelError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    if contents.trim().is_empty() {
        return Ok(T::default());
    }

    serde_json::from_str(&contents).map_err(|source| ReportChannelError::Parse {
        path: path.to_path_buf(),
        source,
    })
}
