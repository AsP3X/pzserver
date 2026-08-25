"""Replace tiles that are still JPEG-black with copies from a pristine pack.

A regional re-render that already packed black frames cannot heal from the
live sqlite — the underlay *is* the black rectangle. The original county
pack is left on the host bind at `/out/tiles.sqlite` after import. Restore
those bytes over any dirty ancestor (or leaf) that is still mostly black
so zoom-out is the real map again, not a DZI-tile-shaped hole.
"""
import sys
from pathlib import Path

from fill_unpainted import mostly_black, parse_keys
from unpack import unpack


def heal(keys, tiles_dir: Path, db_path: Path) -> int:
    """Unpack from `db_path` over every key whose JPEG is mostly black.

    Missing files count as black. Returns how many tiles were restored.
    """
    if not db_path.is_file():
        return 0
    broken = set()
    for z, x, y in keys:
        path = tiles_dir / str(z) / f"{x}_{y}.jpg"
        if not path.is_file() or mostly_black(path):
            broken.add((z, x, y))
    if not broken:
        return 0
    return unpack(db_path, tiles_dir, only=broken)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(
            "usage: heal_black.py <keys.txt> <layer0_files> <pristine tiles.sqlite>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    keys = parse_keys(Path(sys.argv[1]).read_text(encoding="utf-8"))
    n = heal(keys, Path(sys.argv[2]), Path(sys.argv[3]))
    print(f"healed {n} mostly-black tiles from {sys.argv[3]}")
