//! Endpoints scoped to the signed-in user.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use pz_bridge::{InventoryReader, InventorySnapshot, PlayerVitals, VitalsReader};

use crate::error::{ApiError, ApiResult};
use crate::extract::AuthUser;
use crate::services::character::{self, Character};
use crate::services::economy::inventory as holdings;
use crate::services::reports;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/me/character", get(my_character))
        .route("/me/inventory", get(my_inventory))
        .route("/me/inventory/refresh", post(refresh_inventory))
        .route("/me/position", get(my_position))
        .route("/me/reports", get(my_reports).post(file_report))
        .route("/me/reports/{id}", get(my_report))
        .route("/me/reports/{id}/messages", post(reply_report))
        .route("/me/reports/{id}/read", post(read_report))
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
    /// Takes and gives waiting for the next join.
    holds: Vec<holdings::InventoryHold>,
}

/// How stale a snapshot may be before simply opening the page renews it.
///
/// The mod serves requests on its own tick, so asking more often than it can
/// answer only rewrites the same request file. This is a little under the
/// page's poll interval, so an open page keeps itself fresh without ever
/// queueing twice for one answer.
const SNAPSHOT_MAX_AGE: Duration = Duration::from_secs(8);

/// The player's last inventory snapshot.
///
/// Reading it also renews it. A snapshot only exists because somebody asked
/// for one, and requiring that somebody to be a human pressing Refresh meant a
/// player who never found the button had no inventory at all — and one who did
/// press it got a reading that started going stale immediately. An open page
/// now keeps itself current for as long as the player is in game.
async fn my_inventory(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<InventoryResponse>> {
    let username = user.username.as_str();
    let status = state.status.current().await;
    let online = character::is_online(&status.players, username);

    let reader = InventoryReader::new(&state.config.lua_bridge_path);

    let read = reader.read(username).await.map_err(|error| {
        tracing::warn!(%error, "inventory snapshot unreadable");
        ApiError::Internal("inventory snapshot unreadable".to_owned())
    })?;

    let stale = read
        .as_ref()
        .and_then(|read| read.reported_at)
        .and_then(|at| at.elapsed().ok())
        .is_none_or(|age| age > SNAPSHOT_MAX_AGE);

    // Offline players are skipped because the mod drops requests for anyone
    // not on its roster; the queue would just accumulate.
    if online
        && stale
        && let Err(error) = reader.request_snapshot(username).await
    {
        // The reading we already have is still worth serving.
        tracing::warn!(%error, "could not queue an inventory snapshot");
    }

    let holds = holdings::holds(&state.db, user.id, username)
        .await
        .unwrap_or_default();

    Ok(Json(InventoryResponse {
        snapshot: read.as_ref().map(|read| read.data.clone()),
        reported_at: read
            .and_then(|read| read.reported_at)
            .map(DateTime::<Utc>::from),
        online,
        holds,
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

    let live = read.as_ref().and_then(|read| {
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

    let position = match live {
        Some(position) => Some(position),
        None => character::last_position(&state.db, username)
            .await?
            .map(|last| Position {
                x: last.x,
                y: last.y,
                z: last.z,
            }),
    };

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

async fn my_reports(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<reports::Report>>> {
    Ok(Json(reports::list_mine(&state.db, user.id).await?))
}

#[derive(Deserialize)]
struct NewReport {
    kind: String,
    subject: String,
    body: String,
    accused: Option<String>,
}

async fn file_report(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<NewReport>,
) -> Result<(StatusCode, Json<reports::Report>), ApiError> {
    let report = reports::create(
        &state.db,
        user.id,
        &body.kind,
        &body.subject,
        &body.body,
        body.accused.as_deref(),
    )
    .await?;

    reports::refresh_inbox(&state.db, &state.config.lua_bridge_path, &user.username).await;

    Ok((StatusCode::CREATED, Json(report)))
}

async fn my_report(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> ApiResult<Json<reports::Report>> {
    Ok(Json(reports::get_mine(&state.db, user.id, id).await?))
}

#[derive(Deserialize)]
struct ReplyBody {
    body: String,
}

async fn reply_report(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<ReplyBody>,
) -> ApiResult<Json<reports::Report>> {
    let report = reports::add_player_message(&state.db, user.id, id, &body.body).await?;
    reports::refresh_inbox(&state.db, &state.config.lua_bridge_path, &user.username).await;
    Ok(Json(report))
}

async fn read_report(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> ApiResult<Json<reports::Report>> {
    let report = reports::mark_read(&state.db, user.id, id).await?;
    reports::refresh_inbox(&state.db, &state.config.lua_bridge_path, &user.username).await;
    Ok(Json(report))
}
