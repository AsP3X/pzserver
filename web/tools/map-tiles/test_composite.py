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


def test_a_tall_sprite_survives_whole(tmp_path):
    """A PZ sprite is anchored bottom-centre and stands about three diamond
    heights above the square it sits on. Clipping the overlay to that square's
    ground diamond -- which is what the old punch/mask did -- kept the doorstep
    and threw the door away."""
    dirty = tmp_path / "dirty.txt"
    dirty.write_text("20/1_2\n", encoding="utf-8")
    base_dir = tmp_path / "base"
    save_dir = tmp_path / "save"
    (base_dir / "20").mkdir(parents=True)
    (save_dir / "20").mkdir(parents=True)
    Image.new("RGB", (128, 128), (255, 0, 0)).save(base_dir / "20" / "1_2.jpg", quality=95)

    # Ground diamond is the bottom strip; the sprite towers over it.
    overlay = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    for x in range(48, 80):
        for y in range(16, 112):
            overlay.putpixel((x, y), (0, 255, 0, 255))
    overlay.save(save_dir / "20" / "1_2.png")

    assert composite(dirty, base_dir, save_dir) == 1
    out = Image.open(base_dir / "20" / "1_2.jpg").convert("RGB")
    assert out.getpixel((64, 24))[1] > 200, "top of the sprite was clipped away"
    assert out.getpixel((64, 100))[1] > 200, "bottom of the sprite is missing"
    assert out.getpixel((8, 8))[0] > 200, "vanilla outside the sprite was punched"


def test_a_transparent_overlay_leaves_vanilla_alone(tmp_path):
    """The save layer is sparse -- a B42 chunk stores doors and containers, not
    the lotpack. Where it has nothing, the town must come through untouched."""
    dirty = tmp_path / "dirty.txt"
    dirty.write_text("20/1_2\n", encoding="utf-8")
    base_dir = tmp_path / "base"
    save_dir = tmp_path / "save"
    (base_dir / "20").mkdir(parents=True)
    (save_dir / "20").mkdir(parents=True)
    Image.new("RGB", (64, 64), (12, 200, 40)).save(base_dir / "20" / "1_2.jpg", quality=95)
    Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(save_dir / "20" / "1_2.png")

    assert composite(dirty, base_dir, save_dir) == 1
    out = Image.open(base_dir / "20" / "1_2.jpg").convert("RGB")
    assert out.getpixel((32, 32))[1] > 150


def test_empty_dirty_composites_every_overlay_tile(tmp_path):
    """A full county rebuild has no dirty.txt. Composite every save PNG."""
    dirty = tmp_path / "dirty.txt"
    dirty.write_text("", encoding="utf-8")
    base_dir = tmp_path / "base"
    save_dir = tmp_path / "save"
    (base_dir / "20").mkdir(parents=True)
    (save_dir / "20").mkdir(parents=True)
    Image.new("RGB", (64, 64), (255, 0, 0)).save(
        base_dir / "20" / "1_2.jpg", quality=95
    )
    overlay = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for x in range(16):
        for y in range(16):
            overlay.putpixel((x, y), (0, 255, 0, 255))
    overlay.save(save_dir / "20" / "1_2.png")

    assert composite(dirty, base_dir, save_dir) == 1
    out = Image.open(base_dir / "20" / "1_2.jpg").convert("RGB")
    assert out.getpixel((8, 8))[1] > 200


def _stamp(path: Path, rgb: tuple[int, int, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".jpg":
        Image.new("RGB", (64, 64), rgb).save(path, quality=95)
        return
    overlay = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for x in range(16):
        for y in range(16):
            overlay.putpixel((x, y), (*rgb, 255))
    overlay.save(path)


def test_planned_keys_that_miss_the_overlay_still_composite_where_it_landed(
    tmp_path,
):
    """A region job's leaves are the cell AABB. Save sprites often land a
    couple of DZI tiles away, so compositing *only* the leaves reports 0 and
    the run aborts after skip already punched the vanilla doors."""
    from composite import covers_keys

    dirty = tmp_path / "leaves.txt"
    dirty.write_text("20/131_61\n20/132_61\n", encoding="utf-8")
    base_dir = tmp_path / "base"
    save_dir = tmp_path / "save"
    _stamp(base_dir / "20" / "131_61.jpg", (255, 0, 0))
    _stamp(base_dir / "20" / "129_64.jpg", (255, 0, 0))
    _stamp(save_dir / "20" / "129_64.png", (0, 255, 0))

    assert not covers_keys([(20, 131, 61), (20, 132, 61)], save_dir)
    from composite import extra_overlay_lines

    assert extra_overlay_lines(dirty, save_dir) == ["20/129_64"]
    assert composite(dirty, base_dir, save_dir) == 1
    out = Image.open(base_dir / "20" / "129_64.jpg").convert("RGB")
    assert out.getpixel((8, 8))[1] > 200
    red = Image.open(base_dir / "20" / "131_61.jpg").convert("RGB")
    assert red.getpixel((8, 8))[0] > 200
