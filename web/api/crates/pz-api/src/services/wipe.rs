//! Reset the world. Website-authored config stays unless the operator asks
//! to wipe that too.

use std::path::{Path, PathBuf};
use std::time::Duration;

use pz_bridge::docker::DockerClient;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::error::{ApiError, ApiResult};
use crate::services::admin;
use crate::services::backups;
use crate::state::AppState;

const PER_PLAYER_DIRS: &[&str] = &["inventory", "vitals"];

#[derive(Debug, Deserialize)]
pub struct WipeRequest {
    pub confirm: bool,
    #[serde(default)]
    pub include_config: bool,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WipeResult {
    pub message: String,
    pub include_config: bool,
    pub backup: Option<String>,
    pub players_deleted: i64,
    pub filesystem_errors: Vec<String>,
}

pub async fn run(state: &AppState, request: WipeRequest) -> ApiResult<WipeResult> {
    if !request.confirm {
        return Err(ApiError::Validation(
            "Type the confirmation to wipe the world.".to_owned(),
        ));
    }

    if let Some(message) = request.message.as_deref() {
        let _ = admin::broadcast(state, message).await;
    }

    let backup = match backups::create_now(state, "pre_rollback", Some("Pre-wipe safety backup")).await
    {
        Ok(()) => Some("pre-wipe backup written".to_owned()),
        Err(error) => {
            tracing::warn!(error, "pre-wipe backup failed; continuing");
            None
        }
    };

    let running = state
        .docker
        .status()
        .await
        .map(|status| status.running)
        .unwrap_or(false);

    let mut filesystem_errors = Vec::new();

    if running {
        if let Err(error) = exec_game_wipe(state, request.include_config).await {
            filesystem_errors.push(error);
        }
        if let Err(error) = admin::stop(state, None).await {
            tracing::warn!(error = %error, "stop before wipe failed");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    wipe_save_tree(
        &state.config.data_path,
        &state.config.server_name,
        &state.config.lua_bridge_path,
        request.include_config,
        &mut filesystem_errors,
    )
    .await;

    let players_deleted = wipe_website(&state.db, request.include_config).await?;

    if let Err(error) = admin::start(state).await {
        filesystem_errors.push(format!("The world was wiped but the server did not start: {error}"));
    }

    let message = if request.include_config {
        "World, players and website config have been wiped. The server is coming back up clean."
            .to_owned()
    } else {
        "World and players have been wiped. Website and game config were kept and will apply on boot."
            .to_owned()
    };

    Ok(WipeResult {
        message,
        include_config: request.include_config,
        backup,
        players_deleted,
        filesystem_errors,
    })
}

async fn exec_game_wipe(state: &AppState, include_config: bool) -> Result<(), String> {
    let docker = DockerClient::new(
        &state.config.docker_proxy_url,
        &state.config.game_server_container,
        Duration::from_secs(300),
    );
    let name = &state.config.server_name;
    let mut script = format!(
        r#"
set -e
ROOT=/home/steam/Zomboid
rm -rf "$ROOT/Saves/Multiplayer/"* || true
rm -rf "$ROOT/Saves/"* || true
mkdir -p "$ROOT/Saves/Multiplayer"
rm -f "$ROOT/db/{name}.db" "$ROOT/db/{name}.db-shm" "$ROOT/db/{name}.db-wal" \
      "$ROOT/db/serverPZ.db" "$ROOT/db/serverPZ.db-shm" "$ROOT/db/serverPZ.db-wal" || true
for kind in startup version periodic onVersion; do
  rm -rf "$ROOT/backups/$kind/"* || true
done
if [ -d "$ROOT/Lua" ]; then
  find "$ROOT/Lua/inventory" "$ROOT/Lua/vitals" -mindepth 1 -maxdepth 1 -exec rm -rf {{}} + 2>/dev/null || true
  find "$ROOT/Lua" -maxdepth 1 -type f -name '*.json' -exec sh -c ' : > "$1" ' _ {{}} \; 2>/dev/null || true
fi
"#
    );
    if include_config {
        script.push_str(&format!(
            r#"
rm -f "$ROOT/Server/{name}.ini" \
      "$ROOT/Server/{name}_SandboxVars.lua" \
      "$ROOT/Server/{name}_spawnpoints.lua" \
      "$ROOT/Server/{name}_spawnregions.lua" \
      "$ROOT/Server/.mod_state" \
      "$ROOT/Server/.mod_state_applied" \
      "$ROOT/Server/.mod_state_backup" \
      "$ROOT/Server/.config_state" || true
"#
        ));
    }
    let code = docker
        .exec(&["bash", "-lc", &script])
        .await
        .map_err(|error| format!("in-container wipe: {error}"))?;
    if code != 0 {
        return Err(format!("in-container wipe exited {code}"));
    }
    Ok(())
}

async fn wipe_save_tree(
    data: &Path,
    server_name: &str,
    lua: &Path,
    include_config: bool,
    errors: &mut Vec<String>,
) {
    let multiplayer = data.join("Saves").join("Multiplayer");
    if multiplayer.is_dir() {
        remove_children(&multiplayer, errors).await;
    }
    let saves = data.join("Saves");
    if saves.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&saves) {
            for entry in entries.flatten() {
                if entry.file_name() == "Multiplayer" {
                    continue;
                }
                force_remove(&entry.path(), errors).await;
            }
        }
    }

    for stem in [server_name.to_owned(), "serverPZ".to_owned()] {
        let db = data.join("db").join(format!("{stem}.db"));
        for path in [
            db.clone(),
            PathBuf::from(format!("{}-shm", db.display())),
            PathBuf::from(format!("{}-wal", db.display())),
        ] {
            if path.exists() {
                force_remove(&path, errors).await;
            }
        }
    }

    for kind in ["startup", "version", "periodic", "onVersion"] {
        let dir = data.join("backups").join(kind);
        if dir.is_dir() {
            remove_children(&dir, errors).await;
        }
    }

    if lua.is_dir() {
        if let Ok(entries) = std::fs::read_dir(lua) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name == ".gitkeep" {
                    continue;
                }
                let path = entry.path();
                if path.is_dir() && PER_PLAYER_DIRS.contains(&name.as_ref()) {
                    remove_children(&path, errors).await;
                    continue;
                }
                if path.is_file() && name.ends_with(".json") {
                    if let Err(error) = std::fs::write(&path, "") {
                        errors.push(format!("clear {}: {error}", path.display()));
                    }
                }
            }
        }
    }

    if include_config {
        let server_dir = data.join("Server");
        for file in [
            format!("{server_name}.ini"),
            format!("{server_name}_SandboxVars.lua"),
            format!("{server_name}_spawnpoints.lua"),
            format!("{server_name}_spawnregions.lua"),
            ".mod_state".to_owned(),
            ".mod_state_applied".to_owned(),
            ".mod_state_backup".to_owned(),
            ".config_state".to_owned(),
        ] {
            let path = server_dir.join(file);
            if path.exists() {
                force_remove(&path, errors).await;
            }
        }
    }
}

