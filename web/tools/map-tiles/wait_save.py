"""Wait until chunk files in the job cells are newer than before RCON save."""
from __future__ import annotations

import sys
import time
from pathlib import Path

from chunks import cell_in_rects, chunk_cell, iter_chunks, parse_cell_rects


def max_mtime(save: Path, rects) -> tuple[float, int]:
    newest = 0.0
    count = 0
    for x, y, unit, path in iter_chunks(save):
        cx, cy = chunk_cell(x, y, unit)
        if not cell_in_rects(cx, cy, rects):
            continue
        count += 1
        mtime = path.stat().st_mtime
        if mtime > newest:
            newest = mtime
    return newest, count


def wait(
    save: Path,
    rects,
    before: float,
    timeout: float = 20.0,
    interval: float = 0.4,
) -> tuple[bool, int, float]:
    deadline = time.time() + timeout
    newest, count = max_mtime(save, rects)
    if count == 0:
        return False, 0, newest
    while True:
        newest, count = max_mtime(save, rects)
        if newest > before:
            return True, count, newest
        if time.time() >= deadline:
            return False, count, newest
        time.sleep(interval)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(
            "usage: wait_save.py <save dir> <cells.txt> <mtime-before>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    save = Path(sys.argv[1])
    rects = parse_cell_rects(Path(sys.argv[2]).read_text(encoding="utf-8"))
    before = float(sys.argv[3])
    ok, count, newest = wait(save, rects, before)
    if count == 0:
        print("wait save: no chunks in those cells")
        raise SystemExit(0)
    if ok:
        print(f"wait save: {count} chunk(s) flushed (mtime {newest:.3f})")
        raise SystemExit(0)
    print(
        f"wait save: {count} chunk(s) still at mtime {newest:.3f} "
        f"(before {before:.3f}); snapshot may be stale",
        file=sys.stderr,
    )
    raise SystemExit(1)
