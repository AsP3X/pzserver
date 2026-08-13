//! Timed suspensions and permanent bans issued from the panel.
//!
//! The dedicated server has no temp-ban command. A suspension is `banuser`
//! plus a row that says when to `unbanuser`. Permanent bans use the same
//! table with no expiry, so the lift loop cannot accidentally free someone
//! a staff member meant to keep out.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::admin;
use crate::state::AppState;

const MIN_SECONDS: i64 = 60;
const MAX_SECONDS: i64 = 90 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Sanction {
    pub id: i64,
    pub username: String,
    pub reason: Option<String>,
    pub duration_seconds: Option<i32>,
    pub starts_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub lifted_at: Option<DateTime<Utc>>,
    pub lifted_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SanctionList {
    pub active: Vec<Sanction>,
    pub recent: Vec<Sanction>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ActiveMark {
    pub username: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub reason: Option<String>,
}

/// Open sanctions, newest first, plus a short lifted history.
pub async fn list(db: &PgPool) -> Result<SanctionList, sqlx::Error> {
    let active = sqlx::query_as::<_, Sanction>(
        r#"
        SELECT id, username, reason, duration_seconds, starts_at, expires_at,
               lifted_at, lifted_reason
        FROM player_sanctions
        WHERE lifted_at IS NULL
        ORDER BY starts_at DESC
        "#,
    )
    .fetch_all(db)
    .await?;

    let recent = sqlx::query_as::<_, Sanction>(
        r#"
        SELECT id, username, reason, duration_seconds, starts_at, expires_at,
               lifted_at, lifted_reason
        FROM player_sanctions
        WHERE lifted_at IS NOT NULL
        ORDER BY lifted_at DESC
        LIMIT 15
        "#,
    )
    .fetch_all(db)
    .await?;

    Ok(SanctionList { active, recent })
}

/// One open row per name, for decorating the roster.
pub async fn active_marks(db: &PgPool) -> Result<Vec<ActiveMark>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT username, expires_at, reason
        FROM player_sanctions
        WHERE lifted_at IS NULL
        "#,
    )
    .fetch_all(db)
    .await
}

pub async fn active_for(db: &PgPool, username: &str) -> Result<Option<Sanction>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT id, username, reason, duration_seconds, starts_at, expires_at,
               lifted_at, lifted_reason
        FROM player_sanctions
        WHERE lifted_at IS NULL
          AND lower(username) = lower($1)
        "#,
    )
    .bind(username)
    .fetch_optional(db)
    .await
}

/// Kick, ban, and remember the timer. Offline is fine: the kick is best-effort.
pub async fn suspend(
    state: &AppState,
    username: &str,
    reason: Option<&str>,
    duration_seconds: i64,
    staff_id: Uuid,
) -> ApiResult<Sanction> {
    let name = admin::player_name(username)?;
    let seconds = validate_duration(duration_seconds)?;
    let note = clean_reason(reason);
    let expires_at = Utc::now() + Duration::seconds(seconds);

    if let Some(open) = active_for(&state.db, name).await? {
        if open.expires_at.is_none() {
            return Err(ApiError::Validation(
                "They are already banned. Lift that first if you want a timed suspension.".to_owned(),
            ));
        }

        return replace_timer(state, open.id, name, note.as_deref(), seconds, expires_at).await;
    }

    impose(state, name, note.as_deref(), Some(seconds), Some(expires_at), staff_id).await
}

/// Permanent ban, recorded so a later expiry cannot unban them.
pub async fn ban(
    state: &AppState,
    username: &str,
    reason: Option<&str>,
    staff_id: Uuid,
) -> ApiResult<Sanction> {
    let name = admin::player_name(username)?;
    let note = clean_reason(reason);

    if let Some(open) = active_for(&state.db, name).await? {
        if open.expires_at.is_none() {
            return Err(ApiError::Validation(
                "They are already banned.".to_owned(),
            ));
        }

        return convert_to_ban(state, open.id, note.as_deref()).await;
    }

    impose(state, name, note.as_deref(), None, None, staff_id).await
}

