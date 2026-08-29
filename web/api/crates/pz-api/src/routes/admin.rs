//! Staff-only control plane.

use std::collections::BTreeMap;

use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::extract::AdminUser;
use crate::services::admin;
use crate::services::audit;
use crate::services::automations;
use crate::services::backups;
use crate::services::reports;
use crate::services::respawn;
use crate::services::sanctions;
use crate::services::site::{self, SiteSettings};
use crate::services::wipe::{self, WipeRequest, WipeResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/players", get(players))
        .route("/admin/players/{username}/kick", post(kick))
        .route("/admin/players/{username}/ban", post(ban))
        .route("/admin/players/{username}/unban", post(unban))
        .route("/admin/players/{username}/suspend", post(suspend))
        .route("/admin/sanctions", get(sanctions))
        .route("/admin/respawn", get(respawn_view).patch(configure_respawn))
        .route("/admin/respawn/{username}/reset", post(reset_respawn))
        .route("/admin/players/{username}/access", post(access))
        .route("/admin/players/{username}/teleport", post(teleport))
        .route("/admin/players/{username}/inventory", get(inventory))
        .route("/admin/players/{username}/items/give", post(give_item))
        .route("/admin/players/{username}/items/take", post(take_item))
        .route("/admin/server/start", post(start))
        .route("/admin/server/stop", post(stop))
        .route("/admin/server/restart", post(restart))
        .route("/admin/server/save", post(save))
        .route(
            "/admin/server/update",
            get(update_status).post(update_server),
        )
        .route(
            "/admin/players/{username}/password",
            post(set_player_password),
        )
        .route("/admin/whitelist/{username}/toggle", post(whitelist_toggle))
        .route("/admin/whitelist/sync", post(whitelist_sync))
        .route("/admin/broadcast", post(broadcast))
        .route("/admin/console", post(console))
        .route("/admin/config", get(config).patch(update_config))
        .route("/admin/config/sandbox", get(sandbox).patch(update_sandbox))
        .route("/admin/mods", get(mods).post(add_mod))
        .route("/admin/mods/lookup", post(lookup_mod))
        .route("/admin/mods/dependencies", post(mod_dependencies))
        .route("/admin/mods/order", axum::routing::put(reorder_mods))
        .route("/admin/mods/import", post(import_mods))
        .route("/admin/mods/{workshop_id}", delete(remove_mod))
        .route("/admin/whitelist", patch(whitelist_settings))
        .route(
            "/admin/whitelist/{username}",
            post(whitelist_add).delete(whitelist_remove),
        )
        .route("/admin/bridge", get(bridge))
        .route("/admin/items", get(items))
        .route("/admin/logs", get(logs))
        .route("/admin/events", get(events))
        .route("/admin/reports", get(report_queue))
        .route("/admin/reports/{id}", get(show_report).patch(update_report))
        .route("/admin/site", get(site).patch(update_site))
        .route(
            "/admin/backups",
            get(backups).post(create_backup).delete(delete_backups),
        )
        .route("/admin/backups/status", get(backup_status))
        .route(
            "/admin/backups/schedule",
            get(backup_schedule).patch(update_backup_schedule),
        )
        .route("/admin/backups/{id}", delete(delete_backup))
        .route("/admin/backups/{id}/contents", get(backup_contents))
        .route("/admin/backups/{id}/file", get(backup_file))
        .route("/admin/backups/{id}/rollback", post(rollback_backup))
        .route(
            "/admin/automations",
            get(automations).post(create_automation),
        )
        .route(
            "/admin/automations/{id}",
            patch(update_automation).delete(delete_automation),
        )
        .route("/admin/automations/{id}/run", post(run_automation))
        .route("/admin/automations/{id}/runs", get(automation_runs))
        .route("/admin/audit", get(audit_log))
        .route("/admin/audit/actions", get(audit_actions))
        .route("/admin/map-tiles/rerender", post(rerender_tiles))
        .route("/admin/map-tiles/jobs/{id}", get(tile_job))
        .route("/admin/map-tiles/jobs/{id}/log", get(tile_job_log))
}

/// Download and import sit outside the 15s request ceiling.
pub fn file_routes() -> Router<AppState> {
    Router::new()
        .route("/admin/backups/{id}/download", get(download_backup))
        .route("/admin/backups/import", post(import_world))
        .route("/admin/server/wipe", post(wipe_server))
        .route("/admin/mods/{workshop_id}/update", post(update_mod))
}

