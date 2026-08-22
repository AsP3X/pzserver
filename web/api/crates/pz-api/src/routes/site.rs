//! Public site settings: copy, branding and connection details.

use axum::body::Body;
use axum::extract::{Multipart, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::extract::AdminUser;
use crate::services::site::{self, SOURCE_LOCALE, SiteSettings};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/site", get(settings))
        .route("/site/logo", get(logo))
        .route("/site/favicon", get(favicon))
        .route("/admin/site/logo", post(upload_logo).delete(delete_logo))
        .route(
            "/admin/site/favicon",
            post(upload_favicon).delete(delete_favicon),
        )
}

#[derive(Deserialize)]
struct SiteQuery {
    /// Which language to return the copy in. An unknown value falls back to
    /// the source text rather than erroring — a bad locale should not take the
    /// landing page down.
    locale: Option<String>,
}

async fn settings(
    State(state): State<AppState>,
    Query(query): Query<SiteQuery>,
) -> ApiResult<Json<SiteSettings>> {
    let locale = query.locale.as_deref().unwrap_or(SOURCE_LOCALE);

    Ok(Json(site::settings(&state.db, locale).await?))
}

// ── Branding ────────────────────────────────────────────────────────

async fn logo(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    serve(&state, site::Branding::Logo).await
}

async fn favicon(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    serve(&state, site::Branding::Favicon).await
}

/// Send a stored image back, or 404 when none has been uploaded.
///
/// `nosniff` plus an explicit content type from a closed allowlist is what
/// keeps this from becoming a way to serve arbitrary content off our origin.
async fn serve(state: &AppState, which: site::Branding) -> ApiResult<Response> {
    let Some(image) = site::read_image(&state.db, which).await? else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };

    let content_type = header::HeaderValue::from_str(&image.content_type)
        .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream"));

    let mut response = Response::new(Body::from(image.bytes));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    // Short rather than immutable: the filename never changes, so a long cache
    // would leave every visitor on the old logo after a rebrand.
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=300"),
    );

    Ok(response)
}

async fn upload_logo(
    State(state): State<AppState>,
    staff: AdminUser,
    multipart: Multipart,
) -> ApiResult<StatusCode> {
    upload(&state, staff, site::Branding::Logo, multipart).await
}

async fn upload_favicon(
    State(state): State<AppState>,
    staff: AdminUser,
    multipart: Multipart,
) -> ApiResult<StatusCode> {
    upload(&state, staff, site::Branding::Favicon, multipart).await
}

async fn upload(
    state: &AppState,
    AdminUser(staff): AdminUser,
    which: site::Branding,
    mut multipart: Multipart,
) -> ApiResult<StatusCode> {
    let field = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::Validation(format!("Upload failed: {error}")))?
        .ok_or_else(|| ApiError::Validation("No file was sent.".to_owned()))?;

    // Taken from the part rather than sniffed. It is checked against the
    // allowlist before anything is stored, and it is the only thing we will
    // ever serve the bytes back with.
    let content_type = field
        .content_type()
        .map(str::to_owned)
        .ok_or_else(|| ApiError::Validation("That file has no type.".to_owned()))?;

    if !site::is_allowed_image(&content_type) {
        return Err(ApiError::Validation(
            "Use a PNG, JPEG, WebP, GIF or ICO.".to_owned(),
        ));
    }

    let bytes = field
        .bytes()
        .await
        .map_err(|error| ApiError::Validation(format!("Upload failed: {error}")))?;

    site::store_image(&state.db, which, &bytes, &content_type).await?;

    tracing::info!(
        actor = %staff.username,
        bytes = bytes.len(),
        "site branding updated",
    );

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_logo(State(state): State<AppState>, _staff: AdminUser) -> ApiResult<StatusCode> {
    site::clear_image(&state.db, site::Branding::Logo).await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_favicon(State(state): State<AppState>, _staff: AdminUser) -> ApiResult<StatusCode> {
    site::clear_image(&state.db, site::Branding::Favicon).await?;

    Ok(StatusCode::NO_CONTENT)
}
