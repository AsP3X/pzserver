"""The pyramid's full-resolution size, for the pack's own metadata.

The client lays every tile out on the width and height the pack declares
(`tileBounds` in web/ui/src/lib/iso-tiles.ts clamps each tile to them). Those
must be what the render actually produced, not a constant: the size depends on
the game files the pack was built from. This install's county is
2318464 x 1015776, while the hardcoded pair was 2318656 x 1019040 -- 3264 px
taller than it had. Every level was then drawn short, worst zoomed out where
one tile row spans the whole map.

`map_info.json` reports w/h divided by 2^skip and records the reduction, so
multiply it back. Prints "<width> <height>", or nothing if the file cannot be
read -- run.sh keeps the previous value rather than packing a guess.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def full_size(info: dict) -> tuple[int, int]:
    scale = 2 ** int(info.get("skip", 0))
    return int(info["w"]) * scale, int(info["h"]) * scale


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: pack_size.py <map_info.json>", file=sys.stderr)
        raise SystemExit(2)
    try:
        width, height = full_size(
            json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        )
    except Exception as error:
        print(f"pack size unavailable: {error}", file=sys.stderr)
        raise SystemExit(1)
    print(f"{width} {height}")
