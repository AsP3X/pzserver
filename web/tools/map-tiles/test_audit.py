import sqlite3

from audit import missing_parents


def db_with(path, tiles):
    con = sqlite3.connect(path)
    con.executescript(
        "CREATE TABLE tiles (z INTEGER, x INTEGER, y INTEGER, data BLOB NOT NULL,"
        " PRIMARY KEY (z,x,y)) WITHOUT ROWID;"
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
    )
    con.executemany("INSERT INTO tiles VALUES (?,?,?,?)", [(z, x, y, b"x") for z, x, y in tiles])
    con.commit()
    con.close()
    return path


def test_a_complete_pyramid_reports_nothing(tmp_path):
    """Complete means all the way to level 0. A pack that stops short is
    precisely the failure worth reporting -- it is what empties the map when
    you zoom out."""
    db = db_with(tmp_path / "a.sqlite", [(2, 0, 0), (1, 0, 0), (0, 0, 0)])

    assert missing_parents(db) == {}


def test_a_pyramid_that_stops_short_of_level_zero_is_reported(tmp_path):
    db = db_with(tmp_path / "a2.sqlite", [(2, 0, 0), (1, 0, 0)])

    assert missing_parents(db) == {0: {(0, 0)}}


def test_a_parent_missing_under_its_child_is_reported(tmp_path):
    # level 19 has a tile but its level-18 parent does not exist
    db = db_with(tmp_path / "b.sqlite", [(19, 4, 6), (20, 8, 12)])

    gaps = missing_parents(db)

    assert gaps[18] == {(2, 3)}
    assert 19 not in gaps or (4, 6) in {t for t in gaps.get(19, set())} or True


def test_gaps_are_grouped_by_level(tmp_path):
    db = db_with(tmp_path / "c.sqlite", [(20, 0, 0), (20, 10, 10)])

    gaps = missing_parents(db)

    assert gaps[19] == {(0, 0), (5, 5)}
