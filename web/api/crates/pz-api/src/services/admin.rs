//! Staff-only operations against the game server, its config, and the roster.
//!
//! Offline is still a status, not a 500 — but an action that needs RCON and
//! cannot reach it is a validation failure the operator can act on.

use std::collections::{BTreeMap, BTreeSet};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use pz_bridge::{InventoryReader, ServerIni, UpdateReport};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::error::{ApiError, ApiResult};
use crate::services::backups;
use crate::state::AppState;

const PLAYER_NAME: &str = r"^[A-Za-z0-9_]{1,50}$";
const ACCESS_LEVELS: &[&str] = &["admin", "moderator", "overseer", "gm", "observer", "none"];

const EDITABLE_KEYS: &[&str] = &[
    "PublicName",
    "PublicDescription",
    "ServerWelcomeMessage",
    "MaxPlayers",
    "Password",
    "Open",
    "Public",
    "PVP",
    "PauseEmpty",
    "SaveWorldEveryMinutes",
    "SteamVAC",
    "Map",
    "SpawnPoint",
    "HoursForLootRespawn",
    "HoursForZombiesRespawn",
    "NightLength",
    "DayLength",
    "AutoCreateUserInWhiteList",
];

const SECRET_KEYS: &[&str] = &["Password", "RCONPassword"];

/// Names the game will accept in an RCON command.
pub fn player_name(raw: &str) -> ApiResult<&str> {
    let name = raw.trim();
    if regex_is_match(PLAYER_NAME, name) {
        Ok(name)
    } else {
        Err(ApiError::Validation(
            "Player names can only contain letters, numbers and underscores.".to_owned(),
        ))
    }
}

fn regex_is_match(pattern: &str, value: &str) -> bool {
    // Tiny check, not a full regex crate: the pattern is fixed and tiny.
    if value.is_empty() || value.len() > 50 {
        return false;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        && pattern.contains("A-Za-z")
}

pub fn access_level(raw: &str) -> ApiResult<&str> {
    let level = raw.trim();
    if ACCESS_LEVELS.contains(&level) {
        Ok(level)
    } else {
        Err(ApiError::Validation(
            "Access level must be admin, moderator, overseer, gm, observer or none.".to_owned(),
        ))
    }
}

pub fn sanitise_message(raw: &str) -> String {
    raw.replace(['"', '\n', '\r'], "")
        .chars()
        .take(240)
        .collect()
}

async fn rcon(state: &AppState, command: &str) -> ApiResult<String> {
    pz_rcon::execute(&state.config.rcon, command)
        .await
        .map_err(|error| match error {
            pz_rcon::RconError::AuthFailed
            | pz_rcon::RconError::NoPassword
            | pz_rcon::RconError::Connect { .. }
            | pz_rcon::RconError::Timeout { .. } => {
                ApiError::Validation("The game server is not reachable right now.".to_owned())
            }
            other => ApiError::Internal(other.to_string()),
        })
}

// ── Server control ──────────────────────────────────────────────────

pub async fn start(state: &AppState) -> ApiResult<()> {
    state
        .docker
        .start()
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))
}

pub async fn stop(state: &AppState, message: Option<&str>) -> ApiResult<()> {
    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        let body = sanitise_message(message);
        let _ = rcon(state, &format!("servermsg \"{body}\"")).await;
    }

    state
        .docker
        .stop(8)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))
}

pub async fn restart(state: &AppState, message: Option<&str>) -> ApiResult<()> {
    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        let body = sanitise_message(message);
        let _ = rcon(state, &format!("servermsg \"{body}\"")).await;
    }

    state
        .docker
        .restart(8)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))
}

pub async fn save_world(state: &AppState) -> ApiResult<String> {
    rcon(state, "save").await
}

/// Steam branches the game server entrypoint understands.
pub const STEAM_BRANCHES: &[&str] = &["public", "unstable", "iwillbackupmysave"];

/// Which branch the next boot will install.
pub async fn steam_branch(state: &AppState) -> String {
    tokio::fs::read_to_string(state.config.data_path.join(".steam_branch"))
        .await
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| state.config.steam_branch.clone())
        .unwrap_or_else(|| "public".to_owned())
}

/// What the last boot concluded about the install.
///
/// Written by the game server's own entrypoint check, not by us — so it is
/// still readable when the game container is down or deliberately halted.
pub async fn update_report(state: &AppState) -> UpdateReport {
    UpdateReport::read(state.config.data_path.join(".update_status")).await
}

