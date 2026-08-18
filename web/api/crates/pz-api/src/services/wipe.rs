//! Reset the world. Every website account goes with it. Server and site
//! configuration stay unless the operator asks to wipe those too.

use std::path::{Path, PathBuf};
use std::time::Duration;

use pz_bridge::docker::DockerClient;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::error::{ApiError, ApiResult};
use crate::services::admin;
use crate::services::auth;
use crate::services::backups;
use crate::state::AppState;

const PER_PLAYER_DIRS: &[&str] = &["inventory", "vitals"];

/// World-tied rows that are not owned by a `users` foreign key (or that
/// survive `ON DELETE SET NULL`). User-owned wallets, vaults, sessions and
/// shop history go with the account via CASCADE.
///
/// Must name tables that still exist after the latest migration. A dropped
/// table here aborts the website half of the wipe and leaves every account
/// standing — that is how `account_link_codes` (dropped in 0006) kept logins
/// alive after a world reset.
#[cfg_attr(not(test), allow(dead_code))]
const WORLD_DATA_TABLES: &[&str] = &[
    "game_events",
    "player_stats",
    "pvp_violations",
    "player_sanctions",
    "player_reports",
    "item_orders",
    "account_registrations",
    "server_status_samples",
    "audit_logs",
];

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
        if let Err(error) = exec_game_wipe(state).await {
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
        &mut filesystem_errors,
    )
    .await;

    let players_deleted = wipe_website(&state.db, request.include_config).await?;

    if let Some(admin) = state.config.admin_bootstrap.as_ref() {
        match auth::ensure_admin(
            &state.db,
            &admin.username,
            &admin.email,
            &admin.password,
        )
        .await
        {
            Ok(true) => tracing::info!(username = %admin.username, "recreated the first administrator after wipe"),
            Ok(false) => {}
            Err(error) => {
                filesystem_errors.push(format!(
                    "Accounts were wiped but the first administrator could not be recreated: {error}"
                ));
            }
        }
    } else {
        filesystem_errors.push(
            "Accounts were wiped and ADMIN_USERNAME/ADMIN_PASSWORD are unset, so nobody can sign in until those are set and the API restarts."
                .to_owned(),
        );
    }

    if let Err(error) = admin::start(state).await {
        filesystem_errors.push(format!("The world was wiped but the server did not start: {error}"));
    }

    let message = if request.include_config {
        "World, accounts and website config have been wiped. Game server.ini, sandbox and Knox Relay were kept."
            .to_owned()
    } else {
        "World and website accounts have been wiped. Server and site configuration were kept."
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

async fn exec_game_wipe(state: &AppState) -> Result<(), String> {
    let docker = DockerClient::new(
        &state.config.docker_proxy_url,
        &state.config.game_server_container,
        Duration::from_secs(300),
    );
    let name = &state.config.server_name;
    let script = format!(
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
    sqlx::query("DELETE FROM player_reports")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM item_orders")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM account_registrations")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM server_status_samples")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM audit_logs")
        .execute(&mut *tx)
        .await?;

    let deleted = sqlx::query("DELETE FROM users")
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
                -- Branding goes with the rest of the copy: this branch is the
                -- explicit "reset the site's identity too" option, and leaving
                -- the old logo over default text would look half-wiped.
                logo = NULL,
                logo_type = NULL,
                favicon = NULL,
                favicon_type = NULL,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;

    #[test]
    fn world_wipe_tables_exist_in_the_migrated_schema() {
        let live = schema_tables();

        for table in WORLD_DATA_TABLES {
            assert!(
                live.contains(*table),
                "{table} is wiped on a world reset but is not in the migrated schema — \
                 the website half of the wipe will abort and leave accounts in place"
            );
        }
    }

    #[test]
    fn world_wipe_does_not_target_the_dropped_link_codes_table() {
        assert!(
            !WORLD_DATA_TABLES.contains(&"account_link_codes"),
            "account_link_codes was dropped in 0006; deleting it rolls back the wipe"
        );
    }

    #[test]
    fn wipe_website_issues_a_delete_for_every_world_table() {
        let source = include_str!("wipe.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production source");

        for table in WORLD_DATA_TABLES {
            assert!(
                production.contains(&format!("DELETE FROM {table}")),
                "wipe_website is missing DELETE FROM {table}"
            );
        }
        assert!(
            production.contains("DELETE FROM users"),
            "wipe_website must remove every account"
        );
        assert!(
            !production.contains("role = 'player'"),
            "a role filter leaves staff logins standing after a world reset"
        );
    }

    #[test]
    fn wipe_never_deletes_game_server_config() {
        let production = include_str!("wipe.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production source");

        for needle in [
            ".mod_state",
            "_SandboxVars.lua",
            "_spawnpoints.lua",
            "_spawnregions.lua",
            ".config_state",
        ] {
            assert!(
                !production.contains(needle),
                "wipe must not touch game server config ({needle})"
            );
        }
    }

    #[test]
    fn world_wipe_does_not_clear_site_or_store_config() {
        for table in [
            "site_settings",
            "vault_settings",
            "backup_settings",
            "store_items",
            "automations",
            "quests",
            "ui_languages",
            "ui_translations",
            "news_posts",
        ] {
            assert!(
                !WORLD_DATA_TABLES.contains(&table),
                "{table} is site configuration and must survive a default wipe"
            );
        }
    }

    fn schema_tables() -> HashSet<String> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../migrations");
        let mut files: Vec<_> = fs::read_dir(&dir)
            .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
            .map(|entry| entry.expect("dirent").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
            .collect();
        files.sort();

        let mut tables = HashSet::new();
        for path in files {
            let sql = fs::read_to_string(&path).expect("migration");
            for name in idents_after(&sql, "CREATE TABLE ") {
                tables.insert(name);
            }
            for name in idents_after(&sql, "DROP TABLE IF EXISTS ") {
                tables.remove(&name);
            }
            for name in idents_after(&sql, "DROP TABLE ") {
                tables.remove(&name);
            }
        }
        tables
    }

    fn idents_after(sql: &str, needle: &str) -> Vec<String> {
        let mut names = Vec::new();
        let mut rest = sql;
        while let Some(at) = rest.find(needle) {
            let after = rest[at + needle.len()..].trim_start();
            let name: String = after
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                .collect();
            if !name.is_empty() && name != "IF" {
                names.push(name);
            }
            rest = &rest[at + needle.len()..];
        }
        names
    }
}
