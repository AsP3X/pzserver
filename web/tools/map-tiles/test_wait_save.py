import os
import time
from pathlib import Path

from wait_save import max_mtime, wait


def _chunk(save: Path, x: int, y: int) -> Path:
    folder = save / "map" / str(x)
    folder.mkdir(parents=True, exist_ok=True)
    blob = folder / f"{y}.bin"
    blob.write_bytes(b"x")
    return blob


def test_max_mtime_only_counts_cells_in_the_rect(tmp_path):
    inside = _chunk(tmp_path, 100, 200)
    _chunk(tmp_path, 400, 500)
    # B42: chunk (100,200) * 8 squares is cell (3, 6).
    newest, count = max_mtime(tmp_path, [(3, 6, 1, 1)])
    assert count == 1
    assert newest == inside.stat().st_mtime


def test_wait_returns_once_mtime_moves(tmp_path):
    blob = _chunk(tmp_path, 100, 200)
    old = time.time() - 60
    os.utime(blob, (old, old))
    before = blob.stat().st_mtime
    blob.write_bytes(b"yy")
    os.utime(blob, None)
    ok, count, newest = wait(tmp_path, [(3, 6, 1, 1)], before, timeout=2.0)
    assert ok
    assert count == 1
    assert newest > before


def test_wait_times_out_when_mtime_does_not_move(tmp_path):
    blob = _chunk(tmp_path, 100, 200)
    before = blob.stat().st_mtime
    ok, count, newest = wait(tmp_path, [(3, 6, 1, 1)], before, timeout=0.2, interval=0.05)
    assert ok is False
    assert count == 1
    assert newest == before
