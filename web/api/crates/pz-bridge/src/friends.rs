//! The in-game friends channel.
//!
//! Same request/result/inbox idiom as tickets: the mod writes actions to
//! `friends_outbox.json`, this stack answers in `friends_results.json` and
//! projects each player's roster into `friends_inbox.json`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const FRIENDS_OUTBOX_FILE: &str = "friends_outbox.json";
pub const FRIENDS_RESULTS_FILE: &str = "friends_results.json";
pub const FRIENDS_INBOX_FILE: &str = "friends_inbox.json";

const RESULT_LIMIT: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum FriendsChannelError {
    #[error("friends file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("friends file {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("friends file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone)]
pub struct FriendsChannel {
    dir: PathBuf,
}

impl FriendsChannel {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub async fn outbox(&self) -> Result<FriendsOutbox, FriendsChannelError> {
        read_json(&self.dir.join(FRIENDS_OUTBOX_FILE)).await
    }

    pub async fn write_outbox(&self, mut box_: FriendsOutbox) -> Result<(), FriendsChannelError> {
        if box_.requests.len() > RESULT_LIMIT {
            let excess = box_.requests.len() - RESULT_LIMIT;
            box_.requests.drain(..excess);
        }

        write_json(&self.dir.join(FRIENDS_OUTBOX_FILE), &box_).await
    }

    pub async fn results(&self) -> Result<FriendsResults, FriendsChannelError> {
        read_json(&self.dir.join(FRIENDS_RESULTS_FILE)).await
    }

    pub async fn write_results(
        &self,
        mut results: FriendsResults,
    ) -> Result<(), FriendsChannelError> {
        if results.results.len() > RESULT_LIMIT {
            let excess = results.results.len() - RESULT_LIMIT;
            results.results.drain(..excess);
        }

        write_json(&self.dir.join(FRIENDS_RESULTS_FILE), &results).await
    }

    pub async fn inbox(&self) -> Result<FriendsInbox, FriendsChannelError> {
        read_json(&self.dir.join(FRIENDS_INBOX_FILE)).await
    }

    pub async fn write_inbox(&self, inbox: &FriendsInbox) -> Result<(), FriendsChannelError> {
        write_json(&self.dir.join(FRIENDS_INBOX_FILE), inbox).await
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FriendsOutbox {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub requests: Vec<FriendAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendAction {
    pub id: String,
    pub username: String,
    /// `request`, `accept`, `decline`, `cancel`, `unfriend`, `block`,
    /// `unblock`, `share`.
    pub action: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub friendship_id: Option<String>,
    #[serde(default)]
    pub share_position: Option<bool>,
    #[serde(default)]
    pub requested_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FriendsResults {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub results: Vec<FriendResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendResult {
    pub id: String,
    pub username: String,
    /// `sent`, `accepted`, `already_friends`, `already_pending`, `not_registered`,
    /// `blocked`, `self`, `missing`, `error`.
    pub status: String,
    pub at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FriendsInbox {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub players: std::collections::BTreeMap<String, FriendsPlayerInbox>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FriendsPlayerInbox {
    pub unread: i64,
    pub updated_at: String,
    #[serde(default)]
    pub incoming: Vec<FriendSnapshot>,
    #[serde(default)]
    pub outgoing: Vec<FriendSnapshot>,
    #[serde(default)]
    pub friends: Vec<FriendSnapshot>,
    #[serde(default)]
    pub blocked: Vec<FriendSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendSnapshot {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub share_position: bool,
    #[serde(default)]
    pub their_share_position: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

async fn write_json<T: Serialize>(
    path: &std::path::Path,
    value: &T,
) -> Result<(), FriendsChannelError> {
    let temporary = path.with_extension("json.tmp");
    let body =
        serde_json::to_string_pretty(value).map_err(|source| FriendsChannelError::Parse {
            path: path.to_path_buf(),
            source,
        })?;

    tokio::fs::write(&temporary, &body)
        .await
        .map_err(|source| FriendsChannelError::Write {
            path: temporary.clone(),
            source,
        })?;

    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|source| FriendsChannelError::Write {
            path: path.to_path_buf(),
            source,
        })
}

async fn read_json<T>(path: &std::path::Path) -> Result<T, FriendsChannelError>
where
    T: Default + serde::de::DeserializeOwned,
{
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(T::default());
        }
        Err(source) => {
            return Err(FriendsChannelError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    if contents.trim().is_empty() {
        return Ok(T::default());
    }

    serde_json::from_str(&contents).map_err(|source| FriendsChannelError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> (tempfile::TempDir, FriendsChannel) {
        let dir = tempfile::tempdir().expect("temp dir");
        let channel = FriendsChannel::new(dir.path());
        (dir, channel)
    }

    #[tokio::test]
    async fn a_missing_outbox_reads_as_empty() {
        let (_dir, channel) = channel();

        assert!(channel.outbox().await.expect("read").requests.is_empty());
    }

    #[tokio::test]
    async fn parses_a_request_the_mod_would_write() {
        let (dir, channel) = channel();
        std::fs::write(
            dir.path().join(FRIENDS_OUTBOX_FILE),
            r#"{"version":1,"updated_at":"2026-08-31T12:00:00","requests":[
                {"id":"1","username":"rook","action":"request","target":"pike","requested_at":"2026-08-31T12:00:00"}
            ]}"#,
        )
        .expect("write");

        let requests = channel.outbox().await.expect("read").requests;

        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].username, "rook");
        assert_eq!(requests[0].action, "request");
        assert_eq!(requests[0].target.as_deref(), Some("pike"));
    }

    #[tokio::test]
    async fn round_trips_an_inbox_slice() {
        let (_dir, channel) = channel();
        let mut inbox = FriendsInbox {
            version: 1,
            updated_at: "now".to_owned(),
            players: std::collections::BTreeMap::new(),
        };
        inbox.players.insert(
            "rook".to_owned(),
            FriendsPlayerInbox {
                unread: 1,
                updated_at: "now".to_owned(),
                incoming: vec![FriendSnapshot {
                    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_owned(),
                    username: "pike".to_owned(),
                    online: true,
                    share_position: true,
                    their_share_position: true,
                    x: Some(1000.0),
                    y: Some(2000.0),
                    z: Some(0),
                    created_at: Some("now".to_owned()),
                }],
                outgoing: vec![],
                friends: vec![],
                blocked: vec![],
            },
        );

        channel.write_inbox(&inbox).await.expect("write");
        let read = channel.inbox().await.expect("read");

        assert_eq!(read.players["rook"].unread, 1);
        assert_eq!(read.players["rook"].incoming[0].username, "pike");
    }
}