/// Reinstall the game from Steam and bring the server back up.
///
/// The update itself is done by the game server's own entrypoint, not here: it
/// looks for a `.force_update` flag in the shared data directory on boot, wipes
/// the install and re-runs SteamCMD. So this writes the flag, takes the
/// container down cleanly and starts it again — the same sequence the PHP
/// stack's `UpdateGameServer` job used, minus the queue.
///
/// A pre-update backup is taken first and a failure to take one does not stop
/// the update, because a server that cannot be updated is the worse outcome —
/// but it is logged loudly, since that is the backup you would want.
pub async fn update_game(
    state: &AppState,
    branch: Option<&str>,
    message: Option<&str>,
) -> ApiResult<()> {
    if let Some(branch) = branch
        && !STEAM_BRANCHES.contains(&branch)
    {
        return Err(ApiError::Validation(format!(
            "Unknown branch. Pick one of: {}.",
            STEAM_BRANCHES.join(", ")
        )));
    }

    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        let body = sanitise_message(message);
        let _ = rcon(state, &format!("servermsg \"{body}\"")).await;
    }

    match backups::create_now(state, "pre_update", Some("Automatic pre-update backup")).await {
        Ok(_) => {}
        Err(error) => {
            tracing::error!(%error, "pre-update backup failed — updating anyway");
        }
    }

    if let Some(branch) = branch {
        let path = state.config.data_path.join(".steam_branch");

        tokio::fs::write(&path, branch)
            .await
            .map_err(|error| ApiError::Internal(format!("could not set the branch: {error}")))?;
    }

    // Written last of the preparation steps: everything above can fail without
    // consequence, but once this exists the next boot wipes the install.
    let flag = state.config.data_path.join(".force_update");
    tokio::fs::write(&flag, chrono::Utc::now().timestamp().to_string())
        .await
        .map_err(|error| ApiError::Internal(format!("could not request the update: {error}")))?;

    // Best effort: a server that is already down still needs updating, and the
    // container stop below is what actually guarantees a clean shutdown.
    let _ = rcon(state, "save").await;
    let _ = rcon(state, "quit").await;

    if let Err(error) = state.docker.stop(30).await {
        // The flag is on disk, so an operator restarting by hand still gets the
        // update. Leaving it there is deliberate.
        return Err(ApiError::Internal(format!(
            "the update is queued but the server could not be stopped: {error}"
        )));
    }

    state
        .docker
        .start()
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    tracing::warn!(branch, "game server update started");

    Ok(())
}

pub async fn broadcast(state: &AppState, message: &str) -> ApiResult<String> {
    let body = sanitise_message(message);
    if body.is_empty() {
        return Err(ApiError::Validation("Write a message first.".to_owned()));
    }
    rcon(state, &format!("servermsg \"{body}\"")).await
}

pub async fn console(state: &AppState, command: &str) -> ApiResult<String> {
    let command = command.trim();
    if command.is_empty() {
        return Err(ApiError::Validation("Type a command first.".to_owned()));
    }
    if command.len() > 500 {
        return Err(ApiError::Validation("That command is too long.".to_owned()));
    }
    rcon(state, command).await
}

// ── Players ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AdminPlayer {
    pub username: String,
    pub online: bool,
    pub is_dead: bool,
    pub zombie_kills: i32,
    pub hours_survived: f64,
    pub profession: Option<String>,
    /// Overall body health 0–100, when the mod has written vitals.
    pub health: Option<f64>,
    /// Hair, skin and hat as the mod last reported them.
    pub appearance: Option<serde_json::Value>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub z: Option<i32>,
    /// Open panel sanction, if we issued one.
    pub sanction: Option<PlayerSanction>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerSanction {
    pub kind: &'static str,
    pub expires_at: Option<DateTime<Utc>>,
    pub reason: Option<String>,
}

#[derive(FromRow)]
struct StatsRow {
    username: String,
    zombie_kills: i32,
    hours_survived: f64,
    profession: Option<String>,
    is_dead: bool,
    health: Option<f64>,
    appearance: Option<serde_json::Value>,
    last_synced_at: DateTime<Utc>,
    x: Option<f64>,
    y: Option<f64>,
    z: Option<i32>,
}

