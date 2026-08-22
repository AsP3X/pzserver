import io
import sqlite3

import pytest

pytest.importorskip("PIL")
from PIL import Image

from recompress import recompress


def _jpeg(size: int, quality: int) -> bytes:
    image = Image.new("RGB", (size, size), (40, 80, 30))
    for x in range(0, size, 8):
        for y in range(0, size, 8):
            image.putpixel((x, y), (200, 30, 30))
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def test_recompress_shrinks_a_high_quality_tile(tmp_path):
    db = tmp_path / "tiles.sqlite"
    fat = _jpeg(256, 95)
    con = sqlite3.connect(db)
    con.executescript(
        """CREATE TABLE tiles (z INTEGER, x INTEGER, y INTEGER, data BLOB NOT NULL,
               PRIMARY KEY (z, x, y)) WITHOUT ROWID;"""
    )
    con.execute("INSERT INTO tiles VALUES (20, 1, 2, ?)", (fat,))
    con.commit()
    con.close()

    updated, skipped, saved = recompress(db, quality=40)

    assert updated == 1
    assert skipped == 0
    assert saved > 0
    con = sqlite3.connect(db)
    thin = con.execute("SELECT data FROM tiles WHERE z=20").fetchone()[0]
    assert len(thin) < len(fat)


def test_recompress_skips_non_jpeg_blobs(tmp_path):
    db = tmp_path / "tiles.sqlite"
    con = sqlite3.connect(db)
    con.executescript(
        """CREATE TABLE tiles (z INTEGER, x INTEGER, y INTEGER, data BLOB NOT NULL,
               PRIMARY KEY (z, x, y)) WITHOUT ROWID;"""
    )
    con.execute("INSERT INTO tiles VALUES (8, 0, 0, ?)", (b"not-a-jpeg",))
    con.commit()
    con.close()

    updated, skipped, saved = recompress(db, quality=40)

    assert updated == 0
    assert skipped == 1
    assert saved == 0
    con = sqlite3.connect(db)
    assert con.execute("SELECT data FROM tiles").fetchone()[0] == b"not-a-jpeg"
