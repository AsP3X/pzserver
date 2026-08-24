//! Buy offers on the auction house.
//!
//! A player names an item, a count, and a unit price. Coins leave their wallet
//! for the full count. Anyone with the item can fill part of it; when the
//! count is gone the offer comes down. Staff may post unlimited quantity and
//! no end date, house-funded.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::economy::{self, delivery, wallet};
use crate::state::AppState;

const HOUSE_FEE_BPS: i64 = 500;
const DURATIONS: &[i64] = &[12, 24, 48];
const PLAYER_MAX_WANT: i32 = 100;
const FILL_MAX: i32 = 100;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Offer {
    pub id: Uuid,
    pub buyer_id: Uuid,
    pub filler_id: Option<Uuid>,
    pub item_type: String,
    pub item_name: String,
    pub quantity: Option<i32>,
    pub remaining: Option<i32>,
    pub price: i64,
    pub staff: bool,
    pub status: String,
    pub ends_at: Option<DateTime<Utc>>,
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

#[derive(Debug, Clone, FromRow)]
struct Fill {
    pub id: Uuid,
    pub offer_id: Uuid,
    pub filler_id: Uuid,
    pub quantity: i32,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct PostOffer {
    pub item_type: String,
    pub item_name: Option<String>,
    pub quantity: Option<i32>,
    pub price: i64,
    pub hours: Option<i64>,
    pub unlimited: Option<bool>,
    pub indefinite: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct FillOffer {
    pub quantity: i32,
}

pub async fn catalogue(db: &PgPool, viewer: Option<Uuid>) -> Result<Vec<OfferView>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Offer>(OFFER_SELECT)
        .fetch_all(db)
        .await?;
    let mut views = Vec::with_capacity(rows.len());
    for offer in rows {
        if offer.status != "live" {
            continue;
        }
        if offer.remaining == Some(0) {
            continue;
        }
        views.push(view(db, offer, viewer).await?);
    }
    Ok(views)
}

pub async fn admin_list(db: &PgPool) -> Result<Vec<OfferView>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Offer>(
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, remaining, price,
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
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, remaining, price,
                  staff, status, ends_at, created_at, settled_at
           FROM auction_buy_offers
           WHERE buyer_id = $1
              OR filler_id = $1
              OR id IN (
                  SELECT offer_id FROM auction_buy_offer_fills WHERE filler_id = $1
              )
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
    let unlimited = body.unlimited.unwrap_or(false);
    let indefinite = body.indefinite.unwrap_or(false);
    if unlimited && !staff {
        return Err(ApiError::Validation(
            "Only staff can post an unlimited buy offer.".to_owned(),
        ));
    }
    if indefinite && !staff {
        return Err(ApiError::Validation(
            "Only staff can post an offer with no end.".to_owned(),
        ));
    }

    let (quantity, remaining) = if unlimited {
        (None, None)
    } else {
        let quantity = body
            .quantity
            .ok_or_else(|| ApiError::Validation("Say how many you want.".to_owned()))?;
        if !(1..=PLAYER_MAX_WANT).contains(&quantity) && !staff {
            return Err(ApiError::Validation(format!(
                "Want between 1 and {PLAYER_MAX_WANT}."
            )));
        }
        if !(1..=10_000).contains(&quantity) {
            return Err(ApiError::Validation("Want between 1 and 10000.".to_owned()));
        }
        (Some(quantity), Some(quantity))
    };

    let unit = economy::coins(body.price, "Price")?;
    if let Some(count) = quantity {
        economy::coins(unit.saturating_mul(i64::from(count)), "Total")?;
    }

    let ends_at = if indefinite {
        None
    } else {
        let hours = body.hours.unwrap_or(24);
        if !DURATIONS.contains(&hours) {
            return Err(ApiError::Validation(
                "Duration must be 12, 24 or 48 hours.".to_owned(),
            ));
        }
        Some(Utc::now() + Duration::hours(hours))
    };

    let name = body
        .item_name
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| item_type.clone());

    let escrow = match quantity {
        Some(count) if !staff => unit * i64::from(count),
        _ => 0,
    };

    let mut tx = state.db.begin().await?;
    if escrow > 0 {
        let available = wallet::available_tx(&mut tx, buyer_id).await?;
        if available < escrow {
            return Err(ApiError::Validation(format!(
                "Not enough coins. Available: {available}."
            )));
        }
    }
    let offer = sqlx::query_as::<_, Offer>(
        r#"INSERT INTO auction_buy_offers
            (buyer_id, item_type, item_name, quantity, remaining, price, staff, status, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'live',$8)
           RETURNING id, buyer_id, filler_id, item_type, item_name, quantity, remaining, price,
                     staff, status, ends_at, created_at, settled_at"#,
    )
    .bind(buyer_id)
    .bind(&item_type)
    .bind(&name)
    .bind(quantity)
    .bind(remaining)
    .bind(unit)
    .bind(staff)
    .bind(ends_at)
    .fetch_one(&mut *tx)
    .await?;

    if escrow > 0 {
        wallet::debit_tx(
            &mut tx,
            buyer_id,
            escrow,
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
    body: FillOffer,
) -> ApiResult<OfferView> {
    let count = body.quantity;
    if !(1..=FILL_MAX).contains(&count) {
        return Err(ApiError::Validation(format!(
            "Fill between 1 and {FILL_MAX}."
        )));
    }

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
    if offer.ends_at.is_some_and(|ends| ends <= Utc::now()) {
        return Err(ApiError::Validation("That offer has ended.".to_owned()));
    }
    if offer.remaining == Some(0) {
        return Err(ApiError::Validation(
            "That offer is already filled.".to_owned(),
        ));
    }
    if let Some(left) = offer.remaining {
        if count > left {
            return Err(ApiError::Validation(format!(
                "Only {left} left on this offer."
            )));
        }
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
        count,
        online,
    )
    .await?;

    let mut tx = state.db.begin().await?;
    let offer = lock_offer(&mut tx, offer_id).await?;
    if offer.status != "live" {
        return Err(ApiError::Validation("That offer is not open.".to_owned()));
    }
    if offer.ends_at.is_some_and(|ends| ends <= Utc::now()) {
        return Err(ApiError::Validation("That offer has ended.".to_owned()));
    }
    if let Some(left) = offer.remaining {
        if left < 1 {
            return Err(ApiError::Validation(
                "That offer is already filled.".to_owned(),
            ));
        }
        if count > left {
            return Err(ApiError::Validation(format!(
                "Only {left} left on this offer."
            )));
        }
        sqlx::query(
            r#"UPDATE auction_buy_offers
               SET remaining = remaining - $2, filler_id = $3
               WHERE id = $1"#,
        )
        .bind(offer.id)
        .bind(count)
        .bind(filler_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("UPDATE auction_buy_offers SET filler_id = $2 WHERE id = $1")
            .bind(offer.id)
            .bind(filler_id)
            .execute(&mut *tx)
            .await?;
    }

    let fill = sqlx::query_as::<_, Fill>(
        r#"INSERT INTO auction_buy_offer_fills (offer_id, filler_id, quantity, status)
           VALUES ($1,$2,$3,'collecting')
           RETURNING id, offer_id, filler_id, quantity, status"#,
    )
    .bind(offer.id)
    .bind(filler_id)
    .bind(count)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    if let Err(error) = delivery::take(
        state,
        username,
        &offer.item_type,
        count,
        "auction_offer_take",
        "auction_buy_offer_fill",
        fill.id,
    )
    .await
    {
        fail_fill(state, fill.id).await?;
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
    if offer.status != "live" {
        return Err(ApiError::Validation(
            "That offer cannot be cancelled.".to_owned(),
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

    refund_unfilled(state, &offer).await?;
    Ok(())
}

pub async fn tick(state: &AppState) {
    let Ok(due) = sqlx::query_as::<_, Offer>(
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, remaining, price,
                  staff, status, ends_at, created_at, settled_at
           FROM auction_buy_offers
           WHERE status = 'live' AND ends_at IS NOT NULL AND ends_at <= now()"#,
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

pub async fn on_fill_moved(state: &AppState, fill_id: Uuid, removed: i32) -> ApiResult<()> {
    let Some(fill) = get_fill(&state.db, fill_id).await? else {
        return Ok(());
    };
    if fill.status != "collecting" {
        return Ok(());
    }
    let count = removed.max(0);
    if count < 1 {
        fail_fill(state, fill.id).await?;
        return Ok(());
    }
    let quantity = count.min(fill.quantity);
    settle_fill(state, fill, quantity).await
}

pub async fn on_fill_failed(state: &AppState, fill_id: Uuid) -> ApiResult<()> {
    fail_fill(state, fill_id).await
}

/// Older whole-offer takes from before partial fills. Treat as one fill.
pub async fn on_item_moved(
    state: &AppState,
    offer_id: Uuid,
    kind: &str,
    removed: i32,
) -> ApiResult<()> {
    if kind != "auction_offer_take" {
        return Ok(());
    }
    let Some(fill_id) = latest_collecting_fill(&state.db, offer_id).await? else {
        return Ok(());
    };
    on_fill_moved(state, fill_id, removed).await
}

pub async fn on_item_failed(state: &AppState, offer_id: Uuid, kind: &str) -> ApiResult<()> {
    if kind != "auction_offer_take" {
        return Ok(());
    }
    let Some(fill_id) = latest_collecting_fill(&state.db, offer_id).await? else {
        return Ok(());
    };
    fail_fill(state, fill_id).await
}

async fn settle_fill(state: &AppState, fill: Fill, quantity: i32) -> ApiResult<()> {
    let Some(offer) = get(&state.db, fill.offer_id).await? else {
        return Ok(());
    };
    let payout = unit_payout(offer.price, quantity, offer.staff);
    if payout > 0 {
        wallet::credit(
            &state.db,
            fill.filler_id,
            payout,
            economy::SOURCE_OFFER_SALE,
            Some(&format!("Filled buy offer for {}", offer.item_name)),
            Some("auction_buy_offer"),
            Some(offer.id),
        )
        .await?;
    }
    sqlx::query(
        r#"UPDATE auction_buy_offer_fills
           SET status = 'done', quantity = $2, finished_at = now()
           WHERE id = $1"#,
    )
    .bind(fill.id)
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
    close_if_done(state, offer.id).await
}

async fn fail_fill(state: &AppState, fill_id: Uuid) -> ApiResult<()> {
    let Some(fill) = get_fill(&state.db, fill_id).await? else {
        return Ok(());
    };
    if fill.status != "collecting" {
        return Ok(());
    }
    let Some(offer) = get(&state.db, fill.offer_id).await? else {
        return Ok(());
    };

    sqlx::query(
        r#"UPDATE auction_buy_offer_fills
           SET status = 'failed', finished_at = now()
           WHERE id = $1"#,
    )
    .bind(fill.id)
    .execute(&state.db)
    .await?;

    if offer.status == "live" {
        if offer.remaining.is_some() {
            sqlx::query(
                r#"UPDATE auction_buy_offers
                   SET remaining = remaining + $2
                   WHERE id = $1 AND remaining IS NOT NULL"#,
            )
            .bind(offer.id)
            .bind(fill.quantity)
            .execute(&state.db)
            .await?;
        }
    } else if !offer.staff {
        let refund = offer.price * i64::from(fill.quantity);
        if refund > 0 {
            wallet::credit(
                &state.db,
                offer.buyer_id,
                refund,
                economy::SOURCE_OFFER_REFUND,
                Some("Buy offer fill returned"),
                Some("auction_buy_offer"),
                Some(offer.id),
            )
            .await?;
        }
    }
    Ok(())
}

async fn close_if_done(state: &AppState, offer_id: Uuid) -> ApiResult<()> {
    let Some(offer) = get(&state.db, offer_id).await? else {
        return Ok(());
    };
    if offer.status != "live" || offer.remaining != Some(0) {
        return Ok(());
    }
    let pending: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM auction_buy_offer_fills
           WHERE offer_id = $1 AND status = 'collecting'"#,
    )
    .bind(offer_id)
    .fetch_one(&state.db)
    .await?;
    if pending > 0 {
        return Ok(());
    }
    sqlx::query(
        r#"UPDATE auction_buy_offers SET status = 'filled', settled_at = now()
           WHERE id = $1 AND status = 'live' AND remaining = 0"#,
    )
    .bind(offer_id)
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
    refund_unfilled(state, &offer).await?;
    Ok(())
}

/// Coins still sitting on the unfilled (and not currently collecting) remainder.
async fn refund_unfilled(state: &AppState, offer: &Offer) -> ApiResult<()> {
    if offer.staff {
        return Ok(());
    }
    let leftover = offer.remaining.unwrap_or(0);
    if leftover < 1 {
        return Ok(());
    }
    let refund = offer.price * i64::from(leftover);
    if refund < 1 {
        return Ok(());
    }
    wallet::credit(
        &state.db,
        offer.buyer_id,
        refund,
        economy::SOURCE_OFFER_REFUND,
        Some("Buy offer returned"),
        Some("auction_buy_offer"),
        Some(offer.id),
    )
    .await?;
    Ok(())
}

fn unit_payout(unit: i64, quantity: i32, staff: bool) -> i64 {
    let gross = unit * i64::from(quantity);
    let fee = if staff {
        0
    } else {
        gross * HOUSE_FEE_BPS / 10_000
    };
    (gross - fee).max(0)
}

async fn username_of(db: &PgPool, user_id: Uuid) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
}

async fn get(db: &PgPool, id: Uuid) -> Result<Option<Offer>, sqlx::Error> {
    sqlx::query_as::<_, Offer>(
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, remaining, price,
                  staff, status, ends_at, created_at, settled_at
           FROM auction_buy_offers WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

async fn get_fill(db: &PgPool, id: Uuid) -> Result<Option<Fill>, sqlx::Error> {
    sqlx::query_as::<_, Fill>(
        r#"SELECT id, offer_id, filler_id, quantity, status
           FROM auction_buy_offer_fills WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

async fn latest_collecting_fill(db: &PgPool, offer_id: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT id FROM auction_buy_offer_fills
           WHERE offer_id = $1 AND status = 'collecting'
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(offer_id)
    .fetch_optional(db)
    .await
}

async fn lock_offer(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, id: Uuid) -> ApiResult<Offer> {
    sqlx::query_as::<_, Offer>(
        r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, remaining, price,
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

const OFFER_SELECT: &str = r#"SELECT id, buyer_id, filler_id, item_type, item_name, quantity, remaining, price,
                                     staff, status, ends_at, created_at, settled_at
                              FROM auction_buy_offers"#;

#[cfg(test)]
mod tests {
    use super::unit_payout;

    #[test]
    fn a_player_sale_keeps_five_percent() {
        assert_eq!(unit_payout(100, 1, false), 95);
        assert_eq!(unit_payout(10, 3, false), 29);
        assert_eq!(unit_payout(1, 1, false), 1);
    }

    #[test]
    fn a_staff_buyback_pays_the_full_price() {
        assert_eq!(unit_payout(100, 4, true), 400);
    }

    #[test]
    fn leftover_units_are_the_unfilled_remainder() {
        assert_eq!(Some(10).map(|want| want - 3), Some(7));
        assert_eq!(Option::<i32>::None, None);
    }
}