pub async fn list_players(state: &AppState) -> ApiResult<Vec<AdminPlayer>> {
    let rows = sqlx::query_as::<_, StatsRow>(
        r#"
        SELECT username, zombie_kills,
               hours_survived::double precision AS hours_survived,
               profession, is_dead,
               (vitals ->> 'health')::double precision AS health,
               appearance,
               last_synced_at,
               x, y, z
        FROM player_stats
        ORDER BY username
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    let marks = crate::services::sanctions::active_marks(&state.db)
        .await
        .unwrap_or_default();
    let marks: BTreeMap<String, crate::services::sanctions::ActiveMark> = marks
        .into_iter()
        .map(|mark| (mark.username.to_ascii_lowercase(), mark))
        .collect();

    let live = state.bridge.players_live().await.ok().flatten();
    let live_players = live
        .as_ref()
        .map(|read| read.data.players.as_slice())
        .unwrap_or(&[]);

    let online: BTreeSet<String> = live_players
        .iter()
        .map(|player| player.username.clone())
        .chain(state.status.current().await.players.into_iter())
        .collect();

    let mut by_name: BTreeMap<String, AdminPlayer> = BTreeMap::new();

    for row in rows {
        let key = row.username.to_ascii_lowercase();
        by_name.insert(
            row.username.clone(),
            AdminPlayer {
                online: online.contains(&row.username),
                username: row.username,
                is_dead: row.is_dead,
                zombie_kills: row.zombie_kills,
                hours_survived: row.hours_survived,
                profession: row.profession,
                health: row.health,
                appearance: row.appearance,
                last_seen_at: Some(row.last_synced_at),
                x: row.x,
                y: row.y,
                z: row.z,
                sanction: marks.get(&key).map(|mark| PlayerSanction {
                    kind: if mark.expires_at.is_some() {
                        "suspend"
                    } else {
                        "ban"
                    },
                    expires_at: mark.expires_at,
                    reason: mark.reason.clone(),
                }),
            },
        );
    }

    for player in live_players {
        let entry = by_name
            .entry(player.username.clone())
            .or_insert_with(|| AdminPlayer {
                username: player.username.clone(),
                online: true,
                is_dead: player.is_dead,
                zombie_kills: 0,
                hours_survived: 0.0,
                profession: None,
                health: None,
                appearance: None,
                last_seen_at: None,
                x: None,
                y: None,
                z: None,
                sanction: None,
            });
        entry.online = true;
        entry.is_dead = player.is_dead;
        entry.x = Some(player.x);
        entry.y = Some(player.y);
        entry.z = Some(player.z);
        if player.appearance.is_some() {
            entry.appearance = player.appearance.clone();
        }
        if entry.sanction.is_none() {
            entry.sanction = marks
                .get(&player.username.to_ascii_lowercase())
                .map(|mark| PlayerSanction {
                    kind: if mark.expires_at.is_some() {
                        "suspend"
                    } else {
                        "ban"
                    },
                    expires_at: mark.expires_at,
                    reason: mark.reason.clone(),
                });
        }
    }

    Ok(by_name.into_values().collect())
}

// ── Events ──────────────────────────────────────────────────────────

const EVENT_TYPES: &[&str] = &["death", "pvp_kill"];
const EVENTS_LIMIT_MAX: i64 = 200;

/// One row on the moderation log — a death or a PvP kill.
///
/// Connects, disconnects and hits are not here: the bridge never writes them.
/// A death credited to another player also produces a `pvp_kill` for the
/// killer, so the same square can appear twice when both types are shown.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AdminEvent {
    pub id: i64,
    pub event_type: String,
    pub player: String,
    /// Killer on a death, victim on a PvP kill.
    pub target: Option<String>,
    /// Who an operator would usually act on: the killer if there is one.
    pub subject: String,
    pub cause: Option<String>,
    pub weapon: Option<String>,
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub z: Option<i32>,
    pub world_time: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct EventTotals {
    pub deaths: i64,
    pub pvp_kills: i64,
    pub last_24h: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventLog {
    pub events: Vec<AdminEvent>,
    pub totals: EventTotals,
}

pub struct EventFilter {
    pub types: Vec<String>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub limit: i64,
}

pub async fn list_events(state: &AppState, filter: EventFilter) -> ApiResult<EventLog> {
    let types: Vec<String> = if filter.types.is_empty() {
        EVENT_TYPES.iter().map(|kind| (*kind).to_owned()).collect()
    } else {
        filter
            .types
            .into_iter()
            .filter(|kind| EVENT_TYPES.contains(&kind.as_str()))
            .collect()
    };

    if types.is_empty() {
        return Err(ApiError::Validation(
            "Choose death, pvp_kill, or both.".to_owned(),
        ));
    }

    let limit = filter.limit.clamp(1, EVENTS_LIMIT_MAX);

    let events = sqlx::query_as::<_, AdminEvent>(
        r#"
        SELECT
            id,
            event_type,
            player,
            CASE
                WHEN event_type = 'pvp_kill' THEN detail ->> 'victim'
                ELSE detail ->> 'killer'
            END AS target,
            coalesce(
                CASE
                    WHEN event_type = 'pvp_kill' THEN player
                    WHEN coalesce(detail ->> 'killer', '') <> '' THEN detail ->> 'killer'
                    ELSE player
                END,
                player
            ) AS subject,
            detail ->> 'cause' AS cause,
            detail ->> 'weapon' AS weapon,
            x, y, z,
            detail ->> 'world_time' AS world_time,
            occurred_at
        FROM game_events
        WHERE player IS NOT NULL
          AND event_type = ANY($1)
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at < $3)
        ORDER BY occurred_at DESC
        LIMIT $4
        "#,
    )
    .bind(&types)
    .bind(filter.from)
    .bind(filter.to)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let totals = sqlx::query_as::<_, EventTotals>(
        r#"
        SELECT
            count(*) FILTER (WHERE event_type = 'death')::bigint AS deaths,
            count(*) FILTER (WHERE event_type = 'pvp_kill')::bigint AS pvp_kills,
            count(*) FILTER (WHERE occurred_at > now() - interval '24 hours')::bigint AS last_24h
        FROM game_events
        WHERE player IS NOT NULL
        "#,
    )
    .fetch_one(&state.db)
    .await?;

    Ok(EventLog { events, totals })
}

pub async fn kick(state: &AppState, username: &str, reason: Option<&str>) -> ApiResult<String> {
    let name = player_name(username)?;
    let command = match reason.map(str::trim).filter(|value| !value.is_empty()) {
        Some(reason) => {
            let reason = sanitise_message(reason);
            format!("kickuser \"{name}\" -r \"{reason}\"")
        }
        None => format!("kickuser \"{name}\""),
    };
    rcon(state, &command).await
}

pub async fn ban(state: &AppState, username: &str) -> ApiResult<String> {
    let name = player_name(username)?;
    rcon(state, &format!("banuser \"{name}\"")).await
}

pub async fn unban(state: &AppState, username: &str) -> ApiResult<String> {
    let name = player_name(username)?;
    rcon(state, &format!("unbanuser \"{name}\"")).await
}

pub async fn set_access(state: &AppState, username: &str, level: &str) -> ApiResult<String> {
    let name = player_name(username)?;
    let level = access_level(level)?;
    rcon(state, &format!("setaccesslevel \"{name}\" \"{level}\"")).await
}

pub async fn teleport(
    state: &AppState,
    username: &str,
    x: f64,
    y: f64,
    z: i32,
) -> ApiResult<String> {
    let name = player_name(username)?;
    if !(0.0..=30_000.0).contains(&x) || !(0.0..=30_000.0).contains(&y) || !(-1..=8).contains(&z) {
        return Err(ApiError::Validation(
            "Those coordinates are off the map.".to_owned(),
        ));
    }
    rcon(
        state,
        &format!(
            "teleport \"{name}\" {},{},{z}",
            x.round() as i64,
            y.round() as i64
        ),
    )
    .await
}

pub async fn add_to_whitelist(state: &AppState, username: &str) -> ApiResult<String> {
    let name = player_name(username)?;
    rcon(state, &format!("addusertowhitelist \"{name}\"")).await
}

pub async fn remove_from_whitelist(state: &AppState, username: &str) -> ApiResult<String> {
    let name = player_name(username)?;
    rcon(state, &format!("removeuserfromwhitelist \"{name}\"")).await
}

/// Names currently on the game's whitelist.
pub fn whitelist_names(state: &AppState) -> Vec<String> {
    state
        .config
        .whitelist_db_path()
        .map(|path| {
            pz_bridge::whitelist::list(&path)
                .into_iter()
                .map(|row| row.username)
                .collect()
        })
        .unwrap_or_default()
}

/// Add the name if it is absent, remove it if it is present.
///
/// PZ has no "on the list but disabled" state — the whitelist is the list — so
/// a toggle is genuinely an add or a remove rather than a flag.
pub async fn toggle_whitelist(state: &AppState, username: &str) -> ApiResult<bool> {
    let name = player_name(username)?;

    let present = whitelist_names(state)
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(name));

    if present {
        remove_from_whitelist(state, name).await?;
    } else {
        add_to_whitelist(state, name).await?;
    }

    Ok(!present)
}

