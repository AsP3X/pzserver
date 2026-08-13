//! Reads the JSON exports the KnoxRelay mod writes into the shared `Lua/` dir.
//!
//! The mod is unchanged from the PHP stack, so the file formats are fixed by
//! `KR_Beacon.lua` (positions) and `KR_Progress.lua` (progression).
//!
//! One thing to know about these files: the `timestamp` field inside them comes
//! off the in-game calendar, so it reads 1993 and stops advancing whenever the
//! world is paused. Freshness is therefore judged by the file's mtime, never by
//! its contents.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

/// Positions of everyone online, rewritten roughly every 30 real seconds.
pub const PLAYERS_LIVE_FILE: &str = "players_live.json";

/// Character progression, rewritten on the mod's ten-in-game-minute hook.
pub const PLAYER_STATS_FILE: &str = "player_stats.json";

/// How each character died, appended by the mod as corpses are found.
///
/// A rolling window, not an archive: the mod keeps the most recent 200 and
/// trims the front, so anything worth remembering has to be taken into
/// Postgres before it rolls off.
pub const DEATHS_FILE: &str = "deaths.json";

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("bridge file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("bridge file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlayersLiveExport {
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub players: Vec<LivePlayer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LivePlayer {
    pub username: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub z: i32,
    #[serde(default)]
    pub is_dead: bool,
    #[serde(default)]
    pub is_ghost: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlayerStatsExport {
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub players: Vec<StatsPlayer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsPlayer {
    pub username: String,
    #[serde(default)]
    pub zombie_kills: i32,
    #[serde(default)]
    pub hours_survived: f64,
    #[serde(default)]
    pub profession: Option<String>,
    /// Perk name to level. Untrained perks are omitted by the mod.
    #[serde(default)]
    pub skills: BTreeMap<String, i32>,
    /// Absent on KnoxRelay builds older than 1.3.
    #[serde(default)]
    pub traits: Option<serde_json::Value>,
    #[serde(default)]
    pub vitals: Option<serde_json::Value>,
    #[serde(default)]
    pub is_dead: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeathsExport {
    #[serde(default)]
    pub deaths: Vec<Death>,
}

/// One character's death, as the mod saw it happen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Death {
    pub username: String,
    /// `player`, `fire`, `infection` or `unknown` — the mod's own ranking.
    #[serde(default)]
    pub cause: Option<String>,
    /// Present only when another player was credited with the kill.
    #[serde(default)]
    pub killer: Option<String>,
    #[serde(default)]
    pub weapon: Option<String>,
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    #[serde(default)]
    pub z: i32,
    #[serde(default)]
    pub hours_survived: f64,
    #[serde(default)]
    pub zombie_kills: i32,
    /// Unix seconds, from the real clock rather than the in-game calendar.
    /// This is the half of the dedup key that makes a death identifiable.
    #[serde(default)]
    pub occurred_at: i64,
    /// The in-game date it happened on — 1993, and worth showing as such.
    #[serde(default)]
    pub world_time: Option<String>,
}

/// A read of one export, paired with the mtime it was read at.
#[derive(Debug, Clone)]
pub struct BridgeRead<T> {
    pub data: T,
    pub modified_at: Option<SystemTime>,
}

impl<T> BridgeRead<T> {
    /// Whether the file has gone untouched for longer than `max_age`.
    ///
    /// An unknown mtime counts as stale: we cannot prove the mod is alive.
    pub fn is_stale(&self, max_age: Duration) -> bool {
        match self.modified_at.and_then(|at| at.elapsed().ok()) {
            Some(age) => age > max_age,
            None => true,
        }
    }
}

/// Reader over the directory the game server and this API both mount.
#[derive(Debug, Clone)]
pub struct LuaBridge {
    dir: PathBuf,
}

impl LuaBridge {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn path(&self, file: &str) -> PathBuf {
        self.dir.join(file)
    }

    /// Live positions, or `None` when the mod has never written the file.
    pub async fn players_live(&self) -> Result<Option<BridgeRead<PlayersLiveExport>>, BridgeError> {
        self.read_export(PLAYERS_LIVE_FILE).await
    }

    /// Character progression, or `None` when the mod has never written the file.
    pub async fn player_stats(&self) -> Result<Option<BridgeRead<PlayerStatsExport>>, BridgeError> {
        self.read_export(PLAYER_STATS_FILE).await
    }

    /// Recent deaths, or `None` when nobody has died on this server yet.
    pub async fn deaths(&self) -> Result<Option<BridgeRead<DeathsExport>>, BridgeError> {
        self.read_export(DEATHS_FILE).await
    }

    /// When an export was last rewritten, without paying to parse it.
    pub async fn modified_at(&self, file: &str) -> Option<SystemTime> {
        tokio::fs::metadata(self.path(file))
            .await
            .ok()
            .and_then(|meta| meta.modified().ok())
    }

    async fn read_export<T>(&self, file: &str) -> Result<Option<BridgeRead<T>>, BridgeError>
    where
        T: serde::de::DeserializeOwned,
    {
        let path = self.path(file);

        let contents = match tokio::fs::read_to_string(&path).await {
            Ok(contents) => contents,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(BridgeError::Read { path, source }),
        };

        // The repair service writes a zero-byte placeholder over a missing
        // export, and the mod truncates before rewriting. Both read as "no
        // data yet" rather than as corruption.
        if contents.trim().is_empty() {
            return Ok(None);
        }

        let data = serde_json::from_str(&contents)
            .map_err(|source| BridgeError::Parse { path, source })?;

        Ok(Some(BridgeRead {
            data,
            modified_at: self.modified_at(file).await,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returned together because dropping the `TempDir` deletes the directory
    /// the bridge points at.
    fn bridge_with(file: &str, contents: &str) -> (tempfile::TempDir, LuaBridge) {
        let dir = tempfile::tempdir().expect("create temp dir");
        std::fs::write(dir.path().join(file), contents).expect("write export");
        let bridge = LuaBridge::new(dir.path());

        (dir, bridge)
    }

    #[tokio::test]
    async fn missing_export_reads_as_none() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let bridge = LuaBridge::new(dir.path());

        assert!(bridge.players_live().await.expect("read").is_none());
    }

    #[tokio::test]
    async fn empty_export_reads_as_none() {
        let (_dir, bridge) = bridge_with(PLAYERS_LIVE_FILE, "");

        assert!(bridge.players_live().await.expect("read").is_none());
    }

    #[tokio::test]
    async fn parses_live_positions() {
        let (_dir, bridge) = bridge_with(
            PLAYERS_LIVE_FILE,
            r#"{"timestamp":"1993-07-09T12:00:00","player_count":1,
                "players":[{"username":"alice","x":10.5,"y":20.5,"z":0,"is_dead":false,"is_ghost":false}]}"#,
        );

        let read = bridge.players_live().await.expect("read").expect("present");

        assert_eq!(read.data.players.len(), 1);
        assert_eq!(read.data.players[0].username, "alice");
        assert_eq!(read.data.players[0].x, 10.5);
    }

    #[tokio::test]
    async fn parses_stats_without_the_fields_older_mods_omit() {
        let (_dir, bridge) = bridge_with(
            PLAYER_STATS_FILE,
            r#"{"players":[{"username":"bob","zombie_kills":42,"hours_survived":12.5}]}"#,
        );

        let read = bridge.player_stats().await.expect("read").expect("present");
        let player = &read.data.players[0];

        assert_eq!(player.zombie_kills, 42);
        assert_eq!(player.traits, None);
        assert!(player.skills.is_empty());
        assert!(!player.is_dead);
    }

    #[tokio::test]
    async fn malformed_json_is_an_error_not_a_silent_empty() {
        let (_dir, bridge) = bridge_with(PLAYER_STATS_FILE, "{not json");

        assert!(bridge.player_stats().await.is_err());
    }

    #[test]
    fn an_unknown_mtime_counts_as_stale() {
        let read = BridgeRead {
            data: (),
            modified_at: None,
        };

        assert!(read.is_stale(Duration::from_secs(120)));
    }

    #[test]
    fn a_fresh_mtime_is_not_stale() {
        let read = BridgeRead {
            data: (),
            modified_at: Some(SystemTime::now()),
        };

        assert!(!read.is_stale(Duration::from_secs(120)));
    }
}