async fn wipe_server(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<WipeRequest>,
) -> ApiResult<Json<WipeResult>> {
    Ok(Json(wipe::run(&state, body).await?))
}

#[derive(serde::Serialize)]
struct CommandReply {
    output: String,
}

// ── Players ─────────────────────────────────────────────────────────

async fn players(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<admin::AdminPlayer>>> {
    Ok(Json(admin::list_players(&state).await?))
}

#[derive(Deserialize)]
struct ReasonBody {
    reason: Option<String>,
}

async fn kick(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
    body: Option<Json<ReasonBody>>,
) -> ApiResult<Json<CommandReply>> {
    let reason = body.and_then(|Json(body)| body.reason);
    Ok(Json(CommandReply {
        output: admin::kick(&state, &username, reason.as_deref()).await?,
    }))
}

async fn ban(
    State(state): State<AppState>,
    AdminUser(staff): AdminUser,
    Path(username): Path<String>,
    body: Option<Json<ReasonBody>>,
) -> ApiResult<Json<sanctions::Sanction>> {
    let reason = body.and_then(|Json(body)| body.reason);
    Ok(Json(
        sanctions::ban(&state, &username, reason.as_deref(), staff.id).await?,
    ))
}

async fn unban(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
) -> ApiResult<Json<CommandReply>> {
    Ok(Json(CommandReply {
        output: sanctions::lift(&state, &username, "staff").await?,
    }))
}

#[derive(Deserialize)]
struct SuspendBody {
    duration_seconds: i64,
    reason: Option<String>,
}

async fn suspend(
    State(state): State<AppState>,
    AdminUser(staff): AdminUser,
    Path(username): Path<String>,
    Json(body): Json<SuspendBody>,
) -> ApiResult<Json<sanctions::Sanction>> {
    Ok(Json(
        sanctions::suspend(
            &state,
            &username,
            body.reason.as_deref(),
            body.duration_seconds,
            staff.id,
        )
        .await?,
    ))
}

async fn sanctions(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<sanctions::SanctionList>> {
    Ok(Json(sanctions::list(&state.db).await?))
}

/// The cooldown setting, plus who is currently sitting one out.
async fn respawn_view(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<respawn::RespawnView>> {
    Ok(Json(respawn::view(&state).await?))
}

#[derive(Deserialize)]
struct RespawnConfigBody {
    enabled: bool,
    delay_minutes: i64,
}

async fn configure_respawn(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<RespawnConfigBody>,
) -> ApiResult<Json<respawn::RespawnView>> {
    Ok(Json(
        respawn::configure(&state, body.enabled, body.delay_minutes).await?,
    ))
}

/// Let one player back in early.
async fn reset_respawn(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
) -> ApiResult<Json<respawn::RespawnView>> {
    Ok(Json(respawn::reset(&state, &username).await?))
}

#[derive(Deserialize)]
struct AccessBody {
    level: String,
}

async fn access(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
    Json(body): Json<AccessBody>,
) -> ApiResult<Json<CommandReply>> {
    Ok(Json(CommandReply {
        output: admin::set_access(&state, &username, &body.level).await?,
    }))
}

#[derive(Deserialize)]
struct TeleportBody {
    x: f64,
    y: f64,
    #[serde(default)]
    z: i32,
}

async fn teleport(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
    Json(body): Json<TeleportBody>,
) -> ApiResult<Json<CommandReply>> {
    Ok(Json(CommandReply {
        output: admin::teleport(&state, &username, body.x, body.y, body.z).await?,
    }))
}

async fn inventory(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
) -> ApiResult<Json<Option<pz_bridge::InventorySnapshot>>> {
    Ok(Json(admin::player_inventory(&state, &username).await?))
}

#[derive(Deserialize)]
struct ItemMove {
    item_type: String,
    count: Option<i32>,
}

async fn give_item(
    State(state): State<AppState>,
    AdminUser(staff): AdminUser,
    Path(username): Path<String>,
    Json(body): Json<ItemMove>,
) -> ApiResult<Json<serde_json::Value>> {
    let item_type = crate::services::economy::item_type(&body.item_type)?;
    let count = body.count.unwrap_or(1);
    if !(1..=100).contains(&count) {
        return Err(ApiError::Validation("Give between 1 and 100.".to_owned()));
    }
    crate::services::economy::delivery::give_now(
        &state,
        &username,
        item_type,
        count,
        "admin_give",
        "admin",
        staff.id,
    )
    .await?;
    Ok(Json(serde_json::json!({
        "message": "Queued. In-world players receive it on the next pulse; others on join."
    })))
}

async fn take_item(
    State(state): State<AppState>,
    AdminUser(staff): AdminUser,
    Path(username): Path<String>,
    Json(body): Json<ItemMove>,
) -> ApiResult<Json<serde_json::Value>> {
    let item_type = crate::services::economy::item_type(&body.item_type)?;
    let count = body.count.unwrap_or(1);
    if !(1..=100).contains(&count) {
        return Err(ApiError::Validation("Take between 1 and 100.".to_owned()));
    }
    crate::services::economy::delivery::take(
        &state,
        &username,
        item_type,
        count,
        "admin_take",
        "admin",
        staff.id,
    )
    .await?;
    Ok(Json(serde_json::json!({
        "message": "Queued. The item leaves their pack the next time they are in the world."
    })))
}

// ── Server ──────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct MessageBody {
    message: Option<String>,
}

async fn start(State(state): State<AppState>, _staff: AdminUser) -> ApiResult<Json<CommandReply>> {
    admin::start(&state).await?;
    Ok(Json(CommandReply {
        output: "starting".to_owned(),
    }))
}

async fn stop(
    State(state): State<AppState>,
    _staff: AdminUser,
    body: Option<Json<MessageBody>>,
) -> ApiResult<Json<CommandReply>> {
    let message = body.and_then(|Json(body)| body.message);
    admin::stop(&state, message.as_deref()).await?;
    Ok(Json(CommandReply {
        output: "stopping".to_owned(),
    }))
}

async fn restart(
    State(state): State<AppState>,
    _staff: AdminUser,
    body: Option<Json<MessageBody>>,
) -> ApiResult<Json<CommandReply>> {
    let message = body.and_then(|Json(body)| body.message);
    admin::restart(&state, message.as_deref()).await?;
    Ok(Json(CommandReply {
        output: "restarting".to_owned(),
    }))
}

async fn save(State(state): State<AppState>, _staff: AdminUser) -> ApiResult<Json<CommandReply>> {
    Ok(Json(CommandReply {
        output: admin::save_world(&state).await?,
    }))
}

#[derive(Deserialize)]
struct BroadcastBody {
    message: String,
}

async fn broadcast(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<BroadcastBody>,
) -> ApiResult<Json<CommandReply>> {
    Ok(Json(CommandReply {
        output: admin::broadcast(&state, &body.message).await?,
    }))
}

#[derive(Deserialize)]
struct ConsoleBody {
    command: String,
}

async fn console(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<ConsoleBody>,
) -> ApiResult<Json<CommandReply>> {
    Ok(Json(CommandReply {
        output: admin::console(&state, &body.command).await?,
    }))
}

// ── Config / mods ───────────────────────────────────────────────────

async fn config(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<admin::ServerConfig>> {
    Ok(Json(admin::read_config(&state).await?))
}

#[derive(Deserialize)]
struct ConfigBody {
    updates: BTreeMap<String, String>,
}

async fn update_config(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<ConfigBody>,
) -> ApiResult<Json<admin::ServerConfig>> {
    admin::write_config(&state, body.updates).await?;
    Ok(Json(admin::read_config(&state).await?))
}

async fn sandbox(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<admin::SandboxConfig>> {
    Ok(Json(admin::read_sandbox(&state).await?))
}

async fn update_sandbox(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<ConfigBody>,
) -> ApiResult<Json<admin::SandboxConfig>> {
    admin::write_sandbox(&state, body.updates).await?;
    Ok(Json(admin::read_sandbox(&state).await?))
}

async fn mods(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<admin::ModEntry>>> {
    Ok(Json(admin::list_mods(&state).await?))
}

#[derive(Deserialize)]
struct AddModBody {
    workshop_id: String,
    mod_id: String,
    map_folder: Option<String>,
}

async fn add_mod(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<AddModBody>,
) -> ApiResult<Json<Vec<admin::ModEntry>>> {
    Ok(Json(
        admin::add_mod(
            &state,
            &body.workshop_id,
            &body.mod_id,
            body.map_folder.as_deref(),
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct LookupBody {
    workshop_id: String,
}

async fn mod_dependencies(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<LookupBody>,
) -> ApiResult<Json<Vec<pz_bridge::WorkshopDetails>>> {
    Ok(Json(
        admin::missing_mod_dependencies(&state, &body.workshop_id).await?,
    ))
}

async fn lookup_mod(
    State(_state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<LookupBody>,
) -> ApiResult<Json<pz_bridge::WorkshopDetails>> {
    let Some(id) = pz_bridge::parse_workshop_id(&body.workshop_id) else {
        return Err(crate::error::ApiError::Validation(
            "Paste a Workshop id, or a Steam Workshop URL.".to_owned(),
        ));
    };

    pz_bridge::workshop::lookup(&id)
        .await
        .map(Json)
        .map_err(|error| crate::error::ApiError::Internal(error.to_string()))
}

#[derive(Deserialize)]
struct ReorderBody {
    mods: Vec<admin::ModEntry>,
}

async fn reorder_mods(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<ReorderBody>,
) -> ApiResult<Json<Vec<admin::ModEntry>>> {
    Ok(Json(admin::reorder_mods(&state, &body.mods).await?))
}

#[derive(Deserialize)]
struct ImportBody {
    workshop_ids: Vec<String>,
    #[serde(default)]
    mod_ids: Vec<String>,
    #[serde(default)]
    map_folders: Vec<String>,
}

async fn import_mods(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<ImportBody>,
) -> ApiResult<Json<Vec<admin::ModEntry>>> {
    Ok(Json(
        admin::import_mods(&state, &body.workshop_ids, &body.mod_ids, &body.map_folders).await?,
    ))
}

async fn remove_mod(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(workshop_id): Path<String>,
) -> ApiResult<Json<Vec<admin::ModEntry>>> {
    Ok(Json(admin::remove_mod(&state, &workshop_id).await?))
}

async fn update_mod(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(workshop_id): Path<String>,
) -> ApiResult<Json<Vec<admin::ModEntry>>> {
    Ok(Json(admin::update_mod(&state, &workshop_id).await?))
}

#[derive(Deserialize)]
struct WhitelistSettings {
    open: bool,
}

async fn whitelist_settings(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<WhitelistSettings>,
) -> ApiResult<Json<admin::ServerConfig>> {
    let mut updates = BTreeMap::new();
    updates.insert(
        "Open".to_owned(),
        if body.open { "true" } else { "false" }.to_owned(),
    );
    admin::write_config(&state, updates).await?;
    Ok(Json(admin::read_config(&state).await?))
}

async fn whitelist_add(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
) -> ApiResult<Json<CommandReply>> {
    Ok(Json(CommandReply {
        output: admin::add_to_whitelist(&state, &username).await?,
    }))
}

async fn whitelist_remove(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
) -> ApiResult<Json<CommandReply>> {
    Ok(Json(CommandReply {
        output: admin::remove_from_whitelist(&state, &username).await?,
    }))
}

async fn whitelist_toggle(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let whitelisted = admin::toggle_whitelist(&state, &username).await?;

    Ok(Json(serde_json::json!({ "whitelisted": whitelisted })))
}

async fn whitelist_sync(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<admin::WhitelistSync>> {
    Ok(Json(admin::sync_whitelist(&state).await?))
}

#[derive(Deserialize)]
struct PlayerPasswordBody {
    password: String,
}

/// Set a player's *game* password. Never touches their website login.
async fn set_player_password(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(username): Path<String>,
    Json(body): Json<PlayerPasswordBody>,
) -> ApiResult<Json<CommandReply>> {
    Ok(Json(CommandReply {
        output: admin::set_game_password(&state, &username, &body.password).await?,
    }))
}

#[derive(Serialize)]
struct UpdateStatus {
    branch: String,
    branches: Vec<String>,
    /// Staff-only: carries the diagnosis, which can name paths.
    report: pz_bridge::UpdateReport,
}

async fn update_status(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<UpdateStatus>> {
    Ok(Json(UpdateStatus {
        branch: admin::steam_branch(&state).await,
        branches: admin::STEAM_BRANCHES
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
        report: admin::update_report(&state).await,
    }))
}

#[derive(Deserialize)]
struct UpdateServerBody {
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// Reinstall the game from Steam. Takes the server down and brings it back.
async fn update_server(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<UpdateServerBody>,
) -> ApiResult<Json<serde_json::Value>> {
    admin::update_game(&state, body.branch.as_deref(), body.message.as_deref()).await?;

    Ok(Json(serde_json::json!({
        "message": "Update started. The server will be down while Steam re-downloads it."
    })))
}

// ── Bridge / logs / site ────────────────────────────────────────────

async fn bridge(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<admin::BridgeHealth>> {
    Ok(Json(admin::bridge_health(&state).await?))
}

#[derive(Serialize)]
struct ItemCatalogResponse {
    items: Vec<pz_bridge::ItemCatalogEntry>,
}

/// Every item the server has registered, modded ones included.
///
/// An absent catalogue answers `200` with an empty list rather than an error.
/// The mod writes it at boot, so "not written yet" is the normal state of a
/// server that has never started, and the picker renders an explanation for it.
///
/// The clone off the cached `Arc` is deliberate: `serde` only serialises `Arc`
/// behind its `rc` feature, and this endpoint is hit about once per admin
/// session — not worth widening a dependency's feature set over.
async fn items(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<ItemCatalogResponse>> {
    Ok(Json(ItemCatalogResponse {
        items: state.item_catalog.items().await.to_vec(),
    }))
}

#[derive(Deserialize)]
struct LogQuery {
    tail: Option<u32>,
}

async fn logs(
    State(state): State<AppState>,
    _staff: AdminUser,
    Query(query): Query<LogQuery>,
) -> ApiResult<Json<admin::ContainerLogs>> {
    Ok(Json(
        admin::container_logs(&state, query.tail.unwrap_or(200)).await?,
    ))
}

#[derive(Deserialize)]
struct EventsQuery {
    types: Option<String>,
    from: Option<chrono::DateTime<chrono::Utc>>,
    to: Option<chrono::DateTime<chrono::Utc>>,
    limit: Option<i64>,
}

async fn report_queue(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<reports::ReportQueue>> {
    Ok(Json(reports::list_all(&state.db).await?))
}

#[derive(Deserialize)]
struct HandleReportBody {
    status: String,
    resolution: Option<String>,
}

async fn show_report(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<i64>,
) -> ApiResult<Json<reports::Report>> {
    reports::get_for_staff(&state.db, id)
        .await?
        .map(Json)
        .ok_or_else(|| crate::error::ApiError::Validation("That report is not here.".to_owned()))
}

async fn update_report(
    State(state): State<AppState>,
    AdminUser(staff): AdminUser,
    Path(id): Path<i64>,
    Json(body): Json<HandleReportBody>,
) -> ApiResult<Json<reports::Report>> {
    let report = reports::update(
        &state.db,
        id,
        staff.id,
        &body.status,
        body.resolution.as_deref(),
    )
    .await?;

    if let Some(username) = reports::author_username(&state.db, id).await? {
        reports::refresh_inbox(&state.db, &state.config.lua_bridge_path, &username).await;
    }

    Ok(Json(report))
}

async fn events(
    State(state): State<AppState>,
    _staff: AdminUser,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Json<admin::EventLog>> {
    let types = query
        .types
        .as_deref()
        .unwrap_or("death,pvp_kill")
        .split(',')
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();

    Ok(Json(
        admin::list_events(
            &state,
            admin::EventFilter {
                types,
                from: query.from,
                to: query.to,
                limit: query.limit.unwrap_or(200),
            },
        )
        .await?,
    ))
}

async fn site(State(state): State<AppState>, _staff: AdminUser) -> ApiResult<Json<SiteSettings>> {
    Ok(Json(site::settings(&state.db, site::SOURCE_LOCALE).await?))
}

#[derive(Deserialize)]
struct SiteUpdate {
    site_name: Option<String>,
    hero_badge: Option<String>,
    hero_title: Option<String>,
    hero_subtitle: Option<String>,
    hero_description: Option<String>,
    hero_cta_label: Option<String>,
    footer_text: Option<String>,
    connect_host: Option<String>,
    connect_port: Option<i32>,
    discord_url: Option<String>,
}

async fn update_site(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<SiteUpdate>,
) -> ApiResult<Json<SiteSettings>> {
    Ok(Json(
        site::update(
            &state.db,
            site::SitePatch {
                site_name: body.site_name,
                hero_badge: body.hero_badge,
                hero_title: body.hero_title,
                hero_subtitle: body.hero_subtitle,
                hero_description: body.hero_description,
                hero_cta_label: body.hero_cta_label,
                footer_text: body.footer_text,
                connect_host: body.connect_host,
                connect_port: body.connect_port,
                discord_url: body.discord_url,
            },
        )
        .await?,
    ))
}

// ── Backups ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct BackupQuery {
    r#type: Option<String>,
}

async fn backups(
    State(state): State<AppState>,
    _staff: AdminUser,
    Query(query): Query<BackupQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let items = backups::list(
        &state.db,
        &state.config.backup_path,
        query.r#type.as_deref(),
    )
    .await?;
    let slot = backups::slot(&state.backup_job).await;
    Ok(Json(serde_json::json!({
        "backups": items,
        "job": slot.current,
        "last_error": slot.last_error,
    })))
}

async fn backup_status(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<serde_json::Value>> {
    let slot = backups::slot(&state.backup_job).await;
    Ok(Json(serde_json::json!({
        "job": slot.current,
        "last_error": slot.last_error,
    })))
}

#[derive(Deserialize)]
struct CreateBackupBody {
    notes: Option<String>,
    notify_players: Option<bool>,
    message: Option<String>,
}

async fn create_backup(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<CreateBackupBody>,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    if body
        .notes
        .as_deref()
        .is_some_and(|notes| notes.chars().count() > 500)
    {
        return Err(ApiError::Validation(
            "Notes must be 500 characters or fewer.".to_owned(),
        ));
    }
    backups::start_create(state.clone(), body.notes).await?;
    if body.notify_players.unwrap_or(false) {
        let message = body
            .message
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Backup in progress — expect a brief lag");
        let _ = admin::broadcast(&state, message).await;
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "message": "Backup started. It will appear in the list shortly."
        })),
    ))
}

async fn delete_backup(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    let filename = backups::delete(&state.db, id).await?;
    Ok(Json(
        serde_json::json!({ "message": format!("Deleted {filename}") }),
    ))
}

#[derive(Deserialize)]
struct BulkDeleteBody {
    ids: Vec<Uuid>,
}

async fn delete_backups(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<BulkDeleteBody>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.ids.is_empty() {
        return Err(ApiError::Validation(
            "Select at least one backup.".to_owned(),
        ));
    }
    let outcome = backups::delete_many(&state.db, &body.ids).await?;
    Ok(Json(serde_json::json!({ "message": outcome.message() })))
}

#[derive(Deserialize)]
struct RollbackBody {
    confirm: bool,
    countdown: Option<u32>,
    message: Option<String>,
}

async fn rollback_backup(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<RollbackBody>,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    if !body.confirm {
        return Err(ApiError::Validation(
            "Confirm the rollback first.".to_owned(),
        ));
    }
    if let Some(seconds) = body.countdown.filter(|value| *value > 0) {
        if !(10..=3600).contains(&seconds) {
            return Err(ApiError::Validation(
                "Countdown must be between 10 and 3600 seconds.".to_owned(),
            ));
        }
        let warning = body
            .message
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Server rolling back — you will be disconnected");
        let _ = admin::broadcast(&state, warning).await;
        let cloned = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(seconds.into())).await;
            if let Err(error) = backups::start_rollback(cloned.clone(), id).await {
                tracing::error!(%error, "delayed rollback failed to start");
                backups::record_error(&cloned, error.to_string()).await;
            }
        });
        return Ok((
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "message": format!("Rollback scheduled in {seconds} seconds")
            })),
        ));
    }

    let filename = backups::start_rollback(state, id).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "message": format!("Restoring {filename}")
        })),
    ))
}

async fn backup_schedule(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<backups::BackupSettings>> {
    Ok(Json(backups::settings(&state.db).await?))
}

async fn update_backup_schedule(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<backups::SchedulePatch>,
) -> ApiResult<Json<backups::BackupSettings>> {
    Ok(Json(backups::update_settings(&state.db, body).await?))
}

async fn backup_contents(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<backups::ArchiveListing>> {
    let backup = backups::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That backup is gone.".to_owned()))?;
    Ok(Json(backups::contents(&backup)?))
}

#[derive(Deserialize)]
struct BackupFileQuery {
    path: String,
}

async fn backup_file(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
    Query(query): Query<BackupFileQuery>,
) -> ApiResult<Json<backups::ArchiveFile>> {
    let backup = backups::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That backup is gone.".to_owned()))?;
    Ok(Json(backups::read_entry(&backup, &query.path)?))
}

async fn download_backup(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    let backup = backups::get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That backup is gone.".to_owned()))?;
    let path = backups::download_path(&backup, &state.config.backup_path)?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| ApiError::Internal(format!("could not read the archive: {error}")))?;
    let body = Body::from_stream(ReaderStream::new(file));
    let mut response = axum::response::Response::new(body);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/gzip"),
    );
    if let Ok(value) =
        header::HeaderValue::from_str(&format!("attachment; filename=\"{}\"", backup.filename))
    {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

async fn import_world(
    State(state): State<AppState>,
    _staff: AdminUser,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    let dir = backups::imports_dir(&state.config.backup_path);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| ApiError::Internal(format!("cannot create the import folder: {error}")))?;

    let dest = dir.join(format!(
        "import_{}.zip",
        chrono::Utc::now().format("%Y-%m-%d_%H-%M-%S")
    ));

    let mut written = false;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::Validation(error.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let mut file = tokio::fs::File::create(&dest)
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|error| ApiError::Validation(error.to_string()))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|error| ApiError::Internal(error.to_string()))?;
        }
        written = true;
        break;
    }

    if !written {
        return Err(ApiError::Validation("Choose a zip to import.".to_owned()));
    }

    backups::start_import(state, dest).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "message": "World import started. The server will restart shortly."
        })),
    ))
}

