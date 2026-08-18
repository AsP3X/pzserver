//! Wallet, store, auction house and cash deposits.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::extract::{AdminUser, AuthUser};
use crate::services::economy::{
    self, auction, deposit, quests, rewards, store, vault, wallet,
};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/me/wallet", get(my_wallet))
        .route("/me/wallet/transactions", get(my_transactions))
        .route("/me/rewards", get(my_rewards))
        .route("/me/rewards/claim", post(claim_reward))
        .route("/me/rewards/quests/{id}/claim", post(claim_quest))
        .route("/me/rewards/quests/{id}/nodes/{node_id}", post(claim_quest_node))
        .route("/admin/quests", get(admin_quests).post(create_quest))
        .route(
            "/admin/quests/{id}",
            get(show_quest).patch(update_quest).delete(delete_quest),
        )
        .route(
            "/admin/quests/{id}/nodes/{node_id}/grant",
            post(grant_quest_node),
        )
        .route("/admin/groups", get(admin_groups).post(create_group))
        .route("/admin/groups/{id}", axum::routing::delete(delete_group))
        .route(
            "/admin/groups/{id}/members",
            get(group_members).post(add_group_member),
        )
        .route(
            "/admin/groups/{id}/members/{username}",
            axum::routing::delete(remove_group_member),
        )
        .route("/store", get(store_catalogue))
        .route("/store/{id}/buy", post(buy_store))
        .route("/me/store/purchases", get(my_purchases))
        .route("/auctions", get(auctions).post(list_auction))
        .route("/auctions/mine", get(my_auctions))
        .route("/auctions/{id}", get(show_auction))
        .route("/auctions/{id}/bid", post(place_bid))
        .route("/auctions/{id}/buyout", post(buyout))
        .route("/auctions/{id}/cancel", post(cancel_auction))
        .route("/admin/store", get(admin_store).post(create_store_item))
        .route(
            "/admin/store/{id}",
            axum::routing::patch(update_store_item).delete(delete_store_item),
        )
        .route("/admin/store/purchases", get(admin_purchases))
        .route("/admin/wallets", get(admin_wallets))
        .route("/admin/wallets/{user_id}", post(adjust_wallet))
        .route("/admin/wallets/{user_id}/transactions", get(admin_transactions))
        .route("/admin/auctions", get(admin_auctions))
        .route("/admin/auctions/{id}/bids", get(admin_auction_bids))
        .route("/admin/auctions/{id}/cancel", post(admin_cancel_auction))
        .route("/me/deposit", get(deposit_preview).post(open_deposit))
        .route("/me/deposit/history", get(my_deposits))
        .route(
            "/admin/bridge/deposits",
            get(admin_deposits).patch(update_deposit_rates),
        )
        .route("/admin/bridge/deposits/{id}/cancel", post(cancel_deposit))
        .route(
            "/admin/bridge/deposits/{id}/credit",
            post(force_credit_deposit),
        )
        .route("/me/vault", get(my_vault))
        .route("/me/vault/store", post(store_in_vault))
        .route("/me/vault/retrieve", post(retrieve_from_vault))
        .route("/me/vault/upgrade", post(upgrade_vault))
        .route("/admin/vault", get(admin_vault).patch(update_vault_settings))
}

