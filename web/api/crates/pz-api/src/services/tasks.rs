//! Background loops: folding the mod's export into Postgres, and sampling
//! population over time.

use std::collections::HashSet;
use std::time::SystemTime;

use chrono::Utc;
use pz_bridge::lua::{PLAYER_STATS_FILE, StatsPlayer};
use sqlx::PgPool;
use tokio::task::JoinHandle;

use crate::services::link::{self, ClaimOutcome};
use crate::state::AppState;

/// How long sampled population history is kept.
const SAMPLE_RETENTION_DAYS: i32 = 30;

/// Expired sessions are dead the moment they expire; sweeping them hourly is
/// plenty.
const SESSION_CLEANUP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);

/// A player standing at the keyboard is waiting for this, so it runs often.
const ACCOUNT_LINK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Start every background loop. Handles are returned so `main` can abort them
/// on shutdown.
pub fn spawn_all(state: AppState) -> Vec<JoinHandle<()>> {
    vec![
        tokio::spawn(stats_sync_loop(state.clone())),
        tokio::spawn(status_sample_loop(state.clone())),
        tokio::spawn(account_link_loop(state.clone())),
        tokio::spawn(session_cleanup_loop(state)),
    ]
}

/// Claim the account-link codes players have typed in game.
///
/// The mod appends to `account_links.json`; every claim that gets an answer is
/// recorded in `account_link_results.json` under the same id, and ids that
/// already have a result are skipped. That is what makes a request file read
/// twice link only once — the same rule the mod applies to the delivery queue.
async fn account_link_loop(state: AppState) {
    let mut ticker = tokio::time::interval(ACCOUNT_LINK_INTERVAL);
    let channel = pz_bridge::LinkChannel::new(&state.config.lua_bridge_path);

    loop {
        ticker.tick().await;

        let requests = match channel.requests().await {
            Ok(requests) => requests.requests,
            Err(error) => {
                tracing::warn!(%error, "account link requests unreadable");
                continue;
            }
        };

        if requests.is_empty() {
            continue;
        }

        let mut ledger = match channel.results().await {
            Ok(ledger) => ledger,
            Err(error) => {
                // Without the ledger we cannot tell which claims were already
                // answered, and guessing would risk linking twice.
                tracing::error!(%error, "account link ledger unreadable; skipping this pass");
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

            let outcome = match link::claim(&state.db, &request.code, &request.username).await {
                Ok(outcome) => outcome,
                Err(error) => {
                    // Left unanswered on purpose: no result means the next pass
                    // tries again, which is what a transient database error
                    // deserves.
                    tracing::error!(%error, id = %request.id, "account link claim failed");
                    continue;
                }
            };

            if outcome.is_success() {
                tracing::info!(username = %request.username, "linked an account to a character");
            } else {
                tracing::info!(
                    username = %request.username,
                    outcome = ?outcome,
                    "rejected an account link",
                );
            }

            new_results.push(pz_bridge::LinkResult {
                id: request.id,
                username: request.username,
                status: status_label(outcome).to_owned(),
                at: Utc::now().to_rfc3339(),
            });
        }

        if new_results.is_empty() {
            continue;
        }

        ledger.results.extend(new_results);
        ledger.updated_at = Utc::now().to_rfc3339();

        if let Err(error) = channel.write_results(ledger).await {
            // The links themselves are committed; only the reply failed. The
            // ids stay unanswered, so the next pass retries and the claim comes
            // back as already_claimed — which the mod can still report.
            tracing::error!(%error, "could not write the account link ledger");
        }
    }
}

/// The wire form of an outcome, matching its serde representation.
fn status_label(outcome: ClaimOutcome) -> &'static str {
    match outcome {
        ClaimOutcome::Linked => "linked",
        ClaimOutcome::UnknownCode => "unknown_code",
        ClaimOutcome::Expired => "expired",
        ClaimOutcome::AlreadyClaimed => "already_claimed",
        ClaimOutcome::AccountAlreadyLinked => "account_already_linked",
        ClaimOutcome::NameTaken => "name_taken",
    }
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

        match link::prune_codes(&state.db).await {
            Ok(0) => {}
            Ok(removed) => tracing::info!(codes = removed, "pruned expired link codes"),
            Err(error) => tracing::error!(%error, "failed to prune expired link codes"),
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
