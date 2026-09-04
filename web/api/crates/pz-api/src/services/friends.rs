//! Friendships between website accounts.
//!
//! The graph lives here, not in Lua. Knox Relay only queues actions and
//! projects the roster the panel writes. Identity is the website user: both
//! sides need a website account (created when they join) before a request
//! can land.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::character;

#[derive(Debug, Clone)]
pub struct LiveMark {
    pub username: String,
    pub x: f64,
    pub y: f64,
    pub z: i32,
    pub appearance: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FriendsView {
    pub incoming: Vec<FriendCard>,
    pub outgoing: Vec<FriendCard>,
    pub friends: Vec<FriendCard>,
    pub blocked: Vec<FriendCard>,
    /// Server-wide switch. When false, nobody's pin is published to friends.
    pub map_enabled: bool,
}

/// Someone the picker can search: a website account, or a character the
/// server has seen who has not registered yet.
#[derive(Debug, Clone, Serialize)]
pub struct DirectoryEntry {
    pub username: String,
    pub profession: Option<String>,
    pub online: bool,
    /// `none`, `friends`, `incoming`, `outgoing`, `blocked`, `unregistered`.
    pub relation: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FriendCard {
    pub id: Uuid,
    pub username: String,
    pub status: String,
    pub online: bool,
    pub share_position: bool,
    pub their_share_position: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<FriendPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FriendPosition {
    pub x: f64,
    pub y: f64,
    pub z: i32,
}

#[derive(Debug, Clone, FromRow)]
struct EdgeRow {
    id: Uuid,
    status: String,
    requested_by: Uuid,
    blocked_by: Option<Uuid>,
    other_username: String,
    share_position: bool,
    their_share_position: bool,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
struct NamedUser {
    id: Uuid,
    username: String,
}

/// Stable unordered pair so (A,B) and (B,A) collide on the unique index.
pub fn pair(left: Uuid, right: Uuid) -> (Uuid, Uuid) {
    if left < right {
        (left, right)
    } else {
        (right, left)
    }
}

pub async fn view(
    db: &PgPool,
    user_id: Uuid,
    online: &[String],
    live: &[LiveMark],
) -> Result<FriendsView, sqlx::Error> {
    let map_enabled = map_enabled(db).await?;
    let share_maps = share_map_by_name(db).await?;
    let rows = load_edges(db, user_id).await?;
    let mut incoming = Vec::new();
    let mut outgoing = Vec::new();
    let mut friends = Vec::new();
    let mut blocked = Vec::new();

    for row in rows {
        match row.status.as_str() {
            "pending" if row.requested_by == user_id => {
                outgoing.push(card(&row, online, live, db, false, map_enabled, &share_maps).await?);
            }
            "pending" => {
                incoming.push(card(&row, online, live, db, false, map_enabled, &share_maps).await?);
            }
            "accepted" => {
                friends.push(card(&row, online, live, db, true, map_enabled, &share_maps).await?);
            }
            "blocked" if row.blocked_by == Some(user_id) => {
                blocked.push(card(&row, online, live, db, false, map_enabled, &share_maps).await?);
            }
            _ => {}
        }
    }

    Ok(FriendsView {
        incoming,
        outgoing,
        friends,
        blocked,
        map_enabled,
    })
}

#[derive(Debug, Clone, FromRow)]
struct DirectoryRow {
    username: String,
    profession: Option<String>,
    registered: bool,
}

/// Survivors the signed-in player can search when sending a request.
///
/// Website accounts come first. Characters the game has seen but who have no
/// account still appear, marked `unregistered`, so a search for the name they
/// play under finds them instead of looking like a miss.
pub async fn directory(
    db: &PgPool,
    user_id: Uuid,
    online: &[String],
) -> Result<Vec<DirectoryEntry>, sqlx::Error> {
    let rows = sqlx::query_as::<_, DirectoryRow>(
        r#"
        SELECT DISTINCT ON (lower(username)) username, profession, registered FROM (
            SELECT
                u.username,
                p.profession,
                true AS registered
            FROM users u
            LEFT JOIN player_stats p ON lower(p.username) = lower(u.username)
            WHERE u.username IS NOT NULL
              AND u.id <> $1

            UNION ALL

            SELECT
                p.username,
                p.profession,
                false AS registered
            FROM player_stats p
            WHERE NOT EXISTS (
                SELECT 1
                FROM users u
                WHERE u.username IS NOT NULL
                  AND lower(u.username) = lower(p.username)
            )
        ) people
        ORDER BY lower(username), registered DESC, username
        LIMIT 500
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    let edges = load_edges(db, user_id).await?;
    let mut relation_by_name: std::collections::HashMap<String, &'static str> =
        std::collections::HashMap::new();
    let mut hidden = std::collections::HashSet::new();

    for row in &edges {
        let key = row.other_username.to_lowercase();
        match row.status.as_str() {
            "pending" if row.requested_by == user_id => {
                relation_by_name.insert(key, "outgoing");
            }
            "pending" => {
                relation_by_name.insert(key, "incoming");
            }
            "accepted" => {
                relation_by_name.insert(key, "friends");
            }
            "blocked" if row.blocked_by == Some(user_id) => {
                relation_by_name.insert(key, "blocked");
            }
            "blocked" => {
                hidden.insert(key);
            }
            _ => {}
        }
    }

    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let key = row.username.to_lowercase();
            if hidden.contains(&key) {
                return None;
            }
            let relation = relation_by_name
                .get(&key)
                .copied()
                .unwrap_or(if row.registered {
                    "none"
                } else {
                    "unregistered"
                })
                .to_owned();
            Some(DirectoryEntry {
                online: character::is_online(online, &row.username),
                username: row.username,
                profession: row.profession,
                relation,
            })
        })
        .collect())
}

/// Snapshot one player's roster for the Desk.
pub async fn inbox_slice(
    db: &PgPool,
    username: &str,
    online: &[String],
    live: &[LiveMark],
) -> Result<Option<(String, pz_bridge::FriendsPlayerInbox)>, sqlx::Error> {
    let Some(user) = find_user(db, username).await? else {
        return Ok(None);
    };

    let view = view(db, user.id, online, live).await?;
    Ok(Some((
        user.username,
        pz_bridge::FriendsPlayerInbox {
            unread: view.incoming.len() as i64,
            updated_at: Utc::now().to_rfc3339(),
            incoming: view.incoming.iter().map(snapshot).collect(),
            outgoing: view.outgoing.iter().map(snapshot).collect(),
            friends: view.friends.iter().map(snapshot).collect(),
            blocked: view.blocked.iter().map(snapshot).collect(),
        },
    )))
}

pub async fn refresh_inbox(
    db: &PgPool,
    lua_dir: &Path,
    usernames: &[&str],
    online: &[String],
    live: &[LiveMark],
) {
    let channel = pz_bridge::FriendsChannel::new(lua_dir);
    if let Err(error) = write_inbox_slices(db, &channel, usernames, online, live).await {
        tracing::warn!(%error, "could not refresh the friends inbox");
    }
}

/// Rewrite every player who has a friendship row. Called on boot so a restart
/// does not leave Desk looking at a file from before the last accept.
pub async fn rebuild_inbox(db: &PgPool, lua_dir: &Path, online: &[String], live: &[LiveMark]) {
    let names = match sqlx::query_scalar::<_, String>(
        r#"
        SELECT DISTINCT name FROM (
            SELECT u.username AS name
            FROM friendships f
            JOIN users u ON u.id = f.user_low
            UNION
            SELECT u.username
            FROM friendships f
            JOIN users u ON u.id = f.user_high
        ) names
        WHERE name IS NOT NULL
        ORDER BY 1
        LIMIT 500
        "#,
    )
    .fetch_all(db)
    .await
    {
        Ok(names) => names,
        Err(error) => {
            tracing::warn!(%error, "could not list friends for inbox rebuild");
            return;
        }
    };

    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    refresh_inbox(db, lua_dir, &refs, online, live).await;
}

async fn write_inbox_slices(
    db: &PgPool,
    channel: &pz_bridge::FriendsChannel,
    usernames: &[&str],
    online: &[String],
    live: &[LiveMark],
) -> Result<(), pz_bridge::friends::FriendsChannelError> {
    let mut inbox = match channel.inbox().await {
        Ok(inbox) => inbox,
        Err(pz_bridge::friends::FriendsChannelError::Parse { path, source }) => {
            tracing::warn!(
                path = %path.display(),
                %source,
                "friends inbox unreadable; rewriting from scratch"
            );
            pz_bridge::FriendsInbox::default()
        }
        Err(error) => return Err(error),
    };
    inbox.version = 1;
    inbox.updated_at = Utc::now().to_rfc3339();

    let mut seen = std::collections::HashSet::new();
    for name in usernames {
        let key = name.to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        match inbox_slice(db, name, online, live).await {
            Ok(Some((stored, slice))) => {
                inbox.players.insert(stored, slice);
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, username = %name, "friends inbox slice query failed");
            }
        }
    }

