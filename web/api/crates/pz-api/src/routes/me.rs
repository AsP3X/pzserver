//! Endpoints scoped to the signed-in user.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::error::ApiResult;
use crate::extract::AuthUser;
use crate::services::character::{self, Character};
use crate::state::AppState;

use pz_bridge::{PlayerVitals, VitalsReader};

pub fn routes() -> Router<AppState> {
    Router::new().route("/me/character", get(my_character))
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
            vitals: read.vitals,
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
