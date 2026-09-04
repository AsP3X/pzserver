//! Background loops: folding the mod's exports into Postgres, answering
//! in-game registrations, sampling population, and housekeeping.

use std::collections::{HashMap, HashSet};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use pz_bridge::lua::{DEATHS_FILE, Death, LivePlayer, PLAYER_STATS_FILE, StatsPlayer};
use sqlx::PgPool;
use tokio::task::JoinHandle;

use crate::services::auth::{self, JoinEnsure};
use crate::services::registration::{self, OpenOutcome};
use crate::state::AppState;

/// How long sampled population history is kept.
const SAMPLE_RETENTION_DAYS: i32 = 30;

/// Expired sessions are dead the moment they expire; sweeping them hourly is
/// plenty.
const SESSION_CLEANUP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);

/// How often we check whether a timed ban should come off.
const SANCTION_EXPIRY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// A player standing at the keyboard is waiting for this, so it runs often.
const REGISTRATION_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Start every background loop. Handles are returned so `main` can abort them
/// on shutdown.
pub fn spawn_all(state: AppState) -> Vec<JoinHandle<()>> {
    vec![
        tokio::spawn(stats_sync_loop(state.clone())),
        tokio::spawn(deaths_sync_loop(state.clone())),
        tokio::spawn(status_sample_loop(state.clone())),
        tokio::spawn(account_provision_loop(state.clone())),
        tokio::spawn(account_registration_loop(state.clone())),
        tokio::spawn(ingame_report_loop(state.clone())),
        tokio::spawn(ticket_desk_loop(state.clone())),
        tokio::spawn(friends_desk_loop(state.clone())),
        tokio::spawn(session_cleanup_loop(state.clone())),
        tokio::spawn(sanction_expiry_loop(state.clone())),
        tokio::spawn(backup_schedule_loop(state.clone())),
        tokio::spawn(map_tile_progress_loop(state.clone())),
        tokio::spawn(automation_loop(state.clone())),
        tokio::spawn(economy_loop(state.clone())),
        tokio::spawn(respawn_loop(state.clone())),
        tokio::spawn(safezone_loop(state.clone())),
        tokio::spawn(sprite_live_loop(state)),
    ]
}

const SPRITE_LIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

async fn sprite_live_loop(state: AppState) {
    let mut ticker = tokio::time::interval(SPRITE_LIVE_INTERVAL);
    loop {
        ticker.tick().await;
        crate::services::sprite_live::refresh_if_stale(&state).await;
    }
}

async fn map_tile_progress_loop(state: AppState) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        ticker.tick().await;
        crate::services::map_tile_jobs::tick_dry_run(&state).await;
    }
}

const SAFEZONE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

async fn safezone_loop(state: AppState) {
    let mut ticker = tokio::time::interval(SAFEZONE_INTERVAL);
    loop {
        ticker.tick().await;
        crate::services::safezones::import(&state).await;
    }
}

/// Faster than the mod's own 2.5-second sweep would strictly need, because the
/// window between a player respawning and being bounced is time they spend
/// walking around a world they are supposed to be locked out of.
const RESPAWN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

async fn respawn_loop(state: AppState) {
    let mut ticker = tokio::time::interval(RESPAWN_INTERVAL);
    loop {
        ticker.tick().await;
        crate::services::respawn::tick(&state).await;
    }
}

const ECONOMY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

async fn economy_loop(state: AppState) {
    let mut ticker = tokio::time::interval(ECONOMY_INTERVAL);
    loop {
        ticker.tick().await;
        crate::services::economy::delivery::tick(&state).await;
        crate::services::economy::deposit::tick(&state).await;
        crate::services::economy::auction::tick(&state).await;
        crate::services::economy::offers::tick(&state).await;
    }
}

const BACKUP_SCHEDULE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

async fn backup_schedule_loop(state: AppState) {
    let mut ticker = tokio::time::interval(BACKUP_SCHEDULE_INTERVAL);
    loop {
        ticker.tick().await;
        crate::services::backups::tick_schedule(&state).await;
    }
}

