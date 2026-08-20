"""Check the render against what the client actually needs.

web/ui/src/lib/iso-tiles.ts places every pin with worldToDzi(), which uses only
x0, y0 and sqr. Those must match exactly, or survivors land on the wrong
buildings — a failure that still looks like a working map, which is why this
runs before anything is built on top of a render.

The image dimensions are a different matter. `omit_levels: N` reports w and h
divided by 2^N while leaving x0/y0/sqr in full-resolution space, recording the
reduction as `skip`. So the size check undoes that before comparing, and
tolerates a small residual: our game files differ slightly from whatever the
public pyramid was rendered from, which costs at most one tile row at the
bottom edge.
"""
import json
import sys

# From ISO_DZI in web/ui/src/lib/iso-tiles.ts. These decide pin placement.
EXACT = {"x0": 1040384, "y0": -139296, "sqr": 128}

# Full-resolution pyramid the client's tile maths is built around.
FULL_W, FULL_H = 2318656, 1019040

# The B42 vanilla cell rectangles, as documented in pzmap2dzi's own conf.yaml.
# This is the real shape check: w and h are derived from these, so matching
# rects means matching geometry, and comparing rects catches a wrong map where
# comparing pixel counts only catches it by proxy.
CELL_RECTS = [[0, 18, 45, 45], [45, 3, 13, 60], [58, 0, 20, 63]]

# One cell diagonal. Sub-cell differences are padding and rounding against a
# slightly different source install; a whole cell means real geometry drift.
TOLERANCE = 16384


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
    for label, want in (("w", FULL_W), ("h", FULL_H)):
        got = info.get(label, 0) * scale
        if abs(got - want) > TOLERANCE:
            problems.append(
                f"{label} x 2^{skip} is {got}, expected about {want} "
                f"(off by {abs(got - want)}, tolerance {TOLERANCE})"
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
