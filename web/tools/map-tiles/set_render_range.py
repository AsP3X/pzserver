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

# Replace the key if it is already there, taking any list items under it with
# it so a previous run's rects do not survive into this one.
pattern = r"^[ \t]*render_cell_range:[^\n]*\n(?:[ \t]+-[^\n]*\n)*"
patched, n = re.subn(pattern, block, text, count=1, flags=re.M)

if not n:
    # Usually it is absent: this stack ships its own conf.yaml over
    # pzmap2dzi's and never declared the key, so a replace-only patcher fails
    # the whole run at the last moment. Add it under render_conf:, which is
    # where pzmap2dzi reads it from.
    patched, n = re.subn(r"^(render_conf:[ \t]*\n)", r"\1" + block, text, count=1, flags=re.M)

if not n:
    print(
        f"FAIL: {conf} has neither a render_cell_range key nor a render_conf block",
        file=sys.stderr,
    )
    raise SystemExit(1)

conf.write_text(patched, encoding="utf-8")
print(f"render_cell_range = {rects}")
