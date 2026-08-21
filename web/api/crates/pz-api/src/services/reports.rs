//! Player reports and support tickets.
//!
//! A player files one. Staff handle it. The conversation is a thread of
//! messages. The opening body stays on the report for the list; it is also
//! the first player message.

use std::path::Path;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

const KINDS: &[&str] = &["report", "support"];
const STATUSES: &[&str] = &["open", "investigating", "resolved", "rejected"];
const SUBJECT_MIN: usize = 3;
const SUBJECT_MAX: usize = 150;
const BODY_MIN: usize = 10;
const BODY_MAX: usize = 5000;
const MESSAGE_MAX: usize = 2000;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ReportMessage {
    pub id: i64,
    pub report_id: i64,
    pub author_role: String,
    pub author: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub id: i64,
    pub kind: String,
    pub subject: String,
    pub body: String,
    pub accused: Option<String>,
    pub status: String,
    pub resolution: Option<String>,
    pub author: String,
    pub handler: Option<String>,
    pub created_at: DateTime<Utc>,
    pub handled_at: Option<DateTime<Utc>>,
    pub unread: bool,
    pub last_message_preview: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub messages: Vec<ReportMessage>,
}

#[derive(Debug, Clone, FromRow)]
struct ReportRow {
    id: i64,
    kind: String,
    subject: String,
    body: String,
    accused: Option<String>,
    status: String,
    resolution: Option<String>,
    author: String,
    handler: Option<String>,
    created_at: DateTime<Utc>,
    handled_at: Option<DateTime<Utc>>,
    player_last_read_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportQueue {
    pub reports: Vec<Report>,
    pub open_count: i64,
}

pub async fn list_all(db: &PgPool) -> Result<ReportQueue, sqlx::Error> {
    let rows = sqlx::query_as::<_, ReportRow>(
        r#"
        SELECT
            r.id,
            r.kind,
            r.subject,
            r.body,
            r.accused,
            r.status,
            r.resolution,
            coalesce(a.username, r.author_username) AS author,
            h.username AS handler,
            r.created_at,
            r.handled_at,
            r.player_last_read_at
        FROM player_reports r
        LEFT JOIN users a ON a.id = r.user_id
        LEFT JOIN users h ON h.id = r.handled_by
        ORDER BY
            CASE WHEN r.status IN ('open', 'investigating') THEN 0 ELSE 1 END,
            r.created_at DESC
        LIMIT 200
        "#,
    )
    .fetch_all(db)
    .await?;

    let reports = attach_messages(db, rows).await?;

    let open_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)::bigint
        FROM player_reports
        WHERE status IN ('open', 'investigating')
        "#,
    )
    .fetch_one(db)
    .await?;

    Ok(ReportQueue { reports, open_count })
}

pub async fn list_mine(db: &PgPool, user_id: Uuid) -> Result<Vec<Report>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ReportRow>(
        r#"
        SELECT
            r.id,
            r.kind,
            r.subject,
            r.body,
            r.accused,
            r.status,
            r.resolution,
            coalesce(a.username, r.author_username) AS author,
            h.username AS handler,
            r.created_at,
            r.handled_at,
            r.player_last_read_at
        FROM player_reports r
        LEFT JOIN users a ON a.id = r.user_id
        LEFT JOIN users h ON h.id = r.handled_by
        WHERE r.user_id = $1
           OR lower(r.author_username) = lower((SELECT username FROM users WHERE id = $1))
        ORDER BY r.created_at DESC
        LIMIT 100
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    attach_messages(db, rows).await
}

pub async fn get_for_staff(db: &PgPool, id: i64) -> Result<Option<Report>, sqlx::Error> {
    load(db, id).await
}

