//! The panel's intended `server.ini` overrides, written next to the INI.
//!
//! `configure-server.sh` treats `.mod_state` and `.config_state` as
//! authoritative on every boot. PZ rewrites the live INI on shutdown and may
//! prune mods it did not load, so the INI is a cache after the panel has saved
//! once — not the source of truth.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::ini::{IniError, ServerIni};

const MOD_STATE_NAME: &str = ".mod_state";
const CONFIG_STATE_NAME: &str = ".config_state";

/// Keys `configure-server.sh` overwrites from env on boot unless `.config_state`
/// has a value. Anything else can live in the INI alone.
const PERSISTABLE_CONFIG_KEYS: &[&str] = &[
    "DefaultPort",
    "UDPPort",
    "MaxPlayers",
    "Map",
    "Public",
    "PauseEmpty",
    "SaveWorldEveryMinutes",
    "SteamVAC",
    "Open",
    "AutoCreateUserInWhiteList",
    "UPnP",
    "Password",
    "AdminPassword",
];

#[derive(Debug, thiserror::Error)]
pub enum PanelStateError {
    #[error(transparent)]
    Ini(#[from] IniError),

    #[error("panel state at {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("panel state at {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModState {
    pub mods: Vec<String>,
    pub workshop_items: Vec<String>,
}

impl ModState {
    pub fn from_joined(mods: &str, workshop_items: &str) -> Self {
        Self {
            mods: split_list(mods),
            workshop_items: split_list(workshop_items),
        }
    }
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

fn sidecar(ini_path: &Path, name: &str) -> PathBuf {
    ini_path
        .parent()
        .map(|dir| dir.join(name))
        .unwrap_or_else(|| PathBuf::from(name))
}

fn parse_mod_state(contents: &str) -> Option<ModState> {
    let mut mods = None;
    let mut workshop = None;
    for line in contents.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("Mods=") {
            mods = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("WorkshopItems=") {
            workshop = Some(value.to_owned());
        }
    }
    match (mods, workshop) {
        (Some(mods), Some(workshop)) => Some(ModState::from_joined(&mods, &workshop)),
        _ => None,
    }
}

fn strip_newlines(value: &str) -> String {
    value.replace(['\n', '\r'], "")
}

async fn atomic_write(path: &Path, contents: &str) -> Result<(), PanelStateError> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "state".to_owned());
    let tmp = path.with_file_name(format!("{file_name}.tmp"));

    tokio::fs::write(&tmp, contents.as_bytes())
        .await
        .map_err(|source| PanelStateError::Write {
            path: tmp.clone(),
            source,
        })?;

    match tokio::fs::rename(&tmp, path).await {
        Ok(()) => Ok(()),
        Err(_) => {
            // Windows cannot replace an existing file with rename.
            let _ = tokio::fs::remove_file(path).await;
            tokio::fs::rename(&tmp, path)
                .await
                .map_err(|source| PanelStateError::Write {
                    path: path.to_path_buf(),
                    source,
                })
        }
    }
}

async fn read_config_state_file(path: &Path) -> Result<BTreeMap<String, String>, PanelStateError> {
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BTreeMap::new());
        }
        Err(source) => {
            return Err(PanelStateError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    let mut values = BTreeMap::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.trim().to_owned(), value.to_owned());
        }
    }
    Ok(values)
}

/// Parse `.mod_state`. `None` when the file is missing or missing either line
/// — a truncated file must not half-replace the INI.
pub async fn read_mod_state(ini_path: &Path) -> Result<Option<ModState>, PanelStateError> {
    let path = sidecar(ini_path, MOD_STATE_NAME);
    let contents = match tokio::fs::read_to_string(&path).await {
        Ok(contents) => contents,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(PanelStateError::Read { path, source });
        }
    };
    Ok(parse_mod_state(&contents))
}

pub async fn write_mod_state(ini_path: &Path, state: &ModState) -> Result<(), PanelStateError> {
    let path = sidecar(ini_path, MOD_STATE_NAME);
    let contents = format!(
        "Mods={}\nWorkshopItems={}\n",
        state.mods.join(";"),
        state.workshop_items.join(";")
    );
    atomic_write(&path, &contents).await
}

