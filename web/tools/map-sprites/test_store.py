import sqlite3
from pathlib import Path

from PIL import Image

from atlas import pack
from occupancy import decode
from store import (
    bake_get,
    bake_set,
    open_work,
    open_write,
    publish_work,
    write_atlas,
    write_cell,
    write_meta,
    written_cells,
)
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


def test_work_db_resume_and_publish(tmp_path: Path):
    work = tmp_path / "sprites.sqlite.work"
    live = tmp_path / "sprites.sqlite"
    con = open_work(work)
    bake_set(con, "stage", "thumbs")
    bake_set(con, "fingerprint", "abc")
    con.commit()
    image = Image.new("RGBA", (6, 10), (10, 20, 30, 255))
    pages, packed = pack([("wall", image, -3, -10)])
    ids = write_atlas(con, [b"png"], packed)
    write_cell(con, 1, 2, [(0, 0, 0, ids["wall"])], b"thumb")
    con.commit()
    assert bake_get(con, "stage") == "thumbs"
    assert written_cells(con) == {(1, 2)}
    write_meta(con, {"generated_at": "now"})
    publish_work(con, work, live)
    assert live.is_file()
    assert not work.is_file()
    read = sqlite3.connect(live)
    assert read.execute("SELECT count(*) FROM cells").fetchone()[0] == 1
    read.close()