/// Lift whatever is open and unban in the game.
pub async fn lift(state: &AppState, username: &str, why: &str) -> ApiResult<String> {
    let name = admin::player_name(username)?;
    let output = admin::unban(state, name).await?;

    sqlx::query(
        r#"
        UPDATE player_sanctions
           SET lifted_at = now(), lifted_reason = $2
         WHERE lifted_at IS NULL
           AND lower(username) = lower($1)
        "#,
    )
    .bind(name)
    .bind(why)
    .execute(&state.db)
    .await?;

    Ok(output)
}

/// Unban anyone whose timer has run out.
pub async fn expire_due(state: &AppState) -> Result<u64, sqlx::Error> {
    let due = sqlx::query_as::<_, (i64, String)>(
        r#"
        SELECT id, username
        FROM player_sanctions
        WHERE lifted_at IS NULL
          AND expires_at IS NOT NULL
          AND expires_at <= now()
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    let mut lifted = 0;

    for (id, username) in due {
        match admin::unban(state, &username).await {
            Ok(_) => {
                sqlx::query(
                    r#"
                    UPDATE player_sanctions
                       SET lifted_at = now(), lifted_reason = 'expired'
                     WHERE id = $1 AND lifted_at IS NULL
                    "#,
                )
                .bind(id)
                .execute(&state.db)
                .await?;
                lifted += 1;
            }
            Err(error) => {
                tracing::warn!(%username, %error, "could not lift an expired suspension");
            }
        }
    }

    Ok(lifted)
}

async fn impose(
    state: &AppState,
    name: &str,
    reason: Option<&str>,
    duration_seconds: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
    staff_id: Uuid,
) -> ApiResult<Sanction> {
    // Offline players are not an error: the ban is what keeps them out.
    if let Err(error) = admin::kick(state, name, reason).await {
        tracing::debug!(%name, %error, "kick before sanction failed; continuing with ban");
    }

    admin::ban(state, name).await?;

    let row = sqlx::query_as::<_, Sanction>(
        r#"
        INSERT INTO player_sanctions (
            username, reason, duration_seconds, expires_at, created_by
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, username, reason, duration_seconds, starts_at, expires_at,
                  lifted_at, lifted_reason
        "#,
    )
    .bind(name)
    .bind(reason)
    .bind(duration_seconds.map(|value| value as i32))
    .bind(expires_at)
    .bind(staff_id)
    .fetch_one(&state.db)
    .await?;

    Ok(row)
}

async fn replace_timer(
    state: &AppState,
    id: i64,
    name: &str,
    reason: Option<&str>,
    seconds: i64,
    expires_at: DateTime<Utc>,
) -> ApiResult<Sanction> {
    if let Err(error) = admin::kick(state, name, reason).await {
        tracing::debug!(%name, %error, "kick while refreshing a suspension failed");
    }

    let row = sqlx::query_as::<_, Sanction>(
        r#"
        UPDATE player_sanctions
           SET reason = $2,
               duration_seconds = $3,
               expires_at = $4,
               starts_at = now()
         WHERE id = $1
        RETURNING id, username, reason, duration_seconds, starts_at, expires_at,
                  lifted_at, lifted_reason
        "#,
    )
    .bind(id)
    .bind(reason)
    .bind(seconds as i32)
    .bind(expires_at)
    .fetch_one(&state.db)
    .await?;

    Ok(row)
}

async fn convert_to_ban(state: &AppState, id: i64, reason: Option<&str>) -> ApiResult<Sanction> {
    let row = sqlx::query_as::<_, Sanction>(
        r#"
        UPDATE player_sanctions
           SET reason = coalesce($2, reason),
               duration_seconds = NULL,
               expires_at = NULL
         WHERE id = $1
        RETURNING id, username, reason, duration_seconds, starts_at, expires_at,
                  lifted_at, lifted_reason
        "#,
    )
    .bind(id)
    .bind(reason)
    .fetch_one(&state.db)
    .await?;

    Ok(row)
}

fn validate_duration(seconds: i64) -> ApiResult<i64> {
    if seconds < MIN_SECONDS {
        return Err(ApiError::Validation(
            "A suspension has to last at least a minute.".to_owned(),
        ));
    }
    if seconds > MAX_SECONDS {
        return Err(ApiError::Validation(
            "A suspension cannot last more than 90 days.".to_owned(),
        ));
    }
    Ok(seconds)
}

fn clean_reason(reason: Option<&str>) -> Option<String> {
    reason
        .map(admin::sanitise_message)
        .filter(|value| !value.is_empty())
}
