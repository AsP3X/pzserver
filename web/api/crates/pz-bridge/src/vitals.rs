//! The mod's per-player vitals heartbeat.
//!
//! `KR_Vitals` writes one file per player into `Lua/vitals/<username>.json`,
//! falling back to a flat `Lua/vitals_<username>.json` when the subdirectory
//! cannot be created. Both are tried here, newest wins.
//!
//! This is richer than the summary that lands in `player_stats.json`: health
//! and wounds per body part, and the thermoregulator's core and per-part skin
//! temperatures. It is written while a player is online and left behind when
//! they log off, so it reads as "last known condition" rather than "now" —
//! which is why the read carries the file's mtime.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Preferred location, one file per player.
const DIRECTORY: &str = "vitals";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlayerVitals {
    #[serde(default)]
    pub health: Option<BodyHealth>,
    #[serde(default)]
    pub wounds: Option<Vec<Wound>>,
    #[serde(default)]
    pub temperature: Option<BodyTemperature>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BodyHealth {
    /// 0–100 across the whole body.
    #[serde(default)]
    pub overall: f64,
    /// Keyed by PZ's own `BodyPartType` names, e.g. `Hand_L`, `Torso_Upper`.
    #[serde(default)]
    pub parts: BTreeMap<String, PartHealth>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartHealth {
    #[serde(default)]
    pub health: f64,
    /// `Scratch`, `Bite`, `Cut`, `Burn`, `Infection`, … as the mod names them.
    #[serde(default)]
    pub wounds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wound {
    pub part: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// `Minor`, `Moderate` or `Severe`, derived from what the part is down to.
    #[serde(default)]
    pub severity: Option<String>,
    /// Bandaged or stitched — as close as PZ gets to a treated flag.
    #[serde(default)]
    pub treated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BodyTemperature {
    /// Core temperature in Celsius. 37 is normal.
    #[serde(default)]
    pub core: f64,
    /// How far body heat sits from equilibrium.
    #[serde(default)]
    pub body_heat: f64,
    #[serde(default)]
    pub parts: BTreeMap<String, PartTemperature>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartTemperature {
    /// Skin temperature in Celsius.
    #[serde(default)]
    pub skin: f64,
    /// How much the clothing on that part is holding heat in.
    #[serde(default)]
    pub insulation: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum VitalsError {
    #[error("vitals file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("vitals file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// One player's heartbeat, with when it was written.
#[derive(Debug, Clone)]
pub struct VitalsRead {
    pub vitals: PlayerVitals,
    pub reported_at: Option<SystemTime>,
}

#[derive(Debug, Clone)]
pub struct VitalsReader {
    dir: PathBuf,
}

impl VitalsReader {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Read a player's heartbeat, or `None` when the mod has never written one.
    ///
    /// The username comes from our own database rather than from a request, but
    /// it still ends up in a path, so anything that could climb out of the
    /// bridge directory is refused outright.
    pub async fn read(&self, username: &str) -> Result<Option<VitalsRead>, VitalsError> {
        if !is_safe_filename(username) {
            return Ok(None);
        }

        let candidates = [
            self.dir.join(DIRECTORY).join(format!("{username}.json")),
            self.dir.join(format!("{DIRECTORY}_{username}.json")),
        ];

        for path in candidates {
            let contents = match tokio::fs::read_to_string(&path).await {
                Ok(contents) => contents,
                Err(source) if source.kind() == std::io::ErrorKind::NotFound => continue,
                Err(source) => return Err(VitalsError::Read { path, source }),
            };

            if contents.trim().is_empty() {
                continue;
            }

            let vitals = serde_json::from_str(&contents).map_err(|source| VitalsError::Parse {
                path: path.clone(),
                source,
            })?;

            let reported_at = tokio::fs::metadata(&path)
                .await
                .ok()
                .and_then(|meta| meta.modified().ok());

            return Ok(Some(VitalsRead {
                vitals,
                reported_at,
            }));
        }

        Ok(None)
    }
}

/// PZ usernames are letters, digits and underscores; anything else has no
/// business being joined onto a path.
fn is_safe_filename(username: &str) -> bool {
    !username.is_empty()
        && username.len() <= 50
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEARTBEAT: &str = r#"{
        "health": {
            "overall": 84.5,
            "parts": {
                "Head": { "health": 100, "wounds": [] },
                "Hand_L": { "health": 62.5, "wounds": ["Scratch"] }
            }
        },
        "wounds": [
            { "part": "Hand_L", "type": "Scratch", "severity": "Moderate", "treated": false }
        ],
        "temperature": {
            "core": 36.2,
            "body_heat": -0.31,
            "parts": {
                "Head": { "skin": 33.1, "insulation": 0.0 },
                "Hand_L": { "skin": 21.4, "insulation": 0.05 }
            }
        },
        "moodles": { "hunger": 0.2 },
        "clothing": {}
    }"#;

    fn reader() -> (tempfile::TempDir, VitalsReader) {
        let dir = tempfile::tempdir().expect("temp dir");
        let reader = VitalsReader::new(dir.path());

        (dir, reader)
    }

    #[tokio::test]
    async fn a_player_with_no_heartbeat_reads_as_none() {
        let (_dir, reader) = reader();

        assert!(reader.read("rook").await.expect("read").is_none());
    }

    #[tokio::test]
    async fn reads_the_subdirectory_form() {
        let (dir, reader) = reader();
        std::fs::create_dir_all(dir.path().join(DIRECTORY)).expect("mkdir");
        std::fs::write(dir.path().join(DIRECTORY).join("rook.json"), HEARTBEAT).expect("write");

        let read = reader.read("rook").await.expect("read").expect("present");
        let health = read.vitals.health.expect("health");

        assert_eq!(health.overall, 84.5);
        assert_eq!(health.parts["Hand_L"].wounds, vec!["Scratch"]);
        assert!(read.reported_at.is_some());
    }

    #[tokio::test]
    async fn falls_back_to_the_flat_form() {
        let (dir, reader) = reader();
        std::fs::write(dir.path().join("vitals_rook.json"), HEARTBEAT).expect("write");

        let read = reader.read("rook").await.expect("read").expect("present");

        assert_eq!(read.vitals.temperature.expect("temperature").core, 36.2);
    }

    #[tokio::test]
    async fn ignores_the_panels_this_page_does_not_use() {
        let (dir, reader) = reader();
        std::fs::write(dir.path().join("vitals_rook.json"), HEARTBEAT).expect("write");

        // moodles and clothing are in the file and simply not deserialised.
        let read = reader.read("rook").await.expect("read").expect("present");

        assert_eq!(read.vitals.wounds.expect("wounds").len(), 1);
    }

    #[tokio::test]
    async fn a_partial_heartbeat_still_parses() {
        let (dir, reader) = reader();
        std::fs::write(dir.path().join("vitals_rook.json"), r#"{"health":null}"#).expect("write");

        let read = reader.read("rook").await.expect("read").expect("present");

        assert!(read.vitals.health.is_none());
        assert!(read.vitals.temperature.is_none());
    }

    #[tokio::test]
    async fn a_username_that_could_escape_the_directory_is_refused() {
        let (_dir, reader) = reader();

        assert!(
            reader
                .read("../../etc/passwd")
                .await
                .expect("read")
                .is_none()
        );
        assert!(reader.read("rook/../../x").await.expect("read").is_none());
        assert!(reader.read("").await.expect("read").is_none());
    }
}