#[derive(Debug, Serialize)]
pub struct WhitelistSync {
    pub added: Vec<String>,
    /// Website accounts that could not be added, with the reason.
    pub failed: Vec<String>,
    /// On the game whitelist but with no website account. Reported rather than
    /// removed: these are usually staff or people who joined before the site
    /// existed, and deleting their access on a reconcile would be a nasty
    /// surprise.
    pub unmatched: Vec<String>,
}

/// Put every website account on the game whitelist.
///
/// Goes through RCON rather than writing the SQLite file, so the running server
/// picks the change up at once — the game keeps the whitelist in memory and
/// would not notice a file edited underneath it. That does mean the server has
/// to be up, which is why an offline server is rejected with a clear message
/// rather than reported as a sync that added nothing.
pub async fn sync_whitelist(state: &AppState) -> ApiResult<WhitelistSync> {
    if !state.status.current().await.online {
        return Err(ApiError::Validation(
            "The game server has to be running to change the whitelist.".to_owned(),
        ));
    }

    let existing = whitelist_names(state);
    let known = |name: &str| existing.iter().any(|row| row.eq_ignore_ascii_case(name));

    let accounts = sqlx::query_scalar::<_, String>("SELECT username FROM users ORDER BY username")
        .fetch_all(&state.db)
        .await?;

    let mut sync = WhitelistSync {
        added: Vec::new(),
        failed: Vec::new(),
        unmatched: existing
            .iter()
            .filter(|name| {
                !accounts
                    .iter()
                    .any(|account| account.eq_ignore_ascii_case(name))
            })
            .cloned()
            .collect(),
    };

    for account in accounts {
        if known(&account) {
            continue;
        }

        match add_to_whitelist(state, &account).await {
            Ok(_) => sync.added.push(account),
            Err(error) => sync.failed.push(format!("{account}: {error}")),
        }
    }

    tracing::info!(
        added = sync.added.len(),
        failed = sync.failed.len(),
        unmatched = sync.unmatched.len(),
        "whitelist synced",
    );

    Ok(sync)
}

