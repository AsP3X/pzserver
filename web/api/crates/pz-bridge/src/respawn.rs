//! The respawn cooldown shared with Knox Relay (`KR_Cooldown`).
//!
//! Four files, and the direction of each one matters:
//!
//! | file                   | written by | read by |
//! |------------------------|------------|---------|
//! | `respawn_config.json`  | us         | the mod |
//! | `respawn_resets.json`  | us         | the mod |
//! | `respawn_deaths.json`  | the mod    | us      |
//! | `respawn_kicks.json`   | the mod    | us      |
//!
//! The mod deliberately does not disconnect anybody itself — there is no
//! reliable way to do that from Lua on a dedicated server — so it queues a kick
//! and waits for this side to perform it over RCON. Nothing consumed that queue
//! between the PHP panel being parked and this module, which left the cooldown
//! configurable but unenforced.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const CONFIG_FILE: &str = "respawn_config.json";
pub const DEATHS_FILE: &str = "respawn_deaths.json";
pub const RESETS_FILE: &str = "respawn_resets.json";
pub const KICKS_FILE: &str = "respawn_kicks.json";

/// Matches the mod's own fallback in `reloadSettings`.
pub const DEFAULT_DELAY_MINUTES: i64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RespawnConfig {
    pub enabled: bool,
    pub delay_minutes: i64,
}

impl Default for RespawnConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            delay_minutes: DEFAULT_DELAY_MINUTES,
        }
    }
}

/// One queued disconnect.
///
/// There is no id, so a processed entry is identified by username and
/// timestamp together — the mod only ever holds one entry per username at a
/// time, but the timestamp keeps a re-queued kick distinct from the one we
/// just handled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RespawnKick {
    pub username: String,
    #[serde(default)]
    pub reason: Option<String>,
    /// Unix seconds, from `os.time()`.
    #[serde(default)]
    pub timestamp: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct KicksFile {
    #[serde(default)]
    kicks: Vec<RespawnKick>,
}

