"""Check a packed pyramid for the two ways it has actually gone wrong.

Both defects this catches were shipped by an interrupted render and neither is
visible from the outside: the pack opens, serves, and passes an integrity
check while showing black rectangles on the map. Run this after any render
rather than trusting an exit code.

  python audit.py tiles.sqlite
"""
import sqlite3
import sys
from pathlib import Path


def _connect(db_path):
    return sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True)


def missing_parents(db_path) -> dict:
    """Levels mapped to the parent tiles that should exist but do not.

    Every tile owes its existence to its four children being merged, so a
    child with no parent means the merge never finished there -- and the gap
    cascades upward, emptying the zoomed-out levels.
    """
    con = _connect(db_path)
    levels = [z for (z,) in con.execute("SELECT DISTINCT z FROM tiles ORDER BY z")]
    if not levels:
        return {}

    top = max(levels)
    have = {
        z: {(x, y) for x, y in con.execute("SELECT x, y FROM tiles WHERE z = ?", (z,))}
        for z in range(0, top + 1)
    }
    con.close()

    # Walk down to level 0, not just to the shallowest level stored. A pack
    # whose upper levels were never built has nothing there to iterate over,
    # and that is exactly the case worth reporting -- it is what empties the
    # zoomed-out view.
    gaps = {}
    for z in range(top - 1, -1, -1):
        expected = {(x // 2, y // 2) for (x, y) in have[z + 1]}
        if not expected:
            break
        missing = expected - have[z]
        if missing:
            gaps[z] = missing
    return gaps


def main(db_path: str) -> int:
    gaps = missing_parents(db_path)
    total = sum(len(v) for v in gaps.values())

    con = _connect(db_path)
    count = con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0]
    low, high = con.execute("SELECT MIN(z), MAX(z) FROM tiles").fetchone()
    con.close()

    print(f"tiles: {count}   levels: {low}..{high}")
    if not gaps:
        print("pyramid is complete: every tile with children has a parent")
        return 0

    print(f"\nINCOMPLETE: {total} parent tiles missing")
    for z in sorted(gaps):
        sample = sorted(gaps[z])[:6]
        shown = ", ".join(f"{x}_{y}" for x, y in sample)
        more = f" (+{len(gaps[z]) - len(sample)} more)" if len(gaps[z]) > len(sample) else ""
        print(f"  level {z:>2}: {len(gaps[z]):>4} missing   e.g. {shown}{more}")
    print("\nThese render as black rectangles, and the gap widens as you zoom out.")
    return 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: audit.py <tiles.sqlite>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
