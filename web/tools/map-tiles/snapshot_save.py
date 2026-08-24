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

from chunks import chunks_for_cells, parse_cell_rects


def snapshot(src: Path, dst: Path, rects) -> int:
    dst.mkdir(parents=True, exist_ok=True)
    copied = 0
    dictionary = src / "WorldDictionary.bin"
    if dictionary.is_file():
        shutil.copy2(dictionary, dst / "WorldDictionary.bin")
        copied += 1

    for blob in chunks_for_cells(src, rects):
        rel = blob.relative_to(src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(blob, target)
        copied += 1
    return copied


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(
            "usage: snapshot_save.py <src save> <dst save> <cells.txt>",
            file=sys.stderr,
        )
        raise SystemExit(2)

    src, dst, cells = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    if not src.is_dir():
        print(f"FAIL: save folder missing: {src}", file=sys.stderr)
        raise SystemExit(1)
    rects = parse_cell_rects(cells.read_text(encoding="utf-8"))
    count = snapshot(src, dst, rects)
    print(f"snapshot {src} -> {dst}: {count} files for {len(rects)} cell rect(s)")
    if count == 0:
        print("no chunks in those cells; save overlay will be empty")
