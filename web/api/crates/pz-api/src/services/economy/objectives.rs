//! Staff-authored objectives. Completing one pays XP (and optional coins).

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::character;
use crate::services::economy::{self, wallet};
use crate::state::AppState;

const KINDS: &[&str] = &["play", "kills", "hours", "spend", "trade", "manual"];
const CADENCES: &[&str] = &["daily", "once"];
fn once_period() -> NaiveDate {
    NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch")
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Objective {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub kind: String,
    pub goal: i32,
    pub xp: i32,
    pub coins: i64,
    pub cadence: String,
    pub active: bool,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completions: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObjectiveProgress {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub kind: String,
    pub cadence: String,
    pub xp: i32,
    pub coins: i64,
    pub progress: i64,
    pub goal: i64,
    pub complete: bool,
    pub claimed: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ObjectivePatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub kind: Option<String>,
    pub goal: Option<i32>,
    pub xp: Option<i32>,
    pub coins: Option<i64>,
    pub cadence: Option<String>,
    pub active: Option<bool>,
    pub sort_order: Option<i32>,
}

pub async fn list_admin(db: &PgPool) -> Result<Vec<Objective>, sqlx::Error> {
    sqlx::query_as::<_, Objective>(
        r#"SELECT o.id, o.title, o.description, o.kind, o.goal, o.xp, o.coins,
                  o.cadence, o.active, o.sort_order, o.created_at, o.updated_at,
                  (SELECT COUNT(*) FROM objective_completions c WHERE c.objective_id = o.id)::bigint
                    AS completions
           FROM objectives o
           ORDER BY o.sort_order, o.title"#,
    )
    .fetch_all(db)
    .await
}

pub async fn list_active(db: &PgPool) -> Result<Vec<Objective>, sqlx::Error> {
    sqlx::query_as::<_, Objective>(
        r#"SELECT o.id, o.title, o.description, o.kind, o.goal, o.xp, o.coins,
                  o.cadence, o.active, o.sort_order, o.created_at, o.updated_at,
                  0::bigint AS completions
           FROM objectives o
           WHERE o.active
           ORDER BY o.sort_order, o.title"#,
    )
    .fetch_all(db)
    .await
}

pub async fn create(db: &PgPool, patch: ObjectivePatch) -> ApiResult<Objective> {
    let draft = validated(None, &patch)?;
    let row = sqlx::query_as::<_, Objective>(
        r#"INSERT INTO objectives
            (title, description, kind, goal, xp, coins, cadence, active, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, title, description, kind, goal, xp, coins, cadence, active,
                     sort_order, created_at, updated_at, 0::bigint AS completions"#,
    )
    .bind(&draft.title)
    .bind(&draft.description)
    .bind(&draft.kind)
    .bind(draft.goal)
    .bind(draft.xp)
    .bind(draft.coins)
    .bind(&draft.cadence)
    .bind(draft.active)
    .bind(draft.sort_order)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn update(db: &PgPool, id: Uuid, patch: ObjectivePatch) -> ApiResult<Objective> {
    let current = get(db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That objective is gone.".to_owned()))?;
    let draft = validated(Some(&current), &patch)?;
    let row = sqlx::query_as::<_, Objective>(
        r#"UPDATE objectives SET
            title = $2, description = $3, kind = $4, goal = $5, xp = $6, coins = $7,
            cadence = $8, active = $9, sort_order = $10, updated_at = now()
           WHERE id = $1
           RETURNING id, title, description, kind, goal, xp, coins, cadence, active,
                     sort_order, created_at, updated_at,
                     (SELECT COUNT(*) FROM objective_completions c WHERE c.objective_id = objectives.id)::bigint
                       AS completions"#,
    )
    .bind(id)
    .bind(&draft.title)
    .bind(&draft.description)
    .bind(&draft.kind)
    .bind(draft.goal)
    .bind(draft.xp)
    .bind(draft.coins)
    .bind(&draft.cadence)
    .bind(draft.active)
    .bind(draft.sort_order)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::Validation("That objective is gone.".to_owned()))?;
    Ok(row)
}

pub async fn delete(db: &PgPool, id: Uuid) -> ApiResult<()> {
    let result = sqlx::query("DELETE FROM objectives WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::Validation("That objective is gone.".to_owned()));
    }
    Ok(())
}

pub async fn for_player(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    today: NaiveDate,
) -> ApiResult<Vec<ObjectiveProgress>> {
    let rows = list_active(&state.db).await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let snapshot = character::for_username(&state.db, username).await?;
    let measures = measures(state, user_id, today, snapshot.as_ref()).await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let period = period_of(&row.cadence, today);
        let claimed = completed(&state.db, row.id, user_id, period).await?;
        let progress = progress_of(&row, &measures);
        out.push(ObjectiveProgress {
            id: row.id,
            title: row.title,
            description: row.description,
            kind: row.kind,
            cadence: row.cadence,
            xp: row.xp,
            coins: row.coins,
            progress: progress.min(i64::from(row.goal)),
            goal: i64::from(row.goal),
            complete: progress >= i64::from(row.goal),
            claimed,
        });
    }
    Ok(out)
}

pub async fn claim(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    id: Uuid,
    today: NaiveDate,
) -> ApiResult<(i32, i64)> {
    let snapshot = character::for_username(&state.db, username).await?;
    let measures = measures(state, user_id, today, snapshot.as_ref()).await?;
    let row = get(&state.db, id)
        .await?
        .filter(|item| item.active)
        .ok_or_else(|| ApiError::Validation("That objective is gone.".to_owned()))?;

    if row.kind == "manual" {
        return Err(ApiError::Validation(
            "Staff have to mark that objective done.".to_owned(),
        ));
    }

    let period = period_of(&row.cadence, today);
    if completed(&state.db, row.id, user_id, period).await? {
        return Err(ApiError::Validation("Already claimed.".to_owned()));
    }
    if progress_of(&row, &measures) < i64::from(row.goal) {
        return Err(ApiError::Validation("That objective is not finished yet.".to_owned()));
    }

    award(state, user_id, &row, period).await
}

pub async fn grant(
    state: &AppState,
    username: &str,
    id: Uuid,
) -> ApiResult<(i32, i64)> {
    let user_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM users WHERE lower(username) = lower($1)",
    )
    .bind(username.trim())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::Validation("No account with that name.".to_owned()))?;

    let row = get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That objective is gone.".to_owned()))?;
    let today = Utc::now().date_naive();
    let period = period_of(&row.cadence, today);
    if completed(&state.db, row.id, user_id, period).await? {
        return Err(ApiError::Validation("Already claimed.".to_owned()));
    }
    award(state, user_id, &row, period).await
}

pub async fn xp_of(db: &PgPool, user_id: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE((SELECT xp FROM account_progress WHERE user_id = $1), 0)",
    )
    .bind(user_id)
    .fetch_one(db)
    .await
}