/// Prefer `.mod_state` over the live INI so a PZ prune cannot hide the list
/// the panel last saved.
pub async fn read_intended_mod_lists(ini_path: &Path) -> Result<ModState, PanelStateError> {
    if let Some(state) = read_mod_state(ini_path).await? {
        return Ok(state);
    }
    let ini = ServerIni::read(ini_path).await?.unwrap_or_default();
    Ok(ModState {
        mods: ini.get_list("Mods"),
        workshop_items: ini.get_list("WorkshopItems"),
    })
}

/// Write `Mods=` / `WorkshopItems=` to the INI and snapshot `.mod_state` so a
/// restart restores the list the panel last saved, not a first-boot seed.
pub async fn write_intended_mod_lists(
    ini_path: &Path,
    state: &ModState,
) -> Result<(), PanelStateError> {
    let previous = match tokio::fs::read_to_string(ini_path).await {
        Ok(contents) => Some(contents),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => None,
        Err(source) => {
            return Err(PanelStateError::Read {
                path: ini_path.to_path_buf(),
                source,
            });
        }
    };

    let mut updates = BTreeMap::new();
    updates.insert("Mods".to_owned(), state.mods.join(";"));
    updates.insert("WorkshopItems".to_owned(), state.workshop_items.join(";"));
    ServerIni::write_updates(ini_path, &updates).await?;

    if let Err(error) = write_mod_state(ini_path, state).await {
        if let Some(previous) = previous {
            let _ = tokio::fs::write(ini_path, previous).await;
        }
        return Err(error);
    }
    Ok(())
}

