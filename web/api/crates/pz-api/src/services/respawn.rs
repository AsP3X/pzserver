//! Enforcing the respawn cooldown the mod can only ask for.
//!
//! `KR_Cooldown` notices a death, remembers when it happened, and queues a kick
//! for anyone who comes back too early. It cannot disconnect them itself, so
//! without something draining that queue the whole feature is a setting that
//! does nothing. This is that something.

use chrono::{DateTime, TimeZone, Utc};
use pz_bridge::{RespawnChannel, RespawnConfig, RespawnKick};
use serde::Serialize;

use crate::error::{ApiError, ApiResult};
use crate::services::admin;
use crate::state::AppState;

/// Refuse a cooldown long enough to look like a ban by accident.
const MAX_DELAY_MINUTES: i64 = 60 * 24 * 7;

/// One player waiting out a cooldown, as the admin page shows it.
#[derive(Debug, Clone, Serialize)]
pub struct RespawnTimer {
    pub username: String,
    pub died_at: DateTime<Utc>,
    /// Whole minutes still to wait, floored at zero.
    pub minutes_left: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RespawnView {
    pub enabled: bool,
    pub delay_minutes: i64,
    pub timers: Vec<RespawnTimer>,
}

fn channel(state: &AppState) -> RespawnChannel {
    RespawnChannel::new(&state.config.lua_bridge_path)
}

fn internal(error: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(error.to_string())
}

pub async fn view(state: &AppState) -> ApiResult<RespawnView> {
    let channel = channel(state);
    let config = channel.config().await.map_err(internal)?;
    let deaths = channel.deaths().await.map_err(internal)?;

    let now = Utc::now();
    let window = config.delay_minutes.max(0) * 60;

    let mut timers: Vec<RespawnTimer> = deaths
        .into_iter()
        .filter_map(|(username, epoch)| {
            // A timestamp the mod could not have written is a corrupt record,
            // not a reason to drop the whole list.
            let died_at = Utc.timestamp_opt(epoch, 0).single()?;
            let elapsed = (now - died_at).num_seconds();

            Some(RespawnTimer {
                username,
                died_at,
                minutes_left: ((window - elapsed).max(0) + 59) / 60,
            })
        })
        .collect();

    // Longest wait first: that is the player most likely to be asking about it.
    timers.sort_by(|a, b| b.minutes_left.cmp(&a.minutes_left).then(a.username.cmp(&b.username)));

    Ok(RespawnView {
        enabled: config.enabled,
        delay_minutes: config.delay_minutes,
        timers,
    })
}

pub async fn configure(
    state: &AppState,
    enabled: bool,
    delay_minutes: i64,
) -> ApiResult<RespawnView> {
    if !(1..=MAX_DELAY_MINUTES).contains(&delay_minutes) {
        return Err(ApiError::Validation(format!(
            "Cooldown must be between 1 and {MAX_DELAY_MINUTES} minutes."
        )));
    }

    channel(state)
        .set_config(RespawnConfig {
            enabled,
            delay_minutes,
        })
        .await
        .map_err(internal)?;

    tracing::info!(enabled, delay_minutes, "respawn cooldown configured");

    view(state).await
}

/// Clear one player's timer. The mod owns the record, so this is a request.
pub async fn reset(state: &AppState, username: &str) -> ApiResult<RespawnView> {
    let name = admin::player_name(username)?;

    channel(state).queue_reset(name).await.map_err(internal)?;

    tracing::info!(username = name, "respawn cooldown reset queued");

    view(state).await
}

/// Perform every kick the mod has queued.
///
/// Entries are drained only once the kick has actually been sent. A failed RCON
/// call leaves the entry in place so the next tick retries it — the alternative
/// is a player who died staying in the world because the game server happened
/// to be unreachable for one tick.
pub async fn tick(state: &AppState) {
    let channel = channel(state);

    let Ok(queued) = channel.kicks().await else {
        return;
    };

    if queued.is_empty() {
        return;
    }

    let mut handled: Vec<RespawnKick> = Vec::with_capacity(queued.len());

    for entry in queued {
        // A name the mod wrote should already be safe, but this is what builds
        // an RCON command, so it is validated here rather than assumed.
        let Ok(name) = admin::player_name(&entry.username) else {
            tracing::warn!(
                username = %entry.username,
                "dropping a respawn kick for an implausible player name",
            );
            handled.push(entry);
            continue;
        };

        match admin::kick(state, name, entry.reason.as_deref()).await {
            Ok(_) => {
                tracing::info!(username = name, "respawn cooldown kick performed");
                handled.push(entry);
            }
            Err(error) => {
                tracing::warn!(
                    username = name,
                    %error,
                    "respawn cooldown kick failed — leaving it queued",
                );
            }
        }
    }

    if let Err(error) = channel.drain(&handled).await {
        // The kicks happened; only the bookkeeping failed. Left in the queue
        // they would be re-sent, which is harmless — kicking someone already
        // gone is a no-op — but it is worth knowing about.
        tracing::error!(%error, "could not drain the respawn kick queue");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cooldown_longer_than_a_week_is_refused() {
        assert_eq!(MAX_DELAY_MINUTES, 10_080);
    }

    /// Partial minutes round up, so "1 minute left" never displays as 0 while
    /// the player is still being bounced.
    #[test]
    fn remaining_minutes_round_up() {
        let round = |seconds_left: i64| ((seconds_left).max(0) + 59) / 60;

        assert_eq!(round(1), 1);
        assert_eq!(round(60), 1);
        assert_eq!(round(61), 2);
        assert_eq!(round(0), 0);
        assert_eq!(round(-30), 0, "an elapsed cooldown reads as zero, not negative");
    }
}