async fn wipe_website(db: &PgPool, include_config: bool) -> ApiResult<i64> {
    let mut tx = db.begin().await?;

    sqlx::query("DELETE FROM game_events")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM player_stats")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM pvp_violations")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM player_sanctions")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM item_orders")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM account_link_codes")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM account_registrations")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM server_status_samples")
        .execute(&mut *tx)
        .await?;

    let deleted = sqlx::query("DELETE FROM users WHERE role = 'player'")
        .execute(&mut *tx)
        .await?
        .rows_affected() as i64;

    if include_config {
        sqlx::query("DELETE FROM store_items")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM automations")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM objectives")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM quests")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM player_groups")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM news_posts")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM ui_translations")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM ui_languages WHERE code NOT IN ('en', 'de')")
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"UPDATE site_settings SET
                site_name = 'Knox County',
                hero_badge = '',
                hero_title = 'Knox County',
                hero_subtitle = '',
                hero_description = '',
                hero_cta_label = 'Join the server',
                footer_text = '',
                features = '[]'::jsonb,
                discord_url = NULL,
                translations = '{}'::jsonb,
                updated_at = now()
               WHERE id = 1"#,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"UPDATE vault_settings SET
                enabled = true,
                default_slots = 20,
                max_slots = 200,
                slot_upgrade_increment = 10,
                slot_upgrade_cost = 100,
                withdraw_fee_flat = 5,
                withdraw_fee_per_item = 1,
                updated_at = now()
               WHERE id = 1"#,
        )
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(deleted)
}

async fn remove_children(dir: &Path, errors: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            force_remove(&entry.path(), errors).await;
        }
    }
}

async fn force_remove(path: &Path, errors: &mut Vec<String>) {
    if !path.exists() {
        return;
    }
    let _ = tokio::process::Command::new("chmod")
        .args(["-R", "a+rwx"])
        .arg(path)
        .status()
        .await;
    let result = tokio::process::Command::new("rm")
        .args(["-rf"])
        .arg(path)
        .status()
        .await;
    if path.exists() {
        let detail = match result {
            Ok(status) => format!("rm exited {status}"),
            Err(error) => error.to_string(),
        };
        errors.push(format!("{}: {detail}", path.display()));
    }
}
