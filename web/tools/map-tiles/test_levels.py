import sqlite3
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _pack(path: Path, rows) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE tiles (z INTEGER, x INTEGER, y INTEGER, data BLOB NOT NULL,"
        " PRIMARY KEY (z,x,y)) WITHOUT ROWID"
    )
    con.executemany("INSERT INTO tiles VALUES (?,?,?,?)", rows)
    con.commit()
    con.close()


def test_sparse_z21_does_not_become_the_leaf_level(tmp_path):
    db = tmp_path / "t.sqlite"
    rows = [(z, 0, 0, b"x") for z in range(0, 21)]
    rows += [(20, i, 0, b"x") for i in range(1, 50)]  # z20 is the populous level
    rows += [(21, 0, 0, b"x"), (21, 1, 0, b"x")]  # leftover detail tiles
    _pack(db, rows)
    out = subprocess.check_output(
        [sys.executable, str(HERE / "levels.py"), str(db)], text=True
    )
    assert out.strip() == "0 20"
