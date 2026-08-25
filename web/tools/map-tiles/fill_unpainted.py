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
    from PIL import Image, ImageChops, ImageDraw
except ImportError:  # pragma: no cover
    Image = None
    ImageChops = None
    ImageDraw = None

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


def _keep_open_holes(mask, punch, z: int, tx: int, ty: int) -> None:
    """Do not paste vanilla closed doors into skip/punch diamonds.

    Base render leaves those squares unpainted (JPEG-black) so the save
    overlay can own them. Filling from the underlay would put the closed
    sprite back, and compositing an open-door hole on top of it is a no-op.
    """
    if ImageDraw is None or not punch:
        return
    from composite import square_diamond

    geo, rects = punch
    draw = ImageDraw.Draw(mask)
    size = mask.size[0]
    for wx, wy, w, h in rects:
        pts = square_diamond(geo, wx, wy, w, h, z, tx, ty)
        if not any(-size <= px <= size * 2 and -size <= py <= size * 2 for px, py in pts):
            continue
        draw.polygon(pts, fill=255)


def fill_one(new_path: Path, underlay_path: Path, punch=None, z=None, x=None, y=None) -> bool:
    if Image is None:
        raise RuntimeError("Pillow is required to fill unpainted tile corners")
    if not new_path.is_file() or not underlay_path.is_file():
        return False
    new = Image.open(new_path).convert("RGB")
    old = Image.open(underlay_path).convert("RGB")
    if old.size != new.size:
        old = old.resize(new.size, Image.Resampling.LANCZOS)
    mask = _keep_mask(new)
    if punch is not None and z is not None:
        _keep_open_holes(mask, punch, z, x, y)
    filled = Image.composite(new, old, mask)
    filled.save(new_path, quality=70, optimize=True)
    return True


def fill(keys, new_dir: Path, underlay_dir: Path, punch=None) -> int:
    n = 0
    for z, x, y in keys:
        dest = new_dir / str(z) / f"{x}_{y}.jpg"
        src = underlay_dir / str(z) / f"{x}_{y}.jpg"
        if fill_one(dest, src, punch=punch, z=z, x=x, y=y):
            n += 1
    return n


if __name__ == "__main__":
    if len(sys.argv) not in (4, 6):
        print(
            "usage: fill_unpainted.py <leaves.txt> <layer0_files> <underlay dir>"
            " [map_info.json save_squares.txt]",
            file=sys.stderr,
        )
        raise SystemExit(2)
    keys = parse_keys(Path(sys.argv[1]).read_text(encoding="utf-8"))
    punch = None
    if len(sys.argv) == 6:
        from cells import Geometry, parse_rects

        geo = Geometry.from_map_info(Path(sys.argv[4]))
        rects = parse_rects(Path(sys.argv[5]).read_text(encoding="utf-8"))
        punch = (geo, rects)
    n = fill(keys, Path(sys.argv[2]), Path(sys.argv[3]), punch=punch)
    print(f"filled unpainted corners on {n} leaf tiles")
