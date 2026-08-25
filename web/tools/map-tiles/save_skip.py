"""Skip vanilla lotpack paint on squares the save overlay will cover.

Vanilla always draws the closed door. The save layer then draws the open
sprite, which is mostly a hole, so the closed door shows through. Not
painting vanilla in those 8-square blocks leaves the overlay as the only
pixels there.
"""
from pathlib import Path

_RECTS: list[tuple[int, int, int, int]] | None = None
SQUARES_FILE = Path("/tmp/save_skip.txt")


def load_rects(path: Path = SQUARES_FILE) -> list[tuple[int, int, int, int]]:
    if not path.is_file():
        print(f"save-square skip: {path} missing; vanilla closed doors will show")
        return []
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        print(f"save-square skip: {path} empty; vanilla closed doors will show")
        return []
    from cells import parse_rects

    rects = parse_rects(text)
    print(f"save-square skip: {len(rects)} chunk rect(s) from {path}")
    return rects


def covers(sx: int, sy: int, rects=None) -> bool:
    """True when world square (sx, sy) sits in a snapshotted save chunk."""
    global _RECTS
    if rects is None:
        if _RECTS is None:
            _RECTS = load_rects()
        rects = _RECTS
    for x, y, w, h in rects:
        if x <= sx < x + w and y <= sy < y + h:
            return True
    return False
