//! Aggregate stats and leaderboards.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::ApiResult;
use crate::services::stats::{self, LeaderboardEntry, LeaderboardStat, StatsSummary};
use crate::state::AppState;

/// Upper bound on a leaderboard page, so a crafted `limit` cannot ask for the
/// whole table.
const MAX_LEADERBOARD_LIMIT: i64 = 100;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/stats/summary", get(summary))
        .route("/stats/leaderboard", get(leaderboard))
}

async fn summary(State(state): State<AppState>) -> ApiResult<Json<StatsSummary>> {
    Ok(Json(stats::summary(&state.db).await?))
}

#[derive(Deserialize)]
struct LeaderboardQuery {
    /// Unknown values are rejected by serde before they reach the query.
    #[serde(default)]
    stat: LeaderboardStat,
    limit: Option<i64>,
}

async fn leaderboard(
    State(state): State<AppState>,
    Query(query): Query<LeaderboardQuery>,
) -> ApiResult<Json<Vec<LeaderboardEntry>>> {
    let limit = query.limit.unwrap_or(10).clamp(1, MAX_LEADERBOARD_LIMIT);

    Ok(Json(
        stats::leaderboard(&state.db, query.stat, limit).await?,
    ))
}
