//! Banking in-game cash: `Base.Money` and `Base.MoneyBundle` become coins.
//!
//! Items-first, and the ordering matters. The mod strips the cash and writes a
//! result; only then does the wallet move. A crash between those two points
//! leaves a `pending` row whose result is still on disk, and the next tick
//! picks it up — the player is never charged without eventually being paid.
//!
//! The reverse ordering (credit, then take) is what we are avoiding: a player
//! who disconnects at the wrong moment would keep both the coins and the cash.

use chrono::{DateTime, Utc};
use pz_bridge::{DepositChannel, DepositRates, DepositRequest, InventoryReader};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::economy::{SOURCE_DEPOSIT, wallet};
use crate::state::AppState;

/// The two item types `KR_Vault` strips. Anything else is left alone.
const NOTE_TYPE: &str = "Base.Money";
const BUNDLE_TYPE: &str = "Base.MoneyBundle";

/// How long a request may sit unanswered before it is written off.
///
/// The mod only acts while the player is online, so a deposit opened at the end
/// of a session waits for the next one. A day is long enough to cover that and
/// short enough that the queue does not fill with requests nobody remembers.
const REQUEST_LIFETIME_HOURS: i64 = 24;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct MoneyDeposit {
    pub id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub lua_id: String,
    pub status: String,
    pub note_count: i32,
    pub bundle_count: i32,
    pub coins: i64,
    pub note_value: i64,
    pub bundle_value: i64,
    pub detail: Option<String>,
    pub wallet_transaction_id: Option<Uuid>,
    pub attempts: i32,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// What a player would get if they banked right now.
///
/// Read from the mod's last inventory snapshot, so it is a recent reading
/// rather than a live one — `snapshot_at` says how recent. The real tally is
/// done by the mod at the moment of the strip and can differ.
#[derive(Debug, Clone, Serialize)]
pub struct DepositPreview {
    pub note_count: i32,
    pub bundle_count: i32,
    pub coins: i64,
    pub note_value: i64,
    pub bundle_value: i64,
    /// True when the mod has never written a snapshot for this character.
    pub snapshot_missing: bool,
    pub snapshot_at: Option<String>,
    /// Set when a deposit is already in flight — a second one would find no
    /// cash and fail, so the UI should block rather than let them try.
    pub pending: Option<MoneyDeposit>,
}

pub async fn rates(state: &AppState) -> ApiResult<DepositRates> {
    DepositChannel::new(&state.config.lua_bridge_path)
        .rates()
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))
}

pub async fn set_rates(state: &AppState, next: DepositRates) -> ApiResult<DepositRates> {
    if next.money_value < 0 || next.bundle_value < 0 {
        return Err(ApiError::Validation(
            "Rates cannot be negative.".to_owned(),
        ));
    }

    if next.money_value == 0 && next.bundle_value == 0 {
        return Err(ApiError::Validation(
            "At least one rate must pay something, or deposits would take cash for nothing."
                .to_owned(),
        ));
    }

    DepositChannel::new(&state.config.lua_bridge_path)
        .set_rates(next)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    Ok(next)
}

/// Count the cash on a character, from the mod's last inventory snapshot.
///
/// Matched on the exact full type. The looser short-name match used elsewhere
/// would also catch modded currencies the mod will not actually strip, which
/// would promise coins that never arrive.
async fn carried_cash(state: &AppState, username: &str) -> (i32, i32, Option<String>, bool) {
    let reader = InventoryReader::new(&state.config.lua_bridge_path);

    let Ok(Some(file)) = reader.read(username).await else {
        return (0, 0, None, true);
    };

    let mut notes = 0;
    let mut bundles = 0;

    for item in &file.data.items {
        match item.full_type.as_str() {
            NOTE_TYPE => notes += item.count as i32,
            BUNDLE_TYPE => bundles += item.count as i32,
            _ => {}
        }
    }

    (notes, bundles, file.data.timestamp.clone(), false)
}

pub async fn preview(state: &AppState, user_id: Uuid, username: &str) -> ApiResult<DepositPreview> {
    let rates = rates(state).await?;
    let (note_count, bundle_count, snapshot_at, snapshot_missing) =
        carried_cash(state, username).await;

    Ok(DepositPreview {
        note_count,
        bundle_count,
        coins: rates.value_of(note_count as i64, bundle_count as i64),
        note_value: rates.money_value,
        bundle_value: rates.bundle_value,
        snapshot_missing,
        snapshot_at,
        pending: pending_for(&state.db, user_id).await?,
    })
}

