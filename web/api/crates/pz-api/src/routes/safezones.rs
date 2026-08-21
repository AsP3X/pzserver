//! Admin safe-zone rectangles and the PvP incidents they produce.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use uuid::Uuid;

use crate::error::ApiResult;
use crate::extract::AdminUser;
use crate::services::auth::User;
use crate::services::safezones::{
    self, ConfigPatch, PvpViolation, ResolvePatch, SafeZoneView, ZonePatch,
};
use crate::state::AppState;
use pz_bridge::sanctuary::SafeZoneConfig;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/safe-zones", get(public_config))
        .route("/admin/safe-zones", get(show).post(create_zone))
        .route(
            "/admin/safe-zones/config",
            axum::routing::patch(update_config),
        )
        .route("/admin/safe-zones/{id}", axum::routing::delete(delete_zone))
        .route("/admin/safe-zones/violations/{id}", post(resolve_violation))
}

async fn public_config(State(state): State<AppState>) -> ApiResult<Json<SafeZoneConfig>> {
    Ok(Json(safezones::public_config(&state).await))
}

async fn show(State(state): State<AppState>, _staff: AdminUser) -> ApiResult<Json<SafeZoneView>> {
    Ok(Json(safezones::view(&state).await?))
}

async fn update_config(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<ConfigPatch>,
) -> ApiResult<Json<SafeZoneConfig>> {
    Ok(Json(safezones::set_enabled(&state, body.enabled).await?))
}

async fn create_zone(
    State(state): State<AppState>,
    _staff: AdminUser,
    Json(body): Json<ZonePatch>,
) -> ApiResult<(StatusCode, Json<SafeZoneConfig>)> {
    Ok((
        StatusCode::CREATED,
        Json(safezones::add_zone(&state, body).await?),
    ))
}

async fn delete_zone(
    State(state): State<AppState>,
    _staff: AdminUser,
    Path(id): Path<String>,
) -> ApiResult<Json<SafeZoneConfig>> {
    Ok(Json(safezones::remove_zone(&state, &id).await?))
}

async fn resolve_violation(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<ResolvePatch>,
) -> ApiResult<Json<PvpViolation>> {
    Ok(Json(
        safezones::resolve(&state.db, id, body, actor_name(&user)).await?,
    ))
}

fn actor_name(user: &User) -> &str {
    user.username.as_str()
}
