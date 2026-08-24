//! Watch dedicated-server chunk files and enqueue tile jobs for dirty cells.
//!
//! B42 stores visited world as `Saves/Multiplayer/<name>/map/{x}/{y}.bin`
//! (8-square blocks). A cell is 256 squares → 32×32 blocks. Older worlds keep
//! `map_{cx}_{cy}.bin`. Either way the public contract is a cell rect, which
//! the existing tile-job pipeline already accepts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::PgPool;

use crate::error::ApiError;
use crate::services::map_tile_jobs;
use crate::state::AppState;

const CELL_SIZE: i32 = 256;
const B42_BLOCK: i32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Cell {
    pub cx: i32,
    pub cy: i32,
}

pub fn chunk_cell(x: i32, y: i32, unit: i32) -> Cell {
    Cell {
        cx: (x * unit) / CELL_SIZE,
        cy: (y * unit) / CELL_SIZE,
    }
}

pub fn save_dir(data_path: &Path, save_game: &str) -> PathBuf {
    let mut path = data_path.join("Saves");
    for part in save_game.split(['/', '\\']) {
        if !part.is_empty() {
            path.push(part);
        }
    }
    path
}

/// Max mtime (unix millis) of every chunk that belongs to a cell.
pub fn cell_mtimes(save: &Path) -> HashMap<Cell, i64> {
    let mut out = HashMap::new();
    for (x, y, unit, path) in iter_chunks(save) {
        let Ok(mtime) = file_mtime_ms(&path) else {
            continue;
        };
        let cell = chunk_cell(x, y, unit);
        let entry = out.entry(cell).or_insert(mtime);
        if mtime > *entry {
            *entry = mtime;
        }
    }
    out
}

fn file_mtime_ms(path: &Path) -> std::io::Result<i64> {
    let modified = path.metadata()?.modified()?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64)
}

fn iter_chunks(save: &Path) -> Vec<(i32, i32, i32, PathBuf)> {
    let mut out = Vec::new();
    let map_dir = save.join("map");
    if map_dir.is_dir() {
        let Ok(xdirs) = std::fs::read_dir(&map_dir) else {
            return out;
        };
        for xdir in xdirs.flatten() {
            let name = xdir.file_name();
            let Some(x) = name.to_str().and_then(|s| s.parse::<i32>().ok()) else {
                continue;
            };
            if !xdir.path().is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(xdir.path()) else {
                continue;
            };
            for file in files.flatten() {
                let fname = file.file_name();
                let Some(stem) = Path::new(&fname).file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Some(y) = stem.parse::<i32>().ok() else {
                    continue;
                };
                if file.path().extension().and_then(|e| e.to_str()) != Some("bin") {
                    continue;
                }
                out.push((x, y, B42_BLOCK, file.path()));
            }
        }
        return out;
    }

    let Ok(entries) = std::fs::read_dir(save) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(rest) = name.strip_prefix("map_") else {
            continue;
        };
        let Some(stem) = rest.strip_suffix(".bin") else {
            continue;
        };
        let mut parts = stem.split('_');
        let Some(xs) = parts.next() else { continue };
        let Some(ys) = parts.next() else { continue };
        if parts.next().is_some() {
            continue;
        }
        let (Ok(x), Ok(y)) = (xs.parse::<i32>(), ys.parse::<i32>()) else {
            continue;
        };
        out.push((x, y, CELL_SIZE, entry.path()));
    }
    out
}

pub fn dirty_cells(
    scanned: &HashMap<Cell, i64>,
    stored: &HashMap<Cell, i64>,
    max_cells: usize,
) -> Vec<Cell> {
    let mut dirty: Vec<(Cell, i64)> = scanned
        .iter()
        .filter_map(|(cell, mtime)| {
            match stored.get(cell) {
                None => Some((*cell, *mtime)),
                Some(seen) if mtime > seen => Some((*cell, *mtime)),
                _ => None,
            }
        })
        .collect();
    dirty.sort_by(|a, b| b.1.cmp(&a.1));
    dirty.truncate(max_cells);
    dirty.into_iter().map(|(cell, _)| cell).collect()
}

