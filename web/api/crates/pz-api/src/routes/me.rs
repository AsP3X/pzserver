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
        .route("/me/position", get(my_position))
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

#[derive(Serialize)]
struct PositionResponse {
    /// `null` when the mod has never reported this character's position.
    position: Option<Position>,
    /// When the position export was last written. The file outlives the
    /// session, so a position with an old stamp is where you logged out.
    reported_at: Option<DateTime<Utc>>,
    online: bool,
}

#[derive(Serialize)]
struct Position {
    x: f64,
    y: f64,
    z: i32,
}

/// Where the player was last seen.
///
/// Read out of the whole-server position export rather than a per-player file:
/// the mod writes one `players_live.json` every thirty seconds and there is no
/// per-character equivalent. An offline player is simply absent from it, which
/// is why a position and `online: false` can both be true — that is the spot
/// they logged out at, and saying so is more use than an empty map.
async fn my_position(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<PositionResponse>> {
    let username = user.username.as_str();
    let status = state.status.current().await;

    let read = match pz_bridge::LuaBridge::new(&state.config.lua_bridge_path)
        .players_live()
        .await
    {
        Ok(read) => read,
        Err(error) => {
            // The map still draws; it just has nobody on it.
            tracing::warn!(%error, "position export unreadable");
            None
        }
    };

    let position = read.as_ref().and_then(|read| {
        read.data
            .players
            .iter()
            .find(|player| player.username.eq_ignore_ascii_case(username))
            .map(|player| Position {
                x: player.x,
                y: player.y,
                z: player.z,
            })
    });

    Ok(Json(PositionResponse {
        reported_at: position
            .as_ref()
            .and(read.and_then(|read| read.modified_at))
            .map(DateTime::<Utc>::from),
        position,
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
