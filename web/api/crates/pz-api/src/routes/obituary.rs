//! The public obituary.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::ApiResult;
use crate::services::obituary::{self, Obit, ObituarySummary};
use crate::state::AppState;

/// Upper bound on one page, so a crafted `limit` cannot ask for the whole log.
const MAX_LIMIT: i64 = 100;

const DEFAULT_LIMIT: i64 = 25;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/obituary", get(recent))
        .route("/obituary/summary", get(summary))
}

#[derive(Deserialize)]
struct ObituaryQuery {
    limit: Option<i64>,
    /// Cursor: return deaths strictly older than this instant.
    before: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
struct ObituaryPage {
    deaths: Vec<Obit>,
    /// When to ask again from, or null at the end of the roll. Sent rather
    /// than derived client-side so the cursor rule lives in one place.
    next_before: Option<DateTime<Utc>>,
}

async fn recent(
    State(state): State<AppState>,
    Query(query): Query<ObituaryQuery>,
) -> ApiResult<Json<ObituaryPage>> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let deaths = obituary::recent(&state.db, limit, query.before).await?;

    // A short page is the last one. A full page might still be the last, and
    // the next request coming back empty is a cheaper way to find that out
    // than counting the whole table on every page.
    let next_before = (deaths.len() as i64 == limit)
        .then(|| deaths.last().map(|death| death.occurred_at))
        .flatten();

    Ok(Json(ObituaryPage {
        deaths,
        next_before,
    }))
}

async fn summary(State(state): State<AppState>) -> ApiResult<Json<ObituarySummary>> {
    Ok(Json(obituary::summary(&state.db).await?))
}