const AUTOMATION_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

async fn automation_loop(state: AppState) {
    let mut ticker = tokio::time::interval(AUTOMATION_INTERVAL);
    loop {
        ticker.tick().await;
        crate::services::automations::tick(&state).await;
    }
}

/// Upsert the mod's `player_stats.json` into Postgres whenever it changes.
///
/// The export is rewritten on the mod's ten-in-game-minute hook — roughly every
/// 25 real seconds on a running world, and never on a paused one. Gating on the
/// file's mtime keeps a tick with nothing new to read down to a single `stat()`
/// instead of one upsert per player online.
async fn stats_sync_loop(state: AppState) {
    let mut ticker = tokio::time::interval(state.config.stats_sync_interval);
    let bridge = pz_bridge::LuaBridge::new(&state.config.lua_bridge_path);

    // Process-local, deliberately: after a restart one redundant sync is
    // cheaper than another table to persist this in.
    let mut last_synced: Option<SystemTime> = None;

    loop {
        ticker.tick().await;

        // Last-known map pin. The live file is the only export that carries
        // coordinates, and it goes empty the moment nobody is in getOnlinePlayers()
        // — which on a dedicated server is not the same thing as nobody playing.
        match bridge.players_live().await {
            Ok(Some(read)) => {
                if let Err(error) = sync_positions(&state.db, &read.data.players).await {
                    tracing::warn!(%error, "failed to persist live positions");
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "live position export unreadable"),
        }

        let modified_at = bridge.modified_at(PLAYER_STATS_FILE).await;

        if modified_at.is_none() || modified_at == last_synced {
            continue;
        }

        let export = match bridge.player_stats().await {
            Ok(Some(read)) => read.data,
            // Nothing written yet, or a zero-byte placeholder.
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(%error, "stats export unreadable");
                continue;
            }
        };

        match sync_players(&state.db, &export.players).await {
            Ok(count) => {
                // Only a read that actually landed advances the marker, so a
                // failed write is retried on the next tick.
                last_synced = modified_at;

                if count > 0 {
                    tracing::info!(players = count, "synced player stats from the Lua bridge");
                }
            }
            Err(error) => tracing::error!(%error, "failed to sync player stats"),
        }
    }
}

