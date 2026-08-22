import sqlite3

from pack import pack
from unpack import unpack


def make_db(path, tiles):
    con = sqlite3.connect(path)
    con.executescript(
        "CREATE TABLE tiles (z INTEGER, x INTEGER, y INTEGER, data BLOB NOT NULL,"
        " PRIMARY KEY (z,x,y)) WITHOUT ROWID;"
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
    )
    con.executemany("INSERT INTO tiles VALUES (?,?,?,?)", tiles)
    con.commit()
    con.close()


def test_unpack_writes_the_dzi_tree_back(tmp_path):
    db, tree = tmp_path / "t.sqlite", tmp_path / "tree"
    make_db(db, [(20, 3, 4, b"aa"), (19, 1, 2, b"bbb")])

    n = unpack(db, tree)

    assert n == 2
    assert (tree / "20" / "3_4.jpg").read_bytes() == b"aa"
    assert (tree / "19" / "1_2.jpg").read_bytes() == b"bbb"


def test_unpack_skips_the_region_being_rerendered(tmp_path):
    """The whole point: leave a hole so pzmap2dzi redraws it instead of
    finding a tile already there and skipping the work."""
    db, tree = tmp_path / "t.sqlite", tmp_path / "tree"
    make_db(db, [(20, 3, 4, b"aa"), (20, 9, 9, b"cc")])

    n = unpack(db, tree, skip={(20, 3, 4)})

    assert n == 1
    assert not (tree / "20" / "3_4.jpg").exists()
    assert (tree / "20" / "9_9.jpg").exists()


def test_round_trip_through_unpack_and_pack_is_lossless(tmp_path):
    db, tree = tmp_path / "t.sqlite", tmp_path / "tree"
    make_db(db, [(20, 3, 4, b"aa"), (19, 1, 2, b"bbb")])

    unpack(db, tree)
    (tmp_path / "again.sqlite").unlink(missing_ok=True)
    pack(tree, tmp_path / "again.sqlite", {})

    con = sqlite3.connect(tmp_path / "again.sqlite")
    assert con.execute("SELECT data FROM tiles WHERE z=20 AND x=3 AND y=4").fetchone()[0] == b"aa"
    assert con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0] == 2


def test_replace_mode_lets_a_rerendered_tile_win(tmp_path):
    """Without this a regional re-render is a no-op: the packer's default is
    ON CONFLICT DO NOTHING, so the fresh bytes would be discarded."""
    db, tree = tmp_path / "t.sqlite", tmp_path / "tree"
    make_db(db, [(20, 3, 4, b"old")])

    level = tree / "20"
    level.mkdir(parents=True)
    (level / "3_4.jpg").write_bytes(b"new")

    pack(tree, db, {}, replace=True)

    con = sqlite3.connect(db)
    assert con.execute("SELECT data FROM tiles WHERE z=20 AND x=3 AND y=4").fetchone()[0] == b"new"
    assert con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0] == 1


def test_unpack_can_restore_just_the_merge_inputs(tmp_path):
    """A regional re-render restores tens of tiles, not tens of thousands.
    Restoring the whole pack would cost as much as the original pack did."""
    db, tree = tmp_path / "t.sqlite", tmp_path / "tree"
    make_db(db, [(20, 1, 1, b"a"), (20, 2, 2, b"b"), (20, 3, 3, b"c")])

    n = unpack(db, tree, only={(20, 2, 2)})

    assert n == 1
    assert (tree / "20" / "2_2.jpg").exists()
    assert not (tree / "20" / "1_1.jpg").exists()
    assert not (tree / "20" / "3_3.jpg").exists()


def test_only_mode_does_not_read_every_blob(tmp_path):
    """The pack is 24 GB and lives on a slow bind mount. Scanning every row to
    filter down to a handful takes about an hour; targeted lookups take
    milliseconds. Assert the query shape, because the cost is invisible in a
    small test."""
    db, tree = tmp_path / "t.sqlite", tmp_path / "tree"
    make_db(db, [(20, i, i, b"x" * 10) for i in range(200)])

    seen = []
    real_connect = sqlite3.connect

    def traced(*a, **kw):
        con = real_connect(*a, **kw)
        con.set_trace_callback(seen.append)
        return con

    sqlite3.connect = traced
    try:
        unpack(db, tree, only={(20, 7, 7), (20, 9, 9)})
    finally:
        sqlite3.connect = real_connect

    selects = [q for q in seen if "SELECT" in q.upper()]
    assert selects, "expected at least one query"
    assert not any("ORDER BY" in q.upper() and "WHERE" not in q.upper() for q in selects), (
        f"only-mode must not full-scan the tiles table; queries were {selects}"
    )
