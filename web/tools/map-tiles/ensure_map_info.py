"""Write map_info.json for a regional job when the scratch tree is gone.

The packer stores JPEG tiles and deletes them. It leaves map_info.json beside
the empty layer dirs, but `/out` is a host bind that operators wipe. The live
pack is on a named volume and still has the pyramid. Geometry is the same
constants verify.py / ISO_DZI already gate on — reconstruct rather than
demand a full county rerender.
"""
import json
import sqlite3
import sys
from pathlib import Path

from verify import CELL_RECTS, EXACT

# Full county pack uses omit_levels: 2. w/h must match what pzmap2dzi
# computes from the game files (slightly smaller than ISO_DZI), or it
# aborts with "map_info mismatch" rather than mixing pyramids.
DEFAULT_SKIP = 2
PZMAP_SKIP2_W = 579616
PZMAP_SKIP2_H = 253944


def canonical(skip: int = DEFAULT_SKIP) -> dict:
    scale = 2 ** (DEFAULT_SKIP - skip)
    return {
        "x0": EXACT["x0"],
        "y0": EXACT["y0"],
        "sqr": EXACT["sqr"],
        "cell_size": 256,
        "tile_size": 2048,
        "skip": skip,
        "w": PZMAP_SKIP2_W * scale,
        "h": PZMAP_SKIP2_H * scale,
        "cell_rects": [list(r) for r in CELL_RECTS],
    }


def from_pack(pack: Path) -> dict | None:
    if not pack.is_file():
        return None
    try:
        con = sqlite3.connect(f"file:{pack}?mode=ro", uri=True)
        row = con.execute(
            "SELECT value FROM meta WHERE key = 'map_info'"
        ).fetchone()
        con.close()
    except sqlite3.Error:
        return None
    if not row:
        return None
    try:
        info = json.loads(row[0])
    except json.JSONDecodeError:
        return None
    if not isinstance(info, dict) or "x0" not in info:
        return None
    return info


def ensure(dest: Path, pack: Path | None = None) -> str:
    if dest.is_file():
        return "kept"
    info = from_pack(pack) if pack is not None else None
    source = "pack" if info is not None else "canonical"
    if info is None:
        info = canonical()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(info, indent=1) + "\n", encoding="utf-8")
    return source


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        print("usage: ensure_map_info.py <map_info.json> [tiles.sqlite]", file=sys.stderr)
        raise SystemExit(2)
    dest = Path(sys.argv[1])
    pack = Path(sys.argv[2]) if len(sys.argv) == 3 else None
    how = ensure(dest, pack)
    print(f"map_info.json {how} at {dest}")
