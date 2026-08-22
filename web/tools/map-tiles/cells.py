"""Which pyramid tiles a range of map cells lands on.

A regional re-render has to delete exactly the tiles covering the region it is
about to redraw, or pzmap2dzi sees them already on disk and skips the work.
Getting this wrong is quiet: too few tiles deleted and the region does not
actually update, too many and the render takes longer than it needed to.

The projection is the same one the client uses in
web/ui/src/lib/iso-tiles.ts -- worldToDzi() -- and it must stay that way. See
verify.py, which gates the render on the same constants.
"""
import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Geometry:
    """The pyramid's placement, as `map_info.json` reports it."""

    x0: int
    y0: int
    sqr: int
    cell_size: int
    tile_size: int = 2048
    max_level: int = 22

    @classmethod
    def from_map_info(cls, path: Path, **overrides) -> "Geometry":
        info = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(
            x0=info["x0"],
            y0=info["y0"],
            sqr=info["sqr"],
            cell_size=info.get("cell_size", 256),
            **overrides,
        )

    def world_to_dzi(self, x: float, y: float) -> tuple[float, float]:
        half, quarter = self.sqr / 2, self.sqr / 4
        return (x - y) * half + self.x0, (x + y) * quarter + self.y0

    def square_rect_bounds(self, x: float, y: float, w: float, h: float) -> tuple[float, float, float, float]:
        """DZI bounding box of a rectangle of world squares (pin coords)."""
        x_hi, y_hi = x + w, y + h
        corners = [
            self.world_to_dzi(x, y),
            self.world_to_dzi(x_hi, y),
            self.world_to_dzi(x, y_hi),
            self.world_to_dzi(x_hi, y_hi),
        ]
        xs = [p[0] for p in corners]
        ys = [p[1] for p in corners]
        return min(xs), min(ys), max(xs), max(ys)

    def cell_rect_bounds(self, cx: int, cy: int, w: int, h: int) -> tuple[float, float, float, float]:
        """DZI bounding box of a rectangle of cells.

        Iso rotates the square, so the box comes from all four corners rather
        than just two -- taking the diagonal alone loses half the width.
        """
        return self.square_rect_bounds(
            cx * self.cell_size, cy * self.cell_size, w * self.cell_size, h * self.cell_size
        )

    def span(self, level: int) -> int:
        """Full-resolution DZI pixels one tile covers at this level."""
        return self.tile_size * 2 ** (self.max_level - level)


def cells_as_squares(geo: Geometry, rects) -> list:
    """Cell `x,y,w,h` → square box `x*cell, y*cell, w*cell, h*cell`."""
    s = geo.cell_size
    return [(cx * s, cy * s, w * s, h * s) for cx, cy, w, h in rects]


def square_rect_to_tiles(geo: Geometry, rects, levels) -> set:
    """Every `(level, x, y)` tile touched by any world-square rect."""
    tiles = set()
    for x, y, w, h in rects:
        lo_x, lo_y, hi_x, hi_y = geo.square_rect_bounds(x, y, w, h)
        for level in levels:
            span = geo.span(level)
            for tx in range(int(lo_x // span), int(hi_x // span) + 1):
                for ty in range(int(lo_y // span), int(hi_y // span) + 1):
                    if tx >= 0 and ty >= 0:
                        tiles.add((level, tx, ty))
    return tiles


def cell_rect_to_tiles(geo: Geometry, rects, levels) -> set:
    return square_rect_to_tiles(geo, cells_as_squares(geo, rects), levels)


def parse_rects(text: str) -> list:
    """`"34,30,4,4;40,10"` -> `[(34, 30, 4, 4), (40, 10, 1, 1)]`."""
    rects = []
    for chunk in text.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = [int(p) for p in chunk.split(",")]
        if len(parts) == 2:
            parts += [1, 1]
        if len(parts) != 4:
            raise ValueError(f"cell rect must be x,y or x,y,w,h -- got {chunk!r}")
        rects.append(tuple(parts))
    return rects


def merge_inputs(targets: set, deepest: int) -> set:
    """Tiles that must be on disk for `targets` to be merged correctly.

    Each parent is built from its four children, so every target above the
    deepest level needs its children present -- except the children that are
    themselves targets, which the render is about to redraw.
    """
    needed = set()
    for z, x, y in targets:
        if z >= deepest:
            continue
        for dx in (0, 1):
            for dy in (0, 1):
                needed.add((z + 1, x * 2 + dx, y * 2 + dy))
    return needed - set(targets)


def dzi_to_world(geo: Geometry, px: float, py: float) -> tuple[float, float]:
    """Inverse of `world_to_dzi`. Matches dziToWorld() in the client."""
    a = (px - geo.x0) / (geo.sqr / 2)
    b = (py - geo.y0) / (geo.sqr / 4)
    return (a + b) / 2, (b - a) / 2


def dirty_pyramid(leaves: set, max_level: int, min_level: int) -> set:
    """Leaves at max_level plus every parent down to min_level."""
    dirty = set()
    for z, x, y in leaves:
        cz, cx, cy = z, x, y
        while cz >= min_level:
            dirty.add((cz, cx, cy))
            cz -= 1
            cx >>= 1
            cy >>= 1
    return dirty


def covering_cells_for_tiles(geo: Geometry, tiles, level: int) -> list:
    """Cell box that fully covers every tile's footprint at `level`."""
    if not tiles:
        return []

    import math

    span = geo.span(level)
    cells_x, cells_y = [], []
    for _, tx, ty in tiles:
        for px in (tx * span, (tx + 1) * span):
            for py in (ty * span, (ty + 1) * span):
                wx, wy = dzi_to_world(geo, px, py)
                cells_x.append(wx / geo.cell_size)
                cells_y.append(wy / geo.cell_size)

    lo_x = max(0, math.floor(min(cells_x)))
    hi_x = math.ceil(max(cells_x))
    lo_y = max(0, math.floor(min(cells_y)))
    hi_y = math.ceil(max(cells_y))
    return [(lo_x, lo_y, hi_x - lo_x, hi_y - lo_y)]


def expand_to_whole_tiles(geo: Geometry, rects, level: int) -> list:
    """Widen a cell request until it covers every tile it touches, entirely.

    `render_cell_range` paints only the cells it is given. A tile that
    straddles the edge of the request therefore comes back with the requested
    part drawn and the rest black -- trading one hole for a bigger one. Asking
    for the whole of every affected tile is what keeps a regional re-render
    from damaging its own edges.

    Iso rotates the square, so a tile's axis-aligned pixel rect maps to a
    diamond in world space; the cell box around it is wider than strictly
    needed. Rendering a few extra cells is cheap, and getting this wrong is not.
    """
    tiles = cell_rect_to_tiles(geo, rects, [level])
    if not tiles:
        return list(rects)
    return covering_cells_for_tiles(geo, tiles, level)
