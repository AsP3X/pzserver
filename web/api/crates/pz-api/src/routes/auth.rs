//! Registration, login, logout and "who am I".

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Redirect};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::extract::{
    AuthUser, CHALLENGE_COOKIE, MaybeAuthUser, SESSION_COOKIE, challenge_cookie,
    expired_challenge_cookie, expired_session_cookie, session_cookie,
};
use crate::services::auth::{self, User};
use crate::services::registration;
use crate::services::site;
use crate::services::twofactor;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/auth/password", post(change_password))
        .route("/auth/email", post(change_email))
        .route("/auth/2fa", get(two_factor_status))
        .route("/auth/2fa/begin", post(begin_two_factor))
        .route("/auth/2fa/confirm", post(confirm_two_factor))
        .route("/auth/2fa/disable", post(disable_two_factor))
        .route("/auth/2fa/challenge", post(answer_two_factor))
        .route("/auth/steam", get(steam_start))
        .route("/auth/steam/callback", get(steam_callback))
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
    /// The in-game name. Signing up collects an email as well, but this is
    /// what you sign in with.
    username: String,
    password: String,
}

#[derive(Serialize)]
struct SessionResponse {
    user: User,
}

/// What a correct password produces.
///
/// With two-factor off this is a session, same as it always was. With it on the
/// password alone buys nothing but a short-lived ticket — deliberately not a
/// cookie, so a half-finished sign-in cannot be mistaken for a real one by any
/// middleware that only looks for the session cookie.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum LoginOutcome {
    SignedIn {
        user: User,
    },
    TwoFactorRequired {
        challenge: String,
        expires_at: chrono::DateTime<chrono::Utc>,
    },
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
    // Throttled per account, keyed by whatever was typed into the name box.
    // Lower-cased so that varying the capitalisation is not a way to buy
    // another eight attempts against the same account.
    let attempted = body.username.trim().to_lowercase();

    if !state.login_limiter.is_allowed(&attempted) {
        tracing::warn!("login rate limited");

        return Err(ApiError::TooManyRequests);
    }

    let whitelist_db = state.config.whitelist_db_path();
    let Some(user) = auth::authenticate(
        &state.db,
        &body.username,
        &body.password,
        whitelist_db.as_deref(),
    )
    .await?
    else {
        state.login_limiter.record_failure(&attempted);

        // Deliberately the same answer for an unknown name and a wrong
        // password: anything else tells a stranger which accounts exist.
        return Err(ApiError::Validation(
            "Those details do not match an account.".to_owned(),
        ));
    };

    state.login_limiter.clear(&attempted);

    if twofactor::is_enabled(&state.db, user.id).await? {
        let challenge = twofactor::open_challenge(&state.db, user.id).await?;

        tracing::info!(username = %user.username, "password accepted, awaiting a code");

        // No cookie on this branch: the session does not exist yet.
        return Ok((
            StatusCode::OK,
            jar,
            Json(LoginOutcome::TwoFactorRequired {
                challenge: challenge.token,
                expires_at: challenge.expires_at,
            }),
        ));
    }

    tracing::info!(username = %user.username, "login");

    let jar = start_session(&state, jar, &user, &headers).await?;

    Ok((StatusCode::OK, jar, Json(LoginOutcome::SignedIn { user })))
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

// ── Two-factor ──────────────────────────────────────────────────────

/// Label shown in the authenticator app, taken from the site's own name so a
/// player with several accounts can tell them apart.
///
/// Cosmetic only — the secret is what signs a code — so changing the site name
/// never invalidates an existing enrolment.
async fn issuer(state: &AppState) -> String {
    // Source locale deliberately: a translated site name would change the
    // label depending on who was signed in when they enrolled.
    site::settings(&state.db, "en")
        .await
        .map(|settings| settings.site_name)
        .unwrap_or_else(|_| "Knox Relay".to_owned())
}

