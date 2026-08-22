"""Restore the DZI tile tree from a pack.

The packer deletes the loose tree as it stores it, which is what keeps peak
disk near the size of the result. A regional re-render needs it back: the
pyramid's upper levels are built by merging four children into one parent, so
rendering a region without its neighbours on disk produces parents with three
quadrants black.

`skip` is how a region gets redrawn. pzmap2dzi treats a tile that already
exists as done, so the tiles covering the target region are deliberately left
out of the restore -- the hole is the instruction to re-render.
"""
import sqlite3
import sys
from pathlib import Path


def unpack(db_path: Path, tiles_dir: Path, skip: set | None = None,
           only: set | None = None) -> int:
    """Write tiles out as `{level}/{x}_{y}.jpg`. Returns how many landed.

    `only` restores just the named tiles, which is what a regional re-render
    wants: restoring the whole pack would cost as much as packing it did.
    `skip` is the inverse and is for restoring everything but a hole.
    """
    skip = skip or set()
    con = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True)
    tiles_dir = Path(tiles_dir)

    written = 0
    seen_levels = set()

    def emit(z, x, y, data):
        nonlocal written
        level_dir = tiles_dir / str(z)
        if z not in seen_levels:
            level_dir.mkdir(parents=True, exist_ok=True)
            seen_levels.add(z)
        (level_dir / f"{x}_{y}.jpg").write_bytes(data)
        written += 1

    if only is not None:
        # Look each one up by key. Scanning the table instead would pull every
        # blob off disk to keep a handful of them -- on a 24 GB pack over a
        # Docker bind mount that is about an hour, versus milliseconds here.
        for z, x, y in sorted(only):
            if (z, x, y) in skip:
                continue
            row = con.execute(
                "SELECT data FROM tiles WHERE z = ? AND x = ? AND y = ?", (z, x, y)
            ).fetchone()
            if row is not None:
                emit(z, x, y, row[0])
    else:
        for z, x, y, data in con.execute("SELECT z, x, y, data FROM tiles ORDER BY z, x, y"):
            if (z, x, y) in skip:
                continue
            emit(z, x, y, data)

    con.close()
    return written


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: unpack.py <tiles.sqlite> <layer0_files dir> [skip.txt]", file=sys.stderr)
        raise SystemExit(2)

    def read_list(path):
        tiles = set()
        for line in Path(path).read_text(encoding="utf-8").split():
            z, _, rest = line.partition("/")
            x, _, y = rest.partition("_")
            tiles.add((int(z), int(x), int(y)))
        return tiles

    only = None
    skip = set()
    if len(sys.argv) > 4 and sys.argv[3] == "--only":
        only = read_list(sys.argv[4])
    elif len(sys.argv) > 3 and Path(sys.argv[3]).exists():
        skip = read_list(sys.argv[3])

    n = unpack(Path(sys.argv[1]), Path(sys.argv[2]), skip, only)
    if only is not None:
        print(f"restored {n} merge inputs into {sys.argv[2]}")
    else:
        print(f"unpacked {n} tiles into {sys.argv[2]} (held back {len(skip)} for re-render)")