/// Background tick. Seeds on first run. No-ops when the save is missing, the
/// renderer binds are relative (docker cannot use them), or a job is already
/// running.
pub async fn tick(state: &AppState) {
    if state.config.map_tiles_world_scan.is_zero() {
        return;
    }
    if map_tile_jobs::require_absolute_binds(state).is_err() {
        return;
    }
    let save = save_dir(&state.config.data_path, &state.config.pz_save_game);
    if !save.is_dir() {
        return;
    }

    let scanned = match tokio::task::spawn_blocking({
        let save = save.clone();
        move || cell_mtimes(&save)
    })
    .await
    {
        Ok(map) => map,
        Err(error) => {
            tracing::warn!(%error, "map tile world scan join failed");
            return;
        }
    };

    if scanned.is_empty() {
        return;
    }

    match load_stored(&state.db).await {
        Ok(stored) if stored.is_empty() => {
            if let Err(error) = replace_stored(&state.db, &scanned).await {
                tracing::warn!(%error, "map tile world seed failed");
                return;
            }
            tracing::info!(
                cells = scanned.len(),
                "seeded map tile chunk mtimes; not enqueueing"
            );
        }
        Ok(stored) => {
            let dirty = dirty_cells(
                &scanned,
                &stored,
                state.config.map_tiles_world_max_cells,
            );
            if dirty.is_empty() {
                return;
            }
            let cells: Vec<Vec<i32>> = dirty
                .iter()
                .map(|cell| vec![cell.cx, cell.cy, 1, 1])
                .collect();
            match map_tile_jobs::enqueue(state, Vec::new(), cells).await {
                Ok(job) => {
                    tracing::info!(
                        id = %job.id,
                        cells = dirty.len(),
                        "enqueued world-change tile job"
                    );
                }
                Err(ApiError::Conflict { .. }) => {}
                Err(error) => {
                    tracing::warn!(%error, "world-change tile job not enqueued");
                }
            }
        }
        Err(error) => {
            tracing::warn!(%error, "map tile chunk table unreadable");
        }
    }
}

pub async fn mark_seen(db: &PgPool, save: &Path, cells: &[[i32; 4]]) -> Result<(), sqlx::Error> {
    if cells.is_empty() {
        return Ok(());
    }
    let scanned = cell_mtimes(save);
    let mut relevant = HashMap::new();
    for &[x, y, w, h] in cells {
        for cx in x..x + w {
            for cy in y..y + h {
                let cell = Cell { cx, cy };
                if let Some(mtime) = scanned.get(&cell).copied() {
                    relevant.insert(cell, mtime);
                } else {
                    relevant.insert(
                        cell,
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as i64,
                    );
                }
            }
        }
    }
    upsert_stored(db, &relevant).await
}

async fn load_stored(db: &PgPool) -> Result<HashMap<Cell, i64>, sqlx::Error> {
    let rows: Vec<(i32, i32, i64)> = sqlx::query_as("SELECT cx, cy, mtime_ms FROM map_tile_chunks")
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(cx, cy, mtime_ms)| (Cell { cx, cy }, mtime_ms))
        .collect())
}

async fn replace_stored(db: &PgPool, scanned: &HashMap<Cell, i64>) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM map_tile_chunks")
        .execute(db)
        .await?;
    upsert_stored(db, scanned).await
}

async fn upsert_stored(db: &PgPool, scanned: &HashMap<Cell, i64>) -> Result<(), sqlx::Error> {
    for (cell, mtime) in scanned {
        sqlx::query(
            r#"INSERT INTO map_tile_chunks (cx, cy, mtime_ms)
               VALUES ($1, $2, $3)
               ON CONFLICT (cx, cy) DO UPDATE SET mtime_ms = EXCLUDED.mtime_ms"#,
        )
        .bind(cell.cx)
        .bind(cell.cy)
        .bind(mtime)
        .execute(db)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn b42_block_to_cell() {
        assert_eq!(chunk_cell(1375, 1251, 8), Cell { cx: 42, cy: 39 });
    }

    #[test]
    fn legacy_cell_file_stays_a_cell() {
        assert_eq!(chunk_cell(34, 30, 256), Cell { cx: 34, cy: 30 });
    }

    #[test]
    fn save_dir_joins_multiplayer_name() {
        let path = save_dir(Path::new("/pz-data"), "Multiplayer/ZomboidServer");
        assert_eq!(path, PathBuf::from("/pz-data/Saves/Multiplayer/ZomboidServer"));
    }

    #[test]
    fn scans_b42_map_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let blob = tmp.path().join("map/1375/1251.bin");
        fs::create_dir_all(blob.parent().unwrap()).unwrap();
        fs::write(&blob, b"x").unwrap();
        fs::write(tmp.path().join("map_meta.bin"), b"skip").unwrap();
        let times = cell_mtimes(tmp.path());
        assert!(times.contains_key(&Cell { cx: 42, cy: 39 }));
        assert_eq!(times.len(), 1);
    }

    #[test]
    fn dirty_picks_newer_and_caps() {
        let scanned = HashMap::from([
            (Cell { cx: 1, cy: 1 }, 50),
            (Cell { cx: 2, cy: 2 }, 80),
            (Cell { cx: 3, cy: 3 }, 10),
        ]);
        let stored = HashMap::from([
            (Cell { cx: 1, cy: 1 }, 40),
            (Cell { cx: 3, cy: 3 }, 10),
        ]);
        let dirty = dirty_cells(&scanned, &stored, 8);
        assert_eq!(dirty, vec![Cell { cx: 2, cy: 2 }, Cell { cx: 1, cy: 1 }]);
        let capped = dirty_cells(&scanned, &HashMap::new(), 1);
        assert_eq!(capped, vec![Cell { cx: 2, cy: 2 }]);
    }
}
