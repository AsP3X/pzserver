//! In-game Desk notices. The panel is the ledger; Knox Relay only pushes.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiResult;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Notice {
    pub id: Uuid,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub unread: bool,
    pub created_at: DateTime<Utc>,
}

pub async fn push(
    state: &AppState,
    user_id: Uuid,
    kind: &str,
    title: &str,
    body: &str,
    reference_type: Option<&str>,
    reference_id: Option<Uuid>,
) -> ApiResult<()> {
    sqlx::query(
        r#"INSERT INTO desk_notices
            (user_id, kind, title, body, reference_type, reference_id)
           VALUES ($1,$2,$3,$4,$5,$6)"#,
    )
    .bind(user_id)
    .bind(kind)
    .bind(title)
    .bind(body)
    .bind(reference_type)
    .bind(reference_id)
    .execute(&state.db)
    .await?;

    if let Some(username) = username_of(&state.db, user_id).await? {
        crate::services::reports::refresh_inbox(
            &state.db,
            &state.config.lua_bridge_path,
            &username,
        )
        .await;
    }
    Ok(())
}

pub async fn ack(db: &PgPool, username: &str, notice_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE desk_notices n
           SET read_at = now()
           FROM users u
           WHERE n.id = $1 AND n.user_id = u.id
             AND lower(u.username) = lower($2)
             AND n.read_at IS NULL"#,
    )
    .bind(notice_id)
    .bind(username)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn for_user(db: &PgPool, user_id: Uuid) -> Result<Vec<Notice>, sqlx::Error> {
    sqlx::query_as::<_, Notice>(
        r#"SELECT id, kind, title, body, (read_at IS NULL) AS unread, created_at
           FROM desk_notices
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 40"#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

async fn username_of(db: &PgPool, user_id: Uuid) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
}