async fn sync_players(db: &PgPool, players: &[StatsPlayer]) -> Result<u64, sqlx::Error> {
    let mut synced = 0;

    for player in players {
        // The mod falls back to "unknown" when a descriptor has no username;
        // such a row would collide with every other nameless character.
        if player.username.is_empty() || player.username == "unknown" {
            continue;
        }

        sqlx::query(
            r#"
            INSERT INTO player_stats (
                username, zombie_kills, hours_survived, profession,
                skills, traits, vitals, appearance, is_dead, last_synced_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
            ON CONFLICT (username) DO UPDATE SET
                zombie_kills   = EXCLUDED.zombie_kills,
                hours_survived = EXCLUDED.hours_survived,
                profession     = EXCLUDED.profession,
                skills         = EXCLUDED.skills,
                -- Older KnoxRelay builds omit these. Keep what we already
                -- know rather than overwriting it with nothing.
                traits         = COALESCE(EXCLUDED.traits, player_stats.traits),
                vitals         = COALESCE(EXCLUDED.vitals, player_stats.vitals),
                appearance     = COALESCE(EXCLUDED.appearance, player_stats.appearance),
                is_dead        = EXCLUDED.is_dead,
                last_synced_at = now()
            "#,
        )
        .bind(&player.username)
        .bind(player.zombie_kills)
        .bind(player.hours_survived)
        .bind(player.profession.as_deref())
        .bind(serde_json::to_value(&player.skills).unwrap_or_default())
        .bind(player.traits.clone())
        .bind(player.vitals.clone())
        .bind(player.appearance.clone())
        .bind(player.is_dead)
        .execute(db)
        .await?;

        synced += 1;
    }

    Ok(synced)
}

/// Remember the last tile each online player was standing on.
async fn sync_positions(db: &PgPool, players: &[LivePlayer]) -> Result<(), sqlx::Error> {
    for player in players {
        if player.username.is_empty() || player.username == "unknown" {
            continue;
        }

        let updated = sqlx::query(
            r#"
            UPDATE player_stats
               SET x = $2, y = $3, z = $4
             WHERE lower(username) = lower($1)
            "#,
        )
        .bind(&player.username)
        .bind(player.x)
        .bind(player.y)
        .bind(player.z)
        .execute(db)
        .await?;

        if updated.rows_affected() == 0 {
            sqlx::query(
                r#"
                INSERT INTO player_stats (username, x, y, z, last_synced_at)
                VALUES ($1, $2, $3, $4, now())
                ON CONFLICT (username) DO UPDATE SET
                    x = EXCLUDED.x,
                    y = EXCLUDED.y,
                    z = EXCLUDED.z
                "#,
            )
            .bind(&player.username)
            .bind(player.x)
            .bind(player.y)
            .bind(player.z)
            .execute(db)
            .await?;
        }
    }

    Ok(())
}

/// Create a website row for anyone who has joined, without waiting for
/// `/account register`.
///
/// The dedicated server does not fire a reliable join event, so this watches
/// three places the name does show up: the game whitelist (written as they
/// authenticate), the live roster export, and RCON's player list.
async fn account_provision_loop(state: AppState) {
    let mut ticker = tokio::time::interval(REGISTRATION_INTERVAL);

    loop {
        ticker.tick().await;
        provision_joined_accounts(&state).await;
    }
}

struct SeenPlayer {
    username: String,
    steam_id: Option<String>,
}

fn remember_player(
    seen: &mut HashMap<String, SeenPlayer>,
    username: String,
    steam_id: Option<String>,
) {
    if username.is_empty() || username.eq_ignore_ascii_case("unknown") {
        return;
    }

    let steam_id = steam_id.and_then(|id| {
        let trimmed = id.trim();
        if trimmed.is_empty() || trimmed == "0" {
            None
        } else {
            Some(trimmed.to_owned())
        }
    });

    let key = username.to_ascii_lowercase();
    match seen.get_mut(&key) {
        Some(existing) => {
            if existing.steam_id.is_none() {
                existing.steam_id = steam_id;
            }
        }
        None => {
            seen.insert(key, SeenPlayer { username, steam_id });
        }
    }
}

async fn provision_joined_accounts(state: &AppState) {
    let mut seen = HashMap::new();

    if let Some(path) = state.config.whitelist_db_path() {
        for account in pz_bridge::whitelist::list(&path) {
            remember_player(&mut seen, account.username, account.steam_id);
        }
    }

    match state.bridge.players_live().await {
        Ok(Some(read)) => {
            for player in read.data.players {
                remember_player(&mut seen, player.username, None);
            }
        }
        Ok(None) => {}
        Err(error) => {
            tracing::debug!(%error, "live roster unreadable while provisioning accounts")
        }
    }

    for name in state.status.current().await.players {
        remember_player(&mut seen, name, None);
    }

    for player in seen.into_values() {
        match auth::ensure_joined_account(&state.db, &player.username, player.steam_id.as_deref())
            .await
        {
            Ok(JoinEnsure::Created) => {
                tracing::info!(
                    username = %player.username,
                    "created website account for a joined player"
                );
            }
            Ok(JoinEnsure::AlreadyPresent | JoinEnsure::Skipped) => {}
            Err(error) => {
                tracing::error!(
                    %error,
                    username = %player.username,
                    "could not create website account for a joined player"
                );
            }
        }
    }
}

/// Answer the `/account register` commands players have run in game.
///
/// The mod appends to `account_links.json`; every request that gets an answer
/// is recorded in `account_link_results.json` under the same id, and ids that
/// already have a result are skipped. That is what keeps a request file read
/// twice from issuing two codes — the same rule the mod applies to the delivery
/// queue.
/// Take the mod's `deaths.json` into `game_events` whenever it changes.
///
/// The export is a rolling window of the most recent 200 deaths, trimmed from
/// the front as it grows, and nothing else on this stack drains it. A death
/// that is not imported before it rolls off is gone for good, which is why the
/// obituary reads Postgres rather than the file.
///
/// Every pass is offered the whole window again, so the import leans on the
/// unique indexes from migration 0007 rather than tracking what it has seen.
/// The mtime gate is only there to keep an idle server from re-offering two
/// hundred rows every few seconds.
async fn deaths_sync_loop(state: AppState) {
    let mut ticker = tokio::time::interval(state.config.stats_sync_interval);
    let bridge = pz_bridge::LuaBridge::new(&state.config.lua_bridge_path);

    let mut last_synced: Option<SystemTime> = None;

    loop {
        ticker.tick().await;

        let modified_at = bridge.modified_at(DEATHS_FILE).await;

        if modified_at.is_none() || modified_at == last_synced {
            continue;
        }

        let export = match bridge.deaths().await {
            Ok(Some(read)) => read.data,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(%error, "deaths export unreadable");
                continue;
            }
        };

        match import_deaths(&state.db, &export.deaths).await {
            Ok(count) => {
                last_synced = modified_at;

                if count > 0 {
                    tracing::info!(deaths = count, "imported deaths from the Lua bridge");
                }
            }
            Err(error) => tracing::error!(%error, "failed to import deaths"),
        }
    }
}