pub async fn get_mine(db: &PgPool, user_id: Uuid, id: i64) -> ApiResult<Report> {
    let report = load(db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That report is not here.".to_owned()))?;

    if !owns(db, user_id, id).await? {
        return Err(ApiError::Forbidden);
    }

    Ok(report)
}

pub async fn create(
    db: &PgPool,
    user_id: Uuid,
    kind: &str,
    subject: &str,
    body: &str,
    accused: Option<&str>,
) -> ApiResult<Report> {
    let kind = kind.trim();
    if !KINDS.contains(&kind) {
        return Err(ApiError::Validation(
            "Choose report or support.".to_owned(),
        ));
    }

    let subject = subject.trim();
    if subject.chars().count() < SUBJECT_MIN || subject.chars().count() > SUBJECT_MAX {
        return Err(ApiError::Validation(
            "Give the report a short subject.".to_owned(),
        ));
    }

    let body = body.trim();
    if body.chars().count() < BODY_MIN {
        return Err(ApiError::Validation(
            "Give the team enough detail to act on.".to_owned(),
        ));
    }
    if body.chars().count() > BODY_MAX {
        return Err(ApiError::Validation("That report is too long.".to_owned()));
    }

    let accused = accused.map(str::trim).filter(|value| !value.is_empty());
    if kind == "report" && accused.is_none() {
        return Err(ApiError::Validation("Say who you are reporting.".to_owned()));
    }
    if let Some(name) = accused
        && !accused_name(name) {
            return Err(ApiError::Validation(
                "That name can only contain letters, numbers, spaces, underscores and hyphens.".to_owned(),
            ));
        }

    let author = sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(db)
        .await?;

    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO player_reports (user_id, author_username, kind, subject, body, accused, player_last_read_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(&author)
    .bind(kind)
    .bind(subject)
    .bind(body)
    .bind(accused)
    .fetch_one(db)
    .await?;

    insert_message(db, id, "player", None, &author, body).await?;

    load(db, id)
        .await?
        .ok_or_else(|| ApiError::Internal("report vanished after insert".to_owned()))
}

pub async fn update(
    db: &PgPool,
    id: i64,
    staff_id: Uuid,
    status: &str,
    resolution: Option<&str>,
) -> ApiResult<Report> {
    let status = status.trim();
    if !STATUSES.contains(&status) {
        return Err(ApiError::Validation(
            "Status must be open, investigating, resolved or rejected.".to_owned(),
        ));
    }

    let reply = resolution
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(MESSAGE_MAX).collect::<String>());

    let handled = status == "resolved" || status == "rejected";

    let staff_name = sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = $1")
        .bind(staff_id)
        .fetch_one(db)
        .await?;

    let updated = sqlx::query(
        r#"
        UPDATE player_reports
           SET status = $2,
               resolution = COALESCE($3, resolution),
               handled_by = $4,
               handled_at = CASE WHEN $5 THEN now() ELSE handled_at END,
               updated_at = now()
         WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(status)
    .bind(reply.as_deref())
    .bind(staff_id)
    .bind(handled)
    .execute(db)
    .await?;

    if updated.rows_affected() == 0 {
        return Err(ApiError::Validation("That report is not here.".to_owned()));
    }

    if let Some(body) = reply.as_deref() {
        insert_message(db, id, "staff", Some(staff_id), &staff_name, body).await?;
    }

    load(db, id)
        .await?
        .ok_or_else(|| ApiError::Internal("report vanished after update".to_owned()))
}

pub async fn add_player_message(
    db: &PgPool,
    user_id: Uuid,
    report_id: i64,
    body: &str,
) -> ApiResult<Report> {
    let body = body.trim();
    if body.is_empty() {
        return Err(ApiError::Validation("Write a message.".to_owned()));
    }
    if body.chars().count() > MESSAGE_MAX {
        return Err(ApiError::Validation("That message is too long.".to_owned()));
    }

    if !owns(db, user_id, report_id).await? {
        return Err(ApiError::Forbidden);
    }

    let author = sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(db)
        .await?;

    insert_message(db, report_id, "player", None, &author, body).await?;

    sqlx::query(
        r#"
        UPDATE player_reports
           SET status = CASE
                 WHEN status IN ('resolved', 'rejected') THEN 'investigating'
                 ELSE status
               END,
               player_last_read_at = now(),
               updated_at = now()
         WHERE id = $1
        "#,
    )
    .bind(report_id)
    .execute(db)
    .await?;

    load(db, report_id)
        .await?
        .ok_or_else(|| ApiError::Internal("report vanished after reply".to_owned()))
}

pub async fn mark_read(db: &PgPool, user_id: Uuid, report_id: i64) -> ApiResult<Report> {
    if !owns(db, user_id, report_id).await? {
        return Err(ApiError::Forbidden);
    }

    sqlx::query(
        r#"
        UPDATE player_reports
           SET player_last_read_at = now()
         WHERE id = $1
        "#,
    )
    .bind(report_id)
    .execute(db)
    .await?;

    load(db, report_id)
        .await?
        .ok_or_else(|| ApiError::Validation("That report is not here.".to_owned()))
}

/// Author username for writing the game inbox after a staff reply.
pub async fn author_username(db: &PgPool, report_id: i64) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT coalesce(a.username, r.author_username)
        FROM player_reports r
        LEFT JOIN users a ON a.id = r.user_id
        WHERE r.id = $1
        "#,
    )
    .bind(report_id)
    .fetch_optional(db)
    .await
}

