//! The isometric basemap's tiles, served from the local pack.
//!
//! Public, like the rest of the map surface: a tile is not a secret. Anything
//! not in the store is a 404, which the client turns into an upscale of the
//! nearest level it does hold.

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use crate::services::map_tiles::TileMeta;
use crate::state::AppState;

/// A week. Not `immutable`: the URL carries no version, so a re-render for a
/// new game build returns different bytes at the same path.
const TILE_CACHE: &str = "public, max-age=604800";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/map-tiles/meta", get(meta))
        .route("/map-tiles/{z}/{tile}", get(tile))
}

async fn meta(State(state): State<AppState>) -> Json<TileMeta> {
    Json(state.map_tiles.meta())
}

async fn tile(State(state): State<AppState>, Path((z, tile)): Path<(i64, String)>) -> Response {
    let Some((x, y)) = parse_tile(&tile) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    match state.map_tiles.tile(z, x, y).await {
        Ok(Some(bytes)) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, TILE_CACHE),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(%error, z, x, y, "map tile read failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `"3_4.jpg"` -> `(3, 4)`. Anything else is a 404, not a 400: a malformed tile
/// name is a URL that does not name a tile.
fn parse_tile(name: &str) -> Option<(i64, i64)> {
    let stem = name.strip_suffix(".jpg")?;
    let (x, y) = stem.split_once('_')?;
    Some((x.parse().ok()?, y.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::parse_tile;

    #[test]
    fn parses_a_tile_name() {
        assert_eq!(parse_tile("3_4.jpg"), Some((3, 4)));
        assert_eq!(parse_tile("1133_498.jpg"), Some((1133, 498)));
    }

    #[test]
    fn rejects_anything_that_is_not_one() {
        for bad in ["3_4.png", "3_4", "3-4.jpg", "_4.jpg", "a_b.jpg", "../x.jpg"] {
            assert_eq!(parse_tile(bad), None, "{bad} should not parse");
        }
    }
}
