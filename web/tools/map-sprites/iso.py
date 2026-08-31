"""Isometric CRS shared with web/ui/src/lib/iso-tiles.ts.

Pins and sprites must land on the same diamond. These constants are the
official viewer: do not "fix" them here.
"""

X0 = 1_040_384
Y0 = -139_296
SQR = 128
HALF = SQR // 2
QUARTER = SQR // 4
CELL = 256
# pzmap2dzi IsoDZI.LAYER_HEIGHT — DZI pixels to raise each lotpack z.
LAYER_HEIGHT = 192


def world_to_dzi(x: float, y: float) -> tuple[float, float]:
    return (x - y) * HALF + X0, (x + y) * QUARTER + Y0


def dzi_to_world(px: float, py: float) -> tuple[float, float]:
    a = (px - X0) / HALF
    b = (py - Y0) / QUARTER
    return (a + b) / 2, (b - a) / 2


def square_anchor(wx: int, wy: int, z: int = 0) -> tuple[int, int]:
    """DZI pixel of the square's bottom-centre — Texture.ox/oy origin.

    `z` lifts the square: without it, storeys and roofs sit on the ground.
    """
    top_x, top_y = world_to_dzi(wx, wy)
    return int(top_x), int(top_y) + HALF - int(z) * LAYER_HEIGHT