/// Set the password a player uses to join the game.
///
/// This is the game whitelist password, not the website one — the two are
/// separate, and changing this does not touch how they sign in here.
pub async fn set_game_password(
    state: &AppState,
    username: &str,
    password: &str,
) -> ApiResult<String> {
    let name = player_name(username)?;

    // The command is built by string interpolation, so a quote in the password
    // would end the argument early and hand the rest to RCON as commands.
    if password.len() < 6 || password.len() > 64 {
        return Err(ApiError::Validation(
            "Password must be between 6 and 64 characters.".to_owned(),
        ));
    }

    if password.contains(['"', '\\', '\n', '\r']) {
        return Err(ApiError::Validation(
            "Password cannot contain quotes or backslashes.".to_owned(),
        ));
    }

    rcon(state, &format!("changepwd \"{name}\" \"{password}\"")).await
}

// ── Config / mods ───────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ConfigField {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

#[derive(Debug, Serialize)]
pub struct ServerConfig {
    pub fields: Vec<ConfigField>,
    /// True when the file has never been written (server has not booted).
    pub missing: bool,
}

pub async fn read_config(state: &AppState) -> ApiResult<ServerConfig> {
    let ini = ServerIni::read(&state.config.server_ini_path)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    let Some(ini) = ini else {
        return Ok(ServerConfig {
            fields: Vec::new(),
            missing: true,
        });
    };

    let mut fields: Vec<ConfigField> = EDITABLE_KEYS
        .iter()
        .filter_map(|key| {
            ini.get(key).map(|value| ConfigField {
                key: (*key).to_owned(),
                value: if SECRET_KEYS.contains(key) && !value.is_empty() {
                    String::new()
                } else {
                    value.to_owned()
                },
                secret: SECRET_KEYS.contains(key),
            })
        })
        .collect();

    // Keys we know about first, then the rest so an operator can still find
    // something the curated list omitted.
    let known: BTreeSet<&str> = EDITABLE_KEYS.iter().copied().collect();
    for (key, value) in ini.keys() {
        if known.contains(key) || SECRET_KEYS.contains(&key) {
            continue;
        }
        fields.push(ConfigField {
            key: key.to_owned(),
            value: value.to_owned(),
            secret: false,
        });
    }

    Ok(ServerConfig {
        fields,
        missing: false,
    })
}

