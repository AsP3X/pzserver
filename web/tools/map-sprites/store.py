"""SQLite catalogue the API serves. Separate file from tiles.sqlite."""

from __future__ import annotations

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
"""


def open_write(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    return con


def write_meta(con: sqlite3.Connection, values: dict[str, str]) -> None:
    con.executemany("INSERT INTO meta(key, value) VALUES (?, ?)", list(values.items()))


def write_atlas(con: sqlite3.Connection, pages: list[bytes], sprites: list[PackedSprite]) -> dict[str, int]:
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


def write_cell(
    con: sqlite3.Connection,
    cx: int,
    cy: int,
    records: list[tuple[int, int, int, int]],
    thumb: bytes | None,
) -> None:
    con.execute(
        "INSERT INTO cells(cx, cy, occupancy) VALUES (?, ?, ?)",
        (cx, cy, encode(records)),
    )
    if thumb is not None:
        con.execute("INSERT INTO thumbs(cx, cy, data) VALUES (?, ?, ?)", (cx, cy, thumb))
