"""SQLite catalogue the API serves. Separate file from tiles.sqlite."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from atlas import PackedSprite
from occupancy import encode

SCHEMA = """
CREATE TABLE sprites (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    page INTEGER NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    w INTEGER NOT NULL,
    h INTEGER NOT NULL,
    ox INTEGER NOT NULL,
    oy INTEGER NOT NULL
);
CREATE TABLE atlas (
    page INTEGER PRIMARY KEY,
    data BLOB NOT NULL
);
CREATE TABLE cells (
    cx INTEGER NOT NULL,
    cy INTEGER NOT NULL,
    occupancy BLOB NOT NULL,
    PRIMARY KEY (cx, cy)
);
CREATE TABLE thumbs (
    cx INTEGER NOT NULL,
    cy INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (cx, cy)
);
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE overview (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data BLOB NOT NULL
);
"""

WORK_SCHEMA = """
CREATE TABLE IF NOT EXISTS bake_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_cell (
    map_name TEXT NOT NULL,
    cx INTEGER NOT NULL,
    cy INTEGER NOT NULL,
    empty INTEGER NOT NULL,
    names TEXT,
    blob BLOB,
    z_min INTEGER,
    z_max INTEGER,
    PRIMARY KEY (map_name, cx, cy)
);
"""


def work_path(out: Path) -> Path:
    return out.with_name(out.name + ".work")


def _sidecar(path: Path, suffix: str) -> Path:
    return Path(str(path) + suffix)


def unlink_sqlite(path: Path) -> None:
    path.unlink(missing_ok=True)
    _sidecar(path, "-wal").unlink(missing_ok=True)
    _sidecar(path, "-shm").unlink(missing_ok=True)


def open_write(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    unlink_sqlite(path)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    return con


def open_work(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(WORK_SCHEMA)
    con.executescript(SCHEMA.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "))
    return con


def reset_work(path: Path) -> sqlite3.Connection:
    unlink_sqlite(path)
    return open_work(path)


def bake_get(con: sqlite3.Connection, key: str) -> str | None:
    row = con.execute("SELECT value FROM bake_meta WHERE key = ?", (key,)).fetchone()
    return None if row is None else str(row[0])


def bake_set(con: sqlite3.Connection, key: str, value: str) -> None:
    con.execute(
        "INSERT INTO bake_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def write_meta(con: sqlite3.Connection, values: dict[str, str]) -> None:
    con.executemany(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        list(values.items()),
    )


def write_atlas(con: sqlite3.Connection, pages: list[bytes], sprites: list[PackedSprite]) -> dict[str, int]:
    con.execute("DELETE FROM sprites")
    con.execute("DELETE FROM atlas")
    ids: dict[str, int] = {}
    for page, blob in enumerate(pages):
        con.execute("INSERT INTO atlas(page, data) VALUES (?, ?)", (page, blob))
    for index, sprite in enumerate(sprites, start=1):
        con.execute(
            """INSERT INTO sprites(id, name, page, x, y, w, h, ox, oy)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                index,
                sprite.name,
                sprite.page,
                sprite.x,
                sprite.y,
                sprite.w,
                sprite.h,
                sprite.ox,
                sprite.oy,
            ),
        )
        ids[sprite.name] = index
    return ids


def load_sprite_ids(con: sqlite3.Connection) -> dict[str, int]:
    return {str(name): int(sprite_id) for sprite_id, name in con.execute("SELECT id, name FROM sprites")}


def load_sprite_oxoy(con: sqlite3.Connection) -> dict[str, tuple[int, int]]:
    return {
        str(name): (int(ox), int(oy))
        for name, ox, oy in con.execute("SELECT name, ox, oy FROM sprites")
    }


def written_cells(con: sqlite3.Connection) -> set[tuple[int, int]]:
    return {(int(cx), int(cy)) for cx, cy in con.execute("SELECT cx, cy FROM cells")}


def write_cell(
    con: sqlite3.Connection,
    cx: int,
    cy: int,
    records: list[tuple[int, int, int, int]] | bytes,
    thumb: bytes | None,
) -> None:
    blob = records if isinstance(records, (bytes, bytearray)) else encode(records)
    con.execute(
        "INSERT OR REPLACE INTO cells(cx, cy, occupancy) VALUES (?, ?, ?)",
        (cx, cy, blob),
    )
    if thumb is not None:
        con.execute(
            "INSERT OR REPLACE INTO thumbs(cx, cy, data) VALUES (?, ?, ?)",
            (cx, cy, thumb),
        )


def write_overview(con: sqlite3.Connection, blob: bytes) -> None:
    con.execute("INSERT OR REPLACE INTO overview(id, data) VALUES (1, ?)", (blob,))


def publish_work(con: sqlite3.Connection, work: Path, live: Path) -> None:
    """Fold WAL into the work file, then atomically replace the live catalogue."""
    con.commit()
    con.close()
    fold = sqlite3.connect(work)
    fold.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    fold.execute("PRAGMA journal_mode=DELETE")
    fold.close()
    live.parent.mkdir(parents=True, exist_ok=True)
    os.replace(work, live)
    _sidecar(work, "-wal").unlink(missing_ok=True)
    _sidecar(work, "-shm").unlink(missing_ok=True)