/// Merge persistable keys into `.config_state`. No-op when none of the keys
/// are in `updates`, so a mod-only save does not create an empty file.
pub async fn persist_config_state(
    ini_path: &Path,
    updates: &BTreeMap<String, String>,
) -> Result<(), PanelStateError> {
    let persistable: BTreeMap<String, String> = updates
        .iter()
        .filter(|(key, _)| PERSISTABLE_CONFIG_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), strip_newlines(value)))
        .collect();
    if persistable.is_empty() {
        return Ok(());
    }

    let path = sidecar(ini_path, CONFIG_STATE_NAME);
    let mut merged = read_config_state_file(&path).await?;
    merged.retain(|key, _| PERSISTABLE_CONFIG_KEYS.contains(&key.as_str()));
    merged.extend(persistable);

    let contents = merged
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    atomic_write(&path, &contents).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ini_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("ZomboidServer.ini")
    }

    async fn seed_ini(path: &Path, mods: &str, workshop: &str) {
        let body =
            format!("PublicName=Knox\nMods={mods}\nWorkshopItems={workshop}\nMap=Muldraugh, KY\n");
        tokio::fs::write(path, body).await.expect("seed ini");
    }

    #[tokio::test]
    async fn saving_mods_writes_mod_state_next_to_the_ini() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ini = ini_path(&dir);
        seed_ini(&ini, "KnoxRelay", "3777446787").await;

        let next = ModState::from_joined("KnoxRelay;Brita", "3777446787;2822286426");
        write_intended_mod_lists(&ini, &next)
            .await
            .expect("write mods");

        let state = tokio::fs::read_to_string(dir.path().join(MOD_STATE_NAME))
            .await
            .expect(".mod_state must be written so configure-server.sh can restore it");
        assert!(state.contains("Mods=KnoxRelay;Brita"), "{state}");
        assert!(
            state.contains("WorkshopItems=3777446787;2822286426"),
            "{state}"
        );
    }

    #[tokio::test]
    async fn manager_keeps_saved_mods_when_ini_is_pruned_on_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ini = ini_path(&dir);
        seed_ini(&ini, "KnoxRelay", "3777446787").await;

        write_intended_mod_lists(
            &ini,
            &ModState::from_joined("KnoxRelay;Brita", "3777446787;2822286426"),
        )
        .await
        .expect("write mods");

        // What configure-server.sh / PZ can do to the live INI between boots.
        seed_ini(&ini, "KnoxRelay", "3777446787").await;

        let listed = read_intended_mod_lists(&ini).await.expect("list");
        assert_eq!(listed.mods, vec!["KnoxRelay", "Brita"]);
        assert_eq!(listed.workshop_items, vec!["3777446787", "2822286426"]);
    }

    #[tokio::test]
    async fn adding_a_mod_after_ini_prune_does_not_drop_the_saved_list() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ini = ini_path(&dir);
        tokio::fs::write(
            dir.path().join(MOD_STATE_NAME),
            "Mods=Hydrocraft;KnoxRelay\nWorkshopItems=2286126274;3777446787\n",
        )
        .await
        .expect("state");
        seed_ini(&ini, "", "").await;

        let mut current = read_intended_mod_lists(&ini).await.expect("list");
        current.mods.push("NewMod".to_owned());
        current.workshop_items.push("4242424242".to_owned());
        write_intended_mod_lists(&ini, &current)
            .await
            .expect("write");

        let state = tokio::fs::read_to_string(dir.path().join(MOD_STATE_NAME))
            .await
            .expect("state");
        assert!(
            state.contains("Mods=Hydrocraft;KnoxRelay;NewMod"),
            "{state}"
        );
        assert!(
            state.contains("WorkshopItems=2286126274;3777446787;4242424242"),
            "{state}"
        );
    }

    #[tokio::test]
    async fn empty_mod_state_is_a_real_list_not_a_fallback_to_ini() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ini = ini_path(&dir);
        seed_ini(&ini, "KnoxRelay", "3777446787").await;
        tokio::fs::write(dir.path().join(MOD_STATE_NAME), "Mods=\nWorkshopItems=\n")
            .await
            .expect("empty state");

        let listed = read_intended_mod_lists(&ini).await.expect("list");
        assert!(listed.mods.is_empty());
        assert!(listed.workshop_items.is_empty());
    }

    #[tokio::test]
    async fn malformed_mod_state_falls_back_to_ini() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ini = ini_path(&dir);
        seed_ini(&ini, "KnoxRelay", "3777446787").await;
        tokio::fs::write(dir.path().join(MOD_STATE_NAME), "garbage\n")
            .await
            .expect("garbage");

        let listed = read_intended_mod_lists(&ini).await.expect("list");
        assert_eq!(listed.mods, vec!["KnoxRelay"]);
        assert_eq!(listed.workshop_items, vec!["3777446787"]);
    }

    #[tokio::test]
    async fn persist_config_state_merges_map_so_a_map_mod_survives_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ini = ini_path(&dir);
        seed_ini(&ini, "KnoxRelay", "3777446787").await;

        let mut first = BTreeMap::new();
        first.insert("MaxPlayers".to_owned(), "24".to_owned());
        persist_config_state(&ini, &first)
            .await
            .expect("persist players");

        let mut second = BTreeMap::new();
        second.insert("Map".to_owned(), "CustomMap;Muldraugh, KY".to_owned());
        persist_config_state(&ini, &second)
            .await
            .expect("persist map");

        let body = tokio::fs::read_to_string(dir.path().join(CONFIG_STATE_NAME))
            .await
            .expect(".config_state");
        assert!(body.contains("MaxPlayers=24"), "{body}");
        assert!(body.contains("Map=CustomMap;Muldraugh, KY"), "{body}");
    }

    #[tokio::test]
    async fn persist_config_state_ignores_mod_keys_and_does_not_create_a_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ini = ini_path(&dir);
        seed_ini(&ini, "KnoxRelay", "3777446787").await;

        let mut updates = BTreeMap::new();
        updates.insert("Mods".to_owned(), "KnoxRelay;Brita".to_owned());
        persist_config_state(&ini, &updates).await.expect("persist");

        assert!(!dir.path().join(CONFIG_STATE_NAME).exists());
    }
}