async fn admin_auctions(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<auction::ListingView>>> {
    Ok(Json(auction::admin_list(&state.db).await?))
}

async fn admin_auction_bids(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<auction::BidView>>> {
    Ok(Json(auction::bids(&state.db, id).await?))
}

async fn my_wallet(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<wallet::WalletView>> {
    Ok(Json(wallet::view(&state.db, user.id).await?))
}

async fn my_transactions(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<wallet::WalletTransaction>>> {
    Ok(Json(wallet::history(&state.db, user.id, 200).await?))
}

async fn my_rewards(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<rewards::RewardsView>> {
    Ok(Json(rewards::status(&state, user.id, &user.username).await?))
}

#[derive(Deserialize)]
struct ClaimBody {
    key: String,
}

async fn claim_reward(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<ClaimBody>,
) -> ApiResult<Json<rewards::ClaimResult>> {
    Ok(Json(
        rewards::claim(&state, user.id, &user.username, body.key.trim()).await?,
    ))
}

#[derive(Deserialize)]
struct GrantBody {
    username: String,
}

/// Staff completing a step for a player. The only way to finish a `manual`
/// node, which by definition has no measure the server can read.
async fn grant_quest_node(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path((id, node_id)): Path<(Uuid, String)>,
    Json(body): Json<GrantBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let (xp, coins) = quests::grant_node(&state, &body.username, id, &node_id).await?;
    Ok(Json(serde_json::json!({
        "xp": xp,
        "coins": coins,
        "message": "Step granted.",
    })))
}

async fn claim_quest(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<rewards::ClaimResult>> {
    Ok(Json(
        rewards::claim_quest(&state, user.id, &user.username, id).await?,
    ))
}

async fn claim_quest_node(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, node_id)): Path<(Uuid, String)>,
) -> ApiResult<Json<rewards::ClaimResult>> {
    Ok(Json(
        rewards::claim_quest_node(&state, user.id, &user.username, id, &node_id).await?,
    ))
}

async fn admin_quests(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<quests::Quest>>> {
    Ok(Json(quests::list_admin(&state.db).await?))
}

async fn show_quest(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<quests::Quest>> {
    Ok(Json(quests::get(&state.db, id).await?))
}

async fn create_quest(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<quests::QuestPatch>,
) -> ApiResult<(StatusCode, Json<quests::Quest>)> {
    Ok((StatusCode::CREATED, Json(quests::create(&state.db, body).await?)))
}

async fn update_quest(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<quests::QuestPatch>,
) -> ApiResult<Json<quests::Quest>> {
    Ok(Json(quests::update(&state.db, id, body).await?))
}

async fn delete_quest(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    quests::delete(&state.db, id).await?;
    Ok(Json(serde_json::json!({ "message": "Flow removed." })))
}

async fn admin_groups(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<quests::PlayerGroup>>> {
    Ok(Json(quests::list_groups(&state.db).await?))
}

#[derive(Deserialize)]
struct GroupBody {
    name: String,
}

async fn create_group(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<GroupBody>,
) -> ApiResult<(StatusCode, Json<quests::PlayerGroup>)> {
    Ok((
        StatusCode::CREATED,
        Json(quests::create_group(&state.db, &body.name).await?),
    ))
}

async fn delete_group(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    quests::delete_group(&state.db, id).await?;
    Ok(Json(serde_json::json!({ "message": "Group removed." })))
}

async fn group_members(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<String>>> {
    Ok(Json(quests::group_members(&state.db, id).await?))
}

#[derive(Deserialize)]
struct MemberBody {
    username: String,
}

async fn add_group_member(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<MemberBody>,
) -> ApiResult<Json<serde_json::Value>> {
    quests::add_member(&state.db, id, &body.username).await?;
    Ok(Json(serde_json::json!({ "message": "Added." })))
}

async fn remove_group_member(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path((id, username)): Path<(Uuid, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    quests::remove_member_named(&state.db, id, &username).await?;
    Ok(Json(serde_json::json!({ "message": "Removed." })))
}

async fn store_catalogue(
    State(state): State<AppState>,
) -> ApiResult<Json<Vec<store::StoreItem>>> {
    Ok(Json(store::list_public(&state.db).await?))
}

#[derive(Deserialize)]
struct BuyBody {
    quantity: Option<i32>,
}

async fn buy_store(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<BuyBody>,
) -> ApiResult<(StatusCode, Json<store::StorePurchase>)> {
    let purchase = store::buy(
        &state,
        user.id,
        &user.username,
        id,
        body.quantity.unwrap_or(1),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(purchase)))
}

async fn my_purchases(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<store::StorePurchase>>> {
    Ok(Json(store::purchases_for(&state.db, user.id).await?))
}

async fn auctions(
    State(state): State<AppState>,
    crate::extract::MaybeAuthUser(user): crate::extract::MaybeAuthUser,
) -> ApiResult<Json<Vec<auction::ListingView>>> {
    Ok(Json(
        auction::catalogue(&state.db, user.map(|row| row.id)).await?,
    ))
}

async fn my_auctions(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<auction::ListingView>>> {
    Ok(Json(auction::mine(&state.db, user.id).await?))
}

async fn show_auction(
    State(state): State<AppState>,
    crate::extract::MaybeAuthUser(user): crate::extract::MaybeAuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<auction::ListingView>> {
    auction::get_view(&state.db, id, user.map(|row| row.id))
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::Validation("That auction is gone.".to_owned()))
}

async fn list_auction(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<auction::ListItem>,
) -> ApiResult<(StatusCode, Json<auction::ListingView>)> {
    let listing = auction::list_item(&state, user.id, &user.username, body).await?;
    Ok((StatusCode::CREATED, Json(listing)))
}

#[derive(Deserialize)]
struct BidBody {
    amount: i64,
}

async fn place_bid(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<BidBody>,
) -> ApiResult<Json<auction::ListingView>> {
    Ok(Json(auction::bid(&state, id, user.id, body.amount).await?))
}

async fn buyout(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<auction::ListingView>> {
    Ok(Json(auction::buyout(&state, id, user.id).await?))
}

async fn cancel_auction(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    auction::cancel(&state, id, user.id, false).await?;
    Ok(Json(serde_json::json!({ "message": "Listing cancelled." })))
}

async fn admin_store(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<store::StoreItem>>> {
    Ok(Json(store::list_admin(&state.db).await?))
}

async fn create_store_item(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<store::StoreItemPatch>,
) -> ApiResult<(StatusCode, Json<store::StoreItem>)> {
    Ok((StatusCode::CREATED, Json(store::create(&state.db, body).await?)))
}

async fn update_store_item(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<store::StoreItemPatch>,
) -> ApiResult<Json<store::StoreItem>> {
    Ok(Json(store::update(&state.db, id, body).await?))
}

async fn delete_store_item(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    store::delete(&state.db, id).await?;
    Ok(Json(serde_json::json!({ "message": "Listing removed." })))
}

async fn admin_purchases(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<store::StorePurchaseRow>>> {
    Ok(Json(store::purchases_all(&state.db).await?))
}

async fn admin_wallets(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<wallet::AdminWalletRow>>> {
    Ok(Json(wallet::list_admin(&state.db).await?))
}

async fn admin_transactions(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(user_id): Path<Uuid>,
) -> ApiResult<Json<Vec<wallet::WalletTransaction>>> {
    Ok(Json(wallet::history(&state.db, user_id, 1_000).await?))
}

#[derive(Deserialize)]
struct AdjustBody {
    amount: i64,
    reason: Option<String>,
}

async fn adjust_wallet(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<AdjustBody>,
) -> ApiResult<Json<wallet::WalletView>> {
    if body.amount == 0 {
        return Err(ApiError::Validation("Amount cannot be zero.".to_owned()));
    }
    let reason = body.reason.unwrap_or_else(|| "Admin adjustment".to_owned());
    if body.amount > 0 {
        wallet::credit(
            &state.db,
            user_id,
            body.amount,
            economy::SOURCE_ADMIN,
            Some(&reason),
            None,
            None,
        )
        .await?;
    } else {
        wallet::debit(
            &state.db,
            user_id,
            -body.amount,
            economy::SOURCE_ADMIN,
            Some(&reason),
            None,
            None,
        )
        .await?;
    }
    Ok(Json(wallet::view(&state.db, user_id).await?))
}

async fn admin_cancel_auction(
    State(state): State<AppState>,
    AdminUser(staff): AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    auction::cancel(&state, id, staff.id, true).await?;
    Ok(Json(serde_json::json!({ "message": "Listing cancelled." })))
}

// ── Cash deposits ───────────────────────────────────────────────────

/// What the signed-in player would get for banking the cash they carry.
async fn deposit_preview(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<deposit::DepositPreview>> {
    Ok(Json(
        deposit::preview(&state, user.id, &user.username).await?,
    ))
}

/// Hand a deposit to the mod. The wallet moves later, once the cash is gone.
async fn open_deposit(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<(StatusCode, Json<deposit::MoneyDeposit>)> {
    let row = deposit::request(&state, user.id, &user.username).await?;

    Ok((StatusCode::ACCEPTED, Json(row)))
}

async fn my_deposits(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<deposit::MoneyDeposit>>> {
    Ok(Json(deposit::history(&state.db, user.id, 20).await?))
}

#[derive(Serialize)]
struct AdminDepositsResponse {
    rates: pz_bridge::DepositRates,
    deposits: Vec<deposit::MoneyDeposit>,
}

async fn admin_deposits(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<AdminDepositsResponse>> {
    Ok(Json(AdminDepositsResponse {
        rates: deposit::rates(&state).await?,
        deposits: deposit::list(&state.db, None, 100).await?,
    }))
}

#[derive(Deserialize)]
struct DepositRatesBody {
    money_value: i64,
    bundle_value: i64,
}

async fn update_deposit_rates(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<DepositRatesBody>,
) -> ApiResult<Json<pz_bridge::DepositRates>> {
    let rates = deposit::set_rates(
        &state,
        pz_bridge::DepositRates {
            money_value: body.money_value,
            bundle_value: body.bundle_value,
        },
    )
    .await?;

    Ok(Json(rates))
}

async fn cancel_deposit(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<deposit::MoneyDeposit>> {
    Ok(Json(deposit::cancel(&state, id).await?))
}

#[derive(Deserialize)]
struct ForceCreditBody {
    coins: i64,
}

/// Pay a deposit whose credit never landed. Deliberately staff-only and
/// audited: it moves coins without the mod having said anything new.
async fn force_credit_deposit(
    State(state): State<AppState>,
    AdminUser(staff): AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<ForceCreditBody>,
) -> ApiResult<Json<deposit::MoneyDeposit>> {
    Ok(Json(
        deposit::force_credit(&state, id, body.coins, &staff.username).await?,
    ))
}

async fn my_vault(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<vault::VaultView>> {
    Ok(Json(vault::view(&state, user.id).await?))
}

async fn store_in_vault(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<vault::StoreBody>,
) -> ApiResult<Json<vault::VaultView>> {
    Ok(Json(
        vault::store(&state, user.id, &user.username, body).await?,
    ))
}

async fn retrieve_from_vault(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<vault::RetrieveBody>,
) -> ApiResult<Json<vault::VaultView>> {
    Ok(Json(
        vault::retrieve(&state, user.id, &user.username, body).await?,
    ))
}

async fn upgrade_vault(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<vault::VaultView>> {
    Ok(Json(vault::upgrade(&state, user.id).await?))
}

async fn admin_vault(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<vault::AdminVault>> {
    Ok(Json(vault::admin_view(&state.db).await?))
}

async fn update_vault_settings(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<vault::SettingsPatch>,
) -> ApiResult<Json<vault::AdminVault>> {
    vault::update_settings(&state.db, body).await?;
    Ok(Json(vault::admin_view(&state.db).await?))
}
