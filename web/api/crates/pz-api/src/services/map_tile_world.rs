//! Save-chunk helpers for regional tile jobs.
//!
//! B42 stores visited world as `Saves/Multiplayer/<name>/map/{x}/{y}.bin`
//! (8-square blocks). A cell is 256 squares → 32×32 blocks. Older worlds keep
//! `map_{cx}_{cy}.bin`. After a manual region job, `mark_painted` records the
//! mtimes of the cells that were just drawn.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::PgPool;

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
        assert_eq!(
            path,
            PathBuf::from("/pz-data/Saves/Multiplayer/ZomboidServer")
        );
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
}
