"""Replace JPEG-black corners with pixels from the pre-render underlay.

pzmap2dzi initialises a tile to transparent and paints only the cells in
`render_cell_range`. JPEG has no alpha, so unpainted pixels become black —
the giant rectangle around a regional re-render. The original tile from the
pack still has the vanilla terrain in those corners. Copy it back wherever
the new JPEG is near-black and the underlay is not.

Runs *after* the save overlay is composited, so anything the live world
draws is already on the tile and only genuinely unpainted pixels are left to
recover. That ordering is what removed the old open-door mask: there is no
longer a hole here that vanilla must be kept out of.
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
# A regional JPEG with unpainted corners is a sea of (0,0,0). Real Knox
# County tiles are almost never 15% pure black — even night-dark roofs sit
# well above this. Used to decide "this tile is the black rectangle, throw
# it away and put the original back".
BLACK_FRACTION = 0.15


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


def mostly_black(path: Path, fraction: float = BLACK_FRACTION) -> bool:
    """True when `fraction` of pixels are JPEG-black (unpainted corners)."""
    if Image is None or not path.is_file():
        return False
    im = Image.open(path)
    hist = im.convert("L").histogram()
    n = im.size[0] * im.size[1]
    if n <= 0:
        return False
    return sum(hist[: BLACK + 1]) / n >= fraction


def fill_one(new_path: Path, underlay_path: Path) -> bool:
    if Image is None:
        raise RuntimeError("Pillow is required to fill unpainted tile corners")
    if not new_path.is_file() or not underlay_path.is_file():
        return False
    new = Image.open(new_path).convert("RGB")
    old = Image.open(underlay_path).convert("RGB")
    if old.size != new.size:
        old = old.resize(new.size, Image.Resampling.LANCZOS)
    filled = Image.composite(new, old, _keep_mask(new))
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