/// Insert every death that is not already recorded. Returns how many were new.
///
/// A death credited to another player also becomes a `pvp_kill` event, filed
/// under the killer. Both come off the same record: `pvp_kills.json` holds the
/// killer's-eye view of the same events, and reading one file means one dedup
/// key to reason about instead of two that can disagree.
async fn import_deaths(db: &PgPool, deaths: &[Death]) -> Result<u64, sqlx::Error> {
    let mut imported = 0;

    for death in deaths {
        if death.username.is_empty() || death.username == "unknown" {
            continue;
        }

        // Without a real timestamp there is no key to deduplicate on, and the
        // row would be re-inserted on every single pass.
        let Some(occurred_at) = DateTime::from_timestamp(death.occurred_at, 0) else {
            continue;
        };

        let killer = death
            .killer
            .as_deref()
            .filter(|name| !name.is_empty() && *name != "unknown");

        let detail = serde_json::json!({
            "cause": death.cause.as_deref().unwrap_or("unknown"),
            "killer": killer,
            "weapon": death.weapon,
            "hours_survived": death.hours_survived,
            "zombie_kills": death.zombie_kills,
            "world_time": death.world_time,
        });

        let inserted = sqlx::query(
            r#"
            INSERT INTO game_events (event_type, player, detail, x, y, z, occurred_at)
            VALUES ('death', $1, $2, $3, $4, $5, $6)
            ON CONFLICT (player, occurred_at) WHERE event_type = 'death' DO NOTHING
            "#,
        )
        .bind(&death.username)
        .bind(&detail)
        .bind(death.x as f32)
        .bind(death.y as f32)
        .bind(death.z)
        .bind(occurred_at)
        .execute(db)
        .await?;

        if inserted.rows_affected() == 0 {
            // Already imported, so the kill beside it is too.
            continue;
        }

        imported += 1;

        let Some(killer) = killer else {
            continue;
        };

        sqlx::query(
            r#"
            INSERT INTO game_events (event_type, player, detail, x, y, z, occurred_at)
            VALUES ('pvp_kill', $1, $2, $3, $4, $5, $6)
            ON CONFLICT (player, occurred_at, (detail ->> 'victim'))
                WHERE event_type = 'pvp_kill' DO NOTHING
            "#,
        )
        .bind(killer)
        .bind(serde_json::json!({
            "victim": death.username,
            "weapon": death.weapon,
        }))
        .bind(death.x as f32)
        .bind(death.y as f32)
        .bind(death.z)
        .bind(occurred_at)
        .execute(db)
        .await?;
    }

    Ok(imported)
}

