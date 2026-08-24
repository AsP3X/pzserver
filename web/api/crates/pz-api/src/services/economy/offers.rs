//! Buy offers on the auction house.
//!
//! A player posts a price and the coins leave their wallet immediately. Staff
//! offers skip that debit — the house mints the payout when someone fills.
//! Filling takes the item from the seller first, then pays them and delivers
//! to the buyer.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::economy::{self, delivery, wallet};
use crate::state::AppState;

const HOUSE_FEE_BPS: i64 = 500;
const DURATIONS: &[i64] = &[12, 24, 48];

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Offer {
    pub id: Uuid,
    pub buyer_id: Uuid,
    pub filler_id: Option<Uuid>,
    pub item_type: String,
    pub item_name: String,
    pub quantity: i32,
    pub price: i64,
    pub staff: bool,
    pub status: String,
    pub ends_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub settled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OfferView {
    #[serde(flatten)]
    pub offer: Offer,
    pub buyer: String,
    pub filler: Option<String>,
    pub mine: bool,
}

#[derive(Debug, Deserialize)]
pub struct PostOffer {
    pub item_type: String,
    pub item_name: Option<String>,
    pub quantity: Option<i32>,
    pub price: i64,
    pub hours: Option<i64>,
}

pub async fn catalogue(db: &PgPool, viewer: Option<Uuid>) -> Result<Vec<OfferView>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Offer>(OFFER_SELECT)
        .fetch_all(db)
        .await?;
    let mut views = Vec::with_capacity(rows.len());
    for offer in rows {
        if offer.status != "live" && offer.status != "collecting" {
            continue;
        }
        if offer.status == "collecting"
            && viewer != Some(offer.buyer_id)
            && viewer != offer.filler_id
        {
            continue;
        }
        views.push(view(db, offer, viewer).await?);
    }
    Ok(views)
}

pub async fn admin_list(db: &PgPool) -> Result<Vec<OfferView>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Offer>(
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, price,
                  staff, status, ends_at, created_at, settled_at
           FROM auction_buy_offers
           ORDER BY created_at DESC
           LIMIT 200"#,
    )
    .fetch_all(db)
    .await?;
    let mut views = Vec::with_capacity(rows.len());
    for offer in rows {
        views.push(view(db, offer, None).await?);
    }
    Ok(views)
}

pub async fn mine(db: &PgPool, user_id: Uuid) -> Result<Vec<OfferView>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Offer>(
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, price,
                  staff, status, ends_at, created_at, settled_at
           FROM auction_buy_offers
           WHERE buyer_id = $1 OR filler_id = $1
           ORDER BY created_at DESC"#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut views = Vec::with_capacity(rows.len());
    for offer in rows {
        views.push(view(db, offer, Some(user_id)).await?);
    }
    Ok(views)
}

pub async fn get_view(
    db: &PgPool,
    id: Uuid,
    viewer: Option<Uuid>,
) -> Result<Option<OfferView>, sqlx::Error> {
    let Some(offer) = get(db, id).await? else {
        return Ok(None);
    };
    Ok(Some(view(db, offer, viewer).await?))
}

pub async fn post(
    state: &AppState,
    buyer_id: Uuid,
    body: PostOffer,
    staff: bool,
) -> ApiResult<OfferView> {
    let item_type = economy::item_type(&body.item_type)?.to_owned();
    let quantity = body.quantity.unwrap_or(1);
    if !(1..=50).contains(&quantity) {
        return Err(ApiError::Validation("Want between 1 and 50.".to_owned()));
    }
    let price = economy::coins(body.price, "Price")?;
    let hours = body.hours.unwrap_or(24);
    if !DURATIONS.contains(&hours) {
        return Err(ApiError::Validation(
            "Duration must be 12, 24 or 48 hours.".to_owned(),
        ));
    }
    let name = body
        .item_name
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| item_type.clone());

    let mut tx = state.db.begin().await?;
    if !staff {
        let available = wallet::available_tx(&mut tx, buyer_id).await?;
        if available < price {
            return Err(ApiError::Validation(format!(
                "Not enough coins. Available: {available}."
            )));
        }
    }
    let offer = sqlx::query_as::<_, Offer>(
        r#"INSERT INTO auction_buy_offers
            (buyer_id, item_type, item_name, quantity, price, staff, status, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,'live', now() + ($7 * interval '1 hour'))
           RETURNING id, buyer_id, filler_id, item_type, item_name, quantity, price,
                     staff, status, ends_at, created_at, settled_at"#,
    )
    .bind(buyer_id)
    .bind(&item_type)
    .bind(&name)
    .bind(quantity)
    .bind(price)
    .bind(staff)
    .bind(hours)
    .fetch_one(&mut *tx)
    .await?;

    if !staff {
        wallet::debit_tx(
            &mut tx,
            buyer_id,
            price,
            economy::SOURCE_OFFER_ESCROW,
            Some("Buy offer"),
            Some("auction_buy_offer"),
            Some(offer.id),
        )
        .await?;
    }
    tx.commit().await?;

    view(&state.db, offer, Some(buyer_id))
        .await
        .map_err(ApiError::from)
}

