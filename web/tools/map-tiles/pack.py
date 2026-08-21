"""Fold a DZI tile tree into one SQLite file.

Deletes each tile as it is stored. Holding the loose tree and the finished
database at the same time costs roughly double the final size, and the final
size is about 15 GB.
"""
import sqlite3
import sys
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS tiles (
    z INTEGER NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (z, x, y)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def pack(tiles_dir: Path, db_path: Path, meta: dict, replace: bool = False) -> int:
    """Store every tile under `tiles_dir`. Returns how many were newly added.

    `replace` is for a re-render: without it the fresh bytes lose to the row
    already there and the whole run is a no-op. The default stays skip-on-
    conflict, which is what makes an interrupted first pack resumable.
    """
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)

    added = 0
    for level_dir in sorted(_level_dirs(tiles_dir), key=lambda p: int(p.name)):
        z = int(level_dir.name)

        batch = []
        for tile in level_dir.glob("*.jpg"):
            x, _, y = tile.stem.partition("_")
            batch.append((z, int(x), int(y), tile.read_bytes(), tile))

            if len(batch) >= 500:
                added += _flush(con, batch, replace)
                batch.clear()

        added += _flush(con, batch, replace)
        print(f"level {z}: packed, {added} tiles so far", flush=True)

    # Ask the table, not the directory listing. pzmap2dzi creates a directory
    # for every DZI level whether or not it ends up with tiles in it -- levels
    # 0-11 and 21-22 come out empty on a `skip_level` render -- and reporting
    # those as the rendered range tells the client the pack is deeper than it
    # is. The client sets its zoom clamp from max_level, so an inflated value
    # disables the clamp and it requests levels that can only 404.
    low, high = con.execute("SELECT MIN(z), MAX(z) FROM tiles").fetchone()
    meta = dict(meta)
    if low is not None:
        meta.setdefault("min_level", str(low))
        meta.setdefault("max_level", str(high))
    meta["tile_count"] = str(con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0])

    con.executemany(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        list(meta.items()),
    )
    con.commit()
    con.execute("VACUUM")
    con.close()
    return added


def _level_dirs(tiles_dir: Path):
    """The numeric level directories, ignoring anything else that is in there.

    Filtering before the sort matters: the sort key is `int(p.name)`, so a
    stray non-numeric entry would raise rather than be skipped.
    """
    for entry in tiles_dir.iterdir():
        if entry.is_dir() and entry.name.isdigit():
            yield entry


def _flush(con, batch, replace: bool = False) -> int:
    """Insert a batch, then unlink the files that are now safely stored."""
    if not batch:
        return 0

    rows = [(z, x, y, blob) for z, x, y, blob, _ in batch]
    before = con.total_changes
    conflict = (
        "DO UPDATE SET data = excluded.data" if replace else "DO NOTHING"
    )
    con.executemany(
        "INSERT INTO tiles (z, x, y, data) VALUES (?, ?, ?, ?) "
        f"ON CONFLICT(z, x, y) {conflict}",
        rows,
    )
    con.commit()

    for *_, path in batch:
        path.unlink(missing_ok=True)

    return con.total_changes - before


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: pack.py <layer0_files dir> <tiles.sqlite> [k=v ...]", file=sys.stderr)
        raise SystemExit(2)

    args = [a for a in sys.argv[3:] if a != "--replace"]
    replace = "--replace" in sys.argv[3:]
    extra = dict(pair.split("=", 1) for pair in args)
    n = pack(Path(sys.argv[1]), Path(sys.argv[2]), extra, replace=replace)
    print(f"packed {n} new tiles into {sys.argv[2]}")