pub async fn inbox_for(db: &PgPool, username: &str) -> Result<Vec<Report>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ReportRow>(
        r#"
        SELECT
            r.id,
            r.kind,
            r.subject,
            r.body,
            r.accused,
            r.status,
            r.resolution,
            coalesce(a.username, r.author_username) AS author,
            h.username AS handler,
            r.created_at,
            r.handled_at,
            r.player_last_read_at
        FROM player_reports r
        LEFT JOIN users a ON a.id = r.user_id
        LEFT JOIN users h ON h.id = r.handled_by
        WHERE lower(coalesce(a.username, r.author_username)) = lower($1)
        ORDER BY r.created_at DESC
        LIMIT 50
        "#,
    )
    .bind(username)
    .fetch_all(db)
    .await?;

    attach_messages(db, rows).await
}

/// Status written back to the mod for one `/report` command.
#[derive(Debug, Clone, Copy)]
pub enum GameFileStatus {
    Filed,
    Invalid,
    TooShort,
    SelfReport,
}

impl GameFileStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Filed => "filed",
            Self::Invalid => "invalid",
            Self::TooShort => "too_short",
            Self::SelfReport => "self",
        }
    }
}

/// File a report that arrived from the game, not from the website.
pub async fn file_from_game(
    db: &PgPool,
    author: &str,
    accused: &str,
    body: &str,
) -> Result<GameFileStatus, sqlx::Error> {
    let author = author.trim();
    let accused = accused.trim();
    let body = body.trim();

    if author.is_empty() || !accused_name(accused) {
        return Ok(GameFileStatus::Invalid);
    }
    if author.eq_ignore_ascii_case(accused) {
        return Ok(GameFileStatus::SelfReport);
    }
    if body.chars().count() < BODY_MIN {
        return Ok(GameFileStatus::TooShort);
    }

    let body: String = body.chars().take(BODY_MAX).collect();
    let subject = {
        let raw = format!("Report on {accused}");
        raw.chars().take(SUBJECT_MAX).collect::<String>()
    };

    let user_id = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE lower(username) = lower($1)")
        .bind(author)
        .fetch_optional(db)
        .await?;

    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO player_reports (user_id, author_username, kind, subject, body, accused, player_last_read_at)
        VALUES ($1, $2, 'report', $3, $4, $5, now())
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(author)
    .bind(subject)
    .bind(&body)
    .bind(accused)
    .fetch_one(db)
    .await?;

    insert_message(db, id, "player", None, author, &body).await?;

    Ok(GameFileStatus::Filed)
}

/// File a ticket from the in-game Desk (report or support).
pub async fn create_from_desk(
    db: &PgPool,
    username: &str,
    kind: &str,
    subject: &str,
    body: &str,
    accused: Option<&str>,
) -> ApiResult<Report> {
    let user_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM users WHERE lower(username) = lower($1)",
    )
    .bind(username)
    .fetch_optional(db)
    .await?;

    if let Some(user_id) = user_id {
        return create(db, user_id, kind, subject, body, accused).await;
    }

    let kind = kind.trim();
    if !KINDS.contains(&kind) {
        return Err(ApiError::Validation(
            "Choose report or support.".to_owned(),
        ));
    }

    let subject = subject.trim();
    if subject.chars().count() < SUBJECT_MIN || subject.chars().count() > SUBJECT_MAX {
        return Err(ApiError::Validation(
            "Give the report a short subject.".to_owned(),
        ));
    }

    let body = body.trim();
    if body.chars().count() < BODY_MIN {
        return Err(ApiError::Validation(
            "Give the team enough detail to act on.".to_owned(),
        ));
    }
    if body.chars().count() > BODY_MAX {
        return Err(ApiError::Validation("That report is too long.".to_owned()));
    }

    let accused = accused.map(str::trim).filter(|value| !value.is_empty());
    if kind == "report" && accused.is_none() {
        return Err(ApiError::Validation("Say who you are reporting.".to_owned()));
    }
    if let Some(name) = accused
        && !accused_name(name) {
            return Err(ApiError::Validation(
                "That name can only contain letters, numbers, spaces, underscores and hyphens.".to_owned(),
            ));
        }

    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO player_reports (user_id, author_username, kind, subject, body, accused, player_last_read_at)
        VALUES (NULL, $1, $2, $3, $4, $5, now())
        RETURNING id
        "#,
    )
    .bind(username)
    .bind(kind)
    .bind(subject)
    .bind(body)
    .bind(accused)
    .fetch_one(db)
    .await?;

    insert_message(db, id, "player", None, username, body).await?;

    load(db, id)
        .await?
        .ok_or_else(|| ApiError::Internal("report vanished after insert".to_owned()))
}

