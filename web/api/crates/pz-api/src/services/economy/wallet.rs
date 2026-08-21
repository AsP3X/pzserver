//! Coin ledger. Every credit and debit is a row; the balance is the last one.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Wallet {
    pub user_id: Uuid,
    pub balance: i64,
    pub total_earned: i64,
    pub total_spent: i64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WalletView {
    #[serde(flatten)]
    pub wallet: Wallet,
    pub available: i64,
    pub held: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WalletTransaction {
    pub id: Uuid,
    pub user_id: Uuid,
    pub kind: String,
    pub amount: i64,
    pub balance_after: i64,
    pub source: String,
    pub reference_type: Option<String>,
    pub reference_id: Option<Uuid>,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdminWalletRow {
    pub user_id: Uuid,
    pub username: String,
    pub balance: i64,
    pub available: i64,
    pub total_earned: i64,
    pub total_spent: i64,
    pub updated_at: DateTime<Utc>,
}

pub async fn get_or_create(db: &PgPool, user_id: Uuid) -> Result<Wallet, sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO wallets (user_id) VALUES ($1)
           ON CONFLICT (user_id) DO NOTHING"#,
    )
    .bind(user_id)
    .execute(db)
    .await?;

    sqlx::query_as::<_, Wallet>(
        r#"SELECT user_id, balance, total_earned, total_spent, updated_at
           FROM wallets WHERE user_id = $1"#,
    )
    .bind(user_id)
    .fetch_one(db)
    .await
}

pub async fn view(db: &PgPool, user_id: Uuid) -> Result<WalletView, sqlx::Error> {
    let wallet = get_or_create(db, user_id).await?;
    let held = held_amount(db, user_id).await?;
    Ok(WalletView {
        available: (wallet.balance - held).max(0),
        held,
        wallet,
    })
}

pub async fn history(
    db: &PgPool,
    user_id: Uuid,
    limit: i64,
) -> Result<Vec<WalletTransaction>, sqlx::Error> {
    sqlx::query_as::<_, WalletTransaction>(
        r#"SELECT id, user_id, kind, amount, balance_after, source,
                  reference_type, reference_id, description, created_at
           FROM wallet_transactions
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT $2"#,
    )
    .bind(user_id)
    .bind(limit.clamp(1, 1_000))
    .fetch_all(db)
    .await
}

pub async fn list_admin(db: &PgPool) -> Result<Vec<AdminWalletRow>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (Uuid, String, i64, i64, i64, DateTime<Utc>)>(
        r#"SELECT u.id, u.username,
                  COALESCE(w.balance, 0),
                  COALESCE(w.total_earned, 0),
                  COALESCE(w.total_spent, 0),
                  COALESCE(w.updated_at, u.created_at)
           FROM users u
           LEFT JOIN wallets w ON w.user_id = u.id
           ORDER BY COALESCE(w.balance, 0) DESC, u.username"#,
    )
    .fetch_all(db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for (user_id, username, balance, total_earned, total_spent, updated_at) in rows {
        let held = held_amount(db, user_id).await?;
        out.push(AdminWalletRow {
            user_id,
            username,
            balance,
            available: (balance - held).max(0),
            total_earned,
            total_spent,
            updated_at,
        });
    }
    Ok(out)
}

