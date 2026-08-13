//! Router assembly and shared middleware.

mod auth;
mod health;
mod me;
mod obituary;
mod server;
mod site;
mod stats;

use std::time::Duration;

use axum::Router;
use axum::http::{HeaderValue, Method, StatusCode, header};
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

/// Ceiling on any single request. Sits above the RCON and Docker timeouts so a
/// slow game server surfaces as a status, not as a hung connection.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Everything lives under `/api`, so the same URL works whether a caller hits
/// the container directly or comes through the UI's nginx front.
pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .merge(health::routes())
        .nest("/v1", v1(state.clone()));

    Router::new()
        .nest("/api", api)
        .layer(cors(&state))
        .layer(CompressionLayer::new())
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn v1(state: AppState) -> Router<AppState> {
    Router::new()
        .merge(auth::routes())
        .merge(me::routes())
        .merge(obituary::routes())
        .merge(server::routes())
        .merge(site::routes())
        .merge(stats::routes())
        .with_state(state)
}

/// The UI is served from its own origin, so the browser preflights everything.
///
/// Origins are an explicit allowlist from config — never a wildcard, since
/// authenticated routes will land on this same router.
fn cors(state: &AppState) -> CorsLayer {
    let origins: Vec<HeaderValue> = state
        .config
        .cors_origins
        .iter()
        .filter_map(|origin| match origin.parse::<HeaderValue>() {
            Ok(value) => Some(value),
            Err(_) => {
                tracing::warn!(origin, "ignoring unparseable CORS origin");
                None
            }
        })
        .collect();

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE, header::ACCEPT])
        .allow_credentials(true)
        .max_age(Duration::from_secs(3600))
}