pub async fn add_player_message_from_game(
    db: &PgPool,
    username: &str,
    report_id: i64,
    body: &str,
) -> ApiResult<Report> {
    let user_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM users WHERE lower(username) = lower($1)",
    )
    .bind(username)
    .fetch_optional(db)
    .await?;

    if let Some(user_id) = user_id {
        return add_player_message(db, user_id, report_id, body).await;
    }

    let body = body.trim();
    if body.is_empty() {
        return Err(ApiError::Validation("Write a message.".to_owned()));
    }
    if body.chars().count() > MESSAGE_MAX {
        return Err(ApiError::Validation("That message is too long.".to_owned()));
    }

    let owned = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT exists(
            SELECT 1 FROM player_reports
            WHERE id = $1 AND lower(author_username) = lower($2)
        )
        "#,
    )
    .bind(report_id)
    .bind(username)
    .fetch_one(db)
    .await?;

    if !owned {
        return Err(ApiError::Forbidden);
    }

    insert_message(db, report_id, "player", None, username, body).await?;

    sqlx::query(
        r#"
        UPDATE player_reports
           SET status = CASE
                 WHEN status IN ('resolved', 'rejected') THEN 'investigating'
                 ELSE status
               END,
               player_last_read_at = now(),
               updated_at = now()
         WHERE id = $1
        "#,
    )
    .bind(report_id)
    .execute(db)
    .await?;

    load(db, report_id)
        .await?
        .ok_or_else(|| ApiError::Internal("report vanished after reply".to_owned()))
}

pub async fn mark_read_from_game(
    db: &PgPool,
    username: &str,
    report_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE player_reports
           SET player_last_read_at = now()
         WHERE id = $1
           AND lower(coalesce(author_username, '')) = lower($2)
        "#,
    )
    .bind(report_id)
    .bind(username)
    .execute(db)
    .await?;

    Ok(())
}

async fn owns(db: &PgPool, user_id: Uuid, report_id: i64) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT exists(
            SELECT 1
            FROM player_reports r
            LEFT JOIN users a ON a.id = r.user_id
            WHERE r.id = $1
              AND (r.user_id = $2 OR lower(r.author_username) = lower((SELECT username FROM users WHERE id = $2)))
        )
        "#,
    )
    .bind(report_id)
    .bind(user_id)
    .fetch_one(db)
    .await
}

async fn insert_message(
    db: &PgPool,
    report_id: i64,
    role: &str,
    staff_id: Option<Uuid>,
    author: &str,
    body: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO player_report_messages (report_id, author_role, staff_id, author_username, body)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(report_id)
    .bind(role)
    .bind(staff_id)
    .bind(author)
    .bind(body)
    .execute(db)
    .await?;

    Ok(())
}

async fn load(db: &PgPool, id: i64) -> Result<Option<Report>, sqlx::Error> {
    let row = sqlx::query_as::<_, ReportRow>(
        r#"
        SELECT
            r.id,
            r.kind,
            r.subject,
            r.body,
            r.accused,
            r.status,
            r.resolution,
            coalesce(a.username, r.author_username) AS author,
            h.username AS handler,
            r.created_at,
            r.handled_at,
            r.player_last_read_at
        FROM player_reports r
        LEFT JOIN users a ON a.id = r.user_id
        LEFT JOIN users h ON h.id = r.handled_by
        WHERE r.id = $1
        "#,
    )
        .bind(id)
        .fetch_optional(db)
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let mut reports = attach_messages(db, vec![row]).await?;
    Ok(reports.pop())
}