async fn account_registration_loop(state: AppState) {
    let mut ticker = tokio::time::interval(REGISTRATION_INTERVAL);
    let channel = pz_bridge::LinkChannel::new(&state.config.lua_bridge_path);

    loop {
        ticker.tick().await;

        let requests = match channel.requests().await {
            Ok(requests) => requests.requests,
            Err(error) => {
                tracing::warn!(%error, "registration requests unreadable");
                continue;
            }
        };

        if requests.is_empty() {
            continue;
        }

        let mut ledger = match channel.results().await {
            Ok(ledger) => ledger,
            Err(error) => {
                // Without the ledger we cannot tell which requests were already
                // answered, and guessing would mean handing out a second code.
                tracing::error!(%error, "registration ledger unreadable; skipping this pass");
                continue;
            }
        };

        let answered: HashSet<String> = ledger
            .results
            .iter()
            .map(|result| result.id.clone())
            .collect();

        let mut new_results = Vec::new();

        for request in requests {
            if answered.contains(&request.id) {
                continue;
            }

            let outcome =
                registration::open(&state.db, &request.username, request.steam_id.as_deref()).await;

            let result = match outcome {
                Ok(OpenOutcome::Issued { code, expires_at }) => {
                    tracing::info!(
                        username = %request.username,
                        "opened a registration for a character",
                    );

                    pz_bridge::LinkResult {
                        id: request.id,
                        username: request.username,
                        status: "issued".to_owned(),
                        code: Some(code),
                        expires_at: Some(expires_at.to_rfc3339()),
                        at: Utc::now().to_rfc3339(),
                    }
                }
                Err(error) => {
                    // Left unanswered on purpose: no result means the next pass
                    // tries again, which is what a transient failure deserves.
                    tracing::error!(%error, id = %request.id, "registration request failed");
                    continue;
                }
            };

            new_results.push(result);
        }

        if new_results.is_empty() {
            continue;
        }

        ledger.results.extend(new_results);
        ledger.updated_at = Utc::now().to_rfc3339();

        if let Err(error) = channel.write_results(ledger).await {
            // The codes exist but the player cannot see them. They stay
            // unanswered, so the next pass retries the write.
            tracing::error!(%error, "could not write the registration ledger");
        }
    }
}

/// Answer `/report` commands the same way: file the ticket, write a result.
async fn ingame_report_loop(state: AppState) {
    let mut ticker = tokio::time::interval(REGISTRATION_INTERVAL);
    let channel = pz_bridge::ReportChannel::new(&state.config.lua_bridge_path);

    loop {
        ticker.tick().await;

        let requests = match channel.requests().await {
            Ok(requests) => requests.requests,
            Err(error) => {
                tracing::warn!(%error, "in-game report requests unreadable");
                continue;
            }
        };

        if requests.is_empty() {
            continue;
        }

        let mut ledger = match channel.results().await {
            Ok(ledger) => ledger,
            Err(error) => {
                tracing::error!(%error, "in-game report ledger unreadable; skipping this pass");
                continue;
            }
        };

        let answered: HashSet<String> = ledger
            .results
            .iter()
            .map(|result| result.id.clone())
            .collect();

        let mut new_results = Vec::new();

        for request in requests {
            if answered.contains(&request.id) {
                continue;
            }

            let status = match crate::services::reports::file_from_game(
                &state.db,
                &request.username,
                &request.accused,
                &request.body,
            )
            .await
            {
                Ok(status) => {
                    if status.as_str() == "filed" {
                        tracing::info!(
                            author = %request.username,
                            accused = %request.accused,
                            "filed an in-game player report",
                        );
                        crate::services::reports::refresh_inbox(
                            &state.db,
                            &state.config.lua_bridge_path,
                            &request.username,
                        )
                        .await;
                    }
                    status.as_str().to_owned()
                }
                Err(error) => {
                    tracing::error!(%error, id = %request.id, "in-game report request failed");
                    continue;
                }
            };

            new_results.push(pz_bridge::ReportResult {
                id: request.id,
                username: request.username,
                status,
                at: Utc::now().to_rfc3339(),
            });
        }

        if new_results.is_empty() {
            continue;
        }

        ledger.results.extend(new_results);
        ledger.updated_at = Utc::now().to_rfc3339();

        if let Err(error) = channel.write_results(ledger).await {
            tracing::error!(%error, "could not write the in-game report ledger");
        }
    }
}