/// `{ "deaths": { "<username>": <epoch seconds> } }`.
///
/// An empty table is written by Lua as `{}`, which is indistinguishable from an
/// empty object here — exactly what we want.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DeathsFile {
    #[serde(default)]
    deaths: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ResetsFile {
    #[serde(default)]
    resets: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum RespawnError {
    #[error("respawn file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("respawn file {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("respawn file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone)]
pub struct RespawnChannel {
    dir: PathBuf,
}

impl RespawnChannel {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub async fn config(&self) -> Result<RespawnConfig, RespawnError> {
        read_json(&self.dir.join(CONFIG_FILE)).await
    }

    pub async fn set_config(&self, config: RespawnConfig) -> Result<(), RespawnError> {
        write_json(&self.dir.join(CONFIG_FILE), &config).await
    }

    /// Death timestamps the mod is holding, as username to unix seconds.
    pub async fn deaths(&self) -> Result<BTreeMap<String, i64>, RespawnError> {
        let file: DeathsFile = read_json(&self.dir.join(DEATHS_FILE)).await?;

        Ok(file.deaths)
    }

    /// Ask the mod to clear one player's timer.
    ///
    /// Appends rather than replaces: the mod drains this file on its own
    /// schedule, and overwriting would drop a reset queued moments earlier.
    pub async fn queue_reset(&self, username: &str) -> Result<(), RespawnError> {
        let path = self.dir.join(RESETS_FILE);
        let mut file: ResetsFile = read_json(&path).await?;

        if !file.resets.iter().any(|name| name == username) {
            file.resets.push(username.to_owned());
        }

        write_json(&path, &file).await
    }

    pub async fn kicks(&self) -> Result<Vec<RespawnKick>, RespawnError> {
        let file: KicksFile = read_json(&self.dir.join(KICKS_FILE)).await?;

        Ok(file.kicks)
    }

    /// Remove entries we have acted on, leaving anything queued since.
    ///
    /// Draining matters in both directions: leaving an entry in place stops the
    /// mod ever queueing another kick for that player (it skips a username it
    /// already sees), while clearing the whole file would silently swallow a
    /// kick queued between our read and our write.
    pub async fn drain(&self, handled: &[RespawnKick]) -> Result<(), RespawnError> {
        if handled.is_empty() {
            return Ok(());
        }

        let path = self.dir.join(KICKS_FILE);
        let mut file: KicksFile = read_json(&path).await?;

        file.kicks.retain(|entry| !handled.contains(entry));

        write_json(&path, &file).await
    }
}

async fn read_json<T>(path: &std::path::Path) -> Result<T, RespawnError>
where
    T: Default + serde::de::DeserializeOwned,
{
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(T::default());
        }
        Err(source) => {
            return Err(RespawnError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    if contents.trim().is_empty() {
        return Ok(T::default());
    }

    serde_json::from_str(&contents).map_err(|source| RespawnError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

async fn write_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), RespawnError> {
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value).map_err(|source| RespawnError::Parse {
        path: path.to_path_buf(),
        source,
    })?;

    tokio::fs::write(&temporary, body)
        .await
        .map_err(|source| RespawnError::Write {
            path: temporary.clone(),
            source,
        })?;

    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|source| RespawnError::Write {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> (tempfile::TempDir, RespawnChannel) {
        let dir = tempfile::tempdir().expect("create temp dir");
        let channel = RespawnChannel::new(dir.path());

        (dir, channel)
    }

    fn kick(username: &str, at: i64) -> RespawnKick {
        RespawnKick {
            username: username.to_owned(),
            reason: Some("Respawn cooldown: 5 minute(s) remaining. Please wait.".to_owned()),
            timestamp: at,
        }
    }

    #[tokio::test]
    async fn an_unconfigured_cooldown_is_off_and_matches_the_mod_default() {
        let (_dir, channel) = channel();

        let config = channel.config().await.expect("config");

        assert!(!config.enabled);
        assert_eq!(config.delay_minutes, DEFAULT_DELAY_MINUTES);
    }

    #[tokio::test]
    async fn config_round_trips() {
        let (_dir, channel) = channel();

        channel
            .set_config(RespawnConfig {
                enabled: true,
                delay_minutes: 15,
            })
            .await
            .expect("set");

        let config = channel.config().await.expect("config");

        assert!(config.enabled);
        assert_eq!(config.delay_minutes, 15);
    }

    /// The mod writes this file; we only read it.
    #[tokio::test]
    async fn death_timers_are_read_as_a_username_map() {
        let (dir, channel) = channel();
        std::fs::write(
            dir.path().join(DEATHS_FILE),
            r#"{"deaths":{"rook":1786622231,"pike":1786622999}}"#,
        )
        .expect("write");

        let deaths = channel.deaths().await.expect("deaths");

        assert_eq!(deaths.len(), 2);
        assert_eq!(deaths.get("rook"), Some(&1_786_622_231));
    }

    #[tokio::test]
    async fn a_missing_deaths_file_is_no_deaths_rather_than_an_error() {
        let (_dir, channel) = channel();

        assert!(channel.deaths().await.expect("deaths").is_empty());
    }

    #[tokio::test]
    async fn resets_accumulate_rather_than_replacing() {
        let (_dir, channel) = channel();

        channel.queue_reset("rook").await.expect("reset");
        channel.queue_reset("pike").await.expect("reset");
        channel.queue_reset("rook").await.expect("reset");

        let body =
            std::fs::read_to_string(channel.dir.join(RESETS_FILE)).expect("read");
        let file: ResetsFile = serde_json::from_str(&body).expect("parse");

        assert_eq!(file.resets, vec!["rook", "pike"], "no duplicates, none lost");
    }

    #[tokio::test]
    async fn kicks_written_by_the_mod_are_read_back() {
        let (dir, channel) = channel();
        std::fs::write(
            dir.path().join(KICKS_FILE),
            r#"{"kicks":[{"username":"rook","reason":"wait","timestamp":1786622231}]}"#,
        )
        .expect("write");

        let kicks = channel.kicks().await.expect("kicks");

        assert_eq!(kicks.len(), 1);
        assert_eq!(kicks[0].username, "rook");
        assert_eq!(kicks[0].reason.as_deref(), Some("wait"));
    }

    #[tokio::test]
    async fn draining_removes_only_what_was_handled() {
        let (dir, channel) = channel();
        let handled = kick("rook", 100);
        let untouched = kick("pike", 200);

        std::fs::write(
            dir.path().join(KICKS_FILE),
            serde_json::to_string(&KicksFile {
                kicks: vec![handled.clone(), untouched.clone()],
            })
            .expect("encode"),
        )
        .expect("write");

        channel.drain(&[handled]).await.expect("drain");

        assert_eq!(channel.kicks().await.expect("kicks"), vec![untouched]);
    }

    /// The mod appends between our read and our write often enough that this
    /// has to be safe: clearing the file wholesale would lose that kick, and
    /// the player would stay in the world past their cooldown.
    #[tokio::test]
    async fn a_kick_queued_during_processing_survives_the_drain() {
        let (dir, channel) = channel();
        let handled = kick("rook", 100);

        std::fs::write(
            dir.path().join(KICKS_FILE),
            serde_json::to_string(&KicksFile {
                kicks: vec![handled.clone()],
            })
            .expect("encode"),
        )
        .expect("write");

        // Simulates the mod appending while the kick above is being performed.
        let late = kick("pike", 300);
        std::fs::write(
            dir.path().join(KICKS_FILE),
            serde_json::to_string(&KicksFile {
                kicks: vec![handled.clone(), late.clone()],
            })
            .expect("encode"),
        )
        .expect("write");

        channel.drain(&[handled]).await.expect("drain");

        assert_eq!(channel.kicks().await.expect("kicks"), vec![late]);
    }

    #[tokio::test]
    async fn draining_nothing_leaves_the_file_alone() {
        let (dir, channel) = channel();
        let queued = kick("rook", 100);
        std::fs::write(
            dir.path().join(KICKS_FILE),
            serde_json::to_string(&KicksFile {
                kicks: vec![queued.clone()],
            })
            .expect("encode"),
        )
        .expect("write");

        channel.drain(&[]).await.expect("drain");

        assert_eq!(channel.kicks().await.expect("kicks"), vec![queued]);
    }

    /// A re-queued kick for the same player carries a later timestamp, so it
    /// must not be mistaken for the one already handled.
    #[tokio::test]
    async fn a_requeued_kick_for_the_same_player_is_not_treated_as_handled() {
        let (dir, channel) = channel();
        let first = kick("rook", 100);
        let again = kick("rook", 400);

        std::fs::write(
            dir.path().join(KICKS_FILE),
            serde_json::to_string(&KicksFile {
                kicks: vec![again.clone()],
            })
            .expect("encode"),
        )
        .expect("write");

        channel.drain(&[first]).await.expect("drain");

        assert_eq!(channel.kicks().await.expect("kicks"), vec![again]);
    }
}