    channel.write_inbox(&inbox).await
}

pub async fn request(db: &PgPool, me: Uuid, target_username: &str) -> ApiResult<FriendCard> {
    let target = require_user(db, target_username).await?;
    if target.id == me {
        return Err(ApiError::Validation(
            "You cannot send a friend request to yourself.".to_owned(),
        ));
    }

    let mut tx = db.begin().await?;
    let row = upsert_request(&mut tx, me, target.id).await?;
    tx.commit().await?;

    Ok(FriendCard {
        id: row.id,
        username: target.username,
        status: row.status,
        online: false,
        share_position: row.share_mine,
        their_share_position: row.share_theirs,
        position: None,
        appearance: None,
        created_at: row.created_at,
    })
}

pub async fn act(db: &PgPool, me: Uuid, id: Uuid, action: &str) -> ApiResult<FriendCard> {
    match action {
        "accept" => accept(db, me, id).await,
        "decline" => decline(db, me, id).await,
        "cancel" => cancel(db, me, id).await,
        "unfriend" => unfriend(db, me, id).await,
        "block" => block(db, me, id).await,
        "unblock" => unblock(db, me, id).await,
        _ => Err(ApiError::Validation("Unknown friends action.".to_owned())),
    }
}

pub async fn set_share(db: &PgPool, me: Uuid, id: Uuid, share: bool) -> ApiResult<FriendCard> {
    let updated = sqlx::query_as::<_, EdgeRow>(
        r#"
        WITH mine AS (
            UPDATE friendships
            SET share_position_low = CASE WHEN user_low = $2 THEN $3 ELSE share_position_low END,
                share_position_high = CASE WHEN user_high = $2 THEN $3 ELSE share_position_high END
            WHERE id = $1
              AND status = 'accepted'
              AND (user_low = $2 OR user_high = $2)
            RETURNING id
        )
        SELECT
            f.id,
            f.status,
            f.requested_by,
            f.blocked_by,
            u.username AS other_username,
            CASE WHEN f.user_low = $2 THEN f.share_position_low ELSE f.share_position_high END AS share_position,
            CASE WHEN f.user_low = $2 THEN f.share_position_high ELSE f.share_position_low END AS their_share_position,
            f.created_at
        FROM friendships f
        JOIN mine ON mine.id = f.id
        JOIN users u ON u.id = CASE WHEN f.user_low = $2 THEN f.user_high ELSE f.user_low END
        "#,
    )
    .bind(id)
    .bind(me)
    .bind(share)
    .fetch_optional(db)
    .await?;

    let row = updated.ok_or(ApiError::NotFound)?;
    Ok(card_without_presence(&row))
}

/// Result of a Desk / right-click action: halo status plus who else to refresh.
pub struct GameApply {
    pub status: &'static str,
    pub other: Option<String>,
}

/// Apply one Desk / right-click action written by the mod.
pub async fn apply_from_game(
    db: &PgPool,
    username: &str,
    action: &str,
    target: Option<&str>,
    friendship_id: Option<&str>,
    share_position: Option<bool>,
) -> ApiResult<GameApply> {
    let me = find_user(db, username)
        .await?
        .ok_or_else(|| ApiError::Validation("You need a website account first.".to_owned()))?;

    match action {
        "request" => {
            let target = nonempty(target)
                .ok_or_else(|| ApiError::Validation("Say who you want to add.".to_owned()))?;
            let card = request(db, me.id, target).await?;
            let status = if card.status == "accepted" {
                "accepted"
            } else {
                "sent"
            };
            Ok(GameApply {
                status,
                other: Some(card.username),
            })
        }
        "share" => {
            let id = parse_id(friendship_id)?;
            let Some(share) = share_position else {
                return Err(ApiError::Validation("Missing share flag.".to_owned()));
            };
            let card = set_share(db, me.id, id, share).await?;
            Ok(GameApply {
                status: "ok",
                other: Some(card.username),
            })
        }
        other => {
            let id = parse_id(friendship_id)?;
            let card = act(db, me.id, id, other).await?;
            Ok(GameApply {
                status: "ok",
                other: Some(card.username),
            })
        }
    }
}

/// Map a service error to the status string the mod shows as a halo.
pub fn game_status(error: &ApiError) -> &'static str {
    match error {
        ApiError::Validation(message) if message.contains("yourself") => "self",
        ApiError::Validation(message) if message.contains("You need a website account") => {
            "unregistered"
        }
        ApiError::Validation(message) if message.contains("does not have a website account") => {
            "not_registered"
        }
        ApiError::Validation(message) if message.contains("already friends") => "already_friends",
        ApiError::Validation(message) if message.contains("already sent") => "already_pending",
        ApiError::Validation(message) if message.contains("Unblock them first") => "blocked",
        ApiError::Validation(message) if message.contains("cannot send") => "blocked",
        ApiError::Validation(message) if message.contains("who you want") => "missing",
        ApiError::Validation(message) if message.contains("Missing friendship") => "missing",
        ApiError::NotFound => "missing",
        _ => "error",
    }
}

