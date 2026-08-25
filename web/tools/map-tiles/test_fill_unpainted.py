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


def test_missing_underlay_is_a_no_op(tmp_path):
    new_dir = tmp_path / "new"
    (new_dir / "20").mkdir(parents=True)
    Image.new("RGB", (8, 8), (0, 0, 0)).save(new_dir / "20" / "1_2.jpg")
    assert fill_one(new_dir / "20" / "1_2.jpg", tmp_path / "nope.jpg") is False
