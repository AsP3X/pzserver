from pathlib import Path

from PIL import Image

from atlas import pack
from occupancy import decode
from store import open_write, write_atlas, write_cell, write_meta
from thumbs import render_thumb


def test_store_round_trip(tmp_path: Path):
    image = Image.new("RGBA", (6, 10), (10, 20, 30, 255))
    pages, packed = pack([("wall", image, -3, -10)])
    con = open_write(tmp_path / "sprites.sqlite")
    ids = write_atlas(con, [b"png"], packed)
    records = [(4, 5, 0, ids["wall"])]
    thumb = render_thumb([(4, 5, 0, image, -3, -10)], 0, 0)
    write_cell(con, 0, 0, records, thumb)
    write_meta(con, {"generated_at": "now", "z_min": "0", "z_max": "1"})
    con.commit()

    sprite_id, name = con.execute("SELECT id, name FROM sprites").fetchone()
    assert name == "wall"
    blob, = con.execute("SELECT occupancy FROM cells WHERE cx=0 AND cy=0").fetchone()
    assert decode(blob) == [(4, 5, 0, sprite_id)]
    stored = con.execute("SELECT data FROM thumbs WHERE cx=0 AND cy=0").fetchone()
    assert stored is not None
    assert len(stored[0]) > 0
    con.close()
