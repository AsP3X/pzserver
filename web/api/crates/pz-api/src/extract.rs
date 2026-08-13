//! Extractors that turn a session cookie into a user.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use chrono::{DateTime, Utc};
use time::OffsetDateTime;

use crate::error::ApiError;
use crate::services::auth::{self, User};
use crate::state::AppState;

/// Cookie carrying the opaque session token.
pub const SESSION_COOKIE: &str = "knox_session";

/// Roles that may use `/admin`. Matches the UI's `ADMIN_ROLES`.
const ADMIN_ROLES: &[&str] = &["admin", "super_admin", "moderator"];

/// A signed-in user. Extracting this rejects the request with 401 when there
/// is no valid session, so a handler that takes it is a handler that requires
/// one.
pub struct AuthUser(pub User);

/// A staff member. 401 when nobody is signed in, 403 when they are not staff.
#[allow(dead_code)]
pub struct AdminUser(pub User);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AuthUser(user) = AuthUser::from_request_parts(parts, state).await?;

        if !ADMIN_ROLES.contains(&user.role.as_str()) {
            return Err(ApiError::Forbidden);
        }

        Ok(Self(user))
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let MaybeAuthUser(user) = MaybeAuthUser::from_request_parts(parts, state).await?;

        user.map(Self).ok_or(ApiError::Unauthorized)
    }
}

/// The user, if there is one. For endpoints that answer either way.
pub struct MaybeAuthUser(pub Option<User>);

impl FromRequestParts<AppState> for MaybeAuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);

        let Some(token) = jar.get(SESSION_COOKIE).map(|cookie| cookie.value()) else {
            return Ok(Self(None));
        };

        Ok(Self(auth::user_for_token(&state.db, token).await?))
    }
}

/// Build the cookie that carries a session token.
///
/// `SameSite=Lax` is the CSRF defence: the browser will not attach this cookie
/// to a cross-site POST, and every state-changing endpoint here is a POST.
///
/// The expiry comes from the session row rather than from a separate constant,
/// so the cookie and the database can never disagree about when it ends.
pub fn session_cookie(
    token: String,
    expires_at: DateTime<Utc>,
    secure: bool,
) -> Result<Cookie<'static>, ApiError> {
    let expiry = OffsetDateTime::from_unix_timestamp(expires_at.timestamp())
        .map_err(|error| ApiError::Internal(format!("session expiry out of range: {error}")))?;

    Ok(Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        // Not "browsers treat localhost as secure, so leave this on" — which is
        // what stood here, and is only true of Chromium. Safari refuses a
        // Secure cookie over http on any host, localhost included, so the login
        // succeeded, the cookie was silently dropped, and every request after
        // it came back signed out. Serving over plain http means turning this
        // off via SESSION_COOKIE_SECURE; it must be on behind HTTPS.
        .secure(secure)
        .expires(expiry)
        .build())
}

/// The same cookie, already expired — what logging out sends back.
pub fn expired_session_cookie(secure: bool) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(time::Duration::ZERO)
        .build()
}