pub async fn daily_goal(db: &PgPool, kind: &str) -> Result<i32, sqlx::Error> {
    let value: Option<i32> = sqlx::query_scalar(
        r#"SELECT MAX(goal) FROM objectives
           WHERE active AND cadence = 'daily' AND kind = $1"#,
    )
    .bind(kind)
    .fetch_one(db)
    .await?;
    Ok(value.unwrap_or(0))
}

async fn award(
    state: &AppState,
    user_id: Uuid,
    row: &Objective,
    period: NaiveDate,
) -> ApiResult<(i32, i64)> {
    if row.xp < 1 && row.coins < 1 {
        return Err(ApiError::Validation("That objective pays nothing.".to_owned()));
    }

    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        r#"INSERT INTO objective_completions
            (objective_id, user_id, period, xp_awarded, coins_awarded)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (objective_id, user_id, period) DO NOTHING"#,
    )
    .bind(row.id)
    .bind(user_id)
    .bind(period)
    .bind(row.xp)
    .bind(row.coins)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError::Validation("Already claimed.".to_owned()));
    }

    if row.xp > 0 {
        sqlx::query(
            r#"INSERT INTO account_progress (user_id, xp)
               VALUES ($1, $2)
               ON CONFLICT (user_id) DO UPDATE
                 SET xp = account_progress.xp + EXCLUDED.xp,
                     updated_at = now()"#,
        )
        .bind(user_id)
        .bind(i64::from(row.xp))
        .execute(&mut *tx)
        .await?;
    }

    if row.coins > 0 {
        wallet::credit_tx(
            &mut tx,
            user_id,
            row.coins,
            economy::SOURCE_QUEST,
            Some(&row.title),
            Some("objective"),
            Some(row.id),
        )
        .await?;
    }

    tx.commit().await?;
    Ok((row.xp, row.coins))
}

struct Measures {
    play_today: bool,
    play_ever: bool,
    kills_today: i64,
    kills_life: i64,
    hours_today: i64,
    hours_life: i64,
    spend_today: bool,
    spend_ever: bool,
    trade_today: bool,
    trade_ever: bool,
}