pub async fn credit(
    db: &PgPool,
    user_id: Uuid,
    amount: i64,
    source: &str,
    description: Option<&str>,
    reference_type: Option<&str>,
    reference_id: Option<Uuid>,
) -> ApiResult<WalletTransaction> {
    let mut tx = db.begin().await?;
    let row = credit_tx(
        &mut tx,
        user_id,
        amount,
        source,
        description,
        reference_type,
        reference_id,
    )
    .await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn debit(
    db: &PgPool,
    user_id: Uuid,
    amount: i64,
    source: &str,
    description: Option<&str>,
    reference_type: Option<&str>,
    reference_id: Option<Uuid>,
) -> ApiResult<WalletTransaction> {
    let mut tx = db.begin().await?;
    let available = available_tx(&mut tx, user_id).await?;
    if available < amount {
        return Err(ApiError::Validation(format!(
            "Not enough coins. Available: {available}."
        )));
    }
    let row = debit_tx(
        &mut tx,
        user_id,
        amount,
        source,
        description,
        reference_type,
        reference_id,
    )
    .await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn credit_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    amount: i64,
    source: &str,
    description: Option<&str>,
    reference_type: Option<&str>,
    reference_id: Option<Uuid>,
) -> ApiResult<WalletTransaction> {
    if amount < 1 {
        return Err(ApiError::Validation("Amount must be at least 1 coin.".to_owned()));
    }
    ensure_wallet(tx, user_id).await?;
    sqlx::query(
        r#"UPDATE wallets SET
            balance = balance + $2,
            total_earned = total_earned + $2,
            updated_at = now()
           WHERE user_id = $1"#,
    )
    .bind(user_id)
    .bind(amount)
    .execute(&mut **tx)
    .await?;
    insert_tx(
        tx,
        user_id,
        "credit",
        amount,
        source,
        description,
        reference_type,
        reference_id,
    )
    .await
}

pub async fn debit_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    amount: i64,
    source: &str,
    description: Option<&str>,
    reference_type: Option<&str>,
    reference_id: Option<Uuid>,
) -> ApiResult<WalletTransaction> {
    if amount < 1 {
        return Err(ApiError::Validation("Amount must be at least 1 coin.".to_owned()));
    }
    ensure_wallet(tx, user_id).await?;
    let updated = sqlx::query(
        r#"UPDATE wallets SET
            balance = balance - $2,
            total_spent = total_spent + $2,
            updated_at = now()
           WHERE user_id = $1 AND balance >= $2"#,
    )
    .bind(user_id)
    .bind(amount)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::Validation("Not enough coins.".to_owned()));
    }
    insert_tx(
        tx,
        user_id,
        "debit",
        amount,
        source,
        description,
        reference_type,
        reference_id,
    )
    .await
}

pub async fn available_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, sqlx::Error> {
    let balance: i64 = sqlx::query_scalar(
        "SELECT COALESCE((SELECT balance FROM wallets WHERE user_id = $1), 0)",
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    let held: i64 = held_amount_tx(tx, user_id).await?;
    Ok((balance - held).max(0))
}

async fn held_amount(db: &PgPool, user_id: Uuid) -> Result<i64, sqlx::Error> {
    let store: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(total_price), 0)::bigint
           FROM store_purchases
           WHERE user_id = $1
             AND wallet_transaction_id IS NULL
             AND status IN ('pending', 'queued')"#,
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;
    let vault = super::vault::pending_retrieve_fees(db, user_id).await?;
    Ok(store + vault)
}

async fn held_amount_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, sqlx::Error> {
    let store: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(total_price), 0)::bigint
           FROM store_purchases
           WHERE user_id = $1
             AND wallet_transaction_id IS NULL
             AND status IN ('pending', 'queued')"#,
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    let vault: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(fee), 0)::bigint
           FROM vault_moves
           WHERE user_id = $1
             AND direction = 'retrieve'
             AND status = 'pending'
             AND wallet_transaction_id IS NULL"#,
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(store + vault)
}

async fn ensure_wallet(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO wallets (user_id) VALUES ($1)
           ON CONFLICT (user_id) DO NOTHING"#,
    )
    .bind(user_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query("SELECT user_id FROM wallets WHERE user_id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    kind: &str,
    amount: i64,
    source: &str,
    description: Option<&str>,
    reference_type: Option<&str>,
    reference_id: Option<Uuid>,
) -> ApiResult<WalletTransaction> {
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM wallets WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?;
    let row = sqlx::query_as::<_, WalletTransaction>(
        r#"INSERT INTO wallet_transactions
            (user_id, kind, amount, balance_after, source, reference_type, reference_id, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, user_id, kind, amount, balance_after, source,
                     reference_type, reference_id, description, created_at"#,
    )
    .bind(user_id)
    .bind(kind)
    .bind(amount)
    .bind(balance)
    .bind(source)
    .bind(reference_type)
    .bind(reference_id)
    .bind(description)
    .fetch_one(&mut **tx)
    .await?;
    Ok(row)
}
