from pathlib import Path

import pytest

pil = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from rebuild_pyramid import merge_parent, rebuild


def _tile(path: Path, colour, size=32):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (size, size), colour).save(path, quality=95)


def test_parent_is_the_four_children_downsampled(tmp_path):
    tiles = tmp_path / "layer0_files"
    # Children of (19, 4, 6) live at z20: (8,12) (9,12) (8,13) (9,13)
    _tile(tiles / "20" / "8_12.jpg", (255, 0, 0))
    _tile(tiles / "20" / "9_12.jpg", (0, 255, 0))
    _tile(tiles / "20" / "8_13.jpg", (0, 0, 255))
    _tile(tiles / "20" / "9_13.jpg", (255, 255, 0))

    assert merge_parent(tiles, 19, 4, 6, tile_size=32)
    out = Image.open(tiles / "19" / "4_6.jpg").convert("RGB")
    assert out.size == (32, 32)
    # Quadrant colours survive the downsample.
    assert out.getpixel((8, 8))[0] > 200          # red, top-left (dx=0, dy=0)
    assert out.getpixel((24, 8))[1] > 200         # green, top-right
    assert out.getpixel((8, 24))[2] > 200         # blue, bottom-left
    assert out.getpixel((24, 24))[0] > 200        # yellow, bottom-right


def test_missing_child_leaves_the_restored_parent_alone(tmp_path):
    tiles = tmp_path / "layer0_files"
    _tile(tiles / "19" / "4_6.jpg", (10, 10, 10))
    _tile(tiles / "20" / "8_12.jpg", (255, 0, 0))
    # three siblings missing
    assert merge_parent(tiles, 19, 4, 6, tile_size=32) is False
    assert Image.open(tiles / "19" / "4_6.jpg").getpixel((0, 0)) == (10, 10, 10)


def test_child_boundary_does_not_ring(tmp_path):
    """LANCZOS overshoots a hard edge; BOX must not invent a brighter line."""
    tiles = tmp_path / "layer0_files"
    dark = (40, 40, 40)
    light = (200, 200, 200)
    _tile(tiles / "20" / "8_12.jpg", dark)
    _tile(tiles / "20" / "9_12.jpg", light)
    _tile(tiles / "20" / "8_13.jpg", dark)
    _tile(tiles / "20" / "9_13.jpg", light)
    assert merge_parent(tiles, 19, 4, 6, tile_size=32)
    out = Image.open(tiles / "19" / "4_6.jpg").convert("RGB")
    pixels = [out.getpixel((x, y))[0] for y in range(32) for x in range(32)]
    assert max(pixels) <= light[0] + 8
    assert min(pixels) >= dark[0] - 8


def test_rebuild_walks_deepest_first(tmp_path):
    tiles = tmp_path / "layer0_files"
    # Two levels: z20 children → z19, then that z19 plus cousins → z18.
    for dx, dy, colour in [
        (0, 0, (255, 0, 0)),
        (1, 0, (0, 255, 0)),
        (0, 1, (0, 0, 255)),
        (1, 1, (255, 255, 0)),
    ]:
        _tile(tiles / "20" / f"{8 + dx}_{12 + dy}.jpg", colour)
    # Cousin z19 tiles the z18 parent also needs.
    _tile(tiles / "19" / "5_6.jpg", (20, 20, 20))
    _tile(tiles / "19" / "4_7.jpg", (30, 30, 30))
    _tile(tiles / "19" / "5_7.jpg", (40, 40, 40))

    n = rebuild([(18, 2, 3), (19, 4, 6)], tiles, tile_size=32)
    assert n == 2
    assert (tiles / "19" / "4_6.jpg").is_file()
    assert (tiles / "18" / "2_3.jpg").is_file()
