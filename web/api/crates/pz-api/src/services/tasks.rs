//! Background loops: folding the mod's export into Postgres, and sampling
//! population over time.

use std::time::SystemTime;

use pz_bridge::lua::{PLAYER_STATS_FILE, StatsPlayer};
use sqlx::PgPool;
use tokio::task::JoinHandle;

use crate::state::AppState;

/// How long sampled population history is kept.
const SAMPLE_RETENTION_DAYS: i32 = 30;

/// Expired sessions are dead the moment they expire; sweeping them hourly is
/// plenty.
const SESSION_CLEANUP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);

/// Start every background loop. Handles are returned so `main` can abort them
/// on shutdown.
pub fn spawn_all(state: AppState) -> Vec<JoinHandle<()>> {
    vec![
        tokio::spawn(stats_sync_loop(state.clone())),
        tokio::spawn(status_sample_loop(state.clone())),
        tokio::spawn(session_cleanup_loop(state)),
    ]
}

/// Clear out sessions whose expiry has passed.
///
/// Expired sessions are already refused at lookup, so this is housekeeping
/// rather than a security control — without it the table only ever grows.
async fn session_cleanup_loop(state: AppState) {
    let mut ticker = tokio::time::interval(SESSION_CLEANUP_INTERVAL);

    loop {
        ticker.tick().await;

        match crate::services::auth::prune_sessions(&state.db).await {
            Ok(0) => {}
            Ok(removed) => tracing::info!(sessions = removed, "pruned expired sessions"),
            Err(error) => tracing::error!(%error, "failed to prune expired sessions"),
        }
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
                skills, traits, vitals, is_dead, last_synced_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
            ON CONFLICT (username) DO UPDATE SET
                zombie_kills   = EXCLUDED.zombie_kills,
                hours_survived = EXCLUDED.hours_survived,
                profession     = EXCLUDED.profession,
                skills         = EXCLUDED.skills,
                -- Older KnoxRelay builds omit these two. Keep what we already
                -- know rather than overwriting it with nothing.
                traits         = COALESCE(EXCLUDED.traits, player_stats.traits),
                vitals         = COALESCE(EXCLUDED.vitals, player_stats.vitals),
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
        .bind(player.is_dead)
        .execute(db)
        .await?;

        synced += 1;
    }

    Ok(synced)
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
