"""Rebuild dirty ancestor tiles by downsampling their four children.

pzmap2dzi will merge parents itself if they are missing from disk — and it
does that *during* the render, from children that still have unpainted
JPEG-black corners. The result at zoom-out is a black rectangle with the
town diamond in the middle.

We restore those ancestors so the renderer leaves them alone, paint the
leaves, fill unpainted corners, then walk the dirty parents from the
deepest level up and write each from its four children. Missing children
leave the restored parent in place rather than painting a black quadrant.
"""
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None


def parse_keys(text: str) -> list[tuple[int, int, int]]:
    keys = []
    for line in text.split():
        z, _, rest = line.partition("/")
        x, _, y = rest.partition("_")
        keys.append((int(z), int(x), int(y)))
    return keys


def child_path(tiles_dir: Path, z: int, x: int, y: int) -> Path:
    return tiles_dir / str(z) / f"{x}_{y}.jpg"


def merge_parent(tiles_dir: Path, z: int, x: int, y: int, tile_size: int = 2048) -> bool:
    if Image is None:
        raise RuntimeError("Pillow is required to rebuild ancestor tiles")
    children = []
    for dx in (0, 1):
        for dy in (0, 1):
            path = child_path(tiles_dir, z + 1, x * 2 + dx, y * 2 + dy)
            if not path.is_file():
                return False
            children.append((dx, dy, Image.open(path).convert("RGB")))
    canvas = Image.new("RGB", (tile_size * 2, tile_size * 2))
    for dx, dy, im in children:
        # pzmap2dzi crops edge tiles smaller than tile_size. Stretching a
        # sliver to 2048x2048 turns trees into a vertical barcode. Paste at
        # native size in the quadrant, same as merge_tile.
        canvas.paste(im, (dx * tile_size, dy * tile_size))
    parent = canvas.resize((tile_size, tile_size), Image.Resampling.LANCZOS)
    dest = child_path(tiles_dir, z, x, y)
    dest.parent.mkdir(parents=True, exist_ok=True)
    parent.save(dest, quality=70, optimize=True)
    return True


def rebuild(keys, tiles_dir: Path, tile_size: int = 2048) -> int:
    """Deepest first so a z18 merge sees the z19 we just wrote."""
    n = 0
    ordered = sorted(keys, key=lambda t: (-t[0], t[1], t[2]))
    for z, x, y in ordered:
        if merge_parent(tiles_dir, z, x, y, tile_size=tile_size):
            n += 1
    return n


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        print(
            "usage: rebuild_pyramid.py <keep.txt> <layer0_files> [tile_size]",
            file=sys.stderr,
        )
        raise SystemExit(2)
    keys = parse_keys(Path(sys.argv[1]).read_text(encoding="utf-8"))
    tile_size = int(sys.argv[3]) if len(sys.argv) == 4 else 2048
    n = rebuild(keys, Path(sys.argv[2]), tile_size=tile_size)
    print(f"rebuilt {n} ancestor tiles from children")
