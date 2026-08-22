"""Set `omit_levels` on a pzmap2dzi conf.yaml.

A full `make map-tiles` keeps omit_levels: 2 so it never writes z21/z22
(those are ~200 GB). A regional detail job patches this to 1 for the run so
z21 lands on disk for just the cells being painted.
"""
import re
import sys
from pathlib import Path

if len(sys.argv) != 3:
    print("usage: set_omit_levels.py <conf.yaml> <n>", file=sys.stderr)
    raise SystemExit(2)

conf = Path(sys.argv[1])
n = int(sys.argv[2])
if n < 0:
    print("omit_levels must be >= 0", file=sys.stderr)
    raise SystemExit(2)

text = conf.read_text(encoding="utf-8")
patched, count = re.subn(
    r"^([ \t]*omit_levels:[ \t]*)\d+",
    rf"\g<1>{n}",
    text,
    count=1,
    flags=re.M,
)
if not count:
    print(f"FAIL: {conf} has no omit_levels key", file=sys.stderr)
    raise SystemExit(1)

conf.write_text(patched, encoding="utf-8")
print(f"omit_levels = {n}")
