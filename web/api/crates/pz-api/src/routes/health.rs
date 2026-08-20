//! Liveness and readiness.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/health/detailed", get(detailed))
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

#[derive(Serialize)]
struct DetailedHealth {
    status: &'static str,
    version: &'static str,
    database: Dependency,
    backups: Dependency,
    lua_bridge: Dependency,
    game_server: GameServerHealth,
}

#[derive(Serialize)]
struct Dependency {
    reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct GameServerHealth {
    state: crate::services::status::GameState,
    player_count: usize,
    /// Public-safe. No diagnosis: this endpoint has no auth layer.
    update: pz_bridge::PublicUpdate,
}

/// Public liveness probe: says nothing about the internals beyond whether this
/// container can do the job it was started for.
///
/// This is the URL the image's HEALTHCHECK curls, so the 503 is the point. A
/// shared bind mount this process cannot write is not something it can recover
/// from on its own, and serving on quietly is how two days of failed backups
/// went unnoticed in August 2026. The site stays up either way: Docker marks
/// the container unhealthy without stopping it, and no proxy in front of this
/// routes on health.
async fn health(State(state): State<AppState>) -> (StatusCode, Json<Health>) {
    if state.backups_error.is_some() || state.lua_bridge_error.is_some() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Health { status: "degraded" }),
        );
    }

    (StatusCode::OK, Json(Health { status: "ok" }))
}

/// Dependency detail.
///
/// Returns 200 even when a dependency is down — this endpoint reports, the
/// orchestrator decides. Only the `status` field flips to `degraded`.
async fn detailed(State(state): State<AppState>) -> Json<DetailedHealth> {
    let database = match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => Dependency {
            reachable: true,
            error: None,
        },
        Err(error) => Dependency {
            reachable: false,
            error: Some(error.to_string()),
        },
    };

    // Public-safe, like `update` below: whether they work, never the path or
    // the OS error behind it. The diagnosis goes to the container log at boot.
    let backups = Dependency {
        reachable: state.backups_error.is_none(),
        error: None,
    };
    let lua_bridge = Dependency {
        reachable: state.lua_bridge_error.is_none(),
        error: None,
    };

    let server_status = state.status.current().await;
    let update_healthy = server_status.update.healthy;
    let healthy = database.reachable && backups.reachable && lua_bridge.reachable && update_healthy;

    Json(DetailedHealth {
        status: if healthy { "ok" } else { "degraded" },
        version: env!("CARGO_PKG_VERSION"),
        database,
        backups,
        lua_bridge,
        game_server: GameServerHealth {
            state: server_status.state,
            player_count: server_status.player_count,
            update: server_status.update,
        },
    })
}
