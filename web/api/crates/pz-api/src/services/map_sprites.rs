//! Read access to the sprite isometric catalogue.
//!
//! Separate from `map_tiles`: that store is the JPEG DZI pack. This one is
//! atlas pages, occupancy blobs and cell thumbnails from `make map-sprites`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use crate::error::{ApiError, ApiResult};

#[derive(Clone, Debug, Serialize)]
pub struct SpriteMeta {
    pub ready: bool,
    pub generated_at: Option<String>,
    pub game_version: Option<String>,
    pub pages: Option<i64>,
    pub sprites: Option<i64>,
    pub cells: Option<i64>,
    pub z_min: Option<i64>,
    pub z_max: Option<i64>,
    pub thumb_scale: Option<i64>,
    pub max_reach: Option<i64>,
    pub cell_size: Option<i64>,
}

impl SpriteMeta {
    fn absent() -> Self {
        Self {
            ready: false,
            generated_at: None,
            game_version: None,
            pages: None,
            sprites: None,
            cells: None,
            z_min: None,
            z_max: None,
            thumb_scale: None,
            max_reach: None,
            cell_size: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SpriteRecord {
    pub id: i64,
    pub name: String,
    pub page: i64,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub ox: i64,
    pub oy: i64,
}

const POOL_SIZE: usize = 4;

#[derive(Clone)]
pub struct MapSprites {
    inner: Option<Arc<Inner>>,
    live_path: PathBuf,
}

struct Inner {
    connections: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl Inner {
    fn checkout(&self) -> &Mutex<Connection> {
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.connections.len();
        &self.connections[i]
    }
}

impl MapSprites {
    pub fn open(path: &Path) -> Self {
        let live_path = path.with_file_name("live.bin");
        let Ok(con) = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else {
            tracing::info!(path = %path.display(), "no sprite map store; iso-sprite mode unavailable");
            return Self {
                inner: None,
                live_path,
            };
        };
        tune(&con);
        let mut connections = vec![Mutex::new(con)];
        for _ in 1..POOL_SIZE {
            match Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                Ok(extra) => {
                    tune(&extra);
                    connections.push(Mutex::new(extra));
                }
                Err(error) => {
                    tracing::warn!(%error, "sprite map pool opened short");
                    break;
                }
            }
        }
        tracing::info!(
            path = %path.display(),
            readers = connections.len(),
            "sprite map store opened"
        );
        Self {
            inner: Some(Arc::new(Inner {
                connections,
                next: AtomicUsize::new(0),
            })),
            live_path,
        }
    }

    pub fn live_path(&self) -> &Path {
        &self.live_path
    }

    /// Compact live save overlay. Missing file is a cold start, not an error.
    pub fn live_bin(&self) -> Option<Vec<u8>> {
        std::fs::read(&self.live_path).ok().filter(|bytes| {
            bytes.len() >= 12 && bytes.starts_with(b"LIVE")
        })
    }

    pub fn live_revision(&self) -> Option<u32> {
        let bytes = self.live_bin()?;
        Some(u32::from_le_bytes(bytes[4..8].try_into().ok()?))
    }

    pub fn meta(&self) -> SpriteMeta {
        let Some(inner) = &self.inner else {
            return SpriteMeta::absent();
        };
        let con = inner.checkout().lock().expect("sprite map mutex poisoned");
        read_meta(&con).unwrap_or_else(|_| SpriteMeta::absent())
    }

    /// Compact UV table: magic `SPRC`, u32 count, then `count` records of
    /// `{ page,x,y,w,h: u16, ox,oy: i16 }` in id order (id = index + 1).
    pub async fn sprites_bin(&self) -> ApiResult<Option<Vec<u8>>> {
        let Some(inner) = self.inner.clone() else {
            return Ok(None);
        };
        let blob = tokio::task::spawn_blocking(move || -> rusqlite::Result<Vec<u8>> {
            let con = inner.checkout().lock().expect("sprite map mutex poisoned");
            let mut stmt = con.prepare(
                "SELECT id, page, x, y, w, h, ox, oy FROM sprites ORDER BY id",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })?;
            let records: Vec<(i64, i64, i64, i64, i64, i64, i64, i64)> =
                rows.collect::<rusqlite::Result<_>>()?;
            let max_id = records.iter().map(|row| row.0).max().unwrap_or(0).max(0) as usize;
            let mut out = vec![0u8; 8 + max_id * 14];
            out[0..4].copy_from_slice(b"SPRC");
            out[4..8].copy_from_slice(&(max_id as u32).to_le_bytes());
            for (id, page, x, y, w, h, ox, oy) in records {
                if id < 1 {
                    continue;
                }
                let offset = 8 + (id as usize - 1) * 14;
                write_u16(&mut out, offset, page);
                write_u16(&mut out, offset + 2, x);
                write_u16(&mut out, offset + 4, y);
                write_u16(&mut out, offset + 6, w);
                write_u16(&mut out, offset + 8, h);
                write_i16(&mut out, offset + 10, ox);
                write_i16(&mut out, offset + 12, oy);
            }
            Ok(out)
        })
        .await
        .map_err(|error| ApiError::Internal(format!("sprite bin did not finish: {error}")))?
        .map_err(|error| ApiError::Internal(format!("sprite bin failed: {error}")))?;
        Ok(Some(blob))
    }

    pub async fn sprites(&self) -> ApiResult<Vec<SpriteRecord>> {
        self.rows(
            "SELECT id, name, page, x, y, w, h, ox, oy FROM sprites ORDER BY id",
            |row| {
                Ok(SpriteRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    page: row.get(2)?,
                    x: row.get(3)?,
                    y: row.get(4)?,
                    w: row.get(5)?,
                    h: row.get(6)?,
                    ox: row.get(7)?,
                    oy: row.get(8)?,
                })
            },
        )
        .await
    }

    /// Sprite ids whose names are roof tiles (`roofs_*`). Packed as little-endian
    /// `u32` count then that many `u32` ids. Empty catalogue → `None`.
    pub async fn roofs_bin(&self) -> ApiResult<Option<Vec<u8>>> {
        let Some(inner) = self.inner.clone() else {
            return Ok(None);
        };
        let blob = tokio::task::spawn_blocking(move || -> rusqlite::Result<Vec<u8>> {
            let con = inner.checkout().lock().expect("sprite map mutex poisoned");
            let mut stmt = con.prepare(
                "SELECT id FROM sprites WHERE name LIKE 'roofs_%' OR name LIKE '%_roofs_%' ORDER BY id",
            )?;
            let ids: Vec<i64> = stmt
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = vec![0u8; 4 + ids.len() * 4];
            out[0..4].copy_from_slice(&(ids.len() as u32).to_le_bytes());
            for (index, id) in ids.iter().enumerate() {
                let raw = (*id).clamp(0, i64::from(u32::MAX)) as u32;
                out[4 + index * 4..8 + index * 4].copy_from_slice(&raw.to_le_bytes());
            }
            Ok(out)
        })
        .await
        .map_err(|error| ApiError::Internal(format!("roof bin did not finish: {error}")))?
        .map_err(|error| ApiError::Internal(format!("roof bin failed: {error}")))?;
        Ok(Some(blob))
    }

    pub async fn atlas(&self, page: i64) -> ApiResult<Option<Vec<u8>>> {
        self.blob("SELECT data FROM atlas WHERE page = ?1", page)
            .await
    }

    pub async fn cell(&self, cx: i64, cy: i64) -> ApiResult<Option<Vec<u8>>> {
        self.blob2(
            "SELECT occupancy FROM cells WHERE cx = ?1 AND cy = ?2",
            cx,
            cy,
        )
        .await
    }

    pub async fn thumb(&self, cx: i64, cy: i64) -> ApiResult<Option<Vec<u8>>> {
        self.blob2("SELECT data FROM thumbs WHERE cx = ?1 AND cy = ?2", cx, cy)
            .await
    }

    pub async fn overview(&self) -> ApiResult<Option<Vec<u8>>> {
        match self.blob("SELECT data FROM overview WHERE id = ?1", 1).await {
            Ok(bytes) => Ok(bytes),
            Err(_) => Ok(None),
        }
    }

    async fn blob(&self, sql: &'static str, a: i64) -> ApiResult<Option<Vec<u8>>> {
        let Some(inner) = self.inner.clone() else {
            return Ok(None);
        };
        let blob = tokio::task::spawn_blocking(move || {
            let con = inner.checkout().lock().expect("sprite map mutex poisoned");
            con.query_row(sql, [a], |row| row.get::<_, Vec<u8>>(0))
                .optional()
        })
        .await
        .map_err(|error| ApiError::Internal(format!("sprite map read did not finish: {error}")))?
        .map_err(|error| ApiError::Internal(format!("sprite map read failed: {error}")))?;
        Ok(blob)
    }

    async fn blob2(&self, sql: &'static str, a: i64, b: i64) -> ApiResult<Option<Vec<u8>>> {
        let Some(inner) = self.inner.clone() else {
            return Ok(None);
        };
        let blob = tokio::task::spawn_blocking(move || {
            let con = inner.checkout().lock().expect("sprite map mutex poisoned");
            con.query_row(sql, [a, b], |row| row.get::<_, Vec<u8>>(0))
                .optional()
        })
        .await
        .map_err(|error| ApiError::Internal(format!("sprite map read did not finish: {error}")))?
        .map_err(|error| ApiError::Internal(format!("sprite map read failed: {error}")))?;
        Ok(blob)
    }

    async fn rows<T, F>(&self, sql: &'static str, map: F) -> ApiResult<Vec<T>>
    where
        T: Send + 'static,
        F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T> + Send + 'static,
    {
        let Some(inner) = self.inner.clone() else {
            return Ok(Vec::new());
        };
        let rows = tokio::task::spawn_blocking(move || {
            let con = inner.checkout().lock().expect("sprite map mutex poisoned");
            let mut stmt = con.prepare(sql)?;
            let mut map = map;
            let mapped = stmt.query_map([], &mut map)?;
            mapped.collect::<rusqlite::Result<Vec<T>>>()
        })
        .await
        .map_err(|error| ApiError::Internal(format!("sprite list did not finish: {error}")))?
        .map_err(|error| ApiError::Internal(format!("sprite list failed: {error}")))?;
        Ok(rows)
    }
}

fn write_u16(buf: &mut [u8], offset: usize, value: i64) {
    let raw = (value.clamp(0, i64::from(u16::MAX)) as u16).to_le_bytes();
    buf[offset..offset + 2].copy_from_slice(&raw);
}

fn write_i16(buf: &mut [u8], offset: usize, value: i64) {
    let raw = (value.clamp(i64::from(i16::MIN), i64::from(i16::MAX)) as i16).to_le_bytes();
    buf[offset..offset + 2].copy_from_slice(&raw);
}

fn tune(con: &Connection) {
    let _ = con.pragma_update(None, "mmap_size", 64 * 1024 * 1024);
    let _ = con.pragma_update(None, "cache_size", -16_384);
    let _ = con.busy_timeout(std::time::Duration::from_secs(5));
}

fn read_meta(con: &Connection) -> rusqlite::Result<SpriteMeta> {
    let get = |key: &str| -> rusqlite::Result<Option<String>> {
        con.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
    };
    let parse = |key: &str| -> rusqlite::Result<Option<i64>> {
        Ok(get(key)?.and_then(|value| value.parse().ok()))
    };
    let generated_at = get("generated_at")?;
    Ok(SpriteMeta {
        ready: generated_at.is_some(),
        generated_at,
        game_version: get("game_version")?,
        pages: parse("pages")?,
        sprites: parse("sprites")?,
        cells: parse("cells")?,
        z_min: parse("z_min")?,
        z_max: parse("z_max")?,
        thumb_scale: parse("thumb_scale")?,
        max_reach: parse("max_reach")?,
        cell_size: parse("cell_size")?,
    })
}

#[cfg(test)]
mod live_tests {
    #[test]
    fn live_header_revision_is_little_endian_u32() {
        let mut bytes = b"LIVE".to_vec();
        bytes.extend_from_slice(&1_700_000_000u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            1_700_000_000
        );
    }
}
