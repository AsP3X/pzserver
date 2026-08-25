"""Copy the live world's dirty chunks into a snapshot the renderer can read.

The dedicated server has map_*.bin open. We do not point pzmap2dzi at those
files; we copy the cells this job covers (plus WorldDictionary.bin) so a
partial write during the copy is a failed chunk, not a torn read of the live
tree. Destination layout matches the source so save_game_root + save_games
still resolve.
"""
import shutil
import sys
from pathlib import Path

from chunks import chunk_cell, parse_cell_rects


def snapshot(src: Path, dst: Path, rects):
    """Copy dirty chunks. Returns (file count, world-square rects of those chunks)."""
    from chunks import cell_in_rects, iter_chunks

    dst.mkdir(parents=True, exist_ok=True)
    copied = 0
    squares = []
    dictionary = src / "WorldDictionary.bin"
    if dictionary.is_file():
        shutil.copy2(dictionary, dst / "WorldDictionary.bin")
        copied += 1

    for x, y, unit, blob in iter_chunks(src):
        cx, cy = chunk_cell(x, y, unit)
        if not cell_in_rects(cx, cy, rects):
            continue
        rel = blob.relative_to(src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(blob, target)
        copied += 1
        squares.append((x * unit, y * unit, unit, unit))
    return copied, squares


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        print(
            "usage: snapshot_save.py <src save> <dst save> <cells.txt> [squares.txt]",
            file=sys.stderr,
        )
        raise SystemExit(2)

    src, dst, cells = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    if not src.is_dir():
        print(f"FAIL: save folder missing: {src}", file=sys.stderr)
        raise SystemExit(1)
    rects = parse_cell_rects(cells.read_text(encoding="utf-8"))
    count, squares = snapshot(src, dst, rects)
    print(f"snapshot {src} -> {dst}: {count} files for {len(rects)} cell rect(s)")
    if len(sys.argv) == 5:
        Path(sys.argv[4]).write_text(
            ";".join(f"{x},{y},{w},{h}" for x, y, w, h in squares),
            encoding="utf-8",
        )
    if count == 0:
        print("no chunks in those cells; save overlay will be empty")
