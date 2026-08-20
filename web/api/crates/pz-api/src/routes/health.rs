//! Liveness and readiness.

use axum::extract::State;
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

/// Public liveness probe: says nothing about the internals.
async fn health() -> Json<Health> {
    Json(Health { status: "ok" })
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

    let server_status = state.status.current().await;
    let update_healthy = server_status.update.healthy;

    Json(DetailedHealth {
        status: if database.reachable && update_healthy {
            "ok"
        } else {
            "degraded"
        },
        version: env!("CARGO_PKG_VERSION"),
        database,
        game_server: GameServerHealth {
            state: server_status.state,
            player_count: server_status.player_count,
            update: server_status.update,
        },
    })
}
