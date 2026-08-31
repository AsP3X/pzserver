//! Sprite isometric catalogue. Parallel to the JPEG DZI pack.

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use crate::state::AppState;

const CACHE: &str = "public, max-age=604800";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/map-sprites/meta", get(meta))
        .route("/map-sprites/sprites", get(sprites))
        .route("/map-sprites/atlas/{page}", get(atlas))
        .route("/map-sprites/cells/{cell}", get(cell))
        .route("/map-sprites/thumbs/{cell}", get(thumb))
        .route("/map-sprites/overview", get(overview))
}

async fn meta(State(state): State<AppState>) -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-store, no-cache")],
        Json(state.map_sprites.meta()),
    )
}

async fn sprites(State(state): State<AppState>) -> impl IntoResponse {
    match state.map_sprites.sprites().await {
        Ok(rows) => Json(rows).into_response(),
        Err(error) => {
            tracing::error!(%error, "sprite catalogue unread");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn atlas(State(state): State<AppState>, Path(page): Path<i64>) -> Response {
    blob(state.map_sprites.atlas(page).await, "image/png")
}

async fn cell(State(state): State<AppState>, Path(cell): Path<String>) -> Response {
    let Some((cx, cy)) = parse_cell(&cell) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    blob(
        state.map_sprites.cell(cx, cy).await,
        "application/octet-stream",
    )
}

async fn thumb(State(state): State<AppState>, Path(cell): Path<String>) -> Response {
    let Some((cx, cy)) = parse_cell(&cell) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    blob(state.map_sprites.thumb(cx, cy).await, "image/png")
}

async fn overview(State(state): State<AppState>) -> Response {
    blob(state.map_sprites.overview().await, "image/png")
}

fn blob(result: crate::error::ApiResult<Option<Vec<u8>>>, content_type: &'static str) -> Response {
    match result {
        Ok(Some(bytes)) => (
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, CACHE),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(%error, "sprite map blob failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn parse_cell(name: &str) -> Option<(i64, i64)> {
    let (x, y) = name.split_once('_')?;
    Some((x.parse().ok()?, y.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::parse_cell;

    #[test]
    fn parses_cell_names() {
        assert_eq!(parse_cell("41_38"), Some((41, 38)));
        assert_eq!(parse_cell("-1_2"), Some((-1, 2)));
        assert_eq!(parse_cell("nope"), None);
    }
}
