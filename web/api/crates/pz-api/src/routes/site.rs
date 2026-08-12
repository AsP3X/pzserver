//! Public site settings: copy, branding and connection details.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::ApiResult;
use crate::services::site::{self, SOURCE_LOCALE, SiteSettings};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/site", get(settings))
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
