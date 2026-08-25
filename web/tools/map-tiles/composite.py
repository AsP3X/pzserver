"""Alpha-composite save-layer tiles onto the vanilla base JPEGs.

`render save` paints the live world's sprites onto a transparent PNG in the
same DZI grid. Occupied squares cover the original building; empty squares
stay transparent so never-visited land keeps the vanilla tile. Dirty keys
only — merge siblings stay untouched.

Doors and windows are the exception: an open door sprite is mostly a hole,
so compositing it over the vanilla closed door leaves the closed door
showing. Before blending, punch the isometric footprint of every save
chunk out of the vanilla tile so the overlay is the authority there.
"""
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    Image = None
    ImageDraw = None

OVERLAY_EXTS = (".png", ".webp", ".jpg", ".jpeg")


def overlay_path(save_dir: Path, z: int, x: int, y: int) -> Path | None:
    stem = save_dir / str(z) / f"{x}_{y}"
    for ext in OVERLAY_EXTS:
        path = Path(str(stem) + ext)
        if path.is_file():
            return path
    return None


def parse_dirty(text: str) -> list[tuple[int, int, int]]:
    keys = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        level, _, rest = line.partition("/")
        xs, _, ys = rest.partition("_")
        keys.append((int(level), int(xs), int(ys)))
    return keys


def composite_one(base_dir: Path, save_dir: Path, z: int, x: int, y: int, punch=None) -> bool:
    if Image is None:
        raise RuntimeError("Pillow is required to composite save tiles")
    overlay = overlay_path(save_dir, z, x, y)
    if overlay is None:
        return False
    dest = base_dir / str(z) / f"{x}_{y}.jpg"
    dest.parent.mkdir(parents=True, exist_ok=True)
    ov = Image.open(overlay).convert("RGBA")
    if dest.is_file():
        base = Image.open(dest).convert("RGBA")
        if ov.size != base.size:
            ov = ov.resize(base.size, Image.Resampling.LANCZOS)
        if punch:
            punch_save_footprint(base, punch, z, x, y)
        base.alpha_composite(ov)
        out = base
    else:
        out = ov
    out.convert("RGB").save(dest, quality=70, optimize=True)
    return True


def square_diamond(geo, wx: int, wy: int, w: int, h: int, level: int, tx: int, ty: int):
    """Tile-pixel quadrilateral of a world-square rect (iso parallelogram)."""
    span = geo.span(level)
    scale = geo.tile_size / span
    origin_x = tx * span
    origin_y = ty * span
    corners = (
        (wx, wy),
        (wx + w, wy),
        (wx + w, wy + h),
        (wx, wy + h),
    )
    pts = []
    for sx, sy in corners:
        px, py = geo.world_to_dzi(sx, sy)
        pts.append(((px - origin_x) * scale, (py - origin_y) * scale))
    return pts


def punch_save_footprint(base, punch, z: int, tx: int, ty: int) -> None:
    """Clear vanilla pixels under every save chunk's isometric footprint."""
    if ImageDraw is None:
        return
    geo, rects = punch
    size = base.size[0]
    mask = Image.new("L", base.size, 0)
    draw = ImageDraw.Draw(mask)
    drew = False
    for wx, wy, w, h in rects:
        pts = square_diamond(geo, wx, wy, w, h, z, tx, ty)
        if not any(-size <= px <= size * 2 and -size <= py <= size * 2 for px, py in pts):
            continue
        draw.polygon(pts, fill=255)
        drew = True
    if not drew:
        return
    clear = Image.new("RGBA", base.size, (0, 0, 0, 0))
    base.paste(clear, mask=mask)


def composite(dirty: Path, base_dir: Path, save_dir: Path, punch=None) -> int:
    keys = parse_dirty(dirty.read_text(encoding="utf-8"))
    painted = 0
    for z, x, y in keys:
        if composite_one(base_dir, save_dir, z, x, y, punch=punch):
            painted += 1
    return painted


if __name__ == "__main__":
    if len(sys.argv) not in (4, 6):
        print(
            "usage: composite.py <dirty.txt> <base layer0_files> <save layer0_files>"
            " [map_info.json save_squares.txt]",
            file=sys.stderr,
        )
        raise SystemExit(2)
    dirty, base_dir, save_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    if not save_dir.is_dir():
        print(f"save overlay missing at {save_dir}; packing vanilla tiles")
        raise SystemExit(0)
    punch = None
    if len(sys.argv) == 6:
        from cells import Geometry, parse_rects

        geo = Geometry.from_map_info(Path(sys.argv[4]))
        rects = parse_rects(Path(sys.argv[5]).read_text(encoding="utf-8"))
        punch = (geo, rects)
    n = composite(dirty, base_dir, save_dir, punch=punch)
    print(f"composited {n} save tiles onto the base")
