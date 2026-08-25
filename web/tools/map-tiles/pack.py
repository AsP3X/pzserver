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


def pack(tiles_dir: Path, db_path: Path, meta: dict, replace: bool = False,
         only: set | None = None, wal: bool = False) -> int:
    """Store every tile under `tiles_dir`. Returns how many were newly added.

    `replace` is for a re-render: without it the fresh bytes lose to the row
    already there and the whole run is a no-op. The default stays skip-on-
    conflict, which is what makes an interrupted first pack resumable.
    `only` limits a regional re-pack to named keys so merge siblings stay
    untouched on disk and in the database. `wal` lets readers keep going
    while the pack updates a live database.
    """
    con = sqlite3.connect(db_path)
    if wal:
        mode = con.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        if str(mode).lower() != "wal":
            con.close()
            raise RuntimeError(
                f"failed to enable WAL journal_mode (got {mode!r})"
            )
    con.executescript(SCHEMA)

    added = 0
    for level_dir in sorted(_level_dirs(tiles_dir), key=lambda p: int(p.name)):
        z = int(level_dir.name)

        batch = []
        for tile in level_dir.glob("*.jpg"):
            x, _, y = tile.stem.partition("_")
            if only is not None and (z, int(x), int(y)) not in only:
                continue
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
    info = tiles_dir.parent / "map_info.json"
    if info.is_file():
        con.execute(
            "INSERT INTO meta (key, value) VALUES ('map_info', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (info.read_text(encoding="utf-8"),),
        )
    con.commit()

    if wal:
        try:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error as exc:
            # Tiles are already committed; do not roll them back for a
            # checkpoint failure (e.g. a concurrent reader holding the WAL).
            print(f"wal_checkpoint failed: {exc}", file=sys.stderr)

    # Only after a full pack. VACUUM rebuilds the entire database into a
    # temporary copy beside it, so on a 24 GB pack it costs tens of minutes and
    # briefly doubles the disk -- absurd for a regional re-render that replaced
    # a few dozen rows. Even here it earns little: this only ever INSERTs, in
    # level order, so there is barely any fragmentation to reclaim.
    if not replace:
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


def _read_keys(path) -> set:
    """Parse lines of `z/x_y` into (z, x, y) tuples."""
    tiles = set()
    for line in Path(path).read_text(encoding="utf-8").split():
        z, _, rest = line.partition("/")
        x, _, y = rest.partition("_")
        tiles.add((int(z), int(x), int(y)))
    return tiles


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(
            "usage: pack.py <layer0_files dir> <tiles.sqlite> "
            "[--replace] [--wal] [--only keys.txt] [k=v ...]",
            file=sys.stderr,
        )
        raise SystemExit(2)

    replace = False
    wal = False
    only = None
    meta_args = []
    argv = sys.argv[3:]
    i = 0
    while i < len(argv):
        if argv[i] == "--replace":
            replace = True
            i += 1
        elif argv[i] == "--wal":
            wal = True
            i += 1
        elif argv[i] == "--only":
            only = _read_keys(argv[i + 1])
            i += 2
        else:
            meta_args.append(argv[i])
            i += 1

    extra = dict(pair.split("=", 1) for pair in meta_args)
    n = pack(
        Path(sys.argv[1]),
        Path(sys.argv[2]),
        extra,
        replace=replace,
        only=only,
        wal=wal,
    )
    print(f"packed {n} new tiles into {sys.argv[2]}")
