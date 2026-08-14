//! Offline locker. Storing is free. Retrieving costs coins. Capacity is bought.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::economy::{self, delivery, inventory, wallet};
use crate::state::AppState;

pub const SOURCE_FEE: &str = "vault_fee";
pub const SOURCE_UPGRADE: &str = "vault_upgrade";

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Settings {
    pub enabled: bool,
    pub default_slots: i32,
    pub max_slots: i32,
    pub slot_upgrade_increment: i32,
    pub slot_upgrade_cost: i64,
    pub withdraw_fee_flat: i64,
    pub withdraw_fee_per_item: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SettingsPatch {
    pub enabled: Option<bool>,
    pub default_slots: Option<i32>,
    pub max_slots: Option<i32>,
    pub slot_upgrade_increment: Option<i32>,
    pub slot_upgrade_cost: Option<i64>,
    pub withdraw_fee_flat: Option<i64>,
    pub withdraw_fee_per_item: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CargoPiece {
    pub item_type: String,
    pub item_name: String,
    pub category: String,
    pub condition_bp: i16,
    pub quantity: i32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cargo: Vec<CargoPiece>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct VaultItem {
    pub id: Uuid,
    pub item_type: String,
    pub item_name: String,
    pub category: String,
    pub condition_bp: i16,
    pub quantity: i32,
    pub cargo_count: i32,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct VaultMove {
    pub id: Uuid,
    pub direction: String,
    pub status: String,
    pub item_type: String,
    pub item_name: String,
    pub category: String,
    pub condition_bp: i16,
    pub requested: i32,
    pub actual: i32,
    pub fee: i64,
    pub cargo_count: i32,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Capacity {
    pub used: i32,
    pub reserved: i32,
    pub total: i32,
    pub max: i32,
    pub upgrade_cost: i64,
    pub upgrade_increment: i32,
    pub at_max: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Fees {
    pub flat: i64,
    pub per_item: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultView {
    pub enabled: bool,
    pub items: Vec<VaultItem>,
    pub capacity: Capacity,
    pub fees: Fees,
    pub wallet: wallet::WalletView,
    pub moves: Vec<VaultMove>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdminVaultRow {
    pub user_id: Uuid,
    pub username: String,
    pub used: i32,
    pub total: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdminVault {
    pub settings: Settings,
    pub vaults: Vec<AdminVaultRow>,
}

#[derive(Debug, Deserialize)]
pub struct StoreBody {
    pub item_type: String,
    pub item_name: Option<String>,
    pub category: Option<String>,
    pub condition: Option<f32>,
    pub quantity: Option<i32>,
    /// Snapshot container id when this is a bag. Picks which backpack.
    pub container_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RetrieveBody {
    pub item_id: Uuid,
    pub quantity: Option<i32>,
}

pub fn fee_for(settings: &Settings, count: i32) -> i64 {
    settings.withdraw_fee_flat + settings.withdraw_fee_per_item * i64::from(count.max(0))
}

pub async fn settings(db: &PgPool) -> Result<Settings, sqlx::Error> {
    sqlx::query_as::<_, Settings>(
        r#"SELECT enabled, default_slots, max_slots, slot_upgrade_increment,
                  slot_upgrade_cost, withdraw_fee_flat, withdraw_fee_per_item
           FROM vault_settings WHERE id = 1"#,
    )
    .fetch_one(db)
    .await
}

pub async fn view(state: &AppState, user_id: Uuid) -> ApiResult<VaultView> {
    let settings = settings(&state.db).await?;
    let capacity_slots = ensure_vault(&state.db, user_id, settings.default_slots).await?;
    let items = items(&state.db, user_id).await?;
    let reserved = reserved_new_stacks(&state.db, user_id).await?;
    let used = i32::try_from(items.len()).unwrap_or(i32::MAX);
    let increment = settings
        .slot_upgrade_increment
        .min((settings.max_slots - capacity_slots).max(0));
    Ok(VaultView {
        enabled: settings.enabled,
        items,
        capacity: Capacity {
            used,
            reserved,
            total: capacity_slots,
            max: settings.max_slots,
            upgrade_cost: settings.slot_upgrade_cost,
            upgrade_increment: increment,
            at_max: capacity_slots >= settings.max_slots,
        },
        fees: Fees {
            flat: settings.withdraw_fee_flat,
            per_item: settings.withdraw_fee_per_item,
        },
        wallet: wallet::view(&state.db, user_id).await?,
        moves: recent_moves(&state.db, user_id).await?,
    })
}

pub async fn admin_view(db: &PgPool) -> ApiResult<AdminVault> {
    let settings = settings(db).await?;
    let vaults = sqlx::query_as::<_, (Uuid, String, i32, i32)>(
        r#"SELECT v.user_id, u.username,
                  (SELECT COUNT(*)::int FROM vault_items i WHERE i.user_id = v.user_id),
                  v.slot_capacity
           FROM vaults v
           JOIN users u ON u.id = v.user_id
           ORDER BY 3 DESC, u.username"#,
    )
    .fetch_all(db)
    .await?;
    Ok(AdminVault {
        settings,
        vaults: vaults
            .into_iter()
            .map(|(user_id, username, used, total)| AdminVaultRow {
                user_id,
                username,
                used,
                total,
            })
            .collect(),
    })
}

pub async fn update_settings(db: &PgPool, patch: SettingsPatch) -> ApiResult<Settings> {
    let current = settings(db).await?;
    let default_slots = bound_slots(patch.default_slots.unwrap_or(current.default_slots), 1, 2_000)?;
    let max_slots = bound_slots(patch.max_slots.unwrap_or(current.max_slots), 1, 2_000)?;
    if max_slots < default_slots {
        return Err(ApiError::Validation(
            "Maximum slots must be at least the starting size.".to_owned(),
        ));
    }
    let increment = bound_slots(
        patch
            .slot_upgrade_increment
            .unwrap_or(current.slot_upgrade_increment),
        1,
        200,
    )?;
    let upgrade_cost = patch
        .slot_upgrade_cost
        .unwrap_or(current.slot_upgrade_cost);
    if upgrade_cost < 1 {
        return Err(ApiError::Validation(
            "Upgrade cost must be at least 1 coin.".to_owned(),
        ));
    }
    let flat = patch
        .withdraw_fee_flat
        .unwrap_or(current.withdraw_fee_flat);
    let per_item = patch
        .withdraw_fee_per_item
        .unwrap_or(current.withdraw_fee_per_item);
    if flat < 0 || per_item < 0 {
        return Err(ApiError::Validation(
            "Retrieve fees cannot be negative.".to_owned(),
        ));
    }

    sqlx::query(
        r#"UPDATE vault_settings SET
            enabled = $1,
            default_slots = $2,
            max_slots = $3,
            slot_upgrade_increment = $4,
            slot_upgrade_cost = $5,
            withdraw_fee_flat = $6,
            withdraw_fee_per_item = $7,
            updated_at = now()
           WHERE id = 1"#,
    )
    .bind(patch.enabled.unwrap_or(current.enabled))
    .bind(default_slots)
    .bind(max_slots)
    .bind(increment)
    .bind(upgrade_cost)
    .bind(flat)
    .bind(per_item)
    .execute(db)
    .await?;

    Ok(settings(db).await?)
}

pub async fn store(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    body: StoreBody,
) -> ApiResult<VaultView> {
    let settings = require_enabled(&state.db).await?;
    let item_type = economy::item_type(&body.item_type)?.to_owned();
    let mut quantity = body.quantity.unwrap_or(1);
    if !(1..=100).contains(&quantity) {
        return Err(ApiError::Validation("Store between 1 and 100.".to_owned()));
    }
    let (cargo, cargo_count) = pack_from_inventory(state, username, &item_type, body.container_id.as_deref()).await?;
    if cargo_count > 0 {
        quantity = 1;
    }
    let condition_bp = condition_bp(body.condition);
    let name = body
        .item_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(item_type.as_str())
        .chars()
        .take(80)
        .collect::<String>();
    let category = body
        .category
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("General")
        .chars()
        .take(40)
        .collect::<String>();

    let online = state
        .status
        .current()
        .await
        .players
        .iter()
        .any(|player| player == username);
    inventory::ensure_available(state, user_id, username, &item_type, quantity, online).await?;

    let mut tx = state.db.begin().await?;
    let capacity = ensure_vault_tx(&mut tx, user_id, settings.default_slots).await?;
    if !has_room_tx(&mut tx, user_id, capacity, &item_type, condition_bp, cargo_count > 0).await?
    {
        return Err(ApiError::Validation(
            "The vault is full. Buy more slots, or retrieve something first.".to_owned(),
        ));
    }

    let cargo_json = serde_json::to_value(&cargo).unwrap_or(serde_json::json!([]));
    let row = sqlx::query_as::<_, VaultMove>(
        r#"INSERT INTO vault_moves
            (user_id, direction, status, item_type, item_name, category,
             condition_bp, requested, fee, cargo, cargo_count)
           VALUES ($1,'store','pending',$2,$3,$4,$5,$6,0,$7,$8)
           RETURNING id, direction, status, item_type, item_name, category,
                     condition_bp, requested, actual, fee, cargo_count,
                     created_at, finished_at"#,
    )
    .bind(user_id)
    .bind(&item_type)
    .bind(&name)
    .bind(&category)
    .bind(condition_bp)
    .bind(quantity)
    .bind(&cargo_json)
    .bind(cargo_count)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    if let Err(error) = delivery::take(
        state,
        username,
        &item_type,
        quantity,
        "vault_store",
        "vault_move",
        row.id,
    )
    .await
    {
        let _ = fail_move(&state.db, row.id, 0).await;
        return Err(error);
    }

    view(state, user_id).await
}

pub async fn retrieve(
    state: &AppState,
    user_id: Uuid,
    username: &str,
    body: RetrieveBody,
) -> ApiResult<VaultView> {
    let settings = require_enabled(&state.db).await?;
    let mut quantity = body.quantity.unwrap_or(1);
    if !(1..=100).contains(&quantity) {
        return Err(ApiError::Validation("Retrieve between 1 and 100.".to_owned()));
    }

    let mut tx = state.db.begin().await?;
    let item = sqlx::query_as::<_, VaultItem>(
        r#"SELECT id, item_type, item_name, category, condition_bp, quantity, cargo_count
           FROM vault_items
           WHERE id = $1 AND user_id = $2
           FOR UPDATE"#,
    )
    .bind(body.item_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::Validation("That stack is not in your vault.".to_owned()))?;

    let cargo: Vec<CargoPiece> = sqlx::query_scalar::<_, serde_json::Value>(
        r#"SELECT cargo FROM vault_items WHERE id = $1"#,
    )
    .bind(item.id)
    .fetch_one(&mut *tx)
    .await
    .ok()
    .and_then(|value| serde_json::from_value(value).ok())
    .unwrap_or_default();

    if item.cargo_count > 0 {
        quantity = 1;
    }

    if item.quantity < quantity {
        return Err(ApiError::Validation(format!(
            "Only {} of that in the vault.",
            item.quantity
        )));
    }

    let units = retrieve_units(quantity, item.cargo_count);
    let fee = fee_for(&settings, units);
    if fee > 0 {
        let available = wallet::available_tx(&mut tx, user_id).await?;
        if available < fee {
            return Err(ApiError::Validation(format!(
                "Retrieve costs {fee} coins. Available: {available}."
            )));
        }
    }

    take_item_tx(&mut tx, item.id, quantity).await?;

    let cargo_json = serde_json::to_value(&cargo).unwrap_or(serde_json::json!([]));
    let row = sqlx::query_as::<_, VaultMove>(
        r#"INSERT INTO vault_moves
            (user_id, direction, status, item_type, item_name, category,
             condition_bp, requested, fee, cargo, cargo_count)
           VALUES ($1,'retrieve','pending',$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, direction, status, item_type, item_name, category,
                     condition_bp, requested, actual, fee, cargo_count,
                     created_at, finished_at"#,
    )
    .bind(user_id)
    .bind(&item.item_type)
    .bind(&item.item_name)
    .bind(&item.category)
    .bind(item.condition_bp)
    .bind(quantity)
    .bind(fee)
    .bind(&cargo_json)
    .bind(item.cargo_count)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let condition = Some(f32::from(item.condition_bp) / 100.0);
    let give = if cargo.is_empty() {
        delivery::give_with_condition(
            state,
            username,
            &item.item_type,
            quantity,
            condition,
            "vault_give",
            "vault_move",
            row.id,
        )
        .await
    } else {
        delivery::give_kit(
            state,
            username,
            &item.item_type,
            condition,
            &cargo_json,
            "vault_give",
            "vault_move",
            row.id,
        )
        .await
    };
    if let Err(error) = give {
        let _ = restore_item(
            &state.db,
            user_id,
            &item.item_type,
            &item.item_name,
            &item.category,
            item.condition_bp,
            quantity,
            &cargo,
        )
        .await;
        let _ = fail_move(&state.db, row.id, 0).await;
        return Err(error);
    }

    view(state, user_id).await
}

pub async fn upgrade(state: &AppState, user_id: Uuid) -> ApiResult<VaultView> {
    let settings = require_enabled(&state.db).await?;
    let mut tx = state.db.begin().await?;
    let current = ensure_vault_tx(&mut tx, user_id, settings.default_slots).await?;
    if current >= settings.max_slots {
        return Err(ApiError::Validation(
            "The vault is already at its maximum size.".to_owned(),
        ));
    }
    let increment = settings
        .slot_upgrade_increment
        .min(settings.max_slots - current);
    let next = current + increment;
    wallet::debit_tx(
        &mut tx,
        user_id,
        settings.slot_upgrade_cost,
        SOURCE_UPGRADE,
        Some(&format!("Vault capacity to {next} slots")),
        Some("vault"),
        Some(user_id),
    )
    .await?;
    sqlx::query(
        r#"UPDATE vaults SET slot_capacity = $2, updated_at = now()
           WHERE user_id = $1"#,
    )
    .bind(user_id)
    .bind(next)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    view(state, user_id).await
}

pub async fn on_delivered(state: &AppState, move_id: Uuid, actual: i32) -> ApiResult<()> {
    let row = sqlx::query_as::<_, (Uuid, String, String, String, String, i16, i32, i64)>(
        r#"SELECT user_id, direction, item_type, item_name, category,
                  condition_bp, requested, fee
           FROM vault_moves
           WHERE id = $1 AND status = 'pending'"#,
    )
    .bind(move_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((user_id, direction, item_type, item_name, category, condition_bp, requested, fee)) =
        row
    else {
        return Ok(());
    };

    if direction == "store" {
        let stored = actual.max(0);
        if stored > 0 {
            let cargo = cargo_of_move(&state.db, move_id).await?;
            restore_item(
                &state.db,
                user_id,
                &item_type,
                &item_name,
                &category,
                condition_bp,
                stored,
                &cargo,
            )
            .await?;
        }
        let status = if stored <= 0 {
            "failed"
        } else if stored < requested {
            "partial"
        } else {
            "done"
        };
        sqlx::query(
            r#"UPDATE vault_moves
               SET status = $2, actual = $3, finished_at = now()
               WHERE id = $1"#,
        )
        .bind(move_id)
        .bind(status)
        .bind(stored)
        .execute(&state.db)
        .await?;
        return Ok(());
    }

    let mut tx = state.db.begin().await?;
    let mut wallet_tx = None;
    if fee > 0 {
        match wallet::debit_tx(
            &mut tx,
            user_id,
            fee,
            SOURCE_FEE,
            Some(&format!("Vault retrieve fee for {requested}× {item_type}")),
            Some("vault_move"),
            Some(move_id),
        )
        .await
        {
            Ok(row) => wallet_tx = Some(row.id),
            Err(_) => {
                tx.rollback().await?;
                let cargo = cargo_of_move(&state.db, move_id).await.unwrap_or_default();
                restore_item(
                    &state.db,
                    user_id,
                    &item_type,
                    &item_name,
                    &category,
                    condition_bp,
                    requested,
                    &cargo,
                )
                .await?;
                fail_move(&state.db, move_id, 0).await?;
                return Ok(());
            }
        }
    }
    sqlx::query(
        r#"UPDATE vault_moves
           SET status = 'done', actual = $2, wallet_transaction_id = $3, finished_at = now()
           WHERE id = $1"#,
    )
    .bind(move_id)
    .bind(requested)
    .bind(wallet_tx)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn on_failed(state: &AppState, move_id: Uuid) -> ApiResult<()> {
    let row = sqlx::query_as::<_, (Uuid, String, String, String, String, i16, i32)>(
        r#"SELECT user_id, direction, item_type, item_name, category, condition_bp, requested
           FROM vault_moves
           WHERE id = $1 AND status = 'pending'"#,
    )
    .bind(move_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((user_id, direction, item_type, item_name, category, condition_bp, requested)) = row
    else {
        return Ok(());
    };

    if direction == "retrieve" {
        let cargo = cargo_of_move(&state.db, move_id).await.unwrap_or_default();
        restore_item(
            &state.db,
            user_id,
            &item_type,
            &item_name,
            &category,
            condition_bp,
            requested,
            &cargo,
        )
        .await?;
    }
    fail_move(&state.db, move_id, 0).await?;
    Ok(())
}

pub async fn pending_store_quantity(
    db: &PgPool,
    user_id: Uuid,
    item_type: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(requested), 0)::bigint
           FROM vault_moves
           WHERE user_id = $1
             AND item_type = $2
             AND direction = 'store'
             AND status = 'pending'"#,
    )
    .bind(user_id)
    .bind(item_type)
    .fetch_one(db)
    .await
}

pub async fn pending_holds(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Vec<inventory::InventoryHold>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String, i32, String)>(
        r#"SELECT item_type, item_name, requested, direction
           FROM vault_moves
           WHERE user_id = $1 AND status = 'pending'"#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(item_type, item_name, quantity, direction)| inventory::InventoryHold {
            item_type,
            item_name,
            quantity,
            kind: if direction == "store" {
                "vault_store".to_owned()
            } else {
                "vault_give".to_owned()
            },
        })
        .collect())
}

pub async fn pending_retrieve_fees(db: &PgPool, user_id: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(fee), 0)::bigint
           FROM vault_moves
           WHERE user_id = $1
             AND direction = 'retrieve'
             AND status = 'pending'
             AND wallet_transaction_id IS NULL"#,
    )
    .bind(user_id)
    .fetch_one(db)
    .await
}

async fn require_enabled(db: &PgPool) -> ApiResult<Settings> {
    let settings = settings(db).await?;
    if !settings.enabled {
        return Err(ApiError::Validation(
            "The vault is closed right now.".to_owned(),
        ));
    }
    Ok(settings)
}

async fn ensure_vault(db: &PgPool, user_id: Uuid, default_slots: i32) -> Result<i32, sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO vaults (user_id, slot_capacity) VALUES ($1, $2)
           ON CONFLICT (user_id) DO NOTHING"#,
    )
    .bind(user_id)
    .bind(default_slots)
    .execute(db)
    .await?;
    sqlx::query_scalar("SELECT slot_capacity FROM vaults WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(db)
        .await
}

async fn ensure_vault_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    default_slots: i32,
) -> Result<i32, sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO vaults (user_id, slot_capacity) VALUES ($1, $2)
           ON CONFLICT (user_id) DO NOTHING"#,
    )
    .bind(user_id)
    .bind(default_slots)
    .execute(&mut **tx)
    .await?;
    sqlx::query_scalar("SELECT slot_capacity FROM vaults WHERE user_id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await
}

async fn items(db: &PgPool, user_id: Uuid) -> Result<Vec<VaultItem>, sqlx::Error> {
    sqlx::query_as::<_, VaultItem>(
        r#"SELECT id, item_type, item_name, category, condition_bp, quantity, cargo_count
           FROM vault_items
           WHERE user_id = $1
           ORDER BY item_name, condition_bp DESC"#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

async fn recent_moves(db: &PgPool, user_id: Uuid) -> Result<Vec<VaultMove>, sqlx::Error> {
    sqlx::query_as::<_, VaultMove>(
        r#"SELECT id, direction, status, item_type, item_name, category,
                  condition_bp, requested, actual, fee, cargo_count,
                  created_at, finished_at
           FROM vault_moves
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 20"#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

async fn reserved_new_stacks(db: &PgPool, user_id: Uuid) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT COUNT(*)::int FROM (
               SELECT m.id
               FROM vault_moves m
               WHERE m.user_id = $1
                 AND m.direction = 'store'
                 AND m.status = 'pending'
                 AND (
                     m.cargo_count > 0
                     OR NOT EXISTS (
                         SELECT 1 FROM vault_items i
                         WHERE i.user_id = m.user_id
                           AND i.item_type = m.item_type
                           AND i.condition_bp = m.condition_bp
                           AND i.cargo_count = 0
                     )
                 )
           ) pending"#,
    )
    .bind(user_id)
    .fetch_one(db)
    .await
}

async fn has_room_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    capacity: i32,
    item_type: &str,
    condition_bp: i16,
    packed: bool,
) -> Result<bool, sqlx::Error> {
    if packed {
        let used: i32 = sqlx::query_scalar(
            "SELECT COUNT(*)::int FROM vault_items WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?;
        let reserved: i32 = sqlx::query_scalar(
            r#"SELECT COUNT(*)::int FROM (
                   SELECT m.id
                   FROM vault_moves m
                   WHERE m.user_id = $1
                     AND m.direction = 'store'
                     AND m.status = 'pending'
                     AND (
                         m.cargo_count > 0
                         OR NOT EXISTS (
                             SELECT 1 FROM vault_items i
                             WHERE i.user_id = m.user_id
                               AND i.item_type = m.item_type
                               AND i.condition_bp = m.condition_bp
                               AND i.cargo_count = 0
                         )
                     )
               ) pending"#,
        )
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?;
        return Ok(used + reserved < capacity);
    }

    let existing: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1 FROM vault_items
               WHERE user_id = $1 AND item_type = $2 AND condition_bp = $3
                 AND cargo_count = 0
           )
           OR EXISTS(
               SELECT 1 FROM vault_moves
               WHERE user_id = $1 AND item_type = $2 AND condition_bp = $3
                 AND direction = 'store' AND status = 'pending'
                 AND cargo_count = 0
           )"#,
    )
    .bind(user_id)
    .bind(item_type)
    .bind(condition_bp)
    .fetch_one(&mut **tx)
    .await?;
    if existing {
        return Ok(true);
    }
    let used: i32 = sqlx::query_scalar(
        "SELECT COUNT(*)::int FROM vault_items WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    let reserved: i32 = sqlx::query_scalar(
        r#"SELECT COUNT(*)::int FROM (
               SELECT m.id
               FROM vault_moves m
               WHERE m.user_id = $1
                 AND m.direction = 'store'
                 AND m.status = 'pending'
                 AND (
                     m.cargo_count > 0
                     OR NOT EXISTS (
                         SELECT 1 FROM vault_items i
                         WHERE i.user_id = m.user_id
                           AND i.item_type = m.item_type
                           AND i.condition_bp = m.condition_bp
                           AND i.cargo_count = 0
                     )
                 )
           ) pending"#,
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(used + reserved < capacity)
}

async fn take_item_tx(
    tx: &mut Transaction<'_, Postgres>,
    item_id: Uuid,
    quantity: i32,
) -> ApiResult<()> {
    let updated = sqlx::query(
        r#"UPDATE vault_items SET quantity = quantity - $2
           WHERE id = $1 AND quantity >= $2"#,
    )
    .bind(item_id)
    .bind(quantity)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::Validation(
            "Not enough of that in the vault.".to_owned(),
        ));
    }
    sqlx::query("DELETE FROM vault_items WHERE id = $1 AND quantity <= 0")
        .bind(item_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn restore_item(
    db: &PgPool,
    user_id: Uuid,
    item_type: &str,
    item_name: &str,
    category: &str,
    condition_bp: i16,
    quantity: i32,
    cargo: &[CargoPiece],
) -> Result<(), sqlx::Error> {
    if quantity < 1 {
        return Ok(());
    }
    sqlx::query(
        r#"INSERT INTO vaults (user_id, slot_capacity)
           VALUES ($1, (SELECT default_slots FROM vault_settings WHERE id = 1))
           ON CONFLICT (user_id) DO NOTHING"#,
    )
    .bind(user_id)
    .execute(db)
    .await?;
    let cargo_json = serde_json::to_value(cargo).unwrap_or(serde_json::json!([]));
    let cargo_count = cargo_units(cargo);
    if cargo_count == 0 {
        let merged = sqlx::query(
            r#"UPDATE vault_items SET quantity = quantity + $4
               WHERE user_id = $1 AND item_type = $2 AND condition_bp = $3
                 AND cargo_count = 0"#,
        )
        .bind(user_id)
        .bind(item_type)
        .bind(condition_bp)
        .bind(quantity)
        .execute(db)
        .await?;
        if merged.rows_affected() > 0 {
            return Ok(());
        }
    }
    sqlx::query(
        r#"INSERT INTO vault_items
            (user_id, item_type, item_name, category, condition_bp, quantity, cargo, cargo_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)"#,
    )
    .bind(user_id)
    .bind(item_type)
    .bind(item_name)
    .bind(category)
    .bind(condition_bp)
    .bind(quantity)
    .bind(&cargo_json)
    .bind(cargo_count)
    .execute(db)
    .await?;
    Ok(())
}

async fn cargo_of_move(db: &PgPool, move_id: Uuid) -> Result<Vec<CargoPiece>, sqlx::Error> {
    let value: serde_json::Value = sqlx::query_scalar("SELECT cargo FROM vault_moves WHERE id = $1")
        .bind(move_id)
        .fetch_one(db)
        .await?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

async fn pack_from_inventory(
    state: &AppState,
    username: &str,
    item_type: &str,
    container_id: Option<&str>,
) -> ApiResult<(Vec<CargoPiece>, i32)> {
    let reader = pz_bridge::InventoryReader::new(&state.config.lua_bridge_path);
    let Ok(Some(file)) = reader.read(username).await else {
        return Ok((Vec::new(), 0));
    };
    let items = &file.data.items;
    let bag_id = container_id
        .map(str::to_owned)
        .or_else(|| {
            items
                .iter()
                .find(|item| {
                    (item.full_type == item_type
                        || item.full_type.rsplit('.').next() == item_type.rsplit('.').next())
                        && item.contains.is_some()
                })
                .and_then(|item| item.contains.clone())
        });
    let Some(bag_id) = bag_id else {
        return Ok((Vec::new(), 0));
    };
    let cargo = pack_container(items, &bag_id);
    let count = cargo_units(&cargo);
    Ok((cargo, count))
}

fn pack_container(items: &[pz_bridge::inventory::InventoryItem], container_id: &str) -> Vec<CargoPiece> {
    let mut stacks: Vec<CargoPiece> = Vec::new();
    for item in items.iter().filter(|item| item.container_id == container_id) {
        let nested = item
            .contains
            .as_deref()
            .map(|id| pack_container(items, id))
            .unwrap_or_default();
        let condition_bp = item
            .condition
            .map(|value| {
                let fraction = if value > 1.0 { value / 100.0 } else { value };
                (fraction * 100.0).round().clamp(0.0, 100.0) as i16
            })
            .unwrap_or(100);
        let quantity = i32::try_from(item.count.max(1)).unwrap_or(1);
        if let Some(existing) = stacks.iter_mut().find(|piece| {
            piece.item_type == item.full_type
                && piece.condition_bp == condition_bp
                && piece.cargo.is_empty()
                && nested.is_empty()
        }) {
            existing.quantity += quantity;
            continue;
        }
        stacks.push(CargoPiece {
            item_type: item.full_type.clone(),
            item_name: if item.name.is_empty() {
                item.full_type.clone()
            } else {
                item.name.clone()
            },
            category: if item.category.is_empty() {
                "General".to_owned()
            } else {
                item.category.clone()
            },
            condition_bp,
            quantity,
            cargo: nested,
        });
    }
    stacks
}

fn cargo_units(cargo: &[CargoPiece]) -> i32 {
    cargo
        .iter()
        .map(|piece| piece.quantity + cargo_units(&piece.cargo))
        .sum()
}

fn retrieve_units(quantity: i32, cargo_count: i32) -> i32 {
    if cargo_count > 0 {
        1 + cargo_count
    } else {
        quantity
    }
}

async fn fail_move(db: &PgPool, id: Uuid, actual: i32) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE vault_moves
           SET status = 'failed', actual = $2, finished_at = now()
           WHERE id = $1 AND status = 'pending'"#,
    )
    .bind(id)
    .bind(actual)
    .execute(db)
    .await?;
    Ok(())
}

fn condition_bp(raw: Option<f32>) -> i16 {
    let fraction = inventory::wear_fraction(raw).unwrap_or(1.0);
    (fraction * 100.0).round().clamp(0.0, 100.0) as i16
}

fn bound_slots(value: i32, min: i32, max: i32) -> ApiResult<i32> {
    if value < min || value > max {
        return Err(ApiError::Validation(format!(
            "Slots must be between {min} and {max}."
        )));
    }
    Ok(value)
}
