"""Check the render against what the client actually needs.

web/ui/src/lib/iso-tiles.ts places every pin with worldToDzi(), which uses only
x0, y0 and sqr. Those must match exactly, or survivors land on the wrong
buildings — a failure that still looks like a working map, which is why this
runs before anything is built on top of a render.

The image dimensions used to be checked against the public pyramid's, with a
tolerance for "our game files differ slightly". That reasoning was wrong: the
client lays every tile out on the size the *pack* declares, so a render 3264 px
shorter than the constant did not cost one row at the bottom edge -- it drew
every level short, worst zoomed out where a single tile row spans the map. The
render's size is now measured (pack_size.py) and published in the pack, so
there is nothing to compare it against. What remains here is the geometry that
really is fixed: x0/y0/sqr place every pin, and cell_rects say it is the right
map.
"""
import json
import sys

# From ISO_DZI in web/ui/src/lib/iso-tiles.ts. These decide pin placement.
EXACT = {"x0": 1040384, "y0": -139296, "sqr": 128}

# A render this far off the shipped county is not this map at all. Wide on
# purpose: the point is to catch a wrong or truncated render, not to pin the
# size, which pack_size.py measures and the pack publishes.
SANE_W, SANE_H = 2318656, 1019040
SANE_FRACTION = 0.05

# The B42 vanilla cell rectangles, as documented in pzmap2dzi's own conf.yaml.
# This is the real shape check: w and h are derived from these, so matching
# rects means matching geometry, and comparing rects catches a wrong map where
# comparing pixel counts only catches it by proxy.
CELL_RECTS = [[0, 18, 45, 45], [45, 3, 13, 60], [58, 0, 20, 63]]


def check(info: dict) -> list:
    """Return a list of problems; empty means the render is usable."""
    problems = []

    for key, want in EXACT.items():
        got = info.get(key)
        if got != want:
            problems.append(f"{key} is {got}, ISO_DZI expects {want}")

    rects = [list(r) for r in info.get("cell_rects", [])]
    if rects != CELL_RECTS:
        problems.append(f"cell_rects are {rects}, expected {CELL_RECTS}")

    skip = info.get("skip", 0)
    scale = 2**skip
    for label, sane in (("w", SANE_W), ("h", SANE_H)):
        got = info.get(label, 0) * scale
        if abs(got - sane) > sane * SANE_FRACTION:
            problems.append(
                f"{label} x 2^{skip} is {got}, which is not Knox County "
                f"(about {sane}, +/-{SANE_FRACTION:.0%})"
            )

    return problems


def main(info_path: str) -> int:
    with open(info_path, encoding="utf-8") as handle:
        info = json.load(handle)

    problems = check(info)
    for problem in problems:
        print(f"FAIL: {problem}", file=sys.stderr)

    if problems:
        print(
            "\nThe pyramid does not line up with web/ui/src/lib/iso-tiles.ts. "
            "Fix conf.yaml (dzi_cell_range) rather than editing ISO_DZI to "
            "match a bad render.",
            file=sys.stderr,
        )
        return 1

    print(
        f"OK: x0/y0/sqr match exactly; {info['w']}x{info['h']} at "
        f"skip={info.get('skip', 0)} is the expected {FULL_W}x{FULL_H} pyramid"
    )
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: verify.py <path to map_info.json>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
