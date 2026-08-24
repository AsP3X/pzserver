from pathlib import Path

import pytest

from composite import overlay_path, parse_dirty

pil = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from composite import composite  # noqa: E402


def test_parse_dirty_keys():
    assert parse_dirty("20/134_59\n21/268_118\n") == [(20, 134, 59), (21, 268, 118)]


def test_overlay_prefers_png(tmp_path):
    z = tmp_path / "21"
    z.mkdir()
    (z / "1_2.webp").write_bytes(b"w")
    (z / "1_2.png").write_bytes(b"p")
    assert overlay_path(tmp_path, 21, 1, 2).name == "1_2.png"


def test_save_pixels_cover_the_base(tmp_path):
    dirty = tmp_path / "dirty.txt"
    dirty.write_text("20/1_2\n", encoding="utf-8")
    base_dir = tmp_path / "base"
    save_dir = tmp_path / "save"
    (base_dir / "20").mkdir(parents=True)
    (save_dir / "20").mkdir(parents=True)
    # JPEG chroma subsampling wrecks a 1×1 stamp; a block survives quality 70.
    Image.new("RGB", (64, 64), (255, 0, 0)).save(base_dir / "20" / "1_2.jpg", quality=95)
    overlay = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for x in range(16):
        for y in range(16):
            overlay.putpixel((x, y), (0, 255, 0, 255))
    overlay.save(save_dir / "20" / "1_2.png")

    assert composite(dirty, base_dir, save_dir) == 1
    out = Image.open(base_dir / "20" / "1_2.jpg").convert("RGB")
    assert out.getpixel((8, 8))[1] > 200
    assert out.getpixel((48, 48))[0] > 200