pub async fn fill(
    state: &AppState,
    offer_id: Uuid,
    filler_id: Uuid,
    username: &str,
) -> ApiResult<OfferView> {
    let offer = get(&state.db, offer_id)
        .await?
        .ok_or_else(|| ApiError::Validation("That offer is gone.".to_owned()))?;
    if offer.status != "live" {
        return Err(ApiError::Validation("That offer is not open.".to_owned()));
    }
    if offer.buyer_id == filler_id {
        return Err(ApiError::Validation(
            "You cannot fill your own offer.".to_owned(),
        ));
    }
    if offer.ends_at <= Utc::now() {
        return Err(ApiError::Validation("That offer has ended.".to_owned()));
    }

    let online = state
        .status
        .current()
        .await
        .players
        .iter()
        .any(|name| name == username);
    crate::services::economy::inventory::ensure_available(
        state,
        filler_id,
        username,
        &offer.item_type,
        offer.quantity,
        online,
    )
    .await?;

    let mut tx = state.db.begin().await?;
    let offer = lock_offer(&mut tx, offer_id).await?;
    if offer.status != "live" {
        return Err(ApiError::Validation("That offer is not open.".to_owned()));
    }
    if offer.ends_at <= Utc::now() {
        return Err(ApiError::Validation("That offer has ended.".to_owned()));
    }
    sqlx::query(
        r#"UPDATE auction_buy_offers SET status = 'collecting', filler_id = $2
           WHERE id = $1"#,
    )
    .bind(offer.id)
    .bind(filler_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    if let Err(error) = delivery::take(
        state,
        username,
        &offer.item_type,
        offer.quantity,
        "auction_offer_take",
        "auction_buy_offer",
        offer.id,
    )
    .await
    {
        fail_fill(state, &offer).await?;
        return Err(error);
    }

    get_view(&state.db, offer.id, Some(filler_id))
        .await?
        .ok_or_else(|| ApiError::Validation("That offer is gone.".to_owned()))
}

pub async fn cancel(state: &AppState, offer_id: Uuid, actor: Uuid, admin: bool) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    let offer = lock_offer(&mut tx, offer_id).await?;
    if !admin && offer.buyer_id != actor {
        return Err(ApiError::Forbidden);
    }
    if offer.status != "live" && offer.status != "collecting" {
        return Err(ApiError::Validation(
            "That offer cannot be cancelled.".to_owned(),
        ));
    }
    if offer.status == "collecting" && !admin {
        return Err(ApiError::Validation(
            "Someone is filling this. An admin has to pull it.".to_owned(),
        ));
    }

    sqlx::query(
        r#"UPDATE auction_buy_offers SET status = 'cancelled', settled_at = now()
           WHERE id = $1"#,
    )
    .bind(offer.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    refund_buyer(state, &offer).await?;
    Ok(())
}

pub async fn tick(state: &AppState) {
    let Ok(due) = sqlx::query_as::<_, Offer>(
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, price,
                  staff, status, ends_at, created_at, settled_at
           FROM auction_buy_offers
           WHERE status = 'live' AND ends_at <= now()"#,
    )
    .fetch_all(&state.db)
    .await
    else {
        return;
    };
    for offer in due {
        let _ = expire(state, offer).await;
    }
}

pub async fn on_item_moved(
    state: &AppState,
    offer_id: Uuid,
    kind: &str,
    removed: i32,
) -> ApiResult<()> {
    let Some(offer) = get(&state.db, offer_id).await? else {
        return Ok(());
    };
    if kind != "auction_offer_take" || offer.status != "collecting" {
        return Ok(());
    }
    let count = removed.max(0);
    if count < 1 {
        fail_fill(state, &offer).await?;
        return Ok(());
    }
    let quantity = count.min(offer.quantity);
    settle(state, offer, quantity).await
}

pub async fn on_item_failed(state: &AppState, offer_id: Uuid, kind: &str) -> ApiResult<()> {
    let Some(offer) = get(&state.db, offer_id).await? else {
        return Ok(());
    };
    if kind == "auction_offer_take" && offer.status == "collecting" {
        fail_fill(state, &offer).await?;
    }
    Ok(())
}

async fn settle(state: &AppState, offer: Offer, quantity: i32) -> ApiResult<()> {
    let Some(filler_id) = offer.filler_id else {
        fail_fill(state, &offer).await?;
        return Ok(());
    };
    let fee = if offer.staff {
        0
    } else {
        offer.price * HOUSE_FEE_BPS / 10_000
    };
    let proceeds = (offer.price - fee).max(0);
    if proceeds > 0 {
        wallet::credit(
            &state.db,
            filler_id,
            proceeds,
            economy::SOURCE_OFFER_SALE,
            Some(&format!("Filled buy offer for {}", offer.item_name)),
            Some("auction_buy_offer"),
            Some(offer.id),
        )
        .await?;
    }
    sqlx::query(
        r#"UPDATE auction_buy_offers SET status = 'filled', quantity = $2, settled_at = now()
           WHERE id = $1"#,
    )
    .bind(offer.id)
    .bind(quantity)
    .execute(&state.db)
    .await?;
    if let Some(username) = username_of(&state.db, offer.buyer_id).await? {
        delivery::give_now(
            state,
            &username,
            &offer.item_type,
            quantity,
            "auction_offer_give",
            "auction_buy_offer",
            offer.id,
        )
        .await?;
    }
    Ok(())
}

async fn fail_fill(state: &AppState, offer: &Offer) -> ApiResult<()> {
    sqlx::query(
        r#"UPDATE auction_buy_offers SET status = 'live', filler_id = NULL
           WHERE id = $1 AND status = 'collecting'"#,
    )
    .bind(offer.id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn expire(state: &AppState, offer: Offer) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    let offer = lock_offer(&mut tx, offer.id).await?;
    if offer.status != "live" {
        return Ok(());
    }
    let updated = sqlx::query(
        r#"UPDATE auction_buy_offers SET status = 'expired', settled_at = now()
           WHERE id = $1 AND status = 'live'"#,
    )
    .bind(offer.id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Ok(());
    }
    tx.commit().await?;
    refund_buyer(state, &offer).await?;
    Ok(())
}

async fn refund_buyer(state: &AppState, offer: &Offer) -> ApiResult<()> {
    if offer.staff {
        return Ok(());
    }
    wallet::credit(
        &state.db,
        offer.buyer_id,
        offer.price,
        economy::SOURCE_OFFER_REFUND,
        Some("Buy offer returned"),
        Some("auction_buy_offer"),
        Some(offer.id),
    )
    .await?;
    Ok(())
}

async fn username_of(db: &PgPool, user_id: Uuid) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
}

async fn get(db: &PgPool, id: Uuid) -> Result<Option<Offer>, sqlx::Error> {
    sqlx::query_as::<_, Offer>(
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, price,
                  staff, status, ends_at, created_at, settled_at
           FROM auction_buy_offers WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

async fn lock_offer(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, id: Uuid) -> ApiResult<Offer> {
    sqlx::query_as::<_, Offer>(
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, price,
                  staff, status, ends_at, created_at, settled_at
           FROM auction_buy_offers WHERE id = $1 FOR UPDATE"#,
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| ApiError::Validation("That offer is gone.".to_owned()))
}

async fn view(db: &PgPool, offer: Offer, viewer: Option<Uuid>) -> Result<OfferView, sqlx::Error> {
    let buyer = username_of(db, offer.buyer_id)
        .await?
        .unwrap_or_else(|| "unknown".to_owned());
    let filler = match offer.filler_id {
        Some(id) => username_of(db, id).await?,
        None => None,
    };
    let mine = viewer == Some(offer.buyer_id);
    Ok(OfferView {
        offer,
        buyer,
        filler,
        mine,
    })
}

const OFFER_SELECT: &str = r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, price,
                                     staff, status, ends_at, created_at, settled_at
                              FROM auction_buy_offers"#;

#[cfg(test)]
mod tests {
    fn proceeds(price: i64, staff: bool) -> i64 {
        let fee = if staff { 0 } else { price * 500 / 10_000 };
        (price - fee).max(0)
    }

    #[test]
    fn a_player_sale_keeps_five_percent() {
        assert_eq!(proceeds(100, false), 95);
        assert_eq!(proceeds(1, false), 1);
    }

    #[test]
    fn a_staff_buyback_pays_the_full_price() {
        assert_eq!(proceeds(100, true), 100);
    }
}
