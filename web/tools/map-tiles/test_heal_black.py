from pathlib import Path

import pytest

pil = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from heal_black import heal
from pack import pack


def test_heal_replaces_a_black_ancestor_from_the_pristine_pack(tmp_path):
    pristine_tree = tmp_path / "orig"
    (pristine_tree / "15").mkdir(parents=True)
    Image.new("RGB", (16, 16), (0, 160, 0)).save(pristine_tree / "15" / "4_1.jpg", quality=95)
    db = tmp_path / "pristine.sqlite"
    pack(pristine_tree, db, {})

    live = tmp_path / "live"
    (live / "15").mkdir(parents=True)
    Image.new("RGB", (16, 16), (0, 0, 0)).save(live / "15" / "4_1.jpg", quality=95)

    assert heal([(15, 4, 1)], live, db) == 1
    out = Image.open(live / "15" / "4_1.jpg").convert("RGB")
    assert out.getpixel((8, 8))[1] > 100


def test_heal_leaves_a_painted_tile_alone(tmp_path):
    tree = tmp_path / "orig"
    (tree / "15").mkdir(parents=True)
    Image.new("RGB", (16, 16), (0, 160, 0)).save(tree / "15" / "4_1.jpg", quality=95)
    db = tmp_path / "pristine.sqlite"
    pack(tree, db, {})

    live = tmp_path / "live"
    (live / "15").mkdir(parents=True)
    Image.new("RGB", (16, 16), (40, 80, 200)).save(live / "15" / "4_1.jpg", quality=95)

    assert heal([(15, 4, 1)], live, db) == 0
    out = Image.open(live / "15" / "4_1.jpg").convert("RGB")
    assert out.getpixel((8, 8))[2] > 150
