import json
import sqlite3

from ensure_map_info import canonical, ensure
from verify import check


def test_canonical_passes_the_geometry_gate():
    assert check(canonical()) == []


def test_ensure_keeps_an_existing_file(tmp_path):
    dest = tmp_path / "map_info.json"
    dest.write_text('{"x0": 1}\n', encoding="utf-8")
    assert ensure(dest) == "kept"
    assert json.loads(dest.read_text())["x0"] == 1


def test_ensure_writes_canonical_when_missing(tmp_path):
    dest = tmp_path / "html" / "map_info.json"
    assert ensure(dest) == "canonical"
    info = json.loads(dest.read_text(encoding="utf-8"))
    assert info["x0"] == 1_040_384
    assert info["skip"] == 2
    assert info["w"] == 579616
    assert info["h"] == 253944
    assert check(info) == []


def test_ensure_prefers_pack_meta(tmp_path):
    pack = tmp_path / "tiles.sqlite"
    con = sqlite3.connect(pack)
    con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    stored = canonical()
    stored["w"] = 579616
    con.execute(
        "INSERT INTO meta (key, value) VALUES ('map_info', ?)",
        (json.dumps(stored),),
    )
    con.commit()
    con.close()
    dest = tmp_path / "map_info.json"
    assert ensure(dest, pack) == "pack"
    assert json.loads(dest.read_text())["w"] == 579616
