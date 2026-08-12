//! Registration, login, logout and "who am I".

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::extract::{
    AuthUser, MaybeAuthUser, SESSION_COOKIE, expired_session_cookie, session_cookie,
};
use crate::services::auth::{self, User};
use crate::services::registration;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/auth/password", post(change_password))
}

#[derive(Deserialize)]
struct RegisterRequest {
    /// Handed to the player in game by `/account register`.
    code: String,
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
struct SessionResponse {
    user: User,
}

#[derive(Serialize)]
struct MeResponse {
    user: Option<User>,
}

/// Finish an in-game registration and sign the new user straight in.
async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<RegisterRequest>,
) -> ApiResult<impl IntoResponse> {
    let user = registration::complete(&state.db, &body.code, &body.email, &body.password).await?;

    tracing::info!(username = %user.username, "account registered");

    let jar = start_session(&state, jar, &user, &headers).await?;

    Ok((StatusCode::CREATED, jar, Json(SessionResponse { user })))
}

async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> ApiResult<impl IntoResponse> {
    // Keyed by email now, since that is what identifies an account.
    if !state.login_limiter.is_allowed(&body.email) {
        tracing::warn!("login rate limited");

        return Err(ApiError::TooManyRequests);
    }

    let Some(user) = auth::authenticate(&state.db, &body.email, &body.password).await? else {
        state.login_limiter.record_failure(&body.email);

        // Deliberately the same answer for an unknown address and a wrong
        // password: anything else tells a stranger which accounts exist.
        return Err(ApiError::Validation(
            "Those details do not match an account.".to_owned(),
        ));
    };

    state.login_limiter.clear(&body.email);
    tracing::info!(username = %user.username, "login");

    let jar = start_session(&state, jar, &user, &headers).await?;

    Ok((StatusCode::OK, jar, Json(SessionResponse { user })))
}

/// Ends this session only — other devices stay signed in.
async fn logout(State(state): State<AppState>, jar: CookieJar) -> ApiResult<impl IntoResponse> {
    if let Some(token) = jar.get(SESSION_COOKIE).map(|cookie| cookie.value()) {
        auth::revoke_session(&state.db, token).await?;
    }

    let jar = jar.add(expired_session_cookie(state.config.session_cookie_secure));

    Ok((StatusCode::NO_CONTENT, jar))
}

/// The current user, or `null`. Always 200 — the UI asks this on every load
/// and a 401 for "not signed in" would be noise in the console.
async fn me(MaybeAuthUser(user): MaybeAuthUser) -> Json<MeResponse> {
    Json(MeResponse { user })
}

/// Issue a session and attach its cookie to the response.
async fn start_session(
    state: &AppState,
    jar: CookieJar,
    user: &User,
    headers: &HeaderMap,
) -> ApiResult<CookieJar> {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        // Long enough to identify a browser, short enough not to store an essay.
        .map(|value| value.chars().take(255).collect::<String>());

    let session = auth::create_session(&state.db, user.id, user_agent.as_deref()).await?;

    Ok(jar.add(session_cookie(
        session.token,
        session.expires_at,
        state.config.session_cookie_secure,
    )?))
}

#[derive(Deserialize)]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

/// Change the signed-in user's password.
///
/// Every other session is dropped on success — a password change is usually a
/// response to something going wrong, and it should end whatever else is
/// signed in. The session making the request survives so the user is not
/// bounced out of the page they are on.
async fn change_password(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    jar: CookieJar,
    Json(body): Json<ChangePasswordRequest>,
) -> ApiResult<StatusCode> {
    let current_token = jar
        .get(SESSION_COOKIE)
        .map(|cookie| cookie.value())
        .ok_or(ApiError::Unauthorized)?;

    let revoked = auth::change_password(
        &state.db,
        user.id,
        &body.current_password,
        &body.new_password,
        current_token,
    )
    .await?;

    tracing::info!(
        username = %user.username,
        revoked_sessions = revoked,
        "password changed",
    );

    Ok(StatusCode::NO_CONTENT)
}
