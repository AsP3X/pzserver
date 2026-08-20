"""Fail loudly if the render's geometry does not match what the client assumes.

web/ui/src/lib/iso-tiles.ts hardcodes ISO_DZI and derives every pin position
from it. A pyramid with different bounds still renders, but puts every survivor
in the wrong place, so this is checked before anything is built on top.
"""
import sys
import xml.etree.ElementTree as ET

EXPECTED = {"Width": "2318656", "Height": "1019040", "TileSize": "2048", "Format": "jpg"}


def main(dzi_path: str) -> int:
    root = ET.parse(dzi_path).getroot()
    size = root.find("{http://schemas.microsoft.com/deepzoom/2008}Size")
    if size is None:
        print(f"FAIL: no <Size> in {dzi_path}", file=sys.stderr)
        return 1

    actual = {
        "Width": size.get("Width"),
        "Height": size.get("Height"),
        "TileSize": root.get("TileSize"),
        "Format": root.get("Format"),
    }

    bad = {k: (v, actual[k]) for k, v in EXPECTED.items() if actual[k] != v}
    for key, (want, got) in bad.items():
        print(f"FAIL: {key} is {got}, ISO_DZI expects {want}", file=sys.stderr)

    if bad:
        print(
            "\nThe pyramid does not match web/ui/src/lib/iso-tiles.ts.\n"
            "Pins would be misplaced. Fix conf.yaml (tile_size, tile_align_levels,\n"
            "dzi_cell_range) rather than editing ISO_DZI to match a bad render.",
            file=sys.stderr,
        )
        return 1

    print(f"OK: geometry matches ISO_DZI ({actual['Width']}x{actual['Height']}, "
          f"tile {actual['TileSize']}, {actual['Format']})")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: verify.py <path to layer0.dzi>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