/// Drain Desk outbox actions and keep `tickets_inbox.json` current.
async fn ticket_desk_loop(state: AppState) {
    let mut ticker = tokio::time::interval(REGISTRATION_INTERVAL);
    let channel = pz_bridge::ReportChannel::new(&state.config.lua_bridge_path);
    crate::services::reports::rebuild_inbox(&state.db, &state.config.lua_bridge_path).await;

    loop {
        ticker.tick().await;

        let mut box_ = match channel.outbox().await {
            Ok(box_) => box_,
            Err(error) => {
                tracing::warn!(%error, "ticket outbox unreadable");
                continue;
            }
        };

        if box_.requests.is_empty() {
            continue;
        }

        let pending = std::mem::take(&mut box_.requests);
        let mut leftover = Vec::new();
        let mut touched: HashSet<String> = HashSet::new();

        for request in pending {
            let username = request.username.clone();
            let outcome = match request.action.as_str() {
                "reply" => {
                    let Some(report_id) = request.report_id else {
                        continue;
                    };
                    crate::services::reports::add_player_message_from_game(
                        &state.db,
                        &username,
                        report_id,
                        request.body.as_deref().unwrap_or(""),
                    )
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string())
                }
                "create" => crate::services::reports::create_from_desk(
                    &state.db,
                    &username,
                    request.kind.as_deref().unwrap_or("support"),
                    request.subject.as_deref().unwrap_or(""),
                    request.body.as_deref().unwrap_or(""),
                    request.accused.as_deref(),
                )
                .await
                .map(|_| ())
                .map_err(|error| error.to_string()),
                "read" => {
                    if let Some(report_id) = request.report_id {
                        crate::services::reports::mark_read_from_game(
                            &state.db, &username, report_id,
                        )
                        .await
                        .map_err(|error| error.to_string())
                    } else {
                        Ok(())
                    }
                }
                "notice_ack" => {
                    let Some(raw) = request.body.as_deref() else {
                        continue;
                    };
                    let Ok(id) = uuid::Uuid::parse_str(raw.trim()) else {
                        continue;
                    };
                    crate::services::economy::notices::ack(&state.db, &username, id)
                        .await
                        .map_err(|error| error.to_string())
                }
                _ => Ok(()),
            };

            match outcome {
                Ok(()) => {
                    touched.insert(username);
                }
                Err(error) => {
                    tracing::warn!(%error, id = %request.id, "ticket outbox action failed");
                    leftover.push(request);
                }
            }
        }

        box_.requests = leftover;
        if let Err(error) = channel.write_outbox(box_).await {
            tracing::error!(%error, "could not rewrite the ticket outbox");
        }

        for username in touched {
            crate::services::reports::refresh_inbox(
                &state.db,
                &state.config.lua_bridge_path,
                &username,
            )
            .await;
        }
    }
}