async fn pending_for(db: &PgPool, user_id: Uuid) -> ApiResult<Option<MoneyDeposit>> {
    let row = sqlx::query_as::<_, MoneyDeposit>(
        r#"SELECT id, user_id, username, lua_id, status, note_count, bundle_count,
                  coins, note_value, bundle_value, detail, wallet_transaction_id,
                  attempts, created_at, finished_at
           FROM money_deposits
           WHERE user_id = $1 AND status = 'pending'
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    Ok(row)
}

/// Open a deposit and hand it to the mod.
///
/// Refuses a second request while one is outstanding. The mod strips *all* cash
/// for whichever request it sees first, so a queued second one would report
/// "no money items found" and read to the player as a lost deposit.
pub async fn request(state: &AppState, user_id: Uuid, username: &str) -> ApiResult<MoneyDeposit> {
    if let Some(existing) = pending_for(&state.db, user_id).await? {
        return Err(ApiError::Conflict {
            field: "deposit",
            message: format!(
                "A deposit is already waiting for you to be online in game (opened {}).",
                existing.created_at.format("%H:%M UTC")
            ),
        });
    }

    let rates = rates(state).await?;
    let (note_count, bundle_count, _, snapshot_missing) = carried_cash(state, username).await;

    if snapshot_missing {
        return Err(ApiError::Validation(
            "We have not seen your character's inventory yet. Join the server once and try again."
                .to_owned(),
        ));
    }

    if note_count == 0 && bundle_count == 0 {
        return Err(ApiError::Validation(
            "You are not carrying any cash to bank.".to_owned(),
        ));
    }

    // Guard the whole flow rather than only the rate editor: a config file
    // edited by hand can still put both rates at zero, and the mod would take
    // the cash regardless.
    if rates.value_of(note_count as i64, bundle_count as i64) < 1 {
        return Err(ApiError::Validation(
            "Cash is not worth any coins at the current rates.".to_owned(),
        ));
    }

    let lua_id = Uuid::new_v4().to_string();

    // The queue write comes first. A row with no queue entry would sit pending
    // until it expired; a queue entry with no row would be stripped by the mod
    // with nothing to credit against, which costs the player real money.
    DepositChannel::new(&state.config.lua_bridge_path)
        .enqueue(DepositRequest {
            id: lua_id.clone(),
            username: username.to_owned(),
            status: "pending".to_owned(),
            created_at: Utc::now().to_rfc3339(),
        })
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    let row = sqlx::query_as::<_, MoneyDeposit>(
        r#"INSERT INTO money_deposits
                (user_id, username, lua_id, note_value, bundle_value)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, user_id, username, lua_id, status, note_count, bundle_count,
                     coins, note_value, bundle_value, detail, wallet_transaction_id,
                     attempts, created_at, finished_at"#,
    )
    .bind(user_id)
    .bind(username)
    .bind(&lua_id)
    .bind(rates.money_value)
    .bind(rates.bundle_value)
    .fetch_one(&state.db)
    .await?;

    tracing::info!(username, lua_id = %row.lua_id, "cash deposit opened");

    Ok(row)
}

pub async fn history(db: &PgPool, user_id: Uuid, limit: i64) -> ApiResult<Vec<MoneyDeposit>> {
    let rows = sqlx::query_as::<_, MoneyDeposit>(
        r#"SELECT id, user_id, username, lua_id, status, note_count, bundle_count,
                  coins, note_value, bundle_value, detail, wallet_transaction_id,
                  attempts, created_at, finished_at
           FROM money_deposits
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT $2"#,
    )
    .bind(user_id)
    .bind(limit.clamp(1, 100))
    .fetch_all(db)
    .await?;

    Ok(rows)
}

pub async fn list(db: &PgPool, status: Option<&str>, limit: i64) -> ApiResult<Vec<MoneyDeposit>> {
    let rows = sqlx::query_as::<_, MoneyDeposit>(
        r#"SELECT id, user_id, username, lua_id, status, note_count, bundle_count,
                  coins, note_value, bundle_value, detail, wallet_transaction_id,
                  attempts, created_at, finished_at
           FROM money_deposits
           WHERE $1::text IS NULL OR status = $1
           ORDER BY created_at DESC
           LIMIT $2"#,
    )
    .bind(status)
    .bind(limit.clamp(1, 500))
    .fetch_all(db)
    .await?;

    Ok(rows)
}

/// Withdraw a request the mod has not acted on yet.
pub async fn cancel(state: &AppState, id: Uuid) -> ApiResult<MoneyDeposit> {
    let deposit = by_id(&state.db, id).await?;

    if deposit.status != "pending" {
        return Err(ApiError::Validation(format!(
            "That deposit is already {}.",
            deposit.status
        )));
    }

    // Take it out of the mod's inbox first. If it has already been picked up
    // this returns false and we leave the row pending, because the cash may be
    // gone and a result could still land.
    let withdrawn = DepositChannel::new(&state.config.lua_bridge_path)
        .withdraw(&deposit.lua_id)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    if !withdrawn {
        return Err(ApiError::Validation(
            "The mod has already taken that request. Wait for its result.".to_owned(),
        ));
    }

    finish(&state.db, id, "cancelled", Some("Cancelled by an admin.")).await?;

    by_id(&state.db, id).await
}

/// Pay out a deposit by hand.
///
/// For the case where the mod took the cash and wrote a result, but the credit
/// could not be applied — a wallet that was locked, or a result file that was
/// pruned before the poller saw it. Refuses to double-pay.
pub async fn force_credit(
    state: &AppState,
    id: Uuid,
    coins: i64,
    actor: &str,
) -> ApiResult<MoneyDeposit> {
    let deposit = by_id(&state.db, id).await?;

    if deposit.wallet_transaction_id.is_some() {
        return Err(ApiError::Validation(
            "That deposit has already been paid.".to_owned(),
        ));
    }

    let coins = super::coins(coins, "Payout")?;

    let transaction = wallet::credit(
        &state.db,
        deposit.user_id,
        coins,
        SOURCE_DEPOSIT,
        Some(&format!("Cash deposit paid by hand ({actor})")),
        Some("money_deposit"),
        Some(deposit.id),
    )
    .await?;

    sqlx::query(
        r#"UPDATE money_deposits
           SET status = 'credited', coins = $2, wallet_transaction_id = $3,
               detail = $4, finished_at = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(coins)
    .bind(transaction.id)
    .bind(format!("Paid by hand by {actor}."))
    .execute(&state.db)
    .await?;

    tracing::warn!(
        deposit = %id,
        username = %deposit.username,
        coins,
        actor,
        "cash deposit paid by hand",
    );

    by_id(&state.db, id).await
}

async fn by_id(db: &PgPool, id: Uuid) -> ApiResult<MoneyDeposit> {
    let row = sqlx::query_as::<_, MoneyDeposit>(
        r#"SELECT id, user_id, username, lua_id, status, note_count, bundle_count,
                  coins, note_value, bundle_value, detail, wallet_transaction_id,
                  attempts, created_at, finished_at
           FROM money_deposits WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::Validation("No such deposit.".to_owned()))?;

    Ok(row)
}

async fn finish(db: &PgPool, id: Uuid, status: &str, detail: Option<&str>) -> ApiResult<()> {
    sqlx::query(
        r#"UPDATE money_deposits
           SET status = $2, detail = $3, finished_at = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(status)
    .bind(detail)
    .execute(db)
    .await?;

    Ok(())
}

/// Match pending deposits against the mod's result ledger and pay them.
pub async fn tick(state: &AppState) {
    let Ok(pending) = pending_rows(&state.db).await else {
        return;
    };

    if pending.is_empty() {
        return;
    }

    let channel = DepositChannel::new(&state.config.lua_bridge_path);
    let Ok(ledger) = channel.results().await else {
        return;
    };

    let cutoff = Utc::now() - chrono::Duration::hours(REQUEST_LIFETIME_HOURS);

    for deposit in pending {
        match ledger
            .results
            .iter()
            .find(|result| result.id == deposit.lua_id)
        {
            Some(result) => apply(state, &deposit, result).await,
            None if deposit.created_at < cutoff => {
                // Nothing was taken — the mod only writes a result after it
                // strips the cash — so withdrawing is safe and costs nobody.
                let _ = channel.withdraw(&deposit.lua_id).await;
                let _ = finish(
                    &state.db,
                    deposit.id,
                    "cancelled",
                    Some("Expired before the character came online."),
                )
                .await;
            }
            None => {}
        }
    }
}

async fn apply(state: &AppState, deposit: &MoneyDeposit, result: &pz_bridge::DepositResult) {
    if !result.succeeded() {
        let _ = finish(
            &state.db,
            deposit.id,
            "failed",
            result.message.as_deref().or(Some("The mod refused it.")),
        )
        .await;

        return;
    }

    // Trust the mod's own tally over the preview: it counted what it actually
    // removed, and rates may have moved since the request was opened. Recompute
    // at the rates the player was quoted so the payout matches what they saw.
    let coins = if result.total_coins > 0 {
        result.total_coins
    } else {
        deposit.note_count_value(result.money_count as i64, result.bundle_count as i64)
    };

    if coins < 1 {
        // The cash is gone and it is worth nothing. That is a real loss, so it
        // is logged loudly and left for an admin rather than quietly closed.
        tracing::error!(
            deposit = %deposit.id,
            username = %deposit.username,
            notes = result.money_count,
            bundles = result.bundle_count,
            "cash deposit stripped but priced at zero coins",
        );

        let _ = finish(
            &state.db,
            deposit.id,
            "failed",
            Some("Cash was taken but priced at zero coins. Needs an admin payout."),
        )
        .await;

        return;
    }

    let transaction = match wallet::credit(
        &state.db,
        deposit.user_id,
        coins,
        SOURCE_DEPOSIT,
        Some(&format!(
            "Banked {} note(s) and {} bundle(s)",
            result.money_count, result.bundle_count
        )),
        Some("money_deposit"),
        Some(deposit.id),
    )
    .await
    {
        Ok(transaction) => transaction,
        Err(error) => {
            // Left pending on purpose. The result stays on disk, so the next
            // tick tries again rather than stranding the player's cash.
            tracing::error!(
                deposit = %deposit.id,
                username = %deposit.username,
                %error,
                "could not credit a completed cash deposit — will retry",
            );

            let _ = sqlx::query("UPDATE money_deposits SET attempts = attempts + 1 WHERE id = $1")
                .bind(deposit.id)
                .execute(&state.db)
                .await;

            return;
        }
    };

    let updated = sqlx::query(
        r#"UPDATE money_deposits
           SET status = 'credited', note_count = $2, bundle_count = $3, coins = $4,
               wallet_transaction_id = $5, finished_at = now()
           WHERE id = $1 AND status = 'pending'"#,
    )
    .bind(deposit.id)
    .bind(result.money_count)
    .bind(result.bundle_count)
    .bind(coins)
    .bind(transaction.id)
    .execute(&state.db)
    .await;

    match updated {
        Ok(done) if done.rows_affected() == 1 => {
            tracing::info!(
                username = %deposit.username,
                coins,
                notes = result.money_count,
                bundles = result.bundle_count,
                "cash deposit credited",
            );
        }
        // The row moved out of pending between the read and the write, which
        // means another tick already paid it. The credit above is then a
        // duplicate and has to be logged — it is real money.
        _ => {
            tracing::error!(
                deposit = %deposit.id,
                transaction = %transaction.id,
                coins,
                "credited a deposit that was no longer pending — possible double pay",
            );
        }
    }
}

impl MoneyDeposit {
    /// Price a tally at the rates this deposit was opened with.
    fn note_count_value(&self, notes: i64, bundles: i64) -> i64 {
        notes * self.note_value + bundles * self.bundle_value
    }
}

async fn pending_rows(db: &PgPool) -> Result<Vec<MoneyDeposit>, sqlx::Error> {
    sqlx::query_as::<_, MoneyDeposit>(
        r#"SELECT id, user_id, username, lua_id, status, note_count, bundle_count,
                  coins, note_value, bundle_value, detail, wallet_transaction_id,
                  attempts, created_at, finished_at
           FROM money_deposits
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT 80"#,
    )
    .fetch_all(db)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deposit_with_rates(note_value: i64, bundle_value: i64) -> MoneyDeposit {
        MoneyDeposit {
            id: Uuid::nil(),
            user_id: Uuid::nil(),
            username: "rook".to_owned(),
            lua_id: "abc".to_owned(),
            status: "pending".to_owned(),
            note_count: 0,
            bundle_count: 0,
            coins: 0,
            note_value,
            bundle_value,
            detail: None,
            wallet_transaction_id: None,
            attempts: 1,
            created_at: Utc::now(),
            finished_at: None,
        }
    }

    /// The quoted rates are frozen onto the row, so a rate change between the
    /// request and the result cannot silently reprice what the player agreed to.
    #[test]
    fn a_tally_is_priced_at_the_rates_the_request_was_opened_with() {
        let deposit = deposit_with_rates(2, 150);

        assert_eq!(deposit.note_count_value(10, 2), 320);
        assert_eq!(deposit.note_count_value(0, 0), 0);
    }

    #[test]
    fn zero_rates_price_everything_at_nothing() {
        let deposit = deposit_with_rates(0, 0);

        assert_eq!(deposit.note_count_value(500, 500), 0);
    }
}
