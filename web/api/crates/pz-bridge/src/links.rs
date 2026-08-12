//! The registration channel shared with the game.
//!
//! Mirrors the mod's own request/result idiom, with the direction reversed: the
//! mod writes `account_links.json` when a player runs `/account register`, this
//! stack answers in `account_link_results.json` with the code that finishes
//! sign-up on the website. Entries are keyed by `id` and any id that already
//! has a result is skipped, so a request file read twice never issues twice —
//! the same rule `KR_Orders` applies to the delivery queue.
//!
//! Nothing here is written by the mod today. `/account register` still has to
//! be added to KnoxRelay; this is the contract it should write against.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Written by the mod when a player runs `/account register`.
pub const LINK_REQUESTS_FILE: &str = "account_links.json";

/// Written by this stack, read by the mod to show the player their code.
pub const LINK_RESULTS_FILE: &str = "account_link_results.json";

/// Keeps the ledger from growing without bound; the mod caps its own the same way.
const RESULT_LIMIT: usize = 200;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LinkRequests {
    #[serde(default)]
    pub requests: Vec<LinkRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkRequest {
    /// Unique per run of the command. The mod should not reuse one.
    pub id: String,
    /// The PZ username of the character that ran it.
    pub username: String,
    #[serde(default)]
    pub steam_id: Option<String>,
    /// In-game timestamp, for the mod's own bookkeeping. Not trusted here.
    #[serde(default)]
    pub requested_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkResults {
    pub version: u32,
    pub updated_at: String,
    #[serde(default)]
    pub results: Vec<LinkResult>,
}

impl Default for LinkResults {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: String::new(),
            results: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkResult {
    /// Echoes the request id, which is how the mod matches them up.
    pub id: String,
    pub username: String,
    /// `issued`, `already_registered` or `error`.
    pub status: String,
    /// The code to show the player. Only on `issued`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub code: Option<String>,
    /// When that code stops working. Only on `issued`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expires_at: Option<String>,
    pub at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum LinkChannelError {
    #[error("link file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("link file {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("link file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// Reader and writer for the two files above.
#[derive(Debug, Clone)]
pub struct LinkChannel {
    dir: PathBuf,
}

impl LinkChannel {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Pending registrations, or an empty list when the mod has written nothing.
    pub async fn requests(&self) -> Result<LinkRequests, LinkChannelError> {
        let path = self.dir.join(LINK_REQUESTS_FILE);

        let contents = match tokio::fs::read_to_string(&path).await {
            Ok(contents) => contents,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LinkRequests::default());
            }
            Err(source) => return Err(LinkChannelError::Read { path, source }),
        };

        if contents.trim().is_empty() {
            return Ok(LinkRequests::default());
        }

        serde_json::from_str(&contents).map_err(|source| LinkChannelError::Parse { path, source })
    }

    pub async fn results(&self) -> Result<LinkResults, LinkChannelError> {
        let path = self.dir.join(LINK_RESULTS_FILE);

        let contents = match tokio::fs::read_to_string(&path).await {
            Ok(contents) => contents,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LinkResults::default());
            }
            Err(source) => return Err(LinkChannelError::Read { path, source }),
        };

        if contents.trim().is_empty() {
            return Ok(LinkResults::default());
        }

        serde_json::from_str(&contents).map_err(|source| LinkChannelError::Parse { path, source })
    }

    /// Replace the result ledger, oldest entries dropped past the cap.
    ///
    /// Written to a temporary file and renamed, so the mod never reads a
    /// half-written ledger — rename is atomic within a directory.
    pub async fn write_results(&self, mut results: LinkResults) -> Result<(), LinkChannelError> {
        if results.results.len() > RESULT_LIMIT {
            let excess = results.results.len() - RESULT_LIMIT;
            results.results.drain(..excess);
        }

        let path = self.dir.join(LINK_RESULTS_FILE);
        let temporary = self.dir.join(format!("{LINK_RESULTS_FILE}.tmp"));

        let body =
            serde_json::to_string_pretty(&results).map_err(|source| LinkChannelError::Parse {
                path: path.clone(),
                source,
            })?;

        tokio::fs::write(&temporary, body)
            .await
            .map_err(|source| LinkChannelError::Write {
                path: temporary.clone(),
                source,
            })?;

        tokio::fs::rename(&temporary, &path)
            .await
            .map_err(|source| LinkChannelError::Write { path, source })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> (tempfile::TempDir, LinkChannel) {
        let dir = tempfile::tempdir().expect("temp dir");
        let channel = LinkChannel::new(dir.path());

        (dir, channel)
    }

    #[tokio::test]
    async fn a_missing_request_file_reads_as_no_requests() {
        let (_dir, channel) = channel();

        assert!(channel.requests().await.expect("read").requests.is_empty());
    }

    #[tokio::test]
    async fn parses_a_request_written_by_the_mod() {
        let (dir, channel) = channel();
        std::fs::write(
            dir.path().join(LINK_REQUESTS_FILE),
            r#"{"version":1,"requests":[
                {"id":"1","username":"rook","steam_id":"7656119","requested_at":"1993-07-14T09:20:00"}
            ]}"#,
        )
        .expect("write");

        let requests = channel.requests().await.expect("read").requests;

        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].username, "rook");
        assert_eq!(requests[0].steam_id.as_deref(), Some("7656119"));
    }

    #[tokio::test]
    async fn parses_a_request_without_the_optional_fields() {
        let (dir, channel) = channel();
        std::fs::write(
            dir.path().join(LINK_REQUESTS_FILE),
            r#"{"requests":[{"id":"1","username":"rook"}]}"#,
        )
        .expect("write");

        let requests = channel.requests().await.expect("read").requests;

        assert_eq!(requests[0].steam_id, None);
    }

    #[tokio::test]
    async fn an_issued_result_carries_the_code() {
        let (_dir, channel) = channel();

        channel
            .write_results(LinkResults {
                version: 1,
                updated_at: "2026-08-12T09:00:00Z".to_owned(),
                results: vec![LinkResult {
                    id: "1".to_owned(),
                    username: "rook".to_owned(),
                    status: "issued".to_owned(),
                    code: Some("NYUY2Z".to_owned()),
                    expires_at: Some("2026-08-12T09:30:00Z".to_owned()),
                    at: "2026-08-12T09:00:00Z".to_owned(),
                }],
            })
            .await
            .expect("write");

        let ledger = channel.results().await.expect("read");

        assert_eq!(ledger.results[0].code.as_deref(), Some("NYUY2Z"));
    }

    #[tokio::test]
    async fn a_rejection_carries_no_code_field_at_all() {
        let (dir, channel) = channel();

        channel
            .write_results(LinkResults {
                results: vec![LinkResult {
                    id: "1".to_owned(),
                    username: "rook".to_owned(),
                    status: "already_registered".to_owned(),
                    code: None,
                    expires_at: None,
                    at: String::new(),
                }],
                ..LinkResults::default()
            })
            .await
            .expect("write");

        let body = std::fs::read_to_string(dir.path().join(LINK_RESULTS_FILE)).expect("read");

        assert!(!body.contains("code"));
    }

    #[tokio::test]
    async fn the_ledger_is_capped() {
        let (_dir, channel) = channel();

        let results = (0..RESULT_LIMIT + 25)
            .map(|index| LinkResult {
                id: index.to_string(),
                username: "rook".to_owned(),
                status: "issued".to_owned(),
                code: None,
                expires_at: None,
                at: String::new(),
            })
            .collect();

        channel
            .write_results(LinkResults {
                results,
                ..LinkResults::default()
            })
            .await
            .expect("write");

        let ledger = channel.results().await.expect("read");

        assert_eq!(ledger.results.len(), RESULT_LIMIT);
        // The oldest went, not the newest.
        assert_eq!(ledger.results[0].id, "25");
    }

    #[tokio::test]
    async fn writing_leaves_no_temporary_file_behind() {
        let (dir, channel) = channel();

        channel
            .write_results(LinkResults::default())
            .await
            .expect("write");

        assert!(!dir.path().join(format!("{LINK_RESULTS_FILE}.tmp")).exists());
    }
}
