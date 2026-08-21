//! Player auction house. Items come out of the world first, then bids escrow coins.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::economy::{self, delivery, wallet};
use crate::state::AppState;

const HOUSE_FEE_BPS: i64 = 500;
const SNIPE_WINDOW: i64 = 120;
const DURATIONS: &[i64] = &[12, 24, 48];

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Listing {
    pub id: Uuid,
    pub seller_id: Uuid,
    pub item_type: String,
    pub item_name: String,
    pub quantity: i32,
    pub condition: Option<f32>,
    pub start_price: i64,
    pub buyout_price: Option<i64>,
    pub current_price: i64,
    pub current_bidder_id: Option<Uuid>,
    pub status: String,
    pub ends_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub settled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListingView {
    #[serde(flatten)]
    pub listing: Listing,
    pub seller: String,
    pub current_bidder: Option<String>,
    pub bid_count: i64,
    pub next_bid: i64,
    pub mine: bool,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[allow(dead_code, reason = "row mapping for auction_bids; no query reads it back yet")]
pub struct Bid {
    pub id: Uuid,
    pub listing_id: Uuid,
    pub bidder_id: Uuid,
    pub amount: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ListItem {
    pub item_type: String,
    pub item_name: Option<String>,
    pub quantity: Option<i32>,
    pub condition: Option<f32>,
    pub start_price: i64,
    pub buyout_price: Option<i64>,
    pub hours: Option<i64>,
}

pub async fn catalogue(db: &PgPool, viewer: Option<Uuid>) -> Result<Vec<ListingView>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Listing>(LISTING_SELECT)
        .fetch_all(db)
        .await?;
    let mut views = Vec::with_capacity(rows.len());
    for listing in rows {
        if listing.status != "live" && listing.status != "collecting" {
            continue;
        }
        if listing.status == "collecting" && viewer != Some(listing.seller_id) {
            continue;
        }
        views.push(view(db, listing, viewer).await?);
    }
    Ok(views)
}

pub async fn admin_list(db: &PgPool) -> Result<Vec<ListingView>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Listing>(
        r#"SELECT id, seller_id, item_type, item_name, quantity, condition,
                  start_price, buyout_price, current_price, current_bidder_id,
                  status, ends_at, created_at, settled_at
           FROM auction_listings
           ORDER BY created_at DESC
           LIMIT 200"#,
    )
    .fetch_all(db)
    .await?;
    let mut views = Vec::with_capacity(rows.len());
    for listing in rows {
        views.push(view(db, listing, None).await?);
    }
    Ok(views)
}

pub async fn mine(db: &PgPool, user_id: Uuid) -> Result<Vec<ListingView>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Listing>(
        r#"SELECT id, seller_id, item_type, item_name, quantity, condition,
                  start_price, buyout_price, current_price, current_bidder_id,
                  status, ends_at, created_at, settled_at
           FROM auction_listings
           WHERE seller_id = $1 OR current_bidder_id = $1
           ORDER BY created_at DESC"#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut views = Vec::with_capacity(rows.len());
    for listing in rows {
        views.push(view(db, listing, Some(user_id)).await?);
    }
    Ok(views)
}

pub async fn get_view(
    db: &PgPool,
    id: Uuid,
    viewer: Option<Uuid>,
) -> Result<Option<ListingView>, sqlx::Error> {
    let Some(listing) = get(db, id).await? else {
        return Ok(None);
    };
    Ok(Some(view(db, listing, viewer).await?))
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct BidView {
    pub id: Uuid,
    pub listing_id: Uuid,
    pub bidder_id: Uuid,
    pub bidder: String,
    pub amount: i64,
    pub created_at: DateTime<Utc>,
}

pub async fn bids(db: &PgPool, listing_id: Uuid) -> Result<Vec<BidView>, sqlx::Error> {
    sqlx::query_as::<_, BidView>(
        r#"SELECT b.id, b.listing_id, b.bidder_id, u.username AS bidder,
                  b.amount, b.created_at
           FROM auction_bids b
           JOIN users u ON u.id = b.bidder_id
           WHERE b.listing_id = $1
           ORDER BY b.created_at DESC
           LIMIT 40"#,
    )
    .bind(listing_id)
    .fetch_all(db)
    .await
}

pub async fn list_item(
    state: &AppState,
    seller_id: Uuid,
    username: &str,
    body: ListItem,
) -> ApiResult<ListingView> {
    let item_type = economy::item_type(&body.item_type)?.to_owned();
    let quantity = body.quantity.unwrap_or(1);
    if !(1..=50).contains(&quantity) {
        return Err(ApiError::Validation("List between 1 and 50.".to_owned()));
    }
    let start = economy::coins(body.start_price, "Starting bid")?;
    let buyout = match body.buyout_price {
        Some(value) => Some(economy::coins(value, "Buyout")?),
        None => None,
    };
    if buyout.is_some_and(|value| value < start) {
        return Err(ApiError::Validation(
            "Buyout must be at least the starting bid.".to_owned(),
        ));
    }
    let hours = body.hours.unwrap_or(24);
    if !DURATIONS.contains(&hours) {
        return Err(ApiError::Validation("Duration must be 12, 24 or 48 hours.".to_owned()));
    }
    let condition = crate::services::economy::inventory::wear_fraction(body.condition);
    let name = body
        .item_name
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| item_type.clone());

    let online = state
        .status
        .current()
        .await
        .players
        .iter()
        .any(|name| name == username);
    crate::services::economy::inventory::ensure_available(
        state,
        seller_id,
        username,
        &item_type,
        quantity,
        online,
    )
    .await?;

    let listing = sqlx::query_as::<_, Listing>(
        r#"INSERT INTO auction_listings
            (seller_id, item_type, item_name, quantity, condition, start_price,
             buyout_price, current_price, status, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$6,'collecting', now() + ($8 * interval '1 hour'))
           RETURNING id, seller_id, item_type, item_name, quantity, condition,
                     start_price, buyout_price, current_price, current_bidder_id,
                     status, ends_at, created_at, settled_at"#,
    )
    .bind(seller_id)
    .bind(&item_type)
    .bind(&name)
    .bind(quantity)
    .bind(condition)
    .bind(start)
    .bind(buyout)
    .bind(hours)
    .fetch_one(&state.db)
    .await?;

    delivery::take(
        state,
        username,
        &item_type,
        quantity,
        "auction_take",
        "auction_listing",
        listing.id,
    )
    .await?;

    view(&state.db, listing, Some(seller_id))
        .await
        .map_err(ApiError::from)
}

pub async fn bid(
    state: &AppState,
    listing_id: Uuid,
    bidder_id: Uuid,
    amount: i64,
) -> ApiResult<ListingView> {
    let amount = economy::coins(amount, "Bid")?;
    let mut tx = state.db.begin().await?;
    let listing = lock_listing(&mut tx, listing_id).await?;
    if listing.status != "live" {
        return Err(ApiError::Validation("That auction is not open.".to_owned()));
    }
    if listing.seller_id == bidder_id {
        return Err(ApiError::Validation("You cannot bid on your own listing.".to_owned()));
    }
    if listing.ends_at <= Utc::now() {
        return Err(ApiError::Validation("That auction has ended.".to_owned()));
    }
    let floor = next_bid(&listing);
    if amount < floor {
        return Err(ApiError::Validation(format!("Bid at least {floor} coins.")));
    }

    let available = wallet::available_tx(&mut tx, bidder_id).await?;
    if available < amount {
        return Err(ApiError::Validation(format!(
            "Not enough coins. Available: {available}."
        )));
    }

    if let Some(previous) = listing.current_bidder_id {
        if previous == bidder_id {
            let extra = amount - listing.current_price;
            if extra < 1 {
                return Err(ApiError::Validation("Raise the bid.".to_owned()));
            }
            wallet::debit_tx(
                &mut tx,
                bidder_id,
                extra,
                economy::SOURCE_AUCTION_ESCROW,
                Some("Auction bid raise"),
                Some("auction_listing"),
                Some(listing.id),
            )
            .await?;
        } else {
            wallet::credit_tx(
                &mut tx,
                previous,
                listing.current_price,
                economy::SOURCE_AUCTION_REFUND,
                Some("Outbid"),
                Some("auction_listing"),
                Some(listing.id),
            )
            .await?;
            wallet::debit_tx(
                &mut tx,
                bidder_id,
                amount,
                economy::SOURCE_AUCTION_ESCROW,
                Some("Auction bid"),
                Some("auction_listing"),
                Some(listing.id),
            )
            .await?;
        }
    } else {
        wallet::debit_tx(
            &mut tx,
            bidder_id,
            amount,
            economy::SOURCE_AUCTION_ESCROW,
            Some("Auction bid"),
            Some("auction_listing"),
            Some(listing.id),
        )
        .await?;
    }

    sqlx::query(
        r#"INSERT INTO auction_bids (listing_id, bidder_id, amount)
           VALUES ($1,$2,$3)"#,
    )
    .bind(listing.id)
    .bind(bidder_id)
    .bind(amount)
    .execute(&mut *tx)
    .await?;

    let mut ends_at = listing.ends_at;
    if ends_at.signed_duration_since(Utc::now()).num_seconds() < SNIPE_WINDOW {
        ends_at = Utc::now() + Duration::seconds(SNIPE_WINDOW);
    }

    let buyout_hit = listing.buyout_price == Some(amount) || listing.buyout_price.is_some_and(|buy| amount >= buy);

    sqlx::query(
        r#"UPDATE auction_listings SET
            current_price = $2,
            current_bidder_id = $3,
            ends_at = $4
           WHERE id = $1"#,
    )
    .bind(listing.id)
    .bind(amount)
    .bind(bidder_id)
    .bind(ends_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    if buyout_hit {
        settle(state, listing.id).await?;
    }

    get_view(&state.db, listing.id, Some(bidder_id))
        .await?
        .ok_or_else(|| ApiError::Validation("That auction is gone.".to_owned()))
}

pub async fn buyout(state: &AppState, listing_id: Uuid, bidder_id: Uuid) -> ApiResult<ListingView> {
    let listing = get(&state.db, listing_id)
        .await?
        .ok_or_else(|| ApiError::Validation("That auction is gone.".to_owned()))?;
    let price = listing
        .buyout_price
        .ok_or_else(|| ApiError::Validation("This listing has no buyout.".to_owned()))?;
    bid(state, listing_id, bidder_id, price).await
}

pub async fn cancel(state: &AppState, listing_id: Uuid, actor: Uuid, admin: bool) -> ApiResult<()> {
    let listing = get(&state.db, listing_id)
        .await?
        .ok_or_else(|| ApiError::Validation("That auction is gone.".to_owned()))?;
    if !admin && listing.seller_id != actor {
        return Err(ApiError::Forbidden);
    }
    if listing.status != "live" && listing.status != "collecting" {
        return Err(ApiError::Validation("That auction cannot be cancelled.".to_owned()));
    }
    if listing.current_bidder_id.is_some() && !admin {
        return Err(ApiError::Validation(
            "Someone has already bid. An admin has to pull it.".to_owned(),
        ));
    }

    if let Some(bidder) = listing.current_bidder_id {
        wallet::credit(
            &state.db,
            bidder,
            listing.current_price,
            economy::SOURCE_AUCTION_REFUND,
            Some("Auction cancelled"),
            Some("auction_listing"),
            Some(listing.id),
        )
        .await?;
    }

    sqlx::query(
        r#"UPDATE auction_listings SET status = 'cancelled', settled_at = now()
           WHERE id = $1"#,
    )
    .bind(listing.id)
    .execute(&state.db)
    .await?;

    if listing.status == "live" {
        return_item(state, &listing).await?;
    }
    Ok(())
}

pub async fn tick(state: &AppState) {
    let Ok(due) = sqlx::query_as::<_, Listing>(
        r#"SELECT id, seller_id, item_type, item_name, quantity, condition,
                  start_price, buyout_price, current_price, current_bidder_id,
                  status, ends_at, created_at, settled_at
           FROM auction_listings
           WHERE status = 'live' AND ends_at <= now()"#,
    )
    .fetch_all(&state.db)
    .await
    else {
        return;
    };
    for listing in due {
        let _ = settle(state, listing.id).await;
    }
}

pub async fn on_item_moved(
    state: &AppState,
    listing_id: Uuid,
    kind: &str,
    removed: i32,
) -> ApiResult<()> {
    let Some(listing) = get(&state.db, listing_id).await? else {
        return Ok(());
    };
    if kind == "auction_take" && listing.status == "collecting" {
        let count = removed.max(0);
        if count < 1 {
            sqlx::query(
                r#"UPDATE auction_listings SET status = 'failed', settled_at = now()
                   WHERE id = $1"#,
            )
            .bind(listing_id)
            .execute(&state.db)
            .await?;
            return Ok(());
        }
        sqlx::query(
            r#"UPDATE auction_listings SET status = 'live', quantity = $2
               WHERE id = $1"#,
        )
        .bind(listing_id)
        .bind(count.min(listing.quantity))
        .execute(&state.db)
        .await?;
    }
    Ok(())
}

pub async fn on_item_failed(state: &AppState, listing_id: Uuid, kind: &str) -> ApiResult<()> {
    let Some(listing) = get(&state.db, listing_id).await? else {
        return Ok(());
    };
    if kind == "auction_take" && listing.status == "collecting" {
        sqlx::query(
            r#"UPDATE auction_listings SET status = 'failed', settled_at = now()
               WHERE id = $1"#,
        )
        .bind(listing_id)
        .execute(&state.db)
        .await?;
    }
    Ok(())
}

async fn settle(state: &AppState, listing_id: Uuid) -> ApiResult<()> {
    let listing = get(&state.db, listing_id)
        .await?
        .ok_or_else(|| ApiError::Validation("That auction is gone.".to_owned()))?;
    if listing.status != "live" {
        return Ok(());
    }

    if let Some(winner) = listing.current_bidder_id {
        let fee = listing.current_price * HOUSE_FEE_BPS / 10_000;
        let proceeds = (listing.current_price - fee).max(0);
        if proceeds > 0 {
            wallet::credit(
                &state.db,
                listing.seller_id,
                proceeds,
                economy::SOURCE_AUCTION_SALE,
                Some(&format!("Sold {}", listing.item_name)),
                Some("auction_listing"),
                Some(listing.id),
            )
            .await?;
        }
        sqlx::query(
            r#"UPDATE auction_listings SET status = 'sold', settled_at = now()
               WHERE id = $1"#,
        )
        .bind(listing.id)
        .execute(&state.db)
        .await?;
        if let Some(username) = username_of(&state.db, winner).await? {
            delivery::give_with_condition(
                state,
                &username,
                &listing.item_type,
                listing.quantity,
                listing.condition,
                "auction_give",
                "auction_listing",
                listing.id,
            )
            .await?;
        }
    } else {
        sqlx::query(
            r#"UPDATE auction_listings SET status = 'expired', settled_at = now()
               WHERE id = $1"#,
        )
        .bind(listing.id)
        .execute(&state.db)
        .await?;
        return_item(state, &listing).await?;
    }
    Ok(())
}

async fn return_item(state: &AppState, listing: &Listing) -> ApiResult<()> {
    let Some(username) = username_of(&state.db, listing.seller_id).await? else {
        return Ok(());
    };
    delivery::give_with_condition(
        state,
        &username,
        &listing.item_type,
        listing.quantity,
        listing.condition,
        "auction_return",
        "auction_listing",
        listing.id,
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

async fn get(db: &PgPool, id: Uuid) -> Result<Option<Listing>, sqlx::Error> {
    sqlx::query_as::<_, Listing>(
        r#"SELECT id, seller_id, item_type, item_name, quantity, condition,
                  start_price, buyout_price, current_price, current_bidder_id,
                  status, ends_at, created_at, settled_at
           FROM auction_listings WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

async fn lock_listing(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> ApiResult<Listing> {
    sqlx::query_as::<_, Listing>(
        r#"SELECT id, seller_id, item_type, item_name, quantity, condition,
                  start_price, buyout_price, current_price, current_bidder_id,
                  status, ends_at, created_at, settled_at
           FROM auction_listings WHERE id = $1 FOR UPDATE"#,
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| ApiError::Validation("That auction is gone.".to_owned()))
}

async fn view(db: &PgPool, listing: Listing, viewer: Option<Uuid>) -> Result<ListingView, sqlx::Error> {
    let seller = username_of(db, listing.seller_id)
        .await?
        .unwrap_or_else(|| "unknown".to_owned());
    let current_bidder = match listing.current_bidder_id {
        Some(id) => username_of(db, id).await?,
        None => None,
    };
    let bid_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auction_bids WHERE listing_id = $1")
        .bind(listing.id)
        .fetch_one(db)
        .await?;
    let mine = viewer == Some(listing.seller_id);
    Ok(ListingView {
        next_bid: next_bid(&listing),
        listing,
        seller,
        current_bidder,
        bid_count,
        mine,
    })
}

fn next_bid(listing: &Listing) -> i64 {
    if listing.current_bidder_id.is_none() {
        return listing.start_price;
    }
    let step = (listing.current_price / 20).max(1);
    listing.current_price + step
}

const LISTING_SELECT: &str = r#"SELECT id, seller_id, item_type, item_name, quantity, condition,
                                       start_price, buyout_price, current_price, current_bidder_id,
                                       status, ends_at, created_at, settled_at
                                FROM auction_listings"#;
