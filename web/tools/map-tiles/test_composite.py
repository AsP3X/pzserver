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


def test_punch_clears_vanilla_inside_a_save_chunk():
    """Open-door sprites are mostly transparent. Without a punch the closed
    vanilla door stays visible through the hole."""
    from cells import Geometry
    from composite import punch_save_footprint, square_diamond

    geo = Geometry(x0=1_040_384, y0=-139_296, sqr=128, cell_size=256)
    wx, wy = 34 * 256, 30 * 256
    z = 20
    span = geo.span(z)
    px, py = geo.world_to_dzi(wx + 4, wy + 4)
    tx, ty = int(px // span), int(py // span)
    pts = square_diamond(geo, wx, wy, 8, 8, z, tx, ty)
    cx = int(sum(p[0] for p in pts) / 4)
    cy = int(sum(p[1] for p in pts) / 4)
    size = geo.tile_size
    assert 0 <= cx < size and 0 <= cy < size

    base = Image.new("RGBA", (size, size), (255, 0, 0, 255))
    punch_save_footprint(base, (geo, [(wx, wy, 8, 8)]), z, tx, ty)
    assert base.getpixel((cx, cy))[3] == 0
    far_x = 0 if cx > size // 2 else size - 1
    far_y = 0 if cy > size // 2 else size - 1
    assert base.getpixel((far_x, far_y))[0] == 255