/// Whether a failed outbox action should be retried on the next pass.
pub fn retry_outbox(error: &ApiError) -> bool {
    matches!(error, ApiError::Database(_) | ApiError::Internal(_))
}

async fn accept(db: &PgPool, me: Uuid, id: Uuid) -> ApiResult<FriendCard> {
    let updated = sqlx::query_as::<_, EdgeRow>(
        r#"
        WITH mine AS (
            UPDATE friendships
            SET status = 'accepted',
                responded_at = now(),
                blocked_by = NULL
            WHERE id = $1
              AND status = 'pending'
              AND requested_by <> $2
              AND (user_low = $2 OR user_high = $2)
            RETURNING id
        )
        SELECT
            f.id, f.status, f.requested_by, f.blocked_by,
            u.username AS other_username,
            CASE WHEN f.user_low = $2 THEN f.share_position_low ELSE f.share_position_high END AS share_position,
            CASE WHEN f.user_low = $2 THEN f.share_position_high ELSE f.share_position_low END AS their_share_position,
            f.created_at
        FROM friendships f
        JOIN mine ON mine.id = f.id
        JOIN users u ON u.id = CASE WHEN f.user_low = $2 THEN f.user_high ELSE f.user_low END
        "#,
    )
    .bind(id)
    .bind(me)
    .fetch_optional(db)
    .await?;

    let row = updated.ok_or(ApiError::NotFound)?;
    Ok(card_without_presence(&row))
}

