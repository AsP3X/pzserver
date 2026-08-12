//! Game server status.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::ApiResult;
use crate::services::stats::{self, StatusSample};
use crate::services::status::ServerStatus;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/server/status", get(status))
        .route("/server/history", get(history))
}

#[derive(Serialize)]
struct StatusResponse {
    #[serde(flatten)]
    status: ServerStatus,
    /// Address to type into the game client, when one is configured.
    connect: Option<ConnectInfo>,
}

#[derive(Serialize)]
struct ConnectInfo {
    host: String,
    port: u16,
}

/// Current status. Never fails on account of the game server — a stopped world
/// is reported as `"state": "offline"` with a 200.
async fn status(State(state): State<AppState>) -> Json<StatusResponse> {
    let status = state.status.current().await;

    let connect = state.config.connect_host.as_ref().map(|host| ConnectInfo {
        host: host.clone(),
        port: state.config.connect_port,
    });

    Json(StatusResponse { status, connect })
}

#[derive(Deserialize)]
struct HistoryQuery {
    hours: Option<i32>,
}

/// Population over time, for the landing page's activity graph.
async fn history(
    State(state): State<AppState>,
    Query(query): Query<HistoryQuery>,
) -> ApiResult<Json<Vec<StatusSample>>> {
    let hours = query.hours.unwrap_or(24).clamp(1, 24 * 30);

    Ok(Json(stats::history(&state.db, hours).await?))
}
