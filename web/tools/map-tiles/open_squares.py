"""List 1x1 world squares whose live sprite is not the closed default.

Used as the skip/punch mask. Whole 8x8 save chunks must not be punched:
skipping vanilla there leaves transparent pixels that JPEG as a black field.
"""
from __future__ import annotations

import sys
from pathlib import Path

from chunk_sprites import visual_sprite_id
from chunks import iter_chunks


def _default_id(obj):
    wrapper = getattr(obj, "object", obj)
    base = getattr(wrapper, "base_object", None)
    return getattr(base, "sprite_id", None) if base is not None else None


def open_rects(save: Path) -> list[tuple[int, int, int, int]]:
    import pzdataspec.utils as utils

    rects = []
    for cx, cy, unit, blob in iter_chunks(save):
        try:
            data = utils.load_chunk(str(blob), version=42)
        except Exception:
            continue
        raw = data.raw
        bs = int(raw.block_size)
        for idx, square in enumerate(raw.squares):
            lx, ly = divmod(idx, bs)
            changed = False
            for grid_square in square.squares:
                for obj in grid_square.objects:
                    if visual_sprite_id(obj) != _default_id(obj):
                        changed = True
                        break
                if changed:
                    break
            if changed:
                rects.append((cx * unit + lx, cy * unit + ly, 1, 1))
    return rects


def write_rects(path: Path, rects) -> None:
    path.write_text(";".join(f"{x},{y},{w},{h}" for x, y, w, h in rects), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: open_squares.py <save snapshot> <out.txt>", file=sys.stderr)
        raise SystemExit(2)
    save, dest = Path(sys.argv[1]), Path(sys.argv[2])
    try:
        rects = open_rects(save)
    except Exception as error:
        print(f"open-square scan skipped: {error}", file=sys.stderr)
        dest.write_text("", encoding="utf-8")
        raise SystemExit(0)
    write_rects(dest, rects)
    print(f"open-square skip: {len(rects)} square(s)")
