//! Read access to the packed isometric tile pyramid.
//!
//! `make map-tiles` renders and packs `tiles.sqlite`; this only ever reads it.
//! A missing file is a normal state — it means nobody has run the render yet —
//! so every read answers `None` rather than failing.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use crate::error::{ApiError, ApiResult};

/// What the client needs to know about the pyramid it is drawing.
#[derive(Clone, Debug, Serialize)]
pub struct TileMeta {
    pub generated: bool,
    pub min_level: Option<i64>,
    pub max_level: Option<i64>,
    pub game_version: Option<String>,
}

impl TileMeta {
    fn absent() -> Self {
        Self {
            generated: false,
            min_level: None,
            max_level: None,
            game_version: None,
        }
    }
}

/// `rusqlite::Connection` is `!Sync`, so it cannot be shared across handlers
/// directly. One mutex-guarded connection, read from the blocking pool, is
/// enough: a tile read is a single indexed blob fetch and the browser caches
/// aggressively on top.
#[derive(Clone)]
pub struct MapTiles {
    inner: Option<Arc<Inner>>,
    meta: TileMeta,
}

struct Inner {
    con: Mutex<Connection>,
}

impl MapTiles {
    /// Opens the store read-only. Never fails: an unusable file is reported as
    /// "not generated", which is exactly how the client should treat it.
    pub fn open(path: &Path) -> Self {
        let con = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        );

        let Ok(con) = con else {
            tracing::info!(path = %path.display(), "no map tile store; iso basemap unavailable");
            return Self {
                inner: None,
                meta: TileMeta::absent(),
            };
        };

        let meta = read_meta(&con).unwrap_or_else(|_| TileMeta::absent());
        tracing::info!(
            path = %path.display(),
            min = ?meta.min_level,
            max = ?meta.max_level,
            "map tile store opened",
        );

        Self {
            inner: Some(Arc::new(Inner {
                con: Mutex::new(con),
            })),
            meta,
        }
    }

    pub fn meta(&self) -> TileMeta {
        self.meta.clone()
    }

    /// One tile, or `None` when it was never rendered.
    pub async fn tile(&self, z: i64, x: i64, y: i64) -> ApiResult<Option<Vec<u8>>> {
        let Some(inner) = self.inner.clone() else {
            return Ok(None);
        };

        // The blocking pool, because a rusqlite read is synchronous and would
        // otherwise stall the async worker it lands on.
        let blob = tokio::task::spawn_blocking(move || {
            let con = inner.con.lock().expect("map tile store mutex poisoned");
            con.query_row(
                "SELECT data FROM tiles WHERE z = ?1 AND x = ?2 AND y = ?3",
                rusqlite::params![z, x, y],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
        })
        .await
        .map_err(|error| ApiError::Internal(format!("map tile read did not finish: {error}")))?
        .map_err(|error| ApiError::Internal(format!("map tile read failed: {error}")))?;

        Ok(blob)
    }
}

fn read_meta(con: &Connection) -> rusqlite::Result<TileMeta> {
    let get = |key: &str| -> rusqlite::Result<Option<String>> {
        con.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
    };

    Ok(TileMeta {
        generated: true,
        min_level: get("min_level")?.and_then(|v| v.parse().ok()),
        max_level: get("max_level")?.and_then(|v| v.parse().ok()),
        game_version: get("game_version")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(dir: &std::path::Path, tiles: &[(i64, i64, i64, &[u8])]) -> MapTiles {
        let path = dir.join("tiles.sqlite");
        let con = rusqlite::Connection::open(&path).unwrap();
        con.execute_batch(
            "CREATE TABLE tiles (z INTEGER, x INTEGER, y INTEGER, data BLOB NOT NULL,
                 PRIMARY KEY (z, x, y)) WITHOUT ROWID;
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta VALUES ('min_level','8'),('max_level','20'),
                 ('game_version','42.20.0');",
        )
        .unwrap();
        for (z, x, y, body) in tiles {
            con.execute(
                "INSERT INTO tiles (z, x, y, data) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![z, x, y, body],
            )
            .unwrap();
        }
        drop(con);
        MapTiles::open(&path)
    }

    #[tokio::test]
    async fn serves_a_stored_tile() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with(dir.path(), &[(20, 3, 4, b"jpegbytes")]);

        assert_eq!(
            store.tile(20, 3, 4).await.unwrap(),
            Some(b"jpegbytes".to_vec())
        );
    }

    #[tokio::test]
    async fn absent_tile_is_none_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with(dir.path(), &[(20, 3, 4, b"x")]);

        // Level 22 was never rendered, and 53% of grid positions never existed.
        assert_eq!(store.tile(22, 0, 0).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_missing_file_is_not_generated_rather_than_a_failure() {
        let store = MapTiles::open(std::path::Path::new("/nonexistent/tiles.sqlite"));

        assert!(!store.meta().generated);
        assert_eq!(store.tile(20, 3, 4).await.unwrap(), None);
    }

    #[tokio::test]
    async fn meta_reports_the_rendered_range() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with(dir.path(), &[]);

        let meta = store.meta();
        assert!(meta.generated);
        assert_eq!(meta.min_level, Some(8));
        assert_eq!(meta.max_level, Some(20));
        assert_eq!(meta.game_version.as_deref(), Some("42.20.0"));
    }
}
