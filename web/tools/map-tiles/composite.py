"""Alpha-composite save-layer tiles onto the vanilla base JPEGs.

`render save` paints the live world's sprites onto a transparent PNG in the
same DZI grid. Occupied squares cover the original building; empty squares
stay transparent so never-visited land keeps the vanilla tile. Dirty keys
only — merge siblings stay untouched.
"""
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

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


def composite_one(base_dir: Path, save_dir: Path, z: int, x: int, y: int) -> bool:
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
        base.alpha_composite(ov)
        out = base
    else:
        out = ov
    out.convert("RGB").save(dest, quality=70, optimize=True)
    return True


def composite(dirty: Path, base_dir: Path, save_dir: Path) -> int:
    keys = parse_dirty(dirty.read_text(encoding="utf-8"))
    painted = 0
    for z, x, y in keys:
        if composite_one(base_dir, save_dir, z, x, y):
            painted += 1
    return painted


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(
            "usage: composite.py <dirty.txt> <base layer0_files> <save layer0_files>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    dirty, base_dir, save_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    if not save_dir.is_dir():
        print(f"save overlay missing at {save_dir}; packing vanilla tiles")
        raise SystemExit(0)
    n = composite(dirty, base_dir, save_dir)
    print(f"composited {n} save tiles onto the base")