async fn measures(
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

pub async fn measured_progress(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    today: NaiveDate,
    kind: &str,
    cadence: &str,
) -> ApiResult<i64> {
    let snapshot = character::for_username(&state.db, username).await?;
    let snap = measures(state, user_id, today, snapshot.as_ref()).await?;
    let row = Objective {
        id: Uuid::nil(),
        title: String::new(),
        description: None,
        kind: kind.to_owned(),
        goal: 1,
        xp: 0,
        coins: 0,
        cadence: cadence.to_owned(),
        active: true,
        sort_order: 0,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        completions: 0,
    };
    Ok(progress_of(&row, &snap))
}

fn progress_of(row: &Objective, measures: &Measures) -> i64 {
    let daily = row.cadence == "daily";
    match row.kind.as_str() {
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

fn period_of(cadence: &str, today: NaiveDate) -> NaiveDate {
    if cadence == "daily" {
        today
    } else {
        once_period()
    }
}

async fn get(db: &PgPool, id: Uuid) -> Result<Option<Objective>, sqlx::Error> {
    sqlx::query_as::<_, Objective>(
        r#"SELECT o.id, o.title, o.description, o.kind, o.goal, o.xp, o.coins,
                  o.cadence, o.active, o.sort_order, o.created_at, o.updated_at,
                  (SELECT COUNT(*) FROM objective_completions c WHERE c.objective_id = o.id)::bigint
                    AS completions
           FROM objectives o
           WHERE o.id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

async fn completed(
    db: &PgPool,
    objective_id: Uuid,
    user_id: Uuid,
    period: NaiveDate,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1 FROM objective_completions
               WHERE objective_id = $1 AND user_id = $2 AND period = $3
           )"#,
    )
    .bind(objective_id)
    .bind(user_id)
    .bind(period)
    .fetch_one(db)
    .await
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

struct Draft {
    title: String,
    description: Option<String>,
    kind: String,
    goal: i32,
    xp: i32,
    coins: i64,
    cadence: String,
    active: bool,
    sort_order: i32,
}

fn validated(current: Option<&Objective>, patch: &ObjectivePatch) -> ApiResult<Draft> {
    let title = patch
        .title
        .clone()
        .or_else(|| current.map(|row| row.title.clone()))
        .unwrap_or_default();
    let title = title.trim().to_owned();
    if title.is_empty() || title.len() > 80 {
        return Err(ApiError::Validation(
            "Title must be between 1 and 80 characters.".to_owned(),
        ));
    }

    let description = patch.description.clone().or_else(|| {
        current.and_then(|row| row.description.clone())
    });
    let description = description
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if description.as_ref().is_some_and(|value| value.len() > 400) {
        return Err(ApiError::Validation(
            "Description must be at most 400 characters.".to_owned(),
        ));
    }

    let kind = patch
        .kind
        .clone()
        .or_else(|| current.map(|row| row.kind.clone()))
        .unwrap_or_else(|| "kills".to_owned());
    if !KINDS.contains(&kind.as_str()) {
        return Err(ApiError::Validation("Unknown objective kind.".to_owned()));
    }

    let cadence = patch
        .cadence
        .clone()
        .or_else(|| current.map(|row| row.cadence.clone()))
        .unwrap_or_else(|| "daily".to_owned());
    if !CADENCES.contains(&cadence.as_str()) {
        return Err(ApiError::Validation("Cadence must be daily or once.".to_owned()));
    }

    let goal = patch.goal.or(current.map(|row| row.goal)).unwrap_or(1);
    if !(1..=100_000).contains(&goal) {
        return Err(ApiError::Validation("Goal must be between 1 and 100000.".to_owned()));
    }

    let xp = patch.xp.or(current.map(|row| row.xp)).unwrap_or(50);
    if !(0..=100_000).contains(&xp) {
        return Err(ApiError::Validation("XP must be between 0 and 100000.".to_owned()));
    }

    let coins = patch.coins.or(current.map(|row| row.coins)).unwrap_or(0);
    if !(0..=100_000).contains(&coins) {
        return Err(ApiError::Validation("Coins must be between 0 and 100000.".to_owned()));
    }
    if xp < 1 && coins < 1 {
        return Err(ApiError::Validation("Pay at least 1 XP or 1 coin.".to_owned()));
    }

    let goal = if kind == "play" || kind == "manual" { 1 } else { goal };

    Ok(Draft {
        title,
        description,
        kind,
        goal,
        xp,
        coins,
        cadence,
        active: patch.active.or(current.map(|row| row.active)).unwrap_or(true),
        sort_order: patch.sort_order.or(current.map(|row| row.sort_order)).unwrap_or(0),
    })
}