/// Drain Knox Desk / right-click friend actions and keep `friends_inbox.json`.
async fn friends_desk_loop(state: AppState) {
    let mut ticker = tokio::time::interval(REGISTRATION_INTERVAL);
    let channel = pz_bridge::FriendsChannel::new(&state.config.lua_bridge_path);
    let (online, live) = friend_presence(&state).await;
    crate::services::friends::rebuild_inbox(
        &state.db,
        &state.config.lua_bridge_path,
        &online,
        &live,
    )
    .await;

    let mut since_positions = 0u32;

    loop {
        ticker.tick().await;

        let mut box_ = match channel.outbox().await {
            Ok(box_) => box_,
            Err(error) => {
                tracing::warn!(%error, "friends outbox unreadable");
                continue;
            }
        };

        let pending = std::mem::take(&mut box_.requests);
        let had_work = !pending.is_empty();
        let mut leftover = Vec::new();
        let mut touched: HashSet<String> = HashSet::new();
        let mut new_results = Vec::new();

        for request in pending {
            let username = request.username.clone();
            let outcome = crate::services::friends::apply_from_game(
                &state.db,
                &username,
                &request.action,
                request.target.as_deref(),
                request.friendship_id.as_deref(),
                request.share_position,
            )
            .await;

            match outcome {
                Ok(applied) => {
                    tracing::info!(
                        actor = %username,
                        action = %request.action,
                        status = applied.status,
                        "applied an in-game friends action",
                    );
                    touched.insert(username.clone());
                    if let Some(name) = applied.other.filter(|name| !name.is_empty()) {
                        touched.insert(name);
                    }
                    new_results.push(pz_bridge::FriendResult {
                        id: request.id,
                        username,
                        status: applied.status.to_owned(),
                        at: Utc::now().to_rfc3339(),
                    });
                }
                Err(error) => {
                    if crate::services::friends::retry_outbox(&error) {
                        tracing::warn!(
                            %error,
                            id = %request.id,
                            "friends outbox action failed"
                        );
                        leftover.push(request);
                        continue;
                    }
                    new_results.push(pz_bridge::FriendResult {
                        id: request.id,
                        username,
                        status: crate::services::friends::game_status(&error).to_owned(),
                        at: Utc::now().to_rfc3339(),
                    });
                }
            }
        }

        if had_work {
            box_.requests = leftover;
            if let Err(error) = channel.write_outbox(box_).await {
                tracing::error!(%error, "could not rewrite the friends outbox");
            }
        }

        if !new_results.is_empty() {
            let mut ledger = match channel.results().await {
                Ok(ledger) => ledger,
                Err(error) => {
                    tracing::error!(%error, "friends results unreadable");
                    pz_bridge::FriendsResults::default()
                }
            };
            ledger.version = 1;
            ledger.updated_at = Utc::now().to_rfc3339();
            ledger.results.extend(new_results);
            if let Err(error) = channel.write_results(ledger).await {
                tracing::error!(%error, "could not write the friends results ledger");
            }
        }

        since_positions += 1;
        if !touched.is_empty() || since_positions >= 3 {
            since_positions = 0;
            let (online, live) = friend_presence(&state).await;
            if !touched.is_empty() {
                let names: Vec<&str> = touched.iter().map(String::as_str).collect();
                crate::services::friends::refresh_inbox(
                    &state.db,
                    &state.config.lua_bridge_path,
                    &names,
                    &online,
                    &live,
                )
                .await;
            } else {
                crate::services::friends::rebuild_inbox(
                    &state.db,
                    &state.config.lua_bridge_path,
                    &online,
                    &live,
                )
                .await;
            }
        }
    }
}

async fn friend_presence(
    state: &AppState,
) -> (Vec<String>, Vec<crate::services::friends::LiveMark>) {
    let online = state.status.current().await.players;
    let live = match state.bridge.players_live().await {
        Ok(Some(read)) => read
            .data
            .players
            .into_iter()
            .map(|player| crate::services::friends::LiveMark {
                username: player.username,
                x: player.x,
                y: player.y,
                z: player.z,
                appearance: player.appearance,
            })
            .collect(),
        Ok(None) => Vec::new(),
        Err(_) => Vec::new(),
    };
    (online, live)
}

