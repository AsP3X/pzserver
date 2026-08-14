//! Daily drop, tasks and account rank. Every payout is a wallet credit.

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::character;
use crate::services::economy::{self, objectives, quests, wallet};
use crate::state::AppState;

const DAILY_KEY: &str = "daily_login";
const XP_PER_RANK: i64 = 100;

#[derive(Debug, Clone, Copy)]
struct TaskSpec {
    id: &'static str,
    key: &'static str,
    coins: i64,
    goal: i64,
}

const TASKS: &[TaskSpec] = &[
    TaskSpec { id: "play", key: "task_play", coins: 10, goal: 1 },
    TaskSpec { id: "cull", key: "task_cull", coins: 15, goal: 10 },
    TaskSpec { id: "survive", key: "task_survive", coins: 10, goal: 1 },
    TaskSpec { id: "spend", key: "task_spend", coins: 15, goal: 1 },
    TaskSpec { id: "trade", key: "task_trade", coins: 15, goal: 1 },
];

#[derive(Debug, Clone, Serialize)]
pub struct RewardsView {
    pub daily: DailyView,
    pub tasks: Vec<TaskView>,
    pub objectives: Vec<objectives::ObjectiveProgress>,
    pub quests: Vec<quests::QuestProgress>,
    pub available_quests: Vec<quests::QuestOffer>,
    pub rank: RankView,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailyView {
    pub available: bool,
    pub claimed_today: bool,
    pub coins: i64,
    pub streak: i32,
    pub next_claim_at: DateTime<Utc>,
    pub last_claim_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskView {
    pub id: String,
    pub coins: i64,
    pub progress: i64,
    pub goal: i64,
    pub complete: bool,
    pub claimed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RankView {
    pub current: i32,
    pub xp: i64,
    pub into: i64,
    pub per_rank: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaimResult {
    pub claimed: i64,
    pub xp: i64,
    pub rewards: RewardsView,
}

pub async fn status(state: &AppState, user_id: Uuid, username: &str) -> ApiResult<RewardsView> {
    let today = Utc::now().date_naive();
    let snapshot = character::for_username(&state.db, username).await?;
    ensure_baseline(&state.db, user_id, today, snapshot.as_ref()).await?;
    load(state, user_id, username, today).await
}

pub async fn claim(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    key: &str,
) -> ApiResult<ClaimResult> {
    let today = Utc::now().date_naive();
    let snapshot = character::for_username(&state.db, username).await?;
    ensure_baseline(&state.db, user_id, today, snapshot.as_ref()).await?;

    let claimed = match key {
        "daily" => claim_daily(state, user_id, today).await?,
        other => {
            let spec = TASKS
                .iter()
                .find(|task| task.id == other)
                .ok_or_else(|| ApiError::Validation("Unknown reward.".to_owned()))?;
            claim_task(state, user_id, username, today, spec).await?
        }
    };

    Ok(ClaimResult {
        claimed,
        xp: 0,
        rewards: load(state, user_id, username, today).await?,
    })
}

pub async fn claim_objective(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    id: Uuid,
) -> ApiResult<ClaimResult> {
    let today = Utc::now().date_naive();
    let snapshot = character::for_username(&state.db, username).await?;
    ensure_baseline(&state.db, user_id, today, snapshot.as_ref()).await?;
    let (xp, coins) = objectives::claim(state, user_id, username, id, today).await?;
    Ok(ClaimResult {
        claimed: coins,
        xp: i64::from(xp),
        rewards: load(state, user_id, username, today).await?,
    })
}

async fn load(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    today: NaiveDate,
) -> ApiResult<RewardsView> {
    let coins = state.config.daily_reward_coins.max(0);
    let claimed_today = claimed(&state.db, user_id, DAILY_KEY, today).await?;
    let last_claim_at = last_claim(&state.db, user_id, DAILY_KEY).await?;
    let next = next_utc_midnight(today);

    Ok(RewardsView {
        daily: DailyView {
            available: !claimed_today && coins > 0,
            claimed_today,
            coins,
            streak: streak(&state.db, user_id, today).await?,
            next_claim_at: next,
            last_claim_at,
        },
        tasks: task_views(state, user_id, username, today).await?,
        objectives: objectives::for_player(state, user_id, username, today).await?,
        quests: quests::for_player(state, user_id, username, today).await?,
        available_quests: quests::offers_for(&state.db, user_id).await?,
        rank: rank_view(&state.db, user_id).await?,
    })
}

pub async fn claim_quest_node(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    quest_id: Uuid,
    node_id: &str,
) -> ApiResult<ClaimResult> {
    let today = Utc::now().date_naive();
    let snapshot = character::for_username(&state.db, username).await?;
    ensure_baseline(&state.db, user_id, today, snapshot.as_ref()).await?;
    let (xp, coins) = quests::claim_node(state, user_id, username, quest_id, node_id, today).await?;
    Ok(ClaimResult {
        claimed: coins,
        xp: i64::from(xp),
        rewards: load(state, user_id, username, today).await?,
    })
}

pub async fn claim_quest(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    quest_id: Uuid,
) -> ApiResult<ClaimResult> {
    quests::claim_offer(&state.db, user_id, quest_id).await?;
    let today = Utc::now().date_naive();
    Ok(ClaimResult {
        claimed: 0,
        xp: 0,
        rewards: load(state, user_id, username, today).await?,
    })
}

async fn claim_daily(state: &AppState, user_id: Uuid, today: NaiveDate) -> ApiResult<i64> {
    let coins = state.config.daily_reward_coins;
    if coins < 1 {
        return Err(ApiError::Validation("Daily rewards are disabled.".to_owned()));
    }
    if claimed(&state.db, user_id, DAILY_KEY, today).await? {
        return Err(ApiError::Validation("Already claimed today.".to_owned()));
    }

    let mut tx = state.db.begin().await?;
    insert_claim(&mut tx, user_id, DAILY_KEY, today, coins).await?;
    wallet::credit_tx(
        &mut tx,
        user_id,
        coins,
        economy::SOURCE_DAILY_REWARD,
        Some("Daily login reward"),
        Some("reward"),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(coins)
}

async fn claim_task(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    today: NaiveDate,
    spec: &TaskSpec,
) -> ApiResult<i64> {
    let view = task_views(state, user_id, username, today)
        .await?
        .into_iter()
        .find(|task| task.id == spec.id)
        .ok_or_else(|| ApiError::Validation("Unknown reward.".to_owned()))?;

    if view.claimed {
        return Err(ApiError::Validation("Already claimed today.".to_owned()));
    }
    if !view.complete {
        return Err(ApiError::Validation("That task is not finished yet.".to_owned()));
    }

    let mut tx = state.db.begin().await?;
    insert_claim(&mut tx, user_id, spec.key, today, spec.coins).await?;
    wallet::credit_tx(
        &mut tx,
        user_id,
        spec.coins,
        economy::SOURCE_QUEST,
        Some(&format!("Daily task: {}", spec.id)),
        Some("reward"),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(spec.coins)
}

async fn task_views(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    today: NaiveDate,
) -> ApiResult<Vec<TaskView>> {
    let snapshot = character::for_username(&state.db, username).await?;
    let baseline = day_baseline(&state.db, user_id, today).await?;
    let start = today
        .and_hms_opt(0, 0, 0)
        .map(|naive| naive.and_utc())
        .unwrap_or_else(Utc::now);
    let played_today = snapshot
        .as_ref()
        .is_some_and(|row| row.last_synced_at.date_naive() == today);
    let kills = snapshot.as_ref().map(|row| i64::from(row.zombie_kills)).unwrap_or(0);
    let hours = snapshot.as_ref().map(|row| row.hours_survived).unwrap_or(0.0);
    let spent = store_today(&state.db, user_id, start).await?;
    let traded = trade_today(&state.db, user_id, start).await?;

    let mut out = Vec::with_capacity(TASKS.len());
    for spec in TASKS {
        let progress = match spec.id {
            "play" => i64::from(played_today),
            "cull" => (kills - i64::from(baseline.0)).max(0),
            "survive" => (hours - baseline.1).floor().max(0.0) as i64,
            "spend" => i64::from(spent),
            "trade" => i64::from(traded),
            _ => 0,
        }
        .min(spec.goal);
        let taken = claimed(&state.db, user_id, spec.key, today).await?;
        out.push(TaskView {
            id: spec.id.to_owned(),
            coins: spec.coins,
            progress,
            goal: spec.goal,
            complete: progress >= spec.goal,
            claimed: taken,
        });
    }
    Ok(out)
}

async fn rank_view(db: &PgPool, user_id: Uuid) -> ApiResult<RankView> {
    let xp = objectives::xp_of(db, user_id).await?;
    Ok(RankView {
        current: rank_of(xp),
        xp,
        into: xp % XP_PER_RANK,
        per_rank: XP_PER_RANK,
    })
}

fn rank_of(xp: i64) -> i32 {
    1 + (xp / XP_PER_RANK).clamp(0, 10_000) as i32
}

fn next_utc_midnight(today: NaiveDate) -> DateTime<Utc> {
    today
        .succ_opt()
        .and_then(|day| day.and_hms_opt(0, 0, 0))
        .map(|naive| naive.and_utc())
        .unwrap_or_else(Utc::now)
}

async fn ensure_baseline(
    db: &PgPool,
    user_id: Uuid,
    today: NaiveDate,
    snapshot: Option<&character::Character>,
) -> Result<(), sqlx::Error> {
    let kills = snapshot.map(|row| row.zombie_kills).unwrap_or(0);
    let hours = snapshot.map(|row| row.hours_survived).unwrap_or(0.0);
    let played_today = snapshot.is_some_and(|row| row.last_synced_at.date_naive() == today);
    let kill_goal = objectives::daily_goal(db, "kills").await?.max(10);
    let hour_goal = objectives::daily_goal(db, "hours").await?.max(1);
    let start_kills = if played_today { (kills - kill_goal).max(0) } else { kills };
    let start_hours = if played_today {
        (hours - f64::from(hour_goal)).max(0.0)
    } else {
        hours
    };

    sqlx::query(
        r#"INSERT INTO reward_baselines (user_id, day, zombie_kills, hours_survived)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, day) DO NOTHING"#,
    )
    .bind(user_id)
    .bind(today)
    .bind(start_kills)
    .bind(start_hours)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn day_baseline(
    db: &PgPool,
    user_id: Uuid,
    today: NaiveDate,
) -> Result<(i32, f64), sqlx::Error> {
    let row = sqlx::query_as::<_, (i32, f64)>(
        r#"SELECT zombie_kills, hours_survived
           FROM reward_baselines WHERE user_id = $1 AND day = $2"#,
    )
    .bind(user_id)
    .bind(today)
    .fetch_optional(db)
    .await?;
    Ok(row.unwrap_or((0, 0.0)))
}

async fn claimed(
    db: &PgPool,
    user_id: Uuid,
    key: &str,
    today: NaiveDate,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1 FROM reward_claims
               WHERE user_id = $1 AND reward_key = $2 AND claim_date = $3
           )"#,
    )
    .bind(user_id)
    .bind(key)
    .bind(today)
    .fetch_one(db)
    .await
}

async fn last_claim(
    db: &PgPool,
    user_id: Uuid,
    key: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT created_at FROM reward_claims
           WHERE user_id = $1 AND reward_key = $2
           ORDER BY created_at DESC LIMIT 1"#,
    )
    .bind(user_id)
    .bind(key)
    .fetch_optional(db)
    .await
}

async fn streak(db: &PgPool, user_id: Uuid, today: NaiveDate) -> Result<i32, sqlx::Error> {
    let days: Vec<NaiveDate> = sqlx::query_scalar(
        r#"SELECT claim_date FROM reward_claims
           WHERE user_id = $1 AND reward_key = $2
           ORDER BY claim_date DESC
           LIMIT 60"#,
    )
    .bind(user_id)
    .bind(DAILY_KEY)
    .fetch_all(db)
    .await?;

    let mut expect = today;
    let mut count = 0;
    for day in days {
        if day == expect {
            count += 1;
            expect = match expect.pred_opt() {
                Some(previous) => previous,
                None => break,
            };
        } else if count == 0 && day == today.pred_opt().unwrap_or(today) {
            count = 1;
            expect = match day.pred_opt() {
                Some(previous) => previous,
                None => break,
            };
        } else {
            break;
        }
    }
    Ok(count)
}

async fn store_today(db: &PgPool, user_id: Uuid, start: DateTime<Utc>) -> Result<bool, sqlx::Error> {
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

async fn trade_today(db: &PgPool, user_id: Uuid, start: DateTime<Utc>) -> Result<bool, sqlx::Error> {
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

async fn insert_claim(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    key: &str,
    today: NaiveDate,
    coins: i64,
) -> ApiResult<()> {
    let inserted = sqlx::query(
        r#"INSERT INTO reward_claims (user_id, reward_key, claim_date, coins)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, reward_key, claim_date) DO NOTHING"#,
    )
    .bind(user_id)
    .bind(key)
    .bind(today)
    .bind(coins)
    .execute(&mut **tx)
    .await?;

    if inserted.rows_affected() == 0 {
        return Err(ApiError::Validation("Already claimed today.".to_owned()));
    }
    Ok(())
}
