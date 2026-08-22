"""Plan a regional re-render.

Prints dirty tiles (every packed ancestor of the leaf set) and the tiles to
restore from the pack (so merges above them have all four children). Callers
pass world squares; cell callers convert with `cells_as_squares` first.

Kept separate from run.sh because the arithmetic is the part worth testing;
see test_cells.py.
"""
import sys
from pathlib import Path

from cells import (
    Geometry,
    covering_cells_for_tiles,
    dirty_pyramid,
    merge_inputs,
    parse_rects,
    square_rect_to_tiles,
)


def plan(geo: Geometry, square_rects, min_level: int, max_level: int):
    """What to redraw, what to restore, which cells to render.

    `square_rects` are world squares. Cell callers convert with
    `cells_as_squares` first.
    """
    leaves = square_rect_to_tiles(geo, square_rects, [max_level])
    targets = dirty_pyramid(leaves, max_level, min_level)
    restore = merge_inputs(targets, deepest=max_level)
    render_cells = covering_cells_for_tiles(geo, leaves, max_level)
    return targets, restore, render_cells


def write(path: Path, tiles) -> None:
    path.write_text("\n".join(f"{z}/{x}_{y}" for z, x, y in sorted(tiles)), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 6:
        print(
            "usage: region.py <map_info.json> <rects> <min_level> <max_level> <out dir>",
            file=sys.stderr,
        )
        raise SystemExit(2)

    info, rects, lo, hi, out = sys.argv[1:]
    geo = Geometry.from_map_info(Path(info))
    targets, restore, render_cells = plan(geo, parse_rects(rects), int(lo), int(hi))

    out = Path(out)
    write(out / "dirty.txt", targets)
    write(out / "restore.txt", restore)
    spec = ";".join(f"{x},{y},{w},{h}" for x, y, w, h in render_cells)
    (out / "render_cells.txt").write_text(spec, encoding="utf-8")

    print(
        f"region {rects}: widened to cells {spec} to cover whole tiles; "
        f"{len(targets)} dirty tiles, {len(restore)} to restore as merge inputs"
    )
