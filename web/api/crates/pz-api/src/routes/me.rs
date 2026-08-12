//! Endpoints scoped to the signed-in user.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Serialize;

use pz_bridge::{InventoryReader, InventorySnapshot, PlayerVitals, VitalsReader};

use crate::error::{ApiError, ApiResult};
use crate::extract::AuthUser;
use crate::services::character::{self, Character};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/me/character", get(my_character))
        .route("/me/inventory", get(my_inventory))
        .route("/me/inventory/refresh", post(refresh_inventory))
}

#[derive(Serialize)]
struct CharacterResponse {
    /// `null` when the game has not reported this character yet — a brand new
    /// survivor whose first export has not landed.
    character: Option<Character>,
    /// Whether this player is connected right now.
    online: bool,
    /// Per-part health and body temperature from the mod's heartbeat. Absent
    /// for a character that has never been online while the mod was running.
    body: Option<BodyResponse>,
}

#[derive(Serialize)]
struct BodyResponse {
    #[serde(flatten)]
    vitals: PlayerVitals,
    /// When the heartbeat was written. The file outlives the session, so this
    /// is what tells the UI whether it is showing live or last-known state.
    reported_at: Option<DateTime<Utc>>,
}

async fn my_character(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<CharacterResponse>> {
    let username = user.username.as_str();
    let character = character::for_username(&state.db, username).await?;

    // Reuses the cached status resolve, so opening this page does not add an
    // RCON round trip of its own.
    let status = state.status.current().await;

    let body = match VitalsReader::new(&state.config.lua_bridge_path)
        .read(username)
        .await
    {
        Ok(read) => read.map(|read| BodyResponse {
            vitals: read.data,
            reported_at: read.reported_at.map(DateTime::<Utc>::from),
        }),
        Err(error) => {
            // A missing or broken heartbeat costs the condition panel, not the
            // page.
            tracing::warn!(%error, "vitals heartbeat unreadable");
            None
        }
    };

    Ok(Json(CharacterResponse {
        online: character::is_online(&status.players, username),
        character,
        body,
    }))
}

#[derive(Serialize)]
struct InventoryResponse {
    /// `null` until the mod has written a snapshot for this character.
    snapshot: Option<InventorySnapshot>,
    reported_at: Option<DateTime<Utc>>,
    /// Whether a refresh would do anything: the mod only serves snapshot
    /// requests for players it can see on the roster.
    online: bool,
}

/// The player's last inventory snapshot.
async fn my_inventory(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<InventoryResponse>> {
    let username = user.username.as_str();
    let status = state.status.current().await;

    let read = InventoryReader::new(&state.config.lua_bridge_path)
        .read(username)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "inventory snapshot unreadable");
            ApiError::Internal("inventory snapshot unreadable".to_owned())
        })?;

    Ok(Json(InventoryResponse {
        snapshot: read.as_ref().map(|read| read.data.clone()),
        reported_at: read
            .and_then(|read| read.reported_at)
            .map(DateTime::<Utc>::from),
        online: character::is_online(&status.players, username),
    }))
}

/// Ask the mod for a fresh snapshot.
///
/// Refused when the player is offline: the mod matches requests against its
/// roster and silently drops the rest, and a button that quietly does nothing
/// is worse than one that says why.
async fn refresh_inventory(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let username = user.username.as_str();
    let status = state.status.current().await;

    if !character::is_online(&status.players, username) {
        return Err(ApiError::Validation(
            "You need to be in game for the server to take a fresh snapshot.".to_owned(),
        ));
    }

    InventoryReader::new(&state.config.lua_bridge_path)
        .request_snapshot(username)
        .await
        .map_err(|error| {
            tracing::error!(%error, "could not queue an inventory snapshot");
            ApiError::Internal("could not queue a snapshot".to_owned())
        })?;

    tracing::info!(username, "queued an inventory snapshot");

    // Accepted, not done: the mod writes the file on its next tick.
    Ok(StatusCode::ACCEPTED)
}
