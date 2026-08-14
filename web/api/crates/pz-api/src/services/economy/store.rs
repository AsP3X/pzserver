//! Staff-defined catalogue. Fixed prices, optional stock, deliver-then-debit.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::economy::{self, delivery, wallet};
use crate::state::AppState;

const CATEGORIES: &[&str] = &[
    "weapons", "ammo", "food", "medical", "tools", "clothing", "other",
];

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct StoreItem {
    pub id: Uuid,
    pub name: String,
    pub item_type: String,
    pub description: Option<String>,
    pub category: String,
    pub quantity: i32,
    pub price: i64,
    pub stock: Option<i32>,
    pub max_per_player: Option<i32>,
    pub featured: bool,
    pub active: bool,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct StorePurchase {
    pub id: Uuid,
    pub user_id: Uuid,
    pub item_id: Option<Uuid>,
    pub item_type: String,
    pub item_name: String,
    pub quantity: i32,
    pub unit_price: i64,
    pub total_price: i64,
    pub status: String,
    pub wallet_transaction_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Default, Deserialize)]
pub struct StoreItemPatch {
    pub name: Option<String>,
    pub item_type: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub quantity: Option<i32>,
    pub price: Option<i64>,
    pub stock: Option<Option<i32>>,
    pub max_per_player: Option<Option<i32>>,
    pub featured: Option<bool>,
    pub active: Option<bool>,
    pub sort_order: Option<i32>,
}

pub async fn list_public(db: &PgPool) -> Result<Vec<StoreItem>, sqlx::Error> {
    sqlx::query_as::<_, StoreItem>(SELECT)
        .fetch_all(db)
        .await
        .map(|rows| rows.into_iter().filter(|item| item.active).collect())
}

pub async fn list_admin(db: &PgPool) -> Result<Vec<StoreItem>, sqlx::Error> {
    sqlx::query_as::<_, StoreItem>(SELECT).fetch_all(db).await
}

const SELECT: &str = r#"SELECT id, name, item_type, description, category, quantity, price,
                               stock, max_per_player, featured, active, sort_order,
                               created_at, updated_at
                        FROM store_items
                        ORDER BY featured DESC, sort_order ASC, name ASC"#;

