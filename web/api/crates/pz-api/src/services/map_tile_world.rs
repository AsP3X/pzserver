//! Watch dedicated-server chunk files and enqueue tile jobs for dirty cells.
//!
//! B42 stores visited world as `Saves/Multiplayer/<name>/map/{x}/{y}.bin`
//! (8-square blocks). A cell is 256 squares → 32×32 blocks. Older worlds keep
//! `map_{cx}_{cy}.bin`. Either way the public contract is a cell rect, which
//! the existing tile-job pipeline already accepts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::error::{ApiError, ApiResult};
use crate::services::map_tile_jobs;
use crate::state::AppState;

const CELL_SIZE: i32 = 256;
const B42_BLOCK: i32 = 8;


#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Cell {
    pub cx: i32,
    pub cy: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Block {
    pub bx: i32,
    pub by: i32,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Settings {
    pub auto_rerender: bool,
    pub batch_blocks: i32,
    pub max_wait_secs: i32,
    pub pending_since: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsView {
    #[serde(flatten)]
    pub settings: Settings,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SettingsPatch {
    pub auto_rerender: Option<bool>,
    pub batch_blocks: Option<i32>,
    pub max_wait_secs: Option<i32>,
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
    for (block, unit, mtime) in iter_block_mtimes(save) {
        let cell = chunk_cell(block.bx, block.by, unit);
        let entry = out.entry(cell).or_insert(mtime);
        if mtime > *entry {
            *entry = mtime;
        }
    }
    out
}

/// One 8-square B42 block (or a legacy cell, which is 256 squares).
pub fn block_mtimes(save: &Path) -> HashMap<Block, i64> {
    let mut out = HashMap::new();
    for (block, _unit, mtime) in iter_block_mtimes(save) {
        let entry = out.entry(block).or_insert(mtime);
        if mtime > *entry {
            *entry = mtime;
        }
    }
    out
}

fn iter_block_mtimes(save: &Path) -> Vec<(Block, i32, i64)> {
    let mut out = Vec::new();
    for (x, y, unit, path) in iter_chunks(save) {
        let Ok(mtime) = file_mtime_ms(&path) else {
            continue;
        };
        out.push((Block { bx: x, by: y }, unit, mtime));
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

#[cfg(test)]
fn dirty_cells(
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

pub fn dirty_blocks(
    scanned: &HashMap<Block, i64>,
    stored: &HashMap<Block, i64>,
    max_blocks: usize,
) -> Vec<Block> {
    let mut dirty: Vec<(Block, i64)> = scanned
        .iter()
        .filter_map(|(block, mtime)| match stored.get(block) {
            None => Some((*block, *mtime)),
            Some(seen) if mtime > seen => Some((*block, *mtime)),
            _ => None,
        })
        .collect();
    // Oldest first so a quiet door is not starved by a busy cell.
    dirty.sort_by(|a, b| a.1.cmp(&b.1));
    dirty.truncate(max_blocks);
    dirty.into_iter().map(|(block, _)| block).collect()
}

pub fn should_flush(dirty: usize, batch: i32, waited_secs: i64, max_wait_secs: i32) -> bool {
    if dirty == 0 {
        return false;
    }
    if dirty >= batch.max(1) as usize {
        return true;
    }
    max_wait_secs > 0 && waited_secs >= i64::from(max_wait_secs)
}

pub fn block_to_square(block: Block, unit: i32) -> [i32; 4] {
    [block.bx * unit, block.by * unit, unit, unit]
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
        move || block_mtimes(&save)
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

    let settings = match load_settings(&state.db).await {
        Ok(row) => row,
        Err(error) => {
            tracing::warn!(%error, "map tile settings unread");
            return;
        }
    };

    match load_stored_blocks(&state.db).await {
        Ok(stored) if stored.is_empty() => {
            if let Err(error) = replace_stored_blocks(&state.db, &scanned).await {
                tracing::warn!(%error, "map tile world seed failed");
                return;
            }
            tracing::info!(
                blocks = scanned.len(),
                "seeded map tile block mtimes; not enqueueing"
            );
        }
        Ok(stored) => {
            if !settings.auto_rerender {
                return;
            }
            let cap = state.config.map_tiles_world_max_cells.max(1) * 8;
            let dirty = dirty_blocks(&scanned, &stored, cap.min(256));
            if dirty.is_empty() {
                let _ = set_pending_since(&state.db, None).await;
                return;
            }
            let pending_since = match settings.pending_since {
                Some(since) => since,
                None => {
                    let now = Utc::now();
                    let _ = set_pending_since(&state.db, Some(now)).await;
                    now
                }
            };
            let waited = (Utc::now() - pending_since).num_seconds().max(0);
            if !should_flush(
                dirty.len(),
                settings.batch_blocks,
                waited,
                settings.max_wait_secs,
            ) {
                return;
            }
            let squares: Vec<Vec<i32>> = dirty
                .iter()
                .map(|block| {
                    let [x, y, w, h] = block_to_square(*block, B42_BLOCK);
                    vec![x, y, w, h]
                })
                .collect();
            match map_tile_jobs::enqueue(state, squares, Vec::new()).await {
                Ok(job) => {
                    let _ = set_pending_since(&state.db, None).await;
                    tracing::info!(
                        id = %job.id,
                        blocks = dirty.len(),
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
            tracing::warn!(%error, "map tile block table unreadable");
        }
    }
}

pub async fn mark_painted(
    db: &PgPool,
    save: &Path,
    squares: &[[i32; 4]],
    cells: &[[i32; 4]],
) -> Result<(), sqlx::Error> {
    let mut square_rects: Vec<[i32; 4]> = squares.to_vec();
    for &[x, y, w, h] in cells {
        square_rects.push([x * CELL_SIZE, y * CELL_SIZE, w * CELL_SIZE, h * CELL_SIZE]);
    }
    if square_rects.is_empty() {
        return Ok(());
    }

    let scanned_blocks = block_mtimes(save);
    let mut relevant_blocks = HashMap::new();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    for &[x, y, w, h] in &square_rects {
        let bx0 = div_floor(x, B42_BLOCK);
        let by0 = div_floor(y, B42_BLOCK);
        let bx1 = div_floor(x + w - 1, B42_BLOCK);
        let by1 = div_floor(y + h - 1, B42_BLOCK);
        for bx in bx0..=bx1 {
            for by in by0..=by1 {
                let block = Block { bx, by };
                let mtime = scanned_blocks.get(&block).copied().unwrap_or(now);
                relevant_blocks.insert(block, mtime);
            }
        }
    }
    upsert_stored_blocks(db, &relevant_blocks).await?;

    let scanned_cells = cell_mtimes(save);
    let mut relevant_cells = HashMap::new();
    for &[x, y, w, h] in cells {
        for cx in x..x + w {
            for cy in y..y + h {
                let cell = Cell { cx, cy };
                let mtime = scanned_cells.get(&cell).copied().unwrap_or(now);
                relevant_cells.insert(cell, mtime);
            }
        }
    }
    if !relevant_cells.is_empty() {
        upsert_stored(db, &relevant_cells).await?;
    }
    Ok(())
}

fn div_floor(value: i32, unit: i32) -> i32 {
    if value >= 0 {
        value / unit
    } else {
        (value - unit + 1) / unit
    }
}

pub async fn view_settings(db: &PgPool) -> Result<SettingsView, sqlx::Error> {
    Ok(SettingsView {
        settings: load_settings(db).await?,
    })
}

pub async fn update_settings(db: &PgPool, patch: SettingsPatch) -> ApiResult<SettingsView> {
    if let Some(batch) = patch.batch_blocks {
        if !(1..=256).contains(&batch) {
            return Err(ApiError::Validation(
                "Batch must be between 1 and 256 blocks.".to_owned(),
            ));
        }
    }
    if let Some(wait) = patch.max_wait_secs {
        if !(0..=86_400).contains(&wait) {
            return Err(ApiError::Validation(
                "Wait must be between 0 and 86400 seconds.".to_owned(),
            ));
        }
    }
    sqlx::query(
        r#"UPDATE map_tile_settings SET
            auto_rerender = COALESCE($1, auto_rerender),
            batch_blocks = COALESCE($2, batch_blocks),
            max_wait_secs = COALESCE($3, max_wait_secs)
           WHERE id = 1"#,
    )
    .bind(patch.auto_rerender)
    .bind(patch.batch_blocks)
    .bind(patch.max_wait_secs)
    .execute(db)
    .await?;
    Ok(view_settings(db).await?)
}

async fn load_settings(db: &PgPool) -> Result<Settings, sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO map_tile_settings (id) VALUES (1)
           ON CONFLICT (id) DO NOTHING"#,
    )
    .execute(db)
    .await?;
    sqlx::query_as::<_, Settings>(
        r#"SELECT auto_rerender, batch_blocks, max_wait_secs, pending_since
           FROM map_tile_settings WHERE id = 1"#,
    )
    .fetch_one(db)
    .await
}

async fn set_pending_since(
    db: &PgPool,
    since: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE map_tile_settings SET pending_since = $1 WHERE id = 1")
        .bind(since)
        .execute(db)
        .await?;
    Ok(())
}

async fn load_stored_blocks(db: &PgPool) -> Result<HashMap<Block, i64>, sqlx::Error> {
    let rows: Vec<(i32, i32, i64)> =
        sqlx::query_as("SELECT bx, by, mtime_ms FROM map_tile_blocks")
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(bx, by, mtime_ms)| (Block { bx, by }, mtime_ms))
        .collect())
}

async fn replace_stored_blocks(
    db: &PgPool,
    scanned: &HashMap<Block, i64>,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM map_tile_blocks").execute(db).await?;
    upsert_stored_blocks(db, scanned).await
}

async fn upsert_stored_blocks(
    db: &PgPool,
    scanned: &HashMap<Block, i64>,
) -> Result<(), sqlx::Error> {
    for (block, mtime) in scanned {
        sqlx::query(
            r#"INSERT INTO map_tile_blocks (bx, by, mtime_ms)
               VALUES ($1, $2, $3)
               ON CONFLICT (bx, by) DO UPDATE SET mtime_ms = EXCLUDED.mtime_ms"#,
        )
        .bind(block.bx)
        .bind(block.by)
        .bind(mtime)
        .execute(db)
        .await?;
    }
    Ok(())
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

    #[test]
    fn dirty_blocks_keep_the_oldest_first() {
        let scanned = HashMap::from([
            (Block { bx: 1, by: 1 }, 50),
            (Block { bx: 2, by: 2 }, 80),
            (Block { bx: 3, by: 3 }, 10),
        ]);
        let stored = HashMap::from([(Block { bx: 1, by: 1 }, 40)]);
        let dirty = dirty_blocks(&scanned, &stored, 8);
        assert_eq!(
            dirty,
            vec![
                Block { bx: 3, by: 3 },
                Block { bx: 1, by: 1 },
                Block { bx: 2, by: 2 },
            ]
        );
    }

    #[test]
    fn a_block_becomes_an_eight_square() {
        assert_eq!(
            block_to_square(Block { bx: 1375, by: 1251 }, 8),
            [11000, 10008, 8, 8]
        );
    }

    #[test]
    fn flush_waits_for_a_batch_unless_the_clock_runs_out() {
        assert!(!should_flush(3, 8, 10, 300));
        assert!(should_flush(8, 8, 10, 300));
        assert!(should_flush(1, 8, 300, 300));
        assert!(!should_flush(1, 8, 10, 0));
        assert!(!should_flush(0, 1, 999, 1));
    }
}