async fn attach_messages(db: &PgPool, rows: Vec<ReportRow>) -> Result<Vec<Report>, sqlx::Error> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let messages = sqlx::query_as::<_, ReportMessage>(
        r#"
        SELECT
            id,
            report_id,
            author_role,
            author_username AS author,
            body,
            created_at
        FROM player_report_messages
        WHERE report_id = ANY($1)
        ORDER BY created_at ASC, id ASC
        "#,
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;

    let mut grouped: std::collections::HashMap<i64, Vec<ReportMessage>> =
        std::collections::HashMap::new();
    for message in messages {
        grouped.entry(message.report_id).or_default().push(message);
    }

    Ok(rows
        .into_iter()
        .map(|row| {
            let thread = grouped.remove(&row.id).unwrap_or_default();
            let last = thread.last();
            let unread = thread.iter().any(|message| {
                message.author_role == "staff"
                    && row
                        .player_last_read_at
                        .is_none_or(|read| message.created_at > read)
            });

            Report {
                id: row.id,
                kind: row.kind,
                subject: row.subject,
                body: row.body,
                accused: row.accused,
                status: row.status,
                resolution: row.resolution,
                author: row.author,
                handler: row.handler,
                created_at: row.created_at,
                handled_at: row.handled_at,
                unread,
                last_message_preview: last.map(|message| {
                    message
                        .body
                        .chars()
                        .take(140)
                        .collect::<String>()
                }),
                last_message_at: last.map(|message| message.created_at),
                messages: thread,
            }
        })
        .collect())
}

/// Rewrite one player's slice of `tickets_inbox.json`.
pub async fn refresh_inbox(db: &PgPool, lua_dir: &Path, username: &str) {
    let channel = pz_bridge::ReportChannel::new(lua_dir);
    if let Err(error) = write_inbox_slice(db, &channel, username).await {
        tracing::warn!(%error, username, "could not refresh the ticket inbox");
    }
}

/// Rebuild the whole inbox from every ticket we still show the game.
pub async fn rebuild_inbox(db: &PgPool, lua_dir: &Path) {
    let channel = pz_bridge::ReportChannel::new(lua_dir);

    let names = match sqlx::query_scalar::<_, String>(
        r#"
        SELECT DISTINCT coalesce(a.username, r.author_username)
        FROM player_reports r
        LEFT JOIN users a ON a.id = r.user_id
        WHERE coalesce(a.username, r.author_username) IS NOT NULL
        ORDER BY 1
        LIMIT 200
        "#,
    )
    .fetch_all(db)
    .await
    {
        Ok(names) => names,
        Err(error) => {
            tracing::warn!(%error, "could not list ticket authors");
            return;
        }
    };

    let mut inbox = pz_bridge::TicketInbox {
        version: 1,
        updated_at: Utc::now().to_rfc3339(),
        players: std::collections::BTreeMap::new(),
    };

    for name in names {
        match inbox_for(db, &name).await {
            Ok(reports) => {
                inbox.players.insert(name, snapshot_player(&reports));
            }
            Err(error) => {
                tracing::warn!(%error, username = %name, "ticket inbox slice failed");
            }
        }
    }

    if let Err(error) = channel.write_inbox(&inbox).await {
        tracing::warn!(%error, "could not write tickets_inbox.json");
    }
}

async fn write_inbox_slice(
    db: &PgPool,
    channel: &pz_bridge::ReportChannel,
    username: &str,
) -> Result<(), pz_bridge::tickets::ReportChannelError> {
    // tickets::ReportChannelError is not re-exported as that path if tickets is private.
    // Use the channel's own error via write_inbox Result.
    let mut inbox = channel.inbox().await?;
    inbox.version = 1;
    inbox.updated_at = Utc::now().to_rfc3339();

    match inbox_for(db, username).await {
        Ok(reports) => {
            inbox
                .players
                .insert(username.to_owned(), snapshot_player(&reports));
        }
        Err(error) => {
            tracing::warn!(%error, username, "ticket inbox slice query failed");
        }
    }

    channel.write_inbox(&inbox).await
}

fn snapshot_player(reports: &[Report]) -> pz_bridge::TicketPlayerInbox {
    let unread = reports.iter().filter(|report| report.unread).count() as i64;
    pz_bridge::TicketPlayerInbox {
        unread,
        updated_at: Utc::now().to_rfc3339(),
        reports: reports
            .iter()
            .map(|report| pz_bridge::TicketSnapshot {
                id: report.id,
                kind: report.kind.clone(),
                subject: report.subject.clone(),
                status: report.status.clone(),
                accused: report.accused.clone(),
                unread: report.unread,
                updated_at: report
                    .last_message_at
                    .unwrap_or(report.created_at)
                    .to_rfc3339(),
                messages: report
                    .messages
                    .iter()
                    .map(|message| pz_bridge::TicketMessage {
                        id: message.id,
                        role: message.author_role.clone(),
                        author: message.author.clone(),
                        body: message.body.clone(),
                        at: message.created_at.to_rfc3339(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn accused_name(value: &str) -> bool {
    let len = value.chars().count();
    (1..=50).contains(&len)
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == ' ')
}