pub async fn get(db: &PgPool, id: Uuid) -> Result<Option<StoreItem>, sqlx::Error> {
    sqlx::query_as::<_, StoreItem>(
        r#"SELECT id, name, item_type, description, category, quantity, price,
                  stock, max_per_player, featured, active, sort_order,
                  created_at, updated_at
           FROM store_items WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn create(db: &PgPool, body: StoreItemPatch) -> ApiResult<StoreItem> {
    let draft = normalised(body, None)?;
    let row = sqlx::query_as::<_, StoreItem>(
        r#"INSERT INTO store_items
            (name, item_type, description, category, quantity, price, stock,
             max_per_player, featured, active, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, name, item_type, description, category, quantity, price,
                     stock, max_per_player, featured, active, sort_order,
                     created_at, updated_at"#,
    )
    .bind(&draft.name)
    .bind(&draft.item_type)
    .bind(&draft.description)
    .bind(&draft.category)
    .bind(draft.quantity)
    .bind(draft.price)
    .bind(draft.stock)
    .bind(draft.max_per_player)
    .bind(draft.featured)
    .bind(draft.active)
    .bind(draft.sort_order)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn update(db: &PgPool, id: Uuid, body: StoreItemPatch) -> ApiResult<StoreItem> {
    let current = get(db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That listing is gone.".to_owned()))?;
    let draft = normalised(body, Some(&current))?;
    sqlx::query(
        r#"UPDATE store_items SET
            name = $2, item_type = $3, description = $4, category = $5,
            quantity = $6, price = $7, stock = $8, max_per_player = $9,
            featured = $10, active = $11, sort_order = $12, updated_at = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(&draft.name)
    .bind(&draft.item_type)
    .bind(&draft.description)
    .bind(&draft.category)
    .bind(draft.quantity)
    .bind(draft.price)
    .bind(draft.stock)
    .bind(draft.max_per_player)
    .bind(draft.featured)
    .bind(draft.active)
    .bind(draft.sort_order)
    .execute(db)
    .await?;
    get(db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That listing is gone.".to_owned()))
}

pub async fn delete(db: &PgPool, id: Uuid) -> ApiResult<()> {
    let result = sqlx::query("DELETE FROM store_items WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::Validation("That listing is gone.".to_owned()));
    }
    Ok(())
}

pub async fn purchases_for(db: &PgPool, user_id: Uuid) -> Result<Vec<StorePurchase>, sqlx::Error> {
    sqlx::query_as::<_, StorePurchase>(PURCHASE_SELECT)
        .bind(user_id)
        .fetch_all(db)
        .await
}

pub async fn purchases_all(db: &PgPool) -> Result<Vec<StorePurchaseRow>, sqlx::Error> {
    sqlx::query_as::<_, StorePurchaseRow>(
        r#"SELECT p.id, p.user_id, u.username, p.item_id, p.item_type, p.item_name,
                  p.quantity, p.unit_price, p.total_price, p.status,
                  p.wallet_transaction_id, p.created_at, p.finished_at
           FROM store_purchases p
           JOIN users u ON u.id = p.user_id
           ORDER BY p.created_at DESC
           LIMIT 80"#,
    )
    .fetch_all(db)
    .await
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct StorePurchaseRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub item_id: Option<Uuid>,
    pub item_type: String,
    pub item_name: String,
    pub quantity: i32,
    pub unit_price: i64,
    pub total_price: i64,
    pub status: String,
    pub wallet_transaction_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

const PURCHASE_SELECT: &str = r#"SELECT id, user_id, item_id, item_type, item_name, quantity,
                                        unit_price, total_price, status, wallet_transaction_id,
                                        created_at, finished_at
                                 FROM store_purchases
                                 WHERE user_id = $1
                                 ORDER BY created_at DESC
                                 LIMIT 40"#;

pub async fn buy(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    item_id: Uuid,
    quantity: i32,
) -> ApiResult<StorePurchase> {
    if !(1..=20).contains(&quantity) {
        return Err(ApiError::Validation("Buy between 1 and 20.".to_owned()));
    }

    let mut tx = state.db.begin().await?;
    let item = sqlx::query_as::<_, StoreItem>(
        r#"SELECT id, name, item_type, description, category, quantity, price,
                  stock, max_per_player, featured, active, sort_order,
                  created_at, updated_at
           FROM store_items WHERE id = $1 FOR UPDATE"#,
    )
    .bind(item_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::Validation("That item is gone.".to_owned()))?;

    if !item.active {
        return Err(ApiError::Validation("That item is not for sale.".to_owned()));
    }

    let units = item.quantity.saturating_mul(quantity);
    let total = item.price.saturating_mul(i64::from(quantity));

    if let Some(stock) = item.stock {
        if stock < quantity {
            return Err(ApiError::Validation("Not enough stock.".to_owned()));
        }
        sqlx::query("UPDATE store_items SET stock = stock - $2 WHERE id = $1")
            .bind(item.id)
            .bind(quantity)
            .execute(&mut *tx)
            .await?;
    }

    if let Some(cap) = item.max_per_player {
        let already: i64 = sqlx::query_scalar(
            r#"SELECT COALESCE(SUM(quantity), 0)::bigint FROM store_purchases
               WHERE user_id = $1 AND item_id = $2
                 AND status IN ('pending', 'queued', 'delivered')"#,
        )
        .bind(user_id)
        .bind(item.id)
        .fetch_one(&mut *tx)
        .await?;
        if already + i64::from(quantity) > i64::from(cap) {
            return Err(ApiError::Validation(
                "You have already bought the limit of that item.".to_owned(),
            ));
        }
    }

    let available = wallet::available_tx(&mut tx, user_id).await?;
    if available < total {
        return Err(ApiError::Validation(format!(
            "Not enough coins. Available: {available}."
        )));
    }

    let purchase = sqlx::query_as::<_, StorePurchase>(
        r#"INSERT INTO store_purchases
            (user_id, item_id, item_type, item_name, quantity, unit_price, total_price, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
           RETURNING id, user_id, item_id, item_type, item_name, quantity, unit_price,
                     total_price, status, wallet_transaction_id, created_at, finished_at"#,
    )
    .bind(user_id)
    .bind(item.id)
    .bind(&item.item_type)
    .bind(&item.name)
    .bind(quantity)
    .bind(item.price)
    .bind(total)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    match delivery::give_now(
        state,
        username,
        &item.item_type,
        units,
        "store_give",
        "store_purchase",
        purchase.id,
    )
    .await?
    {
        delivery::GiveOutcome::Instant => on_delivered(state, purchase.id).await,
        delivery::GiveOutcome::Queued(_) => {
            sqlx::query("UPDATE store_purchases SET status = 'queued' WHERE id = $1")
                .bind(purchase.id)
                .execute(&state.db)
                .await?;
            get_purchase(&state.db, purchase.id)
                .await?
                .ok_or_else(|| ApiError::Validation("That purchase is gone.".to_owned()))
        }
    }
}

pub async fn on_delivered(state: &AppState, purchase_id: Uuid) -> ApiResult<StorePurchase> {
    let purchase = get_purchase(&state.db, purchase_id)
        .await?
        .ok_or_else(|| ApiError::Validation("That purchase is gone.".to_owned()))?;
    if purchase.wallet_transaction_id.is_some() {
        return Ok(purchase);
    }
    if purchase.total_price == 0 {
        sqlx::query(
            r#"UPDATE store_purchases SET status = 'delivered', finished_at = now()
               WHERE id = $1"#,
        )
        .bind(purchase_id)
        .execute(&state.db)
        .await?;
        return get_purchase(&state.db, purchase_id)
            .await?
            .ok_or_else(|| ApiError::Validation("That purchase is gone.".to_owned()));
    }

    let tx_row = wallet::debit(
        &state.db,
        purchase.user_id,
        purchase.total_price,
        economy::SOURCE_STORE,
        Some(&format!("Store: {}", purchase.item_name)),
        Some("store_purchase"),
        Some(purchase.id),
    )
    .await;

    match tx_row {
        Ok(row) => {
            sqlx::query(
                r#"UPDATE store_purchases SET
                    status = 'delivered',
                    wallet_transaction_id = $2,
                    finished_at = now()
                   WHERE id = $1"#,
            )
            .bind(purchase_id)
            .bind(row.id)
            .execute(&state.db)
            .await?;
        }
        Err(error) => {
            tracing::error!(%error, %purchase_id, "store debit after delivery failed");
            sqlx::query(
                r#"UPDATE store_purchases SET status = 'delivered', finished_at = now()
                   WHERE id = $1"#,
            )
            .bind(purchase_id)
            .execute(&state.db)
            .await?;
        }
    }

    get_purchase(&state.db, purchase_id)
        .await?
        .ok_or_else(|| ApiError::Validation("That purchase is gone.".to_owned()))
}

pub async fn on_failed(state: &AppState, purchase_id: Uuid) -> ApiResult<()> {
    let purchase = match get_purchase(&state.db, purchase_id).await? {
        Some(row) => row,
        None => return Ok(()),
    };
    if purchase.status == "delivered" || purchase.status == "refunded" {
        return Ok(());
    }
    sqlx::query(
        r#"UPDATE store_purchases SET status = 'failed', finished_at = now()
           WHERE id = $1"#,
    )
    .bind(purchase_id)
    .execute(&state.db)
    .await?;
    if let Some(item_id) = purchase.item_id {
        sqlx::query(
            r#"UPDATE store_items SET stock = stock + $2
               WHERE id = $1 AND stock IS NOT NULL"#,
        )
        .bind(item_id)
        .bind(purchase.quantity)
        .execute(&state.db)
        .await?;
    }
    Ok(())
}

async fn get_purchase(db: &PgPool, id: Uuid) -> Result<Option<StorePurchase>, sqlx::Error> {
    sqlx::query_as::<_, StorePurchase>(
        r#"SELECT id, user_id, item_id, item_type, item_name, quantity, unit_price,
                  total_price, status, wallet_transaction_id, created_at, finished_at
           FROM store_purchases WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

struct Draft {
    name: String,
    item_type: String,
    description: Option<String>,
    category: String,
    quantity: i32,
    price: i64,
    stock: Option<i32>,
    max_per_player: Option<i32>,
    featured: bool,
    active: bool,
    sort_order: i32,
}

fn normalised(patch: StoreItemPatch, current: Option<&StoreItem>) -> ApiResult<Draft> {
    let name = patch
        .name
        .or_else(|| current.map(|row| row.name.clone()))
        .unwrap_or_default();
    let name = name.trim().to_owned();
    if name.is_empty() || name.len() > 80 {
        return Err(ApiError::Validation(
            "Give the item a name of at most 80 characters.".to_owned(),
        ));
    }
    let item_type = economy::item_type(
        patch
            .item_type
            .as_deref()
            .or(current.map(|row| row.item_type.as_str()))
            .unwrap_or(""),
    )?
    .to_owned();
    let category = patch
        .category
        .or_else(|| current.map(|row| row.category.clone()))
        .unwrap_or_else(|| "other".to_owned());
    if !CATEGORIES.contains(&category.as_str()) {
        return Err(ApiError::Validation("Unknown category.".to_owned()));
    }
    let quantity = patch.quantity.or(current.map(|row| row.quantity)).unwrap_or(1);
    if !(1..=100).contains(&quantity) {
        return Err(ApiError::Validation("Quantity must be 1–100.".to_owned()));
    }
    let price = patch.price.or(current.map(|row| row.price)).unwrap_or(0);
    if !(0..=10_000_000).contains(&price) {
        return Err(ApiError::Validation("Price is out of range.".to_owned()));
    }
    let description = patch
        .description
        .or_else(|| current.and_then(|row| row.description.clone()))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if description.as_ref().is_some_and(|value| value.len() > 400) {
        return Err(ApiError::Validation("Description is too long.".to_owned()));
    }

    Ok(Draft {
        name,
        item_type,
        description,
        category,
        quantity,
        price,
        stock: match patch.stock {
            Some(value) => value,
            None => current.and_then(|row| row.stock),
        },
        max_per_player: match patch.max_per_player {
            Some(value) => value,
            None => current.and_then(|row| row.max_per_player),
        },
        featured: patch.featured.or(current.map(|row| row.featured)).unwrap_or(false),
        active: patch.active.or(current.map(|row| row.active)).unwrap_or(true),
        sort_order: patch.sort_order.or(current.map(|row| row.sort_order)).unwrap_or(0),
    })
}