async fn two_factor_status(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<twofactor::TwoFactorStatus>> {
    Ok(Json(twofactor::status(&state.db, user.id).await?))
}

/// Step one of enrolment: a secret to scan. Two-factor is not on yet.
async fn begin_two_factor(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<twofactor::Enrolment>> {
    let issuer = issuer(&state).await;

    Ok(Json(
        twofactor::begin(&state.db, user.id, &user.username, &issuer).await?,
    ))
}

#[derive(Deserialize)]
struct CodeRequest {
    code: String,
}

#[derive(Serialize)]
struct RecoveryCodesResponse {
    /// Shown once. Only digests are kept, so this cannot be re-issued without
    /// replacing the whole set.
    recovery_codes: Vec<String>,
}

/// Step two: a correct code switches two-factor on.
async fn confirm_two_factor(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<CodeRequest>,
) -> ApiResult<Json<RecoveryCodesResponse>> {
    let issuer = issuer(&state).await;
    let recovery_codes =
        twofactor::confirm(&state.db, user.id, &user.username, &issuer, &body.code).await?;

    Ok(Json(RecoveryCodesResponse { recovery_codes }))
}

#[derive(Deserialize)]
struct DisableTwoFactorRequest {
    password: String,
}

/// Turning two-factor off needs the password, not just an open session.
///
/// An unattended browser is exactly the situation two-factor is there for, so
/// the session alone must not be enough to remove it.
async fn disable_two_factor(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<DisableTwoFactorRequest>,
) -> ApiResult<StatusCode> {
    if !auth::password_matches(&state.db, user.id, &body.password).await? {
        return Err(ApiError::Validation(
            "That password is not correct.".to_owned(),
        ));
    }

    twofactor::disable(&state.db, user.id, &user.username).await?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ChallengeRequest {
    /// Absent for a Steam sign-in, which carries the token in a cookie instead.
    #[serde(default)]
    challenge: Option<String>,
    /// A six-digit code from the app, or one of the recovery codes.
    code: String,
}

/// Finish a sign-in that stopped for a code.
async fn answer_two_factor(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<ChallengeRequest>,
) -> ApiResult<impl IntoResponse> {
    let issuer = issuer(&state).await;

    let token = body
        .challenge
        .clone()
        .or_else(|| {
            jar.get(CHALLENGE_COOKIE)
                .map(|cookie| cookie.value().to_owned())
        })
        .ok_or_else(|| ApiError::Validation("That sign-in has expired. Start again.".to_owned()))?;

    let user_id = twofactor::answer_challenge(
        &state.db,
        &token,
        &body.code,
        async |id| twofactor::secret_for(&state.db, id).await,
        &issuer,
    )
    .await?;

    let user = sqlx::query_as::<_, User>(
        "SELECT id, username, email, role, steam_id, created_at FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    tracing::info!(username = %user.username, "login completed with a second factor");

    let jar = start_session(&state, jar, &user, &headers)
        .await?
        // Spent, whether it arrived in the body or in the cookie.
        .add(expired_challenge_cookie(state.config.session_cookie_secure));

    Ok((StatusCode::OK, jar, Json(SessionResponse { user })))
}

// ── Sign in with Steam ──────────────────────────────────────────────

fn steam_return_to(state: &AppState) -> String {
    format!("{}/api/v1/auth/steam/callback", state.config.public_url)
}

/// Send the browser to Steam.
async fn steam_start(State(state): State<AppState>) -> Redirect {
    Redirect::to(&pz_bridge::steam::authenticate_url(
        &state.config.public_url,
        &steam_return_to(&state),
    ))
}

/// Where Steam sends the browser back.
///
/// This never creates an account. Every account here belongs to a character
/// that has proven itself in game, and a Steam login proves ownership of a
/// Steam profile, not of a character — so an unrecognised SteamID64 is turned
/// away rather than signed up. Joining the server writes `steam_id` onto the
/// website row, so for them this simply works.
async fn steam_callback(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(params): Query<std::collections::BTreeMap<String, String>>,
) -> Result<(CookieJar, Redirect), Redirect> {
    let failed = |reason: &str| {
        tracing::warn!(reason, "steam sign-in refused");
        Redirect::to(&format!("{}/login?steam=failed", state.config.public_url))
    };

    let steam_id = pz_bridge::SteamClient::new()
        .verify(&params)
        .await
        .map_err(|error| failed(&error.to_string()))?;

    let user = sqlx::query_as::<_, User>(
        "SELECT id, username, email, role, steam_id, created_at FROM users WHERE steam_id = $1",
    )
    .bind(&steam_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| failed("database error"))?;

    let Some(user) = user else {
        // Deliberately its own reason: "we do not know this Steam account" is
        // actionable — join the server first — where a generic failure would
        // just look broken.
        return Err(Redirect::to(&format!(
            "{}/login?steam=unknown",
            state.config.public_url
        )));
    };

    if twofactor::is_enabled(&state.db, user.id)
        .await
        .map_err(|_| failed("database error"))?
    {
        let challenge = twofactor::open_challenge(&state.db, user.id)
            .await
            .map_err(|_| failed("could not open a challenge"))?;

        tracing::info!(username = %user.username, "steam sign-in awaiting a code");

        // The token goes in an httpOnly cookie rather than the redirect URL:
        // a query parameter would land in browser history, in any proxy log on
        // the way, and in the Referer of whatever the page loads next.
        return Ok((
            jar.add(
                challenge_cookie(
                    challenge.token,
                    challenge.expires_at,
                    state.config.session_cookie_secure,
                )
                .map_err(|_| failed("bad challenge expiry"))?,
            ),
            Redirect::to(&format!("{}/login?verify=1", state.config.public_url)),
        ));
    }

    tracing::info!(username = %user.username, "login with steam");

    let jar = start_session(&state, jar, &user, &headers)
        .await
        .map_err(|_| failed("could not start a session"))?;

    Ok((jar, Redirect::to(&state.config.public_url)))
}

#[derive(Deserialize)]
struct ChangeEmailRequest {
    password: String,
    email: String,
}

/// Move the address on the account. Returns the updated user so the page can
/// show the new value without a refetch.
async fn change_email(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<ChangeEmailRequest>,
) -> ApiResult<Json<SessionResponse>> {
    let user = auth::change_email(&state.db, user.id, &body.password, &body.email).await?;

    Ok(Json(SessionResponse { user }))
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
