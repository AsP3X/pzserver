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
