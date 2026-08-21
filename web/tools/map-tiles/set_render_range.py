"""Point pzmap2dzi's `render_cell_range` at the cells we want redrawn.

Deliberately only this key. `dzi_cell_range` decides the pyramid's bounds, and
those have to match ISO_DZI in web/ui/src/lib/iso-tiles.ts exactly or every pin
lands on the wrong building -- see verify.py. Rendering a subset while leaving
the pyramid's shape alone is precisely what pzmap2dzi documents this key for.
"""
import re
import sys
from pathlib import Path

from cells import parse_rects

if len(sys.argv) != 3:
    print("usage: set_render_range.py <conf.yaml> <cells>", file=sys.stderr)
    raise SystemExit(2)

conf, spec = Path(sys.argv[1]), sys.argv[2]
rects = parse_rects(spec)

block = "    render_cell_range:\n" + "".join(
    f"        - [{x}, {y}, {w}, {h}]\n" for x, y, w, h in rects
)

text = conf.read_text(encoding="utf-8")
patched, n = re.subn(r"^[ \t]*render_cell_range:.*$", block.rstrip("\n"), text, count=1, flags=re.M)
if not n:
    print(f"FAIL: no render_cell_range key in {conf}", file=sys.stderr)
    raise SystemExit(1)

conf.write_text(patched, encoding="utf-8")
print(f"render_cell_range = {rects}")
