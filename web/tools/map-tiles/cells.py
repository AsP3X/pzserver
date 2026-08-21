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

    def cell_rect_bounds(self, cx: int, cy: int, w: int, h: int) -> tuple[float, float, float, float]:
        """DZI bounding box of a rectangle of cells.

        Iso rotates the square, so the box comes from all four corners rather
        than just two -- taking the diagonal alone loses half the width.
        """
        x_lo, y_lo = cx * self.cell_size, cy * self.cell_size
        x_hi, y_hi = (cx + w) * self.cell_size, (cy + h) * self.cell_size
        corners = [
            self.world_to_dzi(x_lo, y_lo),
            self.world_to_dzi(x_hi, y_lo),
            self.world_to_dzi(x_lo, y_hi),
            self.world_to_dzi(x_hi, y_hi),
        ]
        xs = [p[0] for p in corners]
        ys = [p[1] for p in corners]
        return min(xs), min(ys), max(xs), max(ys)

    def span(self, level: int) -> int:
        """Full-resolution DZI pixels one tile covers at this level."""
        return self.tile_size * 2 ** (self.max_level - level)


def cell_rect_to_tiles(geo: Geometry, rects, levels) -> set:
    """Every `(level, x, y)` tile touched by any of `rects`."""
    tiles = set()
    for cx, cy, w, h in rects:
        lo_x, lo_y, hi_x, hi_y = geo.cell_rect_bounds(cx, cy, w, h)
        for level in levels:
            span = geo.span(level)
            for tx in range(int(lo_x // span), int(hi_x // span) + 1):
                for ty in range(int(lo_y // span), int(hi_y // span) + 1):
                    if tx >= 0 and ty >= 0:
                        tiles.add((level, tx, ty))
    return tiles


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