// ── Automations ─────────────────────────────────────────────────────

async fn automations(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<automations::AutomationView>>> {
    Ok(Json(automations::list(&state.db).await?))
}

async fn create_automation(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<automations::AutomationPatch>,
) -> ApiResult<(StatusCode, Json<automations::AutomationView>)> {
    Ok((
        StatusCode::CREATED,
        Json(automations::create(&state.db, body).await?),
    ))
}

async fn update_automation(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<automations::AutomationPatch>,
) -> ApiResult<Json<automations::AutomationView>> {
    Ok(Json(automations::update(&state.db, id, body).await?))
}

async fn delete_automation(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    automations::delete(&state.db, id).await?;
    Ok(Json(
        serde_json::json!({ "message": "Automation deleted." }),
    ))
}

async fn run_automation(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<automations::AutomationView>> {
    Ok(Json(automations::run_now(&state, id).await?))
}

async fn automation_runs(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<automations::AutomationRun>>> {
    Ok(Json(automations::runs(&state.db, id).await?))
}

async fn audit_log(
    State(state): State<AppState>,
    _staff: AdminUser,
    Query(filter): Query<audit::AuditFilter>,
) -> ApiResult<Json<Vec<audit::AuditEntry>>> {
    Ok(Json(audit::list(&state.db, &filter).await?))
}

async fn audit_actions(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<Vec<String>>> {
    Ok(Json(audit::actions(&state.db).await?))
}

#[derive(Deserialize)]
struct RerenderBody {
    #[serde(default)]
    squares: Vec<Vec<i32>>,
    #[serde(default)]
    cells: Vec<Vec<i32>>,
}

async fn rerender_tiles(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<RerenderBody>,
) -> ApiResult<(StatusCode, Json<crate::services::map_tile_jobs::Job>)> {
    let job = crate::services::map_tile_jobs::enqueue(&state, body.squares, body.cells).await?;
    Ok((StatusCode::ACCEPTED, Json(job)))
}

async fn tile_job(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<crate::services::map_tile_jobs::Job>> {
    Ok(Json(
        crate::services::map_tile_jobs::get(&state.db, id).await?,
    ))
}

#[derive(Debug, serde::Deserialize)]
struct TileLogQuery {
    /// Byte offset from the previous poll. Absent means "from the start".
    #[serde(default)]
    offset: u64,
}

/// The renderer's own output, for the admin Map dialog.
///
/// There is one log sidecar beside the pack, not one per job: only one
/// `pz-map-tiles` container runs at a time and `run.sh` truncates it on
/// start. The job id is still in the path so the dialog cannot show a
/// finished job someone else's run has since overwritten without noticing --
/// `get` fails first if the id is unknown.
async fn tile_job_log(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<Uuid>,
    Query(query): Query<TileLogQuery>,
) -> ApiResult<Json<crate::services::map_tile_jobs::JobLog>> {
    crate::services::map_tile_jobs::get(&state.db, id).await?;
    Ok(Json(
        crate::services::map_tile_jobs::read_job_log(&state.config.map_tiles_path, query.offset)
            .unwrap_or(crate::services::map_tile_jobs::JobLog {
                offset: query.offset,
                text: String::new(),
                size: 0,
            }),
    ))
}
