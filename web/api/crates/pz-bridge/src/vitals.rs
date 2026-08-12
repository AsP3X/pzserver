//! The mod's per-player vitals heartbeat.
//!
//! `KR_Vitals` writes one file per player into `Lua/vitals/<username>.json`,
//! falling back to a flat `Lua/vitals_<username>.json`. Finding whichever
//! exists is [`crate::player_file`]'s job; this module is the shape of what is
//! inside.
//!
//! This is richer than the summary that lands in `player_stats.json`: health
//! and wounds per body part, and the thermoregulator's core and per-part skin
//! temperatures. It is written while a player is online and left behind when
//! they log off, so it reads as "last known condition" rather than "now" —
//! which is why the read carries the file's mtime.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::player_file::{PlayerFile, PlayerFileError, read_player_json};

/// Preferred location, one file per player.
const DIRECTORY: &str = "vitals";

/// Everything one heartbeat carries.
///
/// Every panel is optional: the mod builds each inside its own `pcall`, so a
/// collector that fails leaves its key out rather than taking the file with it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlayerVitals {
    #[serde(default)]
    pub info: Option<CharacterInfo>,
    #[serde(default)]
    pub health: Option<BodyHealth>,
    #[serde(default)]
    pub wounds: Option<Vec<Wound>>,
    #[serde(default)]
    pub temperature: Option<BodyTemperature>,
    #[serde(default)]
    pub moodles: Option<Moodles>,
    #[serde(default)]
    pub weapon: Option<Weapon>,
    #[serde(default)]
    pub clothing: Option<Clothing>,
    #[serde(default)]
    pub encumbrance: Option<Encumbrance>,
    /// Perk name to level and XP progress. Richer than the level-only map in
    /// `player_stats`, which is why the character page prefers this one.
    #[serde(default)]
    pub skills: Option<BTreeMap<String, SkillProgress>>,
    #[serde(default)]
    pub recipes: Option<Vec<Recipe>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterInfo {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub profession: Option<String>,
    #[serde(default)]
    pub traits: Option<Vec<String>>,
    /// Body weight in kilograms, not carried weight.
    #[serde(default)]
    pub weight: Option<f64>,
    #[serde(default)]
    pub kills: Option<i64>,
    #[serde(default)]
    pub hours_survived: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillProgress {
    #[serde(default)]
    pub level: i32,
    /// Progress toward the next level, as the mod reports it.
    #[serde(default)]
    pub xp: f64,
}

/// Needs and afflictions, each 0–1 unless noted.
///
/// All of them count up as things get worse except `endurance`, which is the
/// reserve you spend — a full bar there is good news.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Moodles {
    #[serde(default)]
    pub hunger: Option<f64>,
    #[serde(default)]
    pub thirst: Option<f64>,
    #[serde(default)]
    pub fatigue: Option<f64>,
    #[serde(default)]
    pub endurance: Option<f64>,
    #[serde(default)]
    pub stress: Option<f64>,
    #[serde(default)]
    pub panic: Option<f64>,
    #[serde(default)]
    pub boredom: Option<f64>,
    #[serde(default)]
    pub unhappiness: Option<f64>,
    #[serde(default)]
    pub pain: Option<f64>,
    #[serde(default)]
    pub wetness: Option<f64>,
    #[serde(default)]
    pub drunk: Option<f64>,
    #[serde(default)]
    pub sickness: Option<f64>,
    #[serde(default)]
    pub food_sickness: Option<f64>,
    #[serde(default)]
    pub has_cold: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Weapon {
    #[serde(default)]
    pub name: Option<String>,
    /// 0–100.
    #[serde(default)]
    pub condition: Option<f64>,
    #[serde(default)]
    pub sharpness: Option<f64>,
    #[serde(default)]
    pub attachments: Option<Vec<String>>,
    /// Rounds loaded, for firearms.
    #[serde(default)]
    pub ammo: Option<i64>,
    #[serde(default)]
    pub chamber: Option<bool>,
    #[serde(default)]
    pub jam: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Clothing {
    #[serde(default)]
    pub items: Vec<ClothingItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClothingItem {
    #[serde(default)]
    pub slot: String,
    #[serde(default)]
    pub name: String,
    /// 0–100.
    #[serde(default)]
    pub condition: f64,
    #[serde(default)]
    pub holes: i64,
    /// Bite and scratch resistance, as percentages.
    #[serde(default)]
    pub bite: f64,
    #[serde(default)]
    pub scratch: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Encumbrance {
    #[serde(default)]
    pub current: Option<f64>,
    #[serde(default)]
    pub capacity: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    pub name: String,
    /// Real time, recorded by the mod when the recipe was learned.
    #[serde(default)]
    pub learned_at: Option<String>,
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
    #[error(transparent)]
    File(#[from] PlayerFileError),
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
    pub async fn read(
        &self,
        username: &str,
    ) -> Result<Option<PlayerFile<PlayerVitals>>, VitalsError> {
        Ok(read_player_json(&self.dir, DIRECTORY, username).await?)
    }
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
        "info": {
            "name": "rook", "profession": "Burglar", "traits": ["Brave"],
            "weight": 81.4, "kills": 2847, "hours_survived": 412.5
        },
        "moodles": { "hunger": 0.2, "endurance": 0.9, "has_cold": false },
        "weapon": {
            "name": "Crowbar", "condition": 64, "sharpness": 0,
            "attachments": [], "ammo": null, "chamber": false, "jam": false
        },
        "clothing": {
            "items": [
                { "slot": "Jacket", "name": "Leather Jacket", "condition": 78,
                  "holes": 1, "bite": 42, "scratch": 60 }
            ]
        },
        "encumbrance": { "current": 7.3, "capacity": 12.0 },
        "skills": { "Nimble": { "level": 6, "xp": 0.42 } },
        "recipes": [{ "name": "Make Bandage", "learned_at": "2026-08-11T09:00:00Z" }]
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
        let health = read.data.health.expect("health");

        assert_eq!(health.overall, 84.5);
        assert_eq!(health.parts["Hand_L"].wounds, vec!["Scratch"]);
        assert!(read.reported_at.is_some());
    }

    #[tokio::test]
    async fn falls_back_to_the_flat_form() {
        let (dir, reader) = reader();
        std::fs::write(dir.path().join("vitals_rook.json"), HEARTBEAT).expect("write");

        let read = reader.read("rook").await.expect("read").expect("present");

        assert_eq!(read.data.temperature.expect("temperature").core, 36.2);
    }

    #[tokio::test]
    async fn reads_every_panel_the_mod_writes() {
        let (dir, reader) = reader();
        std::fs::write(dir.path().join("vitals_rook.json"), HEARTBEAT).expect("write");

        let vitals = reader
            .read("rook")
            .await
            .expect("read")
            .expect("present")
            .data;

        assert_eq!(
            vitals.info.expect("info").profession.as_deref(),
            Some("Burglar")
        );
        assert_eq!(vitals.moodles.expect("moodles").hunger, Some(0.2));
        assert_eq!(
            vitals.weapon.expect("weapon").name.as_deref(),
            Some("Crowbar")
        );
        assert_eq!(vitals.clothing.expect("clothing").items.len(), 1);
        assert_eq!(
            vitals.encumbrance.expect("encumbrance").capacity,
            Some(12.0)
        );
        assert_eq!(vitals.skills.expect("skills")["Nimble"].level, 6);
        assert_eq!(vitals.recipes.expect("recipes").len(), 1);
        assert_eq!(vitals.wounds.expect("wounds").len(), 1);
    }

    #[tokio::test]
    async fn a_collector_the_mod_dropped_leaves_its_panel_empty() {
        let (dir, reader) = reader();
        // The mod builds each panel in its own pcall; a failed one is absent.
        std::fs::write(
            dir.path().join("vitals_rook.json"),
            r#"{"health":{"overall":50,"parts":{}}}"#,
        )
        .expect("write");

        let vitals = reader
            .read("rook")
            .await
            .expect("read")
            .expect("present")
            .data;

        assert!(vitals.moodles.is_none());
        assert!(vitals.weapon.is_none());
        assert_eq!(vitals.health.expect("health").overall, 50.0);
    }

    #[tokio::test]
    async fn a_partial_heartbeat_still_parses() {
        let (dir, reader) = reader();
        std::fs::write(dir.path().join("vitals_rook.json"), r#"{"health":null}"#).expect("write");

        let read = reader.read("rook").await.expect("read").expect("present");

        assert!(read.data.health.is_none());
        assert!(read.data.temperature.is_none());
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
