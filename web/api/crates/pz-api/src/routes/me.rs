//! Endpoints scoped to the signed-in user.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;

use crate::error::ApiResult;
use crate::extract::AuthUser;
use crate::services::character::{self, Character};
use crate::services::link::{self, CODE_LIFETIME_MINUTES, LinkCode};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/me/character", get(my_character))
        .route("/me/link-code", post(issue_link_code))
}

#[derive(Serialize)]
struct CharacterResponse {
    /// `null` when the account has no character linked, or when the linked
    /// character has not been reported by the game yet.
    character: Option<Character>,
    /// Whether this player is connected right now.
    online: bool,
}

async fn my_character(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<CharacterResponse>> {
    // No linked name means nothing to look up. The UI shows the link flow.
    let Some(username) = user.username.as_deref() else {
        return Ok(Json(CharacterResponse {
            character: None,
            online: false,
        }));
    };

    let character = character::for_username(&state.db, username).await?;

    // Reuses the cached status resolve, so opening this page does not add an
    // RCON round trip of its own.
    let status = state.status.current().await;

    Ok(Json(CharacterResponse {
        online: character::is_online(&status.players, username),
        character,
    }))
}

#[derive(Serialize)]
struct LinkCodeResponse {
    #[serde(flatten)]
    code: LinkCode,
    /// So the UI can say how long it lasts without hardcoding the number.
    lifetime_minutes: i64,
}

/// Issue a one-time code to type into `/account register` in game.
async fn issue_link_code(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<LinkCodeResponse>> {
    let code = link::issue(&state.db, user.id).await?;

    tracing::info!(user_id = %user.id, "issued an account link code");

    Ok(Json(LinkCodeResponse {
        code,
        lifetime_minutes: CODE_LIFETIME_MINUTES,
    }))
}