/// Record how many players were online, for the population graph.
async fn status_sample_loop(state: AppState) {
    let mut ticker = tokio::time::interval(state.config.status_sample_interval);

    loop {
        ticker.tick().await;

        let status = state.status.current().await;

        let insert =
            sqlx::query("INSERT INTO server_status_samples (online, player_count) VALUES ($1, $2)")
                .bind(status.online)
                .bind(status.player_count as i32)
                .execute(&state.db)
                .await;

        if let Err(error) = insert {
            tracing::error!(%error, "failed to record status sample");
            continue;
        }

        prune_samples(&state.db).await;
    }
}

async fn prune_samples(db: &PgPool) {
    let deleted = sqlx::query(
        "DELETE FROM server_status_samples WHERE sampled_at < now() - make_interval(days => $1)",
    )
    .bind(SAMPLE_RETENTION_DAYS)
    .execute(db)
    .await;

    match deleted {
        Ok(result) if result.rows_affected() > 0 => {
            tracing::debug!(rows = result.rows_affected(), "pruned old status samples");
        }
        Err(error) => tracing::warn!(%error, "failed to prune status samples"),
        Ok(_) => {}
    }
}

/// Clear out sessions and registration codes whose time has passed.
///
/// Both are already refused at lookup, so this is housekeeping rather than a
/// security control — without it the tables only ever grow.
async fn session_cleanup_loop(state: AppState) {
    let mut ticker = tokio::time::interval(SESSION_CLEANUP_INTERVAL);

    loop {
        ticker.tick().await;

        match crate::services::auth::prune_sessions(&state.db).await {
            Ok(0) => {}
            Ok(removed) => tracing::info!(sessions = removed, "pruned expired sessions"),
            Err(error) => tracing::error!(%error, "failed to prune expired sessions"),
        }

        match registration::prune_codes(&state.db).await {
            Ok(0) => {}
            Ok(removed) => tracing::info!(codes = removed, "pruned expired registration codes"),
            Err(error) => tracing::error!(%error, "failed to prune expired registration codes"),
        }

        // Expired challenges are already refused by the query that reads them,
        // so this is housekeeping rather than enforcement.
        match crate::services::twofactor::prune_challenges(&state.db).await {
            Ok(0) => {}
            Ok(removed) => tracing::info!(challenges = removed, "pruned expired 2FA challenges"),
            Err(error) => tracing::error!(%error, "failed to prune expired 2FA challenges"),
        }
    }
}

async fn sanction_expiry_loop(state: AppState) {
    let mut ticker = tokio::time::interval(SANCTION_EXPIRY_INTERVAL);

    loop {
        ticker.tick().await;

        match crate::services::sanctions::expire_due(&state).await {
            Ok(0) => {}
            Ok(lifted) => tracing::info!(lifted, "lifted expired suspensions"),
            Err(error) => tracing::error!(%error, "failed to expire suspensions"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remember_player_keeps_the_first_spelling_and_fills_steam_later() {
        let mut seen = HashMap::new();
        remember_player(&mut seen, "Pike".to_owned(), None);
        remember_player(
            &mut seen,
            "pike".to_owned(),
            Some("76561198000000001".to_owned()),
        );
        remember_player(&mut seen, "unknown".to_owned(), Some("1".to_owned()));
        remember_player(&mut seen, String::new(), Some("1".to_owned()));
        remember_player(&mut seen, "Rook".to_owned(), Some("0".to_owned()));

        assert_eq!(seen.len(), 2);

        let pike = seen.get("pike").expect("pike");
        assert_eq!(pike.username, "Pike");
        assert_eq!(pike.steam_id.as_deref(), Some("76561198000000001"));

        let rook = seen.get("rook").expect("rook");
        assert_eq!(rook.username, "Rook");
        assert_eq!(rook.steam_id, None);
    }
}
