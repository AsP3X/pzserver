//! Last-known pack. Offline management is this snapshot plus queued orders.
//!
//! The game will not edit a disconnected character. We reserve against the
//! last snapshot and let Knox Relay apply the take or give on the next join.

use pz_bridge::InventoryReader;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct InventoryHold {
    pub item_type: String,
    pub item_name: String,
    pub quantity: i32,
    pub kind: String,
}

pub async fn carried(state: &AppState, username: &str, item_type: &str) -> Result<i32, sqlx::Error> {
    let reader = InventoryReader::new(&state.config.lua_bridge_path);
    let Ok(Some(file)) = reader.read(username).await else {
        return Ok(0);
    };
    let short = item_type.rsplit('.').next().unwrap_or(item_type);
    Ok(file
        .data
        .items
        .iter()
        .filter(|item| item.full_type == item_type || item.full_type.rsplit('.').next() == Some(short))
        .map(|item| item.count as i32)
        .sum())
}

pub async fn has_snapshot(state: &AppState, username: &str) -> bool {
    let reader = InventoryReader::new(&state.config.lua_bridge_path);
    matches!(reader.read(username).await, Ok(Some(_)))
}

pub async fn reserved(db: &PgPool, user_id: Uuid, item_type: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(quantity), 0)::bigint
           FROM auction_listings
           WHERE seller_id = $1
             AND item_type = $2
             AND status = 'collecting'"#,
    )
    .bind(user_id)
    .bind(item_type)
    .fetch_one(db)
    .await
}

pub async fn ensure_available(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    item_type: &str,
    want: i32,
    online: bool,
) -> ApiResult<()> {
    let snapshot = has_snapshot(state, username).await;
    if !snapshot {
        if online {
            return Ok(());
        }
        return Err(ApiError::Validation(
            "No inventory recorded yet. Join once so we know what you carry.".to_owned(),
        ));
    }

    let have = carried(state, username, item_type)
        .await
        .map_err(ApiError::from)?;
    let held = reserved(&state.db, user_id, item_type)
        .await
        .map_err(ApiError::from)?;
    let vaulted = super::vault::pending_store_quantity(&state.db, user_id, item_type)
        .await
        .map_err(ApiError::from)?;
    let free = i64::from(have) - held - vaulted;
    if free < i64::from(want) {
        return Err(ApiError::Validation(format!(
            "Your last snapshot has {have} of that, {held} listed and {vaulted} going to the vault. Need {want}."
        )));
    }
    Ok(())
}

pub fn wear_fraction(raw: Option<f32>) -> Option<f32> {
    let value = raw?;
    let fraction = if value > 1.0 { value / 100.0 } else { value };
    Some(fraction.clamp(0.0, 1.0))
}

pub async fn holds(db: &PgPool, user_id: Uuid, username: &str) -> Result<Vec<InventoryHold>, sqlx::Error> {
    let listings = sqlx::query_as::<_, (String, String, i32)>(
        r#"SELECT item_type, item_name, quantity
           FROM auction_listings
           WHERE seller_id = $1 AND status = 'collecting'"#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    let mut out: Vec<InventoryHold> = listings
        .into_iter()
        .map(|(item_type, item_name, quantity)| InventoryHold {
            item_type,
            item_name,
            quantity,
            kind: "auction_take".to_owned(),
        })
        .collect();

    let orders = sqlx::query_as::<_, (String, i32, String)>(
        r#"SELECT item_type, count, kind
           FROM item_orders
           WHERE username = $1 AND status = 'pending' AND kind <> 'auction_take'"#,
    )
    .bind(username)
    .fetch_all(db)
    .await?;

    for (item_type, quantity, kind) in orders {
        out.push(InventoryHold {
            item_name: item_type.clone(),
            item_type,
            quantity,
            kind,
        });
    }

    let mut vaulted = super::vault::pending_holds(db, user_id).await?;
    out.append(&mut vaulted);
    Ok(out)
}