async fn decline(db: &PgPool, me: Uuid, id: Uuid) -> ApiResult<FriendCard> {
    let updated = sqlx::query_as::<_, EdgeRow>(
        r#"
        WITH mine AS (
            UPDATE friendships
            SET status = 'declined',
                responded_at = now()
            WHERE id = $1
              AND status = 'pending'
              AND requested_by <> $2
              AND (user_low = $2 OR user_high = $2)
            RETURNING id
        )
        SELECT
            f.id, f.status, f.requested_by, f.blocked_by,
            u.username AS other_username,
            CASE WHEN f.user_low = $2 THEN f.share_position_low ELSE f.share_position_high END AS share_position,
            CASE WHEN f.user_low = $2 THEN f.share_position_high ELSE f.share_position_low END AS their_share_position,
            f.created_at
        FROM friendships f
        JOIN mine ON mine.id = f.id
        JOIN users u ON u.id = CASE WHEN f.user_low = $2 THEN f.user_high ELSE f.user_low END
        "#,
    )
    .bind(id)
    .bind(me)
    .fetch_optional(db)
    .await?;

    let row = updated.ok_or(ApiError::NotFound)?;
    Ok(card_without_presence(&row))
}

async fn cancel(db: &PgPool, me: Uuid, id: Uuid) -> ApiResult<FriendCard> {
    let mut tx = db.begin().await?;
    let row = sqlx::query_as::<_, EdgeRow>(
        r#"
        SELECT
            f.id, f.status, f.requested_by, f.blocked_by,
            u.username AS other_username,
            CASE WHEN f.user_low = $2 THEN f.share_position_low ELSE f.share_position_high END AS share_position,
            CASE WHEN f.user_low = $2 THEN f.share_position_high ELSE f.share_position_low END AS their_share_position,
            f.created_at
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.user_low = $2 THEN f.user_high ELSE f.user_low END
        WHERE f.id = $1
          AND f.status = 'pending'
          AND f.requested_by = $2
        FOR UPDATE OF f
        "#,
    )
    .bind(id)
    .bind(me)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;

    sqlx::query("DELETE FROM friendships WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(card_without_presence(&row))
}

async fn unfriend(db: &PgPool, me: Uuid, id: Uuid) -> ApiResult<FriendCard> {
    let mut tx = db.begin().await?;
    let row = sqlx::query_as::<_, EdgeRow>(
        r#"
        SELECT
            f.id, f.status, f.requested_by, f.blocked_by,
            u.username AS other_username,
            CASE WHEN f.user_low = $2 THEN f.share_position_low ELSE f.share_position_high END AS share_position,
            CASE WHEN f.user_low = $2 THEN f.share_position_high ELSE f.share_position_low END AS their_share_position,
            f.created_at
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.user_low = $2 THEN f.user_high ELSE f.user_low END
        WHERE f.id = $1
          AND f.status = 'accepted'
          AND (f.user_low = $2 OR f.user_high = $2)
        FOR UPDATE OF f
        "#,
    )
    .bind(id)
    .bind(me)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;

    sqlx::query("DELETE FROM friendships WHERE id = $1 AND status = 'accepted'")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(card_without_presence(&row))
}

async fn block(db: &PgPool, me: Uuid, id: Uuid) -> ApiResult<FriendCard> {
    let updated = sqlx::query_as::<_, EdgeRow>(
        r#"
        WITH mine AS (
            UPDATE friendships
            SET status = 'blocked',
                blocked_by = $2,
                responded_at = now()
            WHERE id = $1
              AND (user_low = $2 OR user_high = $2)
              AND (blocked_by IS NULL OR blocked_by = $2)
            RETURNING id
        )
        SELECT
            f.id, f.status, f.requested_by, f.blocked_by,
            u.username AS other_username,
            CASE WHEN f.user_low = $2 THEN f.share_position_low ELSE f.share_position_high END AS share_position,
            CASE WHEN f.user_low = $2 THEN f.share_position_high ELSE f.share_position_low END AS their_share_position,
            f.created_at
        FROM friendships f
        JOIN mine ON mine.id = f.id
        JOIN users u ON u.id = CASE WHEN f.user_low = $2 THEN f.user_high ELSE f.user_low END
        "#,
    )
    .bind(id)
    .bind(me)
    .fetch_optional(db)
    .await?;

    let row = updated.ok_or(ApiError::NotFound)?;
    Ok(card_without_presence(&row))
}

async fn unblock(db: &PgPool, me: Uuid, id: Uuid) -> ApiResult<FriendCard> {
    let mut tx = db.begin().await?;
    let row = sqlx::query_as::<_, EdgeRow>(
        r#"
        SELECT
            f.id, f.status, f.requested_by, f.blocked_by,
            u.username AS other_username,
            CASE WHEN f.user_low = $2 THEN f.share_position_low ELSE f.share_position_high END AS share_position,
            CASE WHEN f.user_low = $2 THEN f.share_position_high ELSE f.share_position_low END AS their_share_position,
            f.created_at
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.user_low = $2 THEN f.user_high ELSE f.user_low END
        WHERE f.id = $1
          AND f.status = 'blocked'
          AND f.blocked_by = $2
        FOR UPDATE OF f
        "#,
    )
    .bind(id)
    .bind(me)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError::NotFound)?;

    sqlx::query("DELETE FROM friendships WHERE id = $1 AND blocked_by = $2")
        .bind(id)
        .bind(me)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(card_without_presence(&row))
}

