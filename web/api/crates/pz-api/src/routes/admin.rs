//! Staff-only control plane.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::ApiResult;
use crate::extract::AdminUser;
use crate::services::admin;
use crate::services::reports;
use crate::services::sanctions;
use crate::services::site::{self, SiteSettings};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/players", get(players))
        .route("/admin/players/{username}/kick", post(kick))
        .route("/admin/players/{username}/ban", post(ban))
        .route("/admin/players/{username}/unban", post(unban))
        .route("/admin/players/{username}/suspend", post(suspend))
        .route("/admin/sanctions", get(sanctions))
        .route("/admin/players/{username}/access", post(access))
        .route("/admin/players/{username}/teleport", post(teleport))
        .route("/admin/players/{username}/inventory", get(inventory))
        .route("/admin/server/start", post(start))
        .route("/admin/server/stop", post(stop))
        .route("/admin/server/restart", post(restart))
        .route("/admin/server/save", post(save))
        .route("/admin/broadcast", post(broadcast))
        .route("/admin/console", post(console))
        .route("/admin/config", get(config).patch(update_config))
        .route("/admin/mods", get(mods).post(add_mod))
        .route("/admin/mods/lookup", post(lookup_mod))
        .route("/admin/mods/order", axum::routing::put(reorder_mods))
        .route("/admin/mods/import", post(import_mods))
        .route("/admin/mods/{workshop_id}", delete(remove_mod))
        .route("/admin/whitelist", patch(whitelist_settings))
        .route("/admin/whitelist/{username}", post(whitelist_add).delete(whitelist_remove))
        .route("/admin/bridge", get(bridge))
        .route("/admin/logs", get(logs))
        .route("/admin/events", get(events))
        .route("/admin/reports", get(report_queue))
        .route("/admin/reports/{id}", get(show_report).patch(update_report))
        .route("/admin/site", get(site).patch(update_site))
}

#[derive(serde::Serialize)]
struct CommandReply {
    output: String,
}

// ── Players ─────────────────────────────────────────────────────────

async fn players(State(state): State<AppState>, _staff: AdminUser) -> ApiResult<Json<Vec<admin::AdminPlayer>>> {
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

// ── Bridge / logs / site ────────────────────────────────────────────

async fn bridge(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<admin::BridgeHealth>> {
    Ok(Json(admin::bridge_health(&state).await?))
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

async fn site(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<SiteSettings>> {
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
