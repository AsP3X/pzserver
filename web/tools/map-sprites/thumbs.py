"""One isometric thumbnail per cell, baked from the same sprites as live blit."""

from __future__ import annotations

import io

from PIL import Image

from iso import CELL, HALF, square_anchor, world_to_dzi

THUMB_W = 512


def cell_dzi_box(cx: int, cy: int) -> tuple[int, int, int, int]:
    x0, y0 = cx * CELL, cy * CELL
    corners = [
        world_to_dzi(x0, y0),
        world_to_dzi(x0 + CELL, y0),
        world_to_dzi(x0, y0 + CELL),
        world_to_dzi(x0 + CELL, y0 + CELL),
    ]
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    # Sprites extend above the diamond; pad a storey of jumbo trees.
    pad = HALF * 24
    return (
        int(min(xs) - pad),
        int(min(ys) - pad),
        int(max(xs) + pad),
        int(max(ys) + pad),
    )


def render_thumb(
    records: list[tuple[int, int, int, Image.Image, int, int]],
    cx: int,
    cy: int,
) -> bytes | None:
    """records: (lx, ly, z, image, ox, oy) already sorted back-to-front.

    Blits in thumb space. A native-resolution canvas for a 256-square cell
    is tens of thousands of pixels on a side and would rival the JPEG pack.
    """
    if not records:
        return None
    left, top, right, bottom = cell_dzi_box(cx, cy)
    width = max(1, right - left)
    height = max(1, bottom - top)
    scale = THUMB_W / width
    out_w = THUMB_W
    out_h = max(1, int(height * scale))
    canvas = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
    origin_x = cx * CELL
    origin_y = cy * CELL
    for lx, ly, _z, image, ox, oy in records:
        ax, ay = square_anchor(origin_x + lx, origin_y + ly)
        w, h = image.size
        dw = max(1, round(w * scale))
        dh = max(1, round(h * scale))
        stamp = image.resize((dw, dh), Image.Resampling.BILINEAR)
        dx = round((ax + ox - left) * scale)
        dy = round((ay + oy - top) * scale)
        canvas.alpha_composite(stamp, (dx, dy))
    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