struct Upserted {
    id: Uuid,
    status: String,
    share_mine: bool,
    share_theirs: bool,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
struct ExistingEdge {
    id: Uuid,
    status: String,
    requested_by: Uuid,
    blocked_by: Option<Uuid>,
    share_position_low: bool,
    share_position_high: bool,
    created_at: DateTime<Utc>,
    user_low: Uuid,
}

async fn upsert_request(
    tx: &mut Transaction<'_, Postgres>,
    me: Uuid,
    them: Uuid,
) -> ApiResult<Upserted> {
    let (low, high) = pair(me, them);

    let existing = sqlx::query_as::<_, ExistingEdge>(
        r#"
        SELECT id, status, requested_by, blocked_by,
               share_position_low, share_position_high, created_at, user_low
        FROM friendships
        WHERE user_low = $1 AND user_high = $2
        FOR UPDATE
        "#,
    )
    .bind(low)
    .bind(high)
    .fetch_optional(&mut **tx)
    .await?;

    match existing {
        None => {
            let id = Uuid::new_v4();
            let created_at = sqlx::query_scalar::<_, DateTime<Utc>>(
                r#"
                INSERT INTO friendships (id, user_low, user_high, requested_by, status)
                VALUES ($1, $2, $3, $4, 'pending')
                RETURNING created_at
                "#,
            )
            .bind(id)
            .bind(low)
            .bind(high)
            .bind(me)
            .fetch_one(&mut **tx)
            .await?;

            Ok(Upserted {
                id,
                status: "pending".to_owned(),
                share_mine: true,
                share_theirs: true,
                created_at,
            })
        }
        Some(row) if row.status == "accepted" => {
            Err(ApiError::Validation("You are already friends.".to_owned()))
        }
        Some(row) if row.status == "blocked" => {
            if row.blocked_by == Some(me) {
                Err(ApiError::Validation(
                    "You blocked this survivor. Unblock them first.".to_owned(),
                ))
            } else {
                Err(ApiError::Validation(
                    "You cannot send a request to this survivor.".to_owned(),
                ))
            }
        }
        Some(row) if row.status == "pending" && row.requested_by == me => Err(
            ApiError::Validation("A request is already sent.".to_owned()),
        ),
        Some(row) if row.status == "pending" => {
            sqlx::query(
                r#"
                UPDATE friendships
                SET status = 'accepted', responded_at = now()
                WHERE id = $1
                "#,
            )
            .bind(row.id)
            .execute(&mut **tx)
            .await?;

            Ok(shares(me, row, "accepted"))
        }
        Some(row) => {
            // declined, or any other reopenable state: send a fresh request.
            sqlx::query(
                r#"
                UPDATE friendships
                SET status = 'pending',
                    requested_by = $2,
                    blocked_by = NULL,
                    responded_at = NULL
                WHERE id = $1
                "#,
            )
            .bind(row.id)
            .bind(me)
            .execute(&mut **tx)
            .await?;

            Ok(shares(me, row, "pending"))
        }
    }
}

fn shares(me: Uuid, row: ExistingEdge, status: &str) -> Upserted {
    let share_mine = if row.user_low == me {
        row.share_position_low
    } else {
        row.share_position_high
    };
    let share_theirs = if row.user_low == me {
        row.share_position_high
    } else {
        row.share_position_low
    };

    Upserted {
        id: row.id,
        status: status.to_owned(),
        share_mine,
        share_theirs,
        created_at: row.created_at,
    }
}

async fn load_edges(db: &PgPool, user_id: Uuid) -> Result<Vec<EdgeRow>, sqlx::Error> {
    sqlx::query_as::<_, EdgeRow>(
        r#"
        SELECT
            f.id,
            f.status,
            f.requested_by,
            f.blocked_by,
            u.username AS other_username,
            CASE WHEN f.user_low = $1 THEN f.share_position_low ELSE f.share_position_high END AS share_position,
            CASE WHEN f.user_low = $1 THEN f.share_position_high ELSE f.share_position_low END AS their_share_position,
            f.created_at
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
        WHERE f.user_low = $1 OR f.user_high = $1
        ORDER BY f.created_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

async fn card(
    row: &EdgeRow,
    online: &[String],
    live: &[LiveMark],
    db: &PgPool,
    include_position: bool,
    map_enabled: bool,
    share_maps: &HashMap<String, bool>,
) -> Result<FriendCard, sqlx::Error> {
    let is_online = character::is_online(online, &row.other_username);
    let live_mark = live
        .iter()
        .find(|mark| mark.username.eq_ignore_ascii_case(&row.other_username));

    let they_share_map = share_maps
        .get(&row.other_username.to_ascii_lowercase())
        .copied()
        .unwrap_or(true);

    let position = if include_position && map_enabled && row.their_share_position && they_share_map
    {
        if let Some(mark) = live_mark {
            Some(FriendPosition {
                x: mark.x,
                y: mark.y,
                z: mark.z,
            })
        } else {
            character::last_position(db, &row.other_username)
                .await?
                .map(|last| FriendPosition {
                    x: last.x,
                    y: last.y,
                    z: last.z,
                })
        }
    } else {
        None
    };

    Ok(FriendCard {
        id: row.id,
        username: row.other_username.clone(),
        status: row.status.clone(),
        online: is_online,
        share_position: row.share_position,
        their_share_position: row.their_share_position,
        position,
        appearance: live_mark.and_then(|mark| mark.appearance.clone()),
        created_at: row.created_at,
    })
}

fn card_without_presence(row: &EdgeRow) -> FriendCard {
    FriendCard {
        id: row.id,
        username: row.other_username.clone(),
        status: row.status.clone(),
        online: false,
        share_position: row.share_position,
        their_share_position: row.their_share_position,
        position: None,
        appearance: None,
        created_at: row.created_at,
    }
}

fn snapshot(card: &FriendCard) -> pz_bridge::FriendSnapshot {
    pz_bridge::FriendSnapshot {
        id: card.id.to_string(),
        username: card.username.clone(),
        online: card.online,
        share_position: card.share_position,
        their_share_position: card.their_share_position,
        x: card.position.as_ref().map(|position| position.x),
        y: card.position.as_ref().map(|position| position.y),
        z: card.position.as_ref().map(|position| position.z),
        created_at: Some(card.created_at.to_rfc3339()),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MapSettings {
    pub map_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Privacy {
    pub share_map: bool,
    pub map_enabled: bool,
}

pub async fn map_settings(db: &PgPool) -> Result<MapSettings, sqlx::Error> {
    Ok(MapSettings {
        map_enabled: map_enabled(db).await?,
    })
}

pub async fn set_map_enabled(db: &PgPool, enabled: bool) -> Result<MapSettings, sqlx::Error> {
    sqlx::query("UPDATE friends_settings SET map_enabled = $1, updated_at = now() WHERE id = 1")
        .bind(enabled)
        .execute(db)
        .await?;

    Ok(MapSettings {
        map_enabled: enabled,
    })
}

pub async fn privacy(db: &PgPool, user_id: Uuid) -> Result<Privacy, sqlx::Error> {
    let share_map = sqlx::query_scalar::<_, bool>("SELECT share_map FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(db)
        .await?;

    Ok(Privacy {
        share_map,
        map_enabled: map_enabled(db).await?,
    })
}

pub async fn set_share_map(
    db: &PgPool,
    user_id: Uuid,
    share_map: bool,
) -> Result<Privacy, sqlx::Error> {
    sqlx::query("UPDATE users SET share_map = $2, updated_at = now() WHERE id = $1")
        .bind(user_id)
        .bind(share_map)
        .execute(db)
        .await?;

    privacy(db, user_id).await
}

/// Usernames this account is friends with, plus its own, for inbox refresh.
pub async fn friend_usernames(db: &PgPool, user_id: Uuid) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT u.username
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
        WHERE (f.user_low = $1 OR f.user_high = $1)
          AND f.status = 'accepted'
        UNION
        SELECT username FROM users WHERE id = $1
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

async fn map_enabled(db: &PgPool) -> Result<bool, sqlx::Error> {
    let enabled =
        sqlx::query_scalar::<_, bool>("SELECT map_enabled FROM friends_settings WHERE id = 1")
            .fetch_optional(db)
            .await?;

    Ok(enabled.unwrap_or(true))
}

#[derive(Debug, Clone, FromRow)]
struct ShareMapRow {
    username: String,
    share_map: bool,
}

async fn share_map_by_name(db: &PgPool) -> Result<HashMap<String, bool>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ShareMapRow>("SELECT username, share_map FROM users")
        .fetch_all(db)
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| (row.username.to_ascii_lowercase(), row.share_map))
        .collect())
}

async fn find_user(db: &PgPool, username: &str) -> Result<Option<NamedUser>, sqlx::Error> {
    sqlx::query_as::<_, NamedUser>(
        r#"
        SELECT id, username
        FROM users
        WHERE username IS NOT NULL AND lower(username) = lower($1)
        "#,
    )
    .bind(username.trim())
    .fetch_optional(db)
    .await
}

async fn require_user(db: &PgPool, username: &str) -> ApiResult<NamedUser> {
    find_user(db, username).await?.ok_or_else(|| {
        ApiError::Validation("That survivor does not have a website account yet.".to_owned())
    })
}

fn parse_id(raw: Option<&str>) -> ApiResult<Uuid> {
    let value =
        nonempty(raw).ok_or_else(|| ApiError::Validation("Missing friendship.".to_owned()))?;
    Uuid::parse_str(value).map_err(|_| ApiError::NotFound)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_is_ordered_and_commutative() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);

        assert_eq!(pair(a, b), (a, b));
        assert_eq!(pair(b, a), (a, b));
        assert_eq!(pair(a, a), (a, a));
    }

    #[test]
    fn a_shared_pin_is_written_into_the_game_snapshot() {
        let card = FriendCard {
            id: Uuid::from_u128(1),
            username: "pike".to_owned(),
            status: "accepted".to_owned(),
            online: true,
            share_position: true,
            their_share_position: true,
            position: Some(FriendPosition {
                x: 1000.0,
                y: 2000.5,
                z: 1,
            }),
            appearance: None,
            created_at: Utc::now(),
        };

        let snap = snapshot(&card);
        assert_eq!(snap.x, Some(1000.0));
        assert_eq!(snap.y, Some(2000.5));
        assert_eq!(snap.z, Some(1));
    }

    #[test]
    fn a_hidden_pin_is_omitted_from_the_game_snapshot() {
        let card = FriendCard {
            id: Uuid::from_u128(1),
            username: "pike".to_owned(),
            status: "accepted".to_owned(),
            online: true,
            share_position: true,
            their_share_position: false,
            position: None,
            appearance: None,
            created_at: Utc::now(),
        };

        let snap = snapshot(&card);
        assert_eq!(snap.x, None);
        assert_eq!(snap.y, None);
        assert_eq!(snap.z, None);
    }

    #[test]
    fn game_status_maps_the_sentences_the_ui_shows() {
        assert_eq!(
            game_status(&ApiError::Validation(
                "You cannot send a friend request to yourself.".to_owned()
            )),
            "self"
        );
        assert_eq!(
            game_status(&ApiError::Validation(
                "That survivor does not have a website account yet.".to_owned()
            )),
            "not_registered"
        );
        assert_eq!(
            game_status(&ApiError::Validation("You are already friends.".to_owned())),
            "already_friends"
        );
        assert_eq!(
            game_status(&ApiError::Validation(
                "You cannot send a request to this survivor.".to_owned()
            )),
            "blocked"
        );
        assert_eq!(
            game_status(&ApiError::Validation(
                "You need a website account first.".to_owned()
            )),
            "unregistered"
        );
        assert_eq!(
            game_status(&ApiError::Validation("Missing friendship.".to_owned())),
            "missing"
        );
        assert_eq!(game_status(&ApiError::NotFound), "missing");
        assert!(retry_outbox(&ApiError::Internal("disk".to_owned())));
        assert!(!retry_outbox(&ApiError::Validation(
            "Missing friendship.".to_owned()
        )));
    }
}