pub async fn write_config(state: &AppState, updates: BTreeMap<String, String>) -> ApiResult<()> {
    if updates.is_empty() {
        return Ok(());
    }

    for key in updates.keys() {
        if key == "RCONPassword" || key.contains("Password") && key != "Password" {
            return Err(ApiError::Validation(
                "That setting cannot be changed from here.".to_owned(),
            ));
        }
        if key.is_empty() || key.contains('=') || key.contains('\n') {
            return Err(ApiError::Validation("Invalid setting name.".to_owned()));
        }
    }

    ServerIni::write_updates(&state.config.server_ini_path, &updates)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModEntry {
    pub workshop_id: String,
    pub mod_id: String,
    #[serde(default)]
    pub protected: bool,
}

pub async fn list_mods(state: &AppState) -> ApiResult<Vec<ModEntry>> {
    let ini = ServerIni::read(&state.config.server_ini_path)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .unwrap_or_default();

    let workshop = ini.get_list("WorkshopItems");
    let mods = ini.get_list("Mods");
    let len = workshop.len().max(mods.len());

    Ok((0..len)
        .map(|index| {
            let workshop_id = workshop.get(index).cloned().unwrap_or_default();
            let mod_id = mods.get(index).cloned().unwrap_or_default();
            let protected = is_protected(state, &workshop_id, &mod_id);
            ModEntry {
                workshop_id,
                mod_id,
                protected,
            }
        })
        .collect())
}

fn is_protected(state: &AppState, workshop_id: &str, mod_id: &str) -> bool {
    state
        .config
        .bridge_workshop_id
        .as_deref()
        .is_some_and(|id| id == workshop_id)
        || (!mod_id.is_empty() && mod_id == state.config.bridge_mod_id)
}

fn valid_mod_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

pub async fn add_mod(
    state: &AppState,
    workshop_id: &str,
    mod_id: &str,
    map_folder: Option<&str>,
) -> ApiResult<Vec<ModEntry>> {
    let workshop_id = pz_bridge::parse_workshop_id(workshop_id).ok_or_else(|| {
        ApiError::Validation("Paste a Workshop id, or a Steam Workshop URL.".to_owned())
    })?;
    let mod_id = mod_id.trim();

    if !valid_mod_id(mod_id) {
        return Err(ApiError::Validation(
            "That is not a valid mod id.".to_owned(),
        ));
    }

    let current = list_mods(state).await?;
    if current.iter().any(|entry| entry.workshop_id == workshop_id) {
        return Err(ApiError::Validation(
            "That Workshop item is already loaded.".to_owned(),
        ));
    }
    if current.iter().any(|entry| entry.mod_id == mod_id) {
        return Err(ApiError::Validation(
            "That mod id is already on the list.".to_owned(),
        ));
    }

    let mut workshop: Vec<String> = current
        .iter()
        .map(|entry| entry.workshop_id.clone())
        .collect();
    let mut mods: Vec<String> = current.iter().map(|entry| entry.mod_id.clone()).collect();
    workshop.push(workshop_id);
    mods.push(mod_id.to_owned());

    write_mod_lists(state, &workshop, &mods).await?;
    if let Some(folder) = map_folder.map(str::trim).filter(|value| !value.is_empty()) {
        append_map_folder(state, folder).await?;
    }
    list_mods(state).await
}

pub async fn remove_mod(state: &AppState, workshop_id: &str) -> ApiResult<Vec<ModEntry>> {
    let current = list_mods(state).await?;
    let Some(index) = current.iter().position(|entry| {
        (!workshop_id.is_empty() && entry.workshop_id == workshop_id)
            || (workshop_id.is_empty() && entry.mod_id == workshop_id)
    }) else {
        return Err(ApiError::Validation(
            "That mod is not on the list.".to_owned(),
        ));
    };
    if current[index].protected {
        return Err(ApiError::Validation(
            "Knox Relay cannot be removed — the rest of this stack reads it.".to_owned(),
        ));
    }

    let mut workshop: Vec<String> = current
        .iter()
        .map(|entry| entry.workshop_id.clone())
        .collect();
    let mut mods: Vec<String> = current.iter().map(|entry| entry.mod_id.clone()).collect();
    if index < workshop.len() {
        workshop.remove(index);
    }
    if index < mods.len() {
        mods.remove(index);
    }

    write_mod_lists(state, &workshop, &mods).await?;
    list_mods(state).await
}

pub async fn reorder_mods(state: &AppState, entries: &[ModEntry]) -> ApiResult<Vec<ModEntry>> {
    if entries.is_empty() {
        return Err(ApiError::Validation(
            "The load list cannot be empty.".to_owned(),
        ));
    }

    let current = list_mods(state).await?;
    let current_keys: BTreeSet<(String, String)> = current
        .iter()
        .map(|entry| (entry.workshop_id.clone(), entry.mod_id.clone()))
        .collect();
    let next_keys: BTreeSet<(String, String)> = entries
        .iter()
        .map(|entry| (entry.workshop_id.clone(), entry.mod_id.clone()))
        .collect();

    if current_keys != next_keys {
        return Err(ApiError::Validation(
            "Reorder the existing list — do not add or drop entries here.".to_owned(),
        ));
    }

    let workshop: Vec<String> = entries
        .iter()
        .map(|entry| entry.workshop_id.clone())
        .collect();
    let mods: Vec<String> = entries.iter().map(|entry| entry.mod_id.clone()).collect();
    write_mod_lists(state, &workshop, &mods).await?;
    list_mods(state).await
}

pub async fn import_mods(
    state: &AppState,
    workshop_ids: &[String],
    mod_ids: &[String],
    map_folders: &[String],
) -> ApiResult<Vec<ModEntry>> {
    let current = list_mods(state).await?;
    let mut workshop: Vec<String> = current
        .iter()
        .map(|entry| entry.workshop_id.clone())
        .collect();
    let mut mods: Vec<String> = current.iter().map(|entry| entry.mod_id.clone()).collect();

    for raw in workshop_ids {
        let Some(id) = pz_bridge::parse_workshop_id(raw) else {
            continue;
        };
        if !workshop.iter().any(|existing| existing == &id) {
            workshop.push(id);
        }
    }

    for raw in mod_ids {
        let id = raw.trim();
        if valid_mod_id(id) && !mods.iter().any(|existing| existing == id) {
            mods.push(id.to_owned());
        }
    }

    write_mod_lists(state, &workshop, &mods).await?;
    for folder in map_folders {
        if !folder.trim().is_empty() {
            append_map_folder(state, folder.trim()).await?;
        }
    }
    list_mods(state).await
}

async fn append_map_folder(state: &AppState, folder: &str) -> ApiResult<()> {
    if !valid_mod_id(folder) && folder != "Muldraugh, KY" {
        return Ok(());
    }

    let ini = ServerIni::read(&state.config.server_ini_path)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .unwrap_or_default();
    let mut maps = ini.get_list("Map");
    if maps.iter().any(|existing| existing == folder) {
        return Ok(());
    }
    maps.push(folder.to_owned());
    let mut updates = BTreeMap::new();
    updates.insert("Map".to_owned(), maps.join(";"));
    write_config(state, updates).await
}

async fn write_mod_lists(state: &AppState, workshop: &[String], mods: &[String]) -> ApiResult<()> {
    let mut updates = BTreeMap::new();
    updates.insert("WorkshopItems".to_owned(), workshop.join(";"));
    updates.insert("Mods".to_owned(), mods.join(";"));
    write_config(state, updates).await
}

// ── Bridge / logs / inventory ───────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct BridgeFile {
    pub name: String,
    pub present: bool,
    /// True only when this file is *supposed* to be rewriting and is not.
    pub stale: bool,
    /// `fresh` | `idle` | `stale` | `absent`
    pub status: &'static str,
    /// i18n key for why it looks like this.
    pub reason: &'static str,
    pub modified_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct BridgeHealth {
    pub files: Vec<BridgeFile>,
    pub directory: String,
    pub world_paused: bool,
    pub world_fresh: bool,
}

/// How a watched file is supposed to behave.
enum FileKind {
    /// Rewritten on a timer while the world clock is running.
    Heartbeat,
    /// Rewritten even while the server is paused and empty.
    World,
    /// Created the first time the event happens. Old or missing is normal.
    OnEvent,
}

pub async fn bridge_health(state: &AppState) -> ApiResult<BridgeHealth> {
    let watched = [
        ("game_state.json", FileKind::World),
        ("players_live.json", FileKind::Heartbeat),
        ("player_stats.json", FileKind::Heartbeat),
        ("deaths.json", FileKind::OnEvent),
        ("account_links.json", FileKind::OnEvent),
        ("report_requests.json", FileKind::OnEvent),
    ];

    let world_mtime = state.bridge.modified_at("game_state.json").await;
    let world_fresh = world_mtime.is_some_and(|at| {
        at.elapsed()
            .ok()
            .is_none_or(|age| age <= state.config.bridge_stale_after)
    });
    let world_paused = read_world_paused(state).await;

    let mut files = Vec::new();
    for (name, kind) in watched {
        let modified = state.bridge.modified_at(name).await;
        let present = modified.is_some();
        let old = match modified {
            Some(at) => at
                .elapsed()
                .ok()
                .is_none_or(|age| age > state.config.bridge_stale_after),
            None => true,
        };

        let (status, reason, stale) =
            classify_bridge_file(kind, present, old, world_paused, world_fresh);

        files.push(BridgeFile {
            name: name.to_owned(),
            present,
            stale,
            status,
            reason,
            modified_at: modified.and_then(system_time_to_utc),
        });
    }

    Ok(BridgeHealth {
        files,
        directory: state.config.lua_bridge_path.display().to_string(),
        world_paused,
        world_fresh,
    })
}

fn classify_bridge_file(
    kind: FileKind,
    present: bool,
    old: bool,
    world_paused: bool,
    world_fresh: bool,
) -> (&'static str, &'static str, bool) {
    match kind {
        FileKind::World => {
            if present && !old {
                ("fresh", "admin.bridge_reason_world_live", false)
            } else if present {
                ("stale", "admin.bridge_reason_world_stale", true)
            } else {
                ("absent", "admin.bridge_reason_world_absent", true)
            }
        }
        FileKind::Heartbeat => {
            if present && !old {
                ("fresh", "admin.bridge_reason_live", false)
            } else if world_paused && world_fresh {
                ("idle", "admin.bridge_reason_paused", false)
            } else if present {
                ("stale", "admin.bridge_reason_heartbeat_stale", true)
            } else {
                ("absent", "admin.bridge_reason_heartbeat_absent", true)
            }
        }
        FileKind::OnEvent => {
            if present {
                ("idle", "admin.bridge_reason_event_ready", false)
            } else {
                ("idle", "admin.bridge_reason_event_waiting", false)
            }
        }
    }
}

async fn read_world_paused(state: &AppState) -> bool {
    let path = state.bridge.path("game_state.json");
    let Ok(body) = tokio::fs::read_to_string(path).await else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|json| json.get("paused")?.as_bool())
        .unwrap_or(false)
}

