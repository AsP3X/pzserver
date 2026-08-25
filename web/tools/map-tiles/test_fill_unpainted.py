from pathlib import Path

import pytest

pil = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from fill_unpainted import fill, fill_one, mostly_black


def test_black_corners_come_back_from_the_underlay(tmp_path):
    new_dir = tmp_path / "new"
    old_dir = tmp_path / "old"
    (new_dir / "20").mkdir(parents=True)
    (old_dir / "20").mkdir(parents=True)
    # Underlay is green terrain. New paint is a red diamond-ish block in the
    # middle; corners stay JPEG-black.
    old = Image.new("RGB", (64, 64), (0, 180, 0))
    old.save(old_dir / "20" / "1_2.jpg", quality=95)
    new = Image.new("RGB", (64, 64), (0, 0, 0))
    for x in range(16, 48):
        for y in range(16, 48):
            new.putpixel((x, y), (200, 40, 40))
    new.save(new_dir / "20" / "1_2.jpg", quality=95)

    assert fill([(20, 1, 2)], new_dir, old_dir) == 1
    out = Image.open(new_dir / "20" / "1_2.jpg").convert("RGB")
    # Painted interior stays the new red.
    r, g, b = out.getpixel((32, 32))
    assert r > 150 and g < 80
    # Unpainted corner is the underlay green, not black.
    r, g, b = out.getpixel((2, 2))
    assert g > 100 and r < 80


def test_mostly_black_detects_the_unpainted_jpeg_frame(tmp_path):
    black = tmp_path / "black.jpg"
    green = tmp_path / "green.jpg"
    Image.new("RGB", (32, 32), (0, 0, 0)).save(black, quality=95)
    Image.new("RGB", (32, 32), (0, 180, 0)).save(green, quality=95)
    mixed = tmp_path / "mixed.jpg"
    im = Image.new("RGB", (32, 32), (0, 0, 0))
    for x in range(16, 32):
        for y in range(16, 32):
            im.putpixel((x, y), (0, 180, 0))
    im.save(mixed, quality=95)
    assert mostly_black(black) is True
    assert mostly_black(green) is False
    # 75% black is the DZI-tile frame; 15% is the gate.
    assert mostly_black(mixed) is True


def test_open_door_holes_are_not_filled_from_the_closed_underlay(tmp_path):
    """Skip/punch leaves a black diamond so the overlay can own it. Pasting
    the underlay there puts the closed door back."""
    from cells import Geometry
    from composite import square_diamond

    geo = Geometry(x0=1_040_384, y0=-139_296, sqr=128, cell_size=256)
    wx, wy = 34 * 256 + 4, 30 * 256 + 4
    z = 20
    span = geo.span(z)
    px, py = geo.world_to_dzi(wx, wy)
    tx, ty = int(px // span), int(py // span)
    pts = square_diamond(geo, wx, wy, 1, 1, z, tx, ty)
    cx = int(sum(p[0] for p in pts) / 4)
    cy = int(sum(p[1] for p in pts) / 4)
    size = geo.tile_size
    new_dir = tmp_path / "new"
    old_dir = tmp_path / "old"
    (new_dir / "20").mkdir(parents=True)
    (old_dir / "20").mkdir(parents=True)
    Image.new("RGB", (size, size), (0, 180, 0)).save(old_dir / "20" / f"{tx}_{ty}.jpg", quality=95)
    Image.new("RGB", (size, size), (0, 0, 0)).save(new_dir / "20" / f"{tx}_{ty}.jpg", quality=95)

    punch = (geo, [(wx, wy, 1, 1)])
    assert fill([(z, tx, ty)], new_dir, old_dir, punch=punch) == 1
    out = Image.open(new_dir / "20" / f"{tx}_{ty}.jpg").convert("RGB")
    ix, iy = min(size - 1, max(0, cx)), min(size - 1, max(0, cy))
    r, g, b = out.getpixel((ix, iy))
    assert r < 30 and g < 30, (r, g, b, cx, cy)
    far_x = 0 if cx > size // 2 else size - 1
    far_y = 0 if cy > size // 2 else size - 1
    assert out.getpixel((far_x, far_y))[1] > 100


def test_missing_underlay_is_a_no_op(tmp_path):
    new_dir = tmp_path / "new"
    (new_dir / "20").mkdir(parents=True)
    Image.new("RGB", (8, 8), (0, 0, 0)).save(new_dir / "20" / "1_2.jpg")
    assert fill_one(new_dir / "20" / "1_2.jpg", tmp_path / "nope.jpg") is False
