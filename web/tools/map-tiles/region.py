"""Plan a regional re-render.

Prints two files for run.sh: the tiles to hold back (so pzmap2dzi redraws
them) and the tiles to restore from the pack (so the merges above them have
all four children to work with).

Kept separate from run.sh because the arithmetic is the part worth testing;
see test_cells.py.
"""
import sys
from pathlib import Path

from cells import Geometry, cell_rect_to_tiles, merge_inputs, parse_rects


def plan(geo: Geometry, rects, min_level: int, max_level: int):
    levels = list(range(min_level, max_level + 1))
    targets = cell_rect_to_tiles(geo, rects, levels)
    restore = merge_inputs(targets, deepest=max_level)
    return targets, restore


def write(path: Path, tiles) -> None:
    path.write_text("\n".join(f"{z}/{x}_{y}" for z, x, y in sorted(tiles)), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 6:
        print(
            "usage: region.py <map_info.json> <cells> <min_level> <max_level> <out dir>",
            file=sys.stderr,
        )
        raise SystemExit(2)

    info, cells, lo, hi, out = sys.argv[1:]
    geo = Geometry.from_map_info(Path(info))
    targets, restore = plan(geo, parse_rects(cells), int(lo), int(hi))

    out = Path(out)
    write(out / "skip.txt", targets)
    write(out / "restore.txt", restore)
    print(f"region {cells}: {len(targets)} tiles to redraw, {len(restore)} to restore as merge inputs")
