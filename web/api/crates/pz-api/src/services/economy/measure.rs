//! How far along a player is against one measure.
//!
//! This used to live inside `objectives.rs`, keyed on an `Objective` row. Flows
//! needed the same arithmetic for their `task`/`objective` nodes, so they called
//! in through a shim that built a throwaway `Objective` — nil id, empty title,
//! goal 1 — purely to satisfy a function that only ever read two of its fields.
//!
//! Objectives are gone (see migration 0033); the arithmetic is not. It is keyed
//! on `(kind, cadence)` here, which is all it ever needed, and both the flow
//! progress view and the reward baselines read it directly.

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiResult;
use crate::services::character;
use crate::state::AppState;

/// What a condition node can be measured against.
pub const MEASURES: &[&str] = &["play", "kills", "hours", "spend", "trade", "manual"];

/// How often a measure resets.
pub const CADENCES: &[&str] = &["daily", "once"];

/// Sentinel period for `once` work, so the completion table's UNIQUE constraint
/// does the "only ever once" enforcement rather than a second code path.
pub fn once_period() -> NaiveDate {
    NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch is a valid date")
}

pub fn period_of(cadence: &str, today: NaiveDate) -> NaiveDate {
    if cadence == "daily" {
        today
    } else {
        once_period()
    }
}

/// Everything measurable about one player, gathered once.
///
/// Held as a struct because a flow asks about several nodes in a row and each
/// field costs a query; gathering per node turned one progress view into a
/// dozen round trips.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Measures {
    pub play_today: bool,
    pub play_ever: bool,
    pub kills_today: i64,
    pub kills_life: i64,
    pub hours_today: i64,
    pub hours_life: i64,
    pub spend_today: bool,
    pub spend_ever: bool,
    pub trade_today: bool,
    pub trade_ever: bool,
}

pub async fn gather(
    state: &AppState,
    user_id: Uuid,
    today: NaiveDate,
    snapshot: Option<&character::Character>,
) -> ApiResult<Measures> {
    let start = today
        .and_hms_opt(0, 0, 0)
        .map(|naive| naive.and_utc())
        .unwrap_or_else(Utc::now);
    let baseline = super::rewards::day_baseline(&state.db, user_id, today).await?;
    let kills = snapshot.map(|row| i64::from(row.zombie_kills)).unwrap_or(0);
    let hours = snapshot.map(|row| row.hours_survived).unwrap_or(0.0);
    let play_today = snapshot.is_some_and(|row| row.last_synced_at.date_naive() == today);

    Ok(Measures {
        play_today,
        play_ever: snapshot.is_some(),
        kills_today: (kills - i64::from(baseline.0)).max(0),
        kills_life: kills,
        hours_today: (hours - baseline.1).floor().max(0.0) as i64,
        hours_life: hours.floor().max(0.0) as i64,
        spend_today: store_since(&state.db, user_id, start).await?,
        spend_ever: store_since(&state.db, user_id, DateTime::<Utc>::UNIX_EPOCH).await?,
        trade_today: trade_since(&state.db, user_id, start).await?,
        trade_ever: trade_since(&state.db, user_id, DateTime::<Utc>::UNIX_EPOCH).await?,
    })
}

/// Progress against one measure. `manual` always reads 0 — staff grant it.
pub fn progress_of(kind: &str, cadence: &str, measures: &Measures) -> i64 {
    let daily = cadence == "daily";
    match kind {
        "play" => i64::from(if daily { measures.play_today } else { measures.play_ever }),
        "kills" => {
            if daily {
                measures.kills_today
            } else {
                measures.kills_life
            }
        }
        "hours" => {
            if daily {
                measures.hours_today
            } else {
                measures.hours_life
            }
        }
        "spend" => i64::from(if daily { measures.spend_today } else { measures.spend_ever }),
        "trade" => i64::from(if daily { measures.trade_today } else { measures.trade_ever }),
        _ => 0,
    }
}

/// One-shot progress lookup for a single node.
pub async fn measured_progress(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    today: NaiveDate,
    kind: &str,
    cadence: &str,
) -> ApiResult<i64> {
    let snapshot = character::for_username(&state.db, username).await?;
    let measures = gather(state, user_id, today, snapshot.as_ref()).await?;
    Ok(progress_of(kind, cadence, &measures))
}

pub async fn xp_of(db: &PgPool, user_id: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COALESCE((SELECT xp FROM account_progress WHERE user_id = $1), 0)")
        .bind(user_id)
        .fetch_one(db)
        .await
}

/// Largest daily goal any live flow sets for `kind`.
///
/// Seeds the reward baseline so a player who has already been playing today is
/// not handed a day's worth of kills for free. This read the `objectives` table
/// before that table was folded into flows; it now walks the graph JSON of every
/// active flow for condition nodes on a daily cadence.
pub async fn daily_goal(db: &PgPool, kind: &str) -> Result<i32, sqlx::Error> {
    let value: Option<i32> = sqlx::query_scalar(
        r#"SELECT MAX((node -> 'data' ->> 'goal')::int)
           FROM quests q,
                LATERAL jsonb_array_elements(q.graph -> 'nodes') AS node
           WHERE q.active
             AND node ->> 'type' IN ('task', 'objective')
             AND node -> 'data' ->> 'cadence' = 'daily'
             AND node -> 'data' ->> 'measure' = $1
             AND (node -> 'data' ->> 'goal') ~ '^[0-9]+$'"#,
    )
    .bind(kind)
    .fetch_one(db)
    .await?;
    Ok(value.unwrap_or(0))
}

async fn store_since(db: &PgPool, user_id: Uuid, start: DateTime<Utc>) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1 FROM store_purchases
               WHERE user_id = $1 AND created_at >= $2
           )"#,
    )
    .bind(user_id)
    .bind(start)
    .fetch_one(db)
    .await
}

async fn trade_since(db: &PgPool, user_id: Uuid, start: DateTime<Utc>) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1 FROM auction_listings
               WHERE seller_id = $1 AND created_at >= $2
           ) OR EXISTS(
               SELECT 1 FROM auction_bids
               WHERE bidder_id = $1 AND created_at >= $2
           )"#,
    )
    .bind(user_id)
    .bind(start)
    .fetch_one(db)
    .await
}