fn system_time_to_utc(at: SystemTime) -> Option<DateTime<Utc>> {
    DateTime::<Utc>::from_timestamp(
        at.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs() as i64,
        0,
    )
}

#[derive(Debug, Serialize)]
pub struct ContainerLogs {
    pub container: String,
    pub lines: Vec<String>,
}

pub async fn container_logs(state: &AppState, tail: u32) -> ApiResult<ContainerLogs> {
    let tail = tail.clamp(50, 2000);
    let lines = state
        .docker
        .logs(tail)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    Ok(ContainerLogs {
        container: state.config.game_server_container.clone(),
        lines,
    })
}

pub async fn player_inventory(
    state: &AppState,
    username: &str,
) -> ApiResult<Option<pz_bridge::InventorySnapshot>> {
    let name = player_name(username)?;
    let reader = InventoryReader::new(&state.config.lua_bridge_path);
    match reader.read(name).await {
        Ok(Some(file)) => Ok(Some(file.data)),
        Ok(None) => Ok(None),
        Err(error) => Err(ApiError::Internal(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_names_reject_quotes() {
        assert!(player_name("alice").is_ok());
        assert!(player_name("bad name").is_err());
        assert!(player_name("x\";quit").is_err());
    }

    #[test]
    fn messages_lose_quotes_and_newlines() {
        assert_eq!(sanitise_message("hello \"world\"\n"), "hello world");
    }
}
