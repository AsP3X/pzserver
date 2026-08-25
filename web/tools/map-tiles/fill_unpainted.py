"""Replace JPEG-black corners with pixels from the pre-render underlay.

pzmap2dzi initialises a tile to transparent and paints only the cells in
`render_cell_range`. JPEG has no alpha, so unpainted pixels become black —
the giant rectangle around a regional re-render. The original tile from the
pack still has the vanilla terrain in those corners. Copy it back wherever
the new JPEG is near-black and the underlay is not.

Must run *before* the save overlay: punching an open door also leaves a
near-black hole, and filling that from the underlay would put the closed
door back.
"""
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops
except ImportError:  # pragma: no cover
    Image = None
    ImageChops = None

# JPEG of a transparent pixel is (0,0,0). A little headroom covers chroma
# noise without swallowing dark grass or roof tiles (those sit well above).
BLACK = 12


def parse_keys(text: str) -> list[tuple[int, int, int]]:
    keys = []
    for line in text.split():
        z, _, rest = line.partition("/")
        x, _, y = rest.partition("_")
        keys.append((int(z), int(x), int(y)))
    return keys


def _keep_mask(rgb) -> "Image.Image":
    """White where the new tile has colour, black where it is unpainted."""
    r, g, b = rgb.split()
    rm = r.point(lambda p: 255 if p > BLACK else 0)
    gm = g.point(lambda p: 255 if p > BLACK else 0)
    bm = b.point(lambda p: 255 if p > BLACK else 0)
    return ImageChops.lighter(ImageChops.lighter(rm, gm), bm)


def fill_one(new_path: Path, underlay_path: Path) -> bool:
    if Image is None:
        raise RuntimeError("Pillow is required to fill unpainted tile corners")
    if not new_path.is_file() or not underlay_path.is_file():
        return False
    new = Image.open(new_path).convert("RGB")
    old = Image.open(underlay_path).convert("RGB")
    if old.size != new.size:
        old = old.resize(new.size, Image.Resampling.LANCZOS)
    mask = _keep_mask(new)
    filled = Image.composite(new, old, mask)
    filled.save(new_path, quality=70, optimize=True)
    return True


def fill(keys, new_dir: Path, underlay_dir: Path) -> int:
    n = 0
    for z, x, y in keys:
        dest = new_dir / str(z) / f"{x}_{y}.jpg"
        src = underlay_dir / str(z) / f"{x}_{y}.jpg"
        if fill_one(dest, src):
            n += 1
    return n


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(
            "usage: fill_unpainted.py <leaves.txt> <layer0_files> <underlay dir>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    keys = parse_keys(Path(sys.argv[1]).read_text(encoding="utf-8"))
    n = fill(keys, Path(sys.argv[2]), Path(sys.argv[3]))
    print(f"filled unpainted corners on {n} leaf tiles")
