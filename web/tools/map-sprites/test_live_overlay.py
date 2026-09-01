from live_overlay import OccupancyIndex, decode, encode, patch_object
from occupancy import encode as encode_occupancy
from store import open_write, write_atlas, write_cell
from atlas import PackedSprite

from PIL import Image


def test_round_trip_empty():
    blob = encode(1700000000, [])
    mtime, rows = decode(blob)
    assert mtime == 1700000000
    assert rows == []


def test_round_trip_patches():
    blob = encode(42, [(7140, 9636, 0, 12, 0), (7141, 9636, 1, 8, 9)])
    mtime, rows = decode(blob)
    assert mtime == 42
    assert rows == [(7140, 9636, 0, 12, 0), (7141, 9636, 1, 8, 9)]


def test_occupancy_index_finds_door_on_square(tmp_path):
    con = open_write(tmp_path / "sprites.sqlite")
    red = Image.new("RGBA", (8, 8), (255, 0, 0, 255))
    packed = PackedSprite("fixtures_doors_01_0", 0, 1, 1, 8, 8, -4, -8)
    ids = write_atlas(con, [b"png"], [packed])
    door_id = ids["fixtures_doors_01_0"]
    write_cell(con, 27, 37, [(100, 164, 0, door_id)], None)
    con.commit()
    index = OccupancyIndex(con)
    wx, wy = 27 * 256 + 100, 37 * 256 + 164
    found = index.sprites_at(wx, wy, 0)
    assert found == [(door_id, "fixtures_doors_01_0")]
    con.close()
