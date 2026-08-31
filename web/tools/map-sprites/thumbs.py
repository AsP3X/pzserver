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


def thumb_scale() -> float:
    """Cell diamonds are the same size everywhere, so one scale fits all thumbs."""
    left, _top, right, _bottom = cell_dzi_box(0, 0)
    return THUMB_W / max(1, right - left)


def scale_stamp(image: Image.Image, scale: float) -> Image.Image:
    w, h = image.size
    dw = max(1, round(w * scale))
    dh = max(1, round(h * scale))
    if (dw, dh) == (w, h):
        return image
    return image.resize((dw, dh), Image.Resampling.BILINEAR)


def png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    # optimize=True is a second, slower pass. County thumbs and atlas pages
    # do not need it; the extra minutes add up across thousands of cells.
    image.save(buf, format="PNG", compress_level=4, optimize=False)
    return buf.getvalue()


def render_thumb(
    records: list[tuple[int, int, int, Image.Image, int, int]],
    cx: int,
    cy: int,
    *,
    pre_scaled: bool = False,
) -> bytes | None:
    """records: (lx, ly, z, image, ox, oy) already sorted back-to-front.

    Blits in thumb space. A native-resolution canvas for a 256-square cell
    is tens of thousands of pixels on a side and would rival the JPEG pack.

    Pass `pre_scaled=True` when `image` is already `scale_stamp`'d; otherwise
    every blit resizes the native sprite (hours on a full county).
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
        stamp = image if pre_scaled else scale_stamp(image, scale)
        dx = round((ax + ox - left) * scale)
        dy = round((ay + oy - top) * scale)
        _composite(canvas, stamp, dx, dy)
    return png_bytes(canvas)


def _composite(canvas: Image.Image, stamp: Image.Image, dx: int, dy: int) -> None:
    cw, ch = canvas.size
    sw, sh = stamp.size
    if dx >= cw or dy >= ch or dx + sw <= 0 or dy + sh <= 0:
        return
    if dx >= 0 and dy >= 0 and dx + sw <= cw and dy + sh <= ch:
        canvas.alpha_composite(stamp, (dx, dy))
        return
    sx0 = 0 if dx >= 0 else -dx
    sy0 = 0 if dy >= 0 else -dy
    dx0 = max(dx, 0)
    dy0 = max(dy, 0)
    sx1 = min(sw, sx0 + cw - dx0)
    sy1 = min(sh, sy0 + ch - dy0)
    if sx1 <= sx0 or sy1 <= sy0:
        return
    canvas.alpha_composite(stamp.crop((sx0, sy0, sx1, sy1)), (dx0, dy0))
