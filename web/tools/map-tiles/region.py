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
    cell_rect_to_tiles,
    covering_cells_for_tiles,
    dirty_pyramid,
    merge_inputs,
    parse_rects,
    square_rect_to_tiles,
)


def cover_each(geo: Geometry, square_rects, level: int) -> list:
    """One cell box per input rect.

    `covering_cells_for_tiles` is a single AABB. Two towns would otherwise
    become one rectangle of forest between them.
    """
    boxes = []
    for rect in square_rects:
        leaves = square_rect_to_tiles(geo, [rect], [level])
        boxes.extend(covering_cells_for_tiles(geo, leaves, level))
    return boxes


def plan(geo: Geometry, square_rects, min_level: int, max_level: int):
    """What to redraw, what to restore, which cells to render.

    `square_rects` are world squares. Cell callers convert with
    `cells_as_squares` first.
    """
    render_cells = cover_each(geo, square_rects, max_level)
    leaves = (
        cell_rect_to_tiles(geo, render_cells, [max_level])
        if render_cells
        else square_rect_to_tiles(geo, square_rects, [max_level])
    )
    targets = dirty_pyramid(leaves, max_level, min_level)
    restore = merge_inputs(targets, deepest=max_level)
    return targets, restore, render_cells


def plan_detail(geo: Geometry, square_rects, detail_level: int):
    """Fill one deeper level and leave the packed pyramid on disk alone.

    Restores every ancestor so pzmap2dzi treats z20…0 as done and only paints
    the missing z21 files. Pack `--only` the detail keys. A full county of
    z21 is tens of GB; this is how it lands a cell at a time.
    """
    render_cells = cover_each(geo, square_rects, detail_level)
    targets = (
        cell_rect_to_tiles(geo, render_cells, [detail_level])
        if render_cells
        else square_rect_to_tiles(geo, square_rects, [detail_level])
    )
    restore = dirty_pyramid(targets, detail_level, 0) - targets
    return targets, restore, render_cells


def write(path: Path, tiles) -> None:
    path.write_text("\n".join(f"{z}/{x}_{y}" for z, x, y in sorted(tiles)), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) not in (6, 7) or (len(sys.argv) == 7 and sys.argv[6] != "--detail-only"):
        print(
            "usage: region.py <map_info.json> <rects> <min_level> <max_level> <out dir> [--detail-only]",
            file=sys.stderr,
        )
        raise SystemExit(2)

    info, rects, lo, hi, out = sys.argv[1:6]
    geo = Geometry.from_map_info(Path(info))
    if len(sys.argv) == 7:
        targets, restore, render_cells = plan_detail(geo, parse_rects(rects), int(hi))
    else:
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
