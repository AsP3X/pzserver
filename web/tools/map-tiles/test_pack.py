import sqlite3
from pathlib import Path

from pack import pack


def build_tree(root: Path) -> None:
    for z, x, y, body in [(8, 0, 0, b"a"), (20, 3, 4, b"bb"), (20, 5, 6, b"ccc")]:
        d = root / "base" / "layer0_files" / str(z)
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{x}_{y}.jpg").write_bytes(body)


def test_pack_moves_every_tile_and_removes_the_tree(tmp_path):
    tree, db = tmp_path / "tree", tmp_path / "tiles.sqlite"
    build_tree(tree)

    count = pack(tree / "base" / "layer0_files", db, {"game_version": "42.20.0"})

    assert count == 3
    con = sqlite3.connect(db)
    assert con.execute("SELECT data FROM tiles WHERE z=20 AND x=5 AND y=6").fetchone()[0] == b"ccc"
    assert con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0] == 3
    assert con.execute("SELECT value FROM meta WHERE key='game_version'").fetchone()[0] == "42.20.0"
    assert con.execute("SELECT value FROM meta WHERE key='min_level'").fetchone()[0] == "8"
    assert con.execute("SELECT value FROM meta WHERE key='max_level'").fetchone()[0] == "20"
    # Files are removed as they are packed, so peak disk stays near the result.
    assert list((tree / "base" / "layer0_files").rglob("*.jpg")) == []


def test_pack_resumes_without_duplicating(tmp_path):
    tree, db = tmp_path / "tree", tmp_path / "tiles.sqlite"
    build_tree(tree)
    pack(tree / "base" / "layer0_files", db, {})

    build_tree(tree)  # a re-run after an interrupted render
    count = pack(tree / "base" / "layer0_files", db, {})

    con = sqlite3.connect(db)
    assert con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0] == 3
    assert count == 0


def test_meta_levels_come_from_stored_tiles_not_empty_directories(tmp_path):
    """pzmap2dzi pre-creates a directory per DZI level, including ones it never
    fills. Reporting those as the rendered range tells the client the pack is
    deeper than it is, and the client's zoom clamp then does nothing."""
    tree, db = tmp_path / "tree", tmp_path / "tiles.sqlite"
    build_tree(tree)
    tiles = tree / "base" / "layer0_files"
    for z in (0, 1, 7, 21, 22):          # created by the renderer, never filled
        (tiles / str(z)).mkdir(parents=True, exist_ok=True)

    pack(tiles, db, {})

    con = sqlite3.connect(db)
    meta = dict(con.execute("SELECT key, value FROM meta"))
    assert meta["min_level"] == "8", "empty level 0 must not become min_level"
    assert meta["max_level"] == "20", "empty level 22 must not become max_level"


def _statements(fn):
    """Capture the SQL a pack() call issues."""
    seen = []
    real = sqlite3.connect

    def traced(*a, **kw):
        con = real(*a, **kw)
        con.set_trace_callback(seen.append)
        return con

    sqlite3.connect = traced
    try:
        fn()
    finally:
        sqlite3.connect = real
    return seen


def test_a_regional_repack_does_not_vacuum(tmp_path):
    """VACUUM rebuilds the whole database into a temporary copy. On the real
    24 GB pack that is tens of minutes and double the disk, which is absurd
    for a re-render that touched 59 rows -- and it only ever INSERTs, so there
    is next to no fragmentation to reclaim anyway."""
    tree, db = tmp_path / "tree", tmp_path / "tiles.sqlite"
    build_tree(tree)
    tiles = tree / "base" / "layer0_files"

    sql = _statements(lambda: pack(tiles, db, {}, replace=True))

    assert not any("VACUUM" in s.upper() for s in sql), "a replace pack must not VACUUM"


def test_the_first_full_pack_still_vacuums(tmp_path):
    tree, db = tmp_path / "tree", tmp_path / "tiles.sqlite"
    build_tree(tree)
    tiles = tree / "base" / "layer0_files"

    sql = _statements(lambda: pack(tiles, db, {}))

    assert any("VACUUM" in s.upper() for s in sql)


def test_replace_only_updates_named_tiles(tmp_path):
    tree, db = tmp_path / "tree", tmp_path / "tiles.sqlite"
    build_tree(tree)
    tiles = tree / "base" / "layer0_files"
    pack(tiles, db, {"generated_at": "old"})

    build_tree(tree)
    (tiles / "20" / "3_4.jpg").write_bytes(b"NEW")
    (tiles / "20" / "5_6.jpg").write_bytes(b"also-new-but-not-dirty")
    n = pack(tiles, db, {"generated_at": "new"}, replace=True, only={(20, 3, 4)}, wal=True)

    con = sqlite3.connect(db)
    assert con.execute("SELECT data FROM tiles WHERE z=20 AND x=3 AND y=4").fetchone()[0] == b"NEW"
    assert con.execute("SELECT data FROM tiles WHERE z=20 AND x=5 AND y=6").fetchone()[0] == b"ccc"
    assert con.execute("SELECT data FROM tiles WHERE z=8 AND x=0 AND y=0").fetchone()[0] == b"a"
    assert con.execute("SELECT value FROM meta WHERE key='generated_at'").fetchone()[0] == "new"
    assert n == 1
    assert (tiles / "20" / "5_6.jpg").exists()


def test_region_pack_enables_wal(tmp_path):
    tree, db = tmp_path / "tree", tmp_path / "tiles.sqlite"
    build_tree(tree)
    sql = _statements(lambda: pack(tree / "base" / "layer0_files", db, {}, replace=True, wal=True))
    joined = " ".join(sql).upper()
    assert "JOURNAL_MODE" in joined or "WAL" in joined

    con = sqlite3.connect(db)
    assert con.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
