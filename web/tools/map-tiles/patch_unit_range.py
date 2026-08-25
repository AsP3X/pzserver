"""Compare render_cell_range to source coords in the same units.

pzmap2dzi's init_unit_range converts cell rects into source units (cells
for lotpack, 8-square blocks for a B42 save). filter_source_by_unit_range
then converts those source coords *back* to cells and compares them to
unit_range — so a save overlay with unit_range (1248, 1152, 160, 160)
asks whether cell 39 is inside 1248…1408 and drops every chunk.
Affected tiles: 0, composited 0 save tiles, door stays closed.

is_source_empty already compares in source units. Match that.
"""
from pathlib import Path
import sys

TARGET = Path("/opt/pzmap2dzi/pzmap2dzi/pzdzi.py")

OLD = """        for coord in coord_map:
            ux, uy = coord
            cx = ux * self.source_unit_size // self.cell_size
            cy = uy * self.source_unit_size // self.cell_size
            for rx, ry, rw, rh in self.unit_range:
                if rx <= cx < rx + rw and ry <= cy < ry + rh:
                    break
            else:
                to_delete.append(coord)
"""

NEW = """        for coord in coord_map:
            ux, uy = coord
            # unit_range is already in source units (see init_unit_range).
            # Converting to cells here drops every save chunk (block coords).
            for rx, ry, rw, rh in self.unit_range:
                if rx <= ux < rx + rw and ry <= uy < ry + rh:
                    break
            else:
                to_delete.append(coord)
"""


def apply(text: str) -> str:
    if "unit_range is already in source units" in text:
        return text
    if OLD not in text:
        raise SystemExit(
            "filter_source_by_unit_range loop not found — pzmap2dzi pzdzi.py has changed"
        )
    return text.replace(OLD, NEW, 1)


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else TARGET
    original = path.read_text(encoding="utf-8")
    patched = apply(original)
    if patched == original:
        print(f"already patched: {path}")
        return 0
    path.write_text(patched, encoding="utf-8")
    print(f"patched: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
