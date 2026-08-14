//! Give and take items. RCON when the player is online, Lua queue otherwise.

use chrono::{DateTime, Utc};
use pz_bridge::{DeliveryChannel, DeliveryEntry};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::admin;
use crate::state::AppState;

const MAX_ATTEMPTS: i32 = 40;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ItemOrder {
    pub id: Uuid,
    pub lua_id: String,
    pub kind: String,
    pub reference_type: String,
    pub reference_id: Uuid,
    pub username: String,
    pub item_type: String,
    pub count: i32,
    pub condition: Option<f32>,
    pub action: String,
    pub status: String,
    pub attempts: i32,
    pub detail: Option<String>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

pub async fn give_now(
    state: &AppState,
    username: &str,
    item_type: &str,
    count: i32,
    kind: &str,
    reference_type: &str,
    reference_id: Uuid,
) -> ApiResult<GiveOutcome> {
    if try_rcon_give(state, username, item_type, count).await {
        return Ok(GiveOutcome::Instant);
    }
    let order = enqueue(
        state,
        "give_verified",
        username,
        item_type,
        count,
        None,
        None,
        kind,
        reference_type,
        reference_id,
    )
    .await?;
    Ok(GiveOutcome::Queued(order))
}

pub async fn take(
    state: &AppState,
    username: &str,
    item_type: &str,
    count: i32,
    kind: &str,
    reference_type: &str,
    reference_id: Uuid,
) -> ApiResult<ItemOrder> {
    enqueue(
        state,
        "remove_verified",
        username,
        item_type,
        count,
        None,
        None,
        kind,
        reference_type,
        reference_id,
    )
    .await
}

pub async fn give_with_condition(
    state: &AppState,
    username: &str,
    item_type: &str,
    count: i32,
    condition: Option<f32>,
    kind: &str,
    reference_type: &str,
    reference_id: Uuid,
) -> ApiResult<ItemOrder> {
    let action = if condition.is_some() {
        "give_with_condition"
    } else {
        "give_verified"
    };
    enqueue(
        state,
        action,
        username,
        item_type,
        count,
        condition,
        None,
        kind,
        reference_type,
        reference_id,
    )
    .await
}

pub async fn give_kit(
    state: &AppState,
    username: &str,
    item_type: &str,
    condition: Option<f32>,
    cargo: &serde_json::Value,
    kind: &str,
    reference_type: &str,
    reference_id: Uuid,
) -> ApiResult<ItemOrder> {
    enqueue(
        state,
        "give_kit",
        username,
        item_type,
        1,
        condition,
        Some(cargo.clone()),
        kind,
        reference_type,
        reference_id,
    )
    .await
}

async fn enqueue(
    state: &AppState,
    action: &str,
    username: &str,
    item_type: &str,
    count: i32,
    condition: Option<f32>,
    cargo: Option<serde_json::Value>,
    kind: &str,
    reference_type: &str,
    reference_id: Uuid,
) -> ApiResult<ItemOrder> {
    let lua_id = Uuid::new_v4().to_string();
    let channel = DeliveryChannel::new(&state.config.lua_bridge_path);
    channel
        .enqueue(DeliveryEntry {
            id: lua_id.clone(),
            action: action.to_owned(),
            username: username.to_owned(),
            item_type: item_type.to_owned(),
            count,
            status: "pending".to_owned(),
            created_at: Utc::now().to_rfc3339(),
            condition,
            cargo,
        })
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    let row = sqlx::query_as::<_, ItemOrder>(
        r#"INSERT INTO item_orders
            (lua_id, kind, reference_type, reference_id, username, item_type,
             count, condition, action, status, attempts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',1)
           RETURNING id, lua_id, kind, reference_type, reference_id, username,
                     item_type, count, condition, action, status, attempts,
                     detail, created_at, finished_at"#,
    )
    .bind(&lua_id)
    .bind(kind)
    .bind(reference_type)
    .bind(reference_id)
    .bind(username)
    .bind(item_type)
    .bind(count)
    .bind(condition)
    .bind(action)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

pub async fn try_rcon_give(state: &AppState, username: &str, item_type: &str, count: i32) -> bool {
    let online = state.status.current().await.players;
    if !online.iter().any(|name| name == username) {
        return false;
    }
    let Ok(name) = admin::player_name(username) else {
        return false;
    };
    if count < 1 || count > 100 || item_type.contains('"') {
        return false;
    }
    let command = format!("additem \"{name}\" \"{item_type}\" {count}");
    admin::console(state, &command).await.is_ok()
}

pub async fn tick(state: &AppState) {
    let Ok(orders) = pending(&state.db).await else {
        return;
    };
    if orders.is_empty() {
        return;
    }

    let channel = DeliveryChannel::new(&state.config.lua_bridge_path);
    let Ok(ledger) = channel.results().await else {
        return;
    };

    for order in orders {
        if let Some(result) = ledger.results.iter().find(|row| row.id == order.lua_id) {
            apply_result(state, &order, result).await;
            continue;
        }

        if order.attempts >= MAX_ATTEMPTS {
            let _ = mark_failed(&state.db, order.id, Some("Gave up waiting for the game.")).await;
            finish_failed(state, &order).await;
        }
    }
}

async fn apply_result(state: &AppState, order: &ItemOrder, result: &pz_bridge::DeliveryResult) {
    let offline = result
        .message
        .as_deref()
        .is_some_and(|message| message.contains("not online"));

    if result.status == "delivered" || result.status == "ok" {
        let removed = result.removed_count.unwrap_or(order.count);
        let _ = mark_done(&state.db, order.id, result.message.as_deref()).await;
        finish_ok(state, order, removed).await;
        return;
    }

    if offline && order.attempts < MAX_ATTEMPTS {
        if requeue(state, order).await.is_err() {
            let _ = mark_failed(&state.db, order.id, result.message.as_deref()).await;
            finish_failed(state, order).await;
        }
        return;
    }

    let _ = mark_failed(&state.db, order.id, result.message.as_deref()).await;
    finish_failed(state, order).await;
}

async fn finish_ok(state: &AppState, order: &ItemOrder, removed: i32) {
    match order.reference_type.as_str() {
        "store_purchase" => {
            let _ = crate::services::economy::store::on_delivered(state, order.reference_id).await;
        }
        "auction_listing" => {
            let _ = crate::services::economy::auction::on_item_moved(
                state,
                order.reference_id,
                &order.kind,
                removed,
            )
            .await;
        }
        "vault_move" => {
            let _ = crate::services::economy::vault::on_delivered(state, order.reference_id, removed)
                .await;
        }
        _ => {}
    }
}

async fn finish_failed(state: &AppState, order: &ItemOrder) {
    match order.reference_type.as_str() {
        "store_purchase" => {
            let _ = crate::services::economy::store::on_failed(state, order.reference_id).await;
        }
        "auction_listing" => {
            let _ = crate::services::economy::auction::on_item_failed(
                state,
                order.reference_id,
                &order.kind,
            )
            .await;
        }
        "vault_move" => {
            let _ = crate::services::economy::vault::on_failed(state, order.reference_id).await;
        }
        _ => {}
    }
}

async fn requeue(state: &AppState, order: &ItemOrder) -> ApiResult<()> {
    let cargo = if order.action == "give_kit" {
        sqlx::query_scalar::<_, serde_json::Value>(
            "SELECT cargo FROM vault_moves WHERE id = $1",
        )
        .bind(order.reference_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
    } else {
        None
    };
    let lua_id = Uuid::new_v4().to_string();
    let channel = DeliveryChannel::new(&state.config.lua_bridge_path);
    channel
        .enqueue(DeliveryEntry {
            id: lua_id.clone(),
            action: order.action.clone(),
            username: order.username.clone(),
            item_type: order.item_type.clone(),
            count: order.count,
            status: "pending".to_owned(),
            created_at: Utc::now().to_rfc3339(),
            condition: order.condition,
            cargo,
        })
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    sqlx::query(
        r#"UPDATE item_orders SET lua_id = $2, attempts = attempts + 1
           WHERE id = $1"#,
    )
    .bind(order.id)
    .bind(&lua_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn pending(db: &PgPool) -> Result<Vec<ItemOrder>, sqlx::Error> {
    sqlx::query_as::<_, ItemOrder>(
        r#"SELECT id, lua_id, kind, reference_type, reference_id, username,
                  item_type, count, condition, action, status, attempts,
                  detail, created_at, finished_at
           FROM item_orders WHERE status = 'pending'
           ORDER BY created_at ASC LIMIT 80"#,
    )
    .fetch_all(db)
    .await
}

async fn mark_done(db: &PgPool, id: Uuid, detail: Option<&str>) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE item_orders SET status = 'done', detail = $2, finished_at = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(detail)
    .execute(db)
    .await?;
    Ok(())
}

async fn mark_failed(db: &PgPool, id: Uuid, detail: Option<&str>) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE item_orders SET status = 'failed', detail = $2, finished_at = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(detail)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Debug)]
pub enum GiveOutcome {
    Instant,
    Queued(ItemOrder),
}
