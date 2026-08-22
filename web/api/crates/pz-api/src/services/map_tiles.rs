//! Read access to the packed isometric tile pyramid.
//!
//! `make map-tiles` renders and packs `tiles.sqlite`; this only ever reads it.
//! A missing file is a normal state — it means nobody has run the render yet —
//! so every read answers `None` rather than failing.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
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
    pub generated_at: Option<String>,
}

impl TileMeta {
    fn absent() -> Self {
        Self {
            generated: false,
            min_level: None,
            max_level: None,
            game_version: None,
            generated_at: None,
        }
    }
}

/// `rusqlite::Connection` is `!Sync`, so it cannot be shared across handlers
/// directly, so the store keeps a small pool of them and hands each read the
/// next one round-robin.
///
/// A single shared connection was the original design, on the reasoning that a
/// tile read is one indexed blob fetch. Measurement disagreed. A tile read is
/// not cheap when the pack sits on a Docker Desktop bind mount: ~180 ms there
/// against ~6 ms on the host filesystem, because every read is random I/O into
/// a 24 GB file. One connection serialises those, so a viewport of nine tiles
/// cost ~2 s wall and concurrency bought nothing (measured 1.0x). Reading the
/// same nine through independent connections is 3.4x faster, because the
/// latency overlaps.
///
/// Reads only, so there is nothing to coordinate between them beyond SQLite's
/// own read locks.
const POOL_SIZE: usize = 8;

#[derive(Clone)]
pub struct MapTiles {
    inner: Option<Arc<Inner>>,
    meta: TileMeta,
}

struct Inner {
    /// Round-robin, not "find a free one": picking the next index is a single
    /// atomic increment, and under load every connection is busy anyway.
    connections: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl Inner {
    fn checkout(&self) -> &Mutex<Connection> {
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.connections.len();
        &self.connections[i]
    }
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

        // The probe connection becomes the first pool member; the rest open
        // alongside it. A pool member that fails to open is simply left out --
        // a smaller pool still serves, where failing here would take the
        // basemap down over a transient.
        let mut connections = vec![Mutex::new(con)];
        for _ in 1..POOL_SIZE {
            match Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                Ok(extra) => connections.push(Mutex::new(extra)),
                Err(error) => {
                    tracing::warn!(%error, "map tile pool opened short; serving with fewer readers");
                    break;
                }
            }
        }

        tracing::info!(
            path = %path.display(),
            min = ?meta.min_level,
            max = ?meta.max_level,
            readers = connections.len(),
            "map tile store opened",
        );

        Self {
            inner: Some(Arc::new(Inner {
                connections,
                next: AtomicUsize::new(0),
            })),
            meta,
        }
    }

    /// Live row from the pack, not the copy taken at open — a regional job
    /// bumps `generated_at` in place and the client cache-busts from this.
    pub fn meta(&self) -> TileMeta {
        let Some(inner) = &self.inner else {
            return self.meta.clone();
        };
        let con = inner
            .checkout()
            .lock()
            .expect("map tile store mutex poisoned");
        read_meta(&con).unwrap_or_else(|_| self.meta.clone())
    }

    /// One tile, or `None` when it was never rendered.
    pub async fn tile(&self, z: i64, x: i64, y: i64) -> ApiResult<Option<Vec<u8>>> {
        let Some(inner) = self.inner.clone() else {
            return Ok(None);
        };

        // The blocking pool, because a rusqlite read is synchronous and would
        // otherwise stall the async worker it lands on.
        let blob = tokio::task::spawn_blocking(move || {
            let con = inner
                .checkout()
                .lock()
                .expect("map tile store mutex poisoned");
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
        generated_at: get("generated_at")?,
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
                 ('game_version','42.20.0'),('generated_at','2026-08-22T00:00:00Z');",
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

    /// Guards the reason the pool exists: reads have to be able to overlap.
    /// A single shared connection still passes every other test in this file --
    /// it just serialises, which is invisible to a one-at-a-time assertion.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_reads_all_get_their_own_tile() {
        let dir = tempfile::tempdir().unwrap();
        let tiles: Vec<(i64, i64, i64, Vec<u8>)> = (0..32)
            .map(|i| (20, i, i, format!("tile-{i}").into_bytes()))
            .collect();
        let borrowed: Vec<(i64, i64, i64, &[u8])> = tiles
            .iter()
            .map(|(z, x, y, b)| (*z, *x, *y, b.as_slice()))
            .collect();
        let store = store_with(dir.path(), &borrowed);

        let reads = tiles.iter().map(|(z, x, y, expected)| {
            let store = store.clone();
            let expected = expected.clone();
            let (z, x, y) = (*z, *x, *y);
            tokio::spawn(async move { (store.tile(z, x, y).await.unwrap(), expected) })
        });

        for handle in reads.collect::<Vec<_>>() {
            let (got, expected) = handle.await.unwrap();
            assert_eq!(got, Some(expected));
        }
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
        assert_eq!(meta.generated_at.as_deref(), Some("2026-08-22T00:00:00Z"));

        let path = dir.path().join("tiles.sqlite");
        let con = rusqlite::Connection::open(&path).unwrap();
        con.execute(
            "UPDATE meta SET value = '2026-08-22T12:00:00Z' WHERE key = 'generated_at'",
            [],
        )
        .unwrap();
        drop(con);
        assert_eq!(
            store.meta().generated_at.as_deref(),
            Some("2026-08-22T12:00:00Z")
        );
    }
}
