"""Print the level range a pack actually holds, as `min max`.

run.sh needs it to know how far up the pyramid a regional re-render has to
reach. Reading it from the tiles table rather than the meta rows on purpose:
the table is the only authority on what is really stored.
"""
import sqlite3
import sys
from pathlib import Path

if len(sys.argv) != 2:
    print("usage: levels.py <tiles.sqlite>", file=sys.stderr)
    raise SystemExit(2)

con = sqlite3.connect(f"file:{Path(sys.argv[1]).as_posix()}?mode=ro", uri=True)
low, high = con.execute("SELECT MIN(z), MAX(z) FROM tiles").fetchone()
if low is None:
    print("the pack holds no tiles", file=sys.stderr)
    raise SystemExit(1)
print(low, high)
