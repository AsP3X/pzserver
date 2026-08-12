//! Endpoints scoped to the signed-in user.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::error::ApiResult;
use crate::extract::AuthUser;
use crate::services::character::{self, Character};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/me/character", get(my_character))
}

#[derive(Serialize)]
struct CharacterResponse {
    /// `null` when the account has never been seen in game.
    character: Option<Character>,
    /// Whether this player is connected right now.
    online: bool,
}

async fn my_character(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<CharacterResponse>> {
    let character = character::for_username(&state.db, &user.username).await?;

    // Reuses the cached status resolve, so opening this page does not add an
    // RCON round trip of its own.
    let status = state.status.current().await;

    Ok(Json(CharacterResponse {
        online: character::is_online(&status.players, &user.username),
        character,
    }))
}
