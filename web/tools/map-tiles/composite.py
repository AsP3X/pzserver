"""Alpha-composite save-layer tiles onto the vanilla base JPEGs.

`render save` paints the live world's objects onto a transparent PNG in the
same DZI grid. A B42 save chunk stores what the world changed -- doors,
windows, containers, what players put down -- not the lotpack geometry, so
the overlay is sparse: a handful of sprites per square at most, transparent
everywhere else. Blending it straight over vanilla is therefore safe, and is
all this does.

There is deliberately no pixel-space mask here. Clipping the overlay to the
ground diamond of each changed square used to be the "keep the town" guard,
but a PZ sprite is anchored bottom-centre and stands about three diamond
heights tall, so the clip threw away everything but the doorstep. The closed
door is suppressed one sprite at a time in the base render instead (see
save_skip.py), which leaves nothing for a mask to do.
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


def list_overlay_keys(save_dir: Path) -> list[tuple[int, int, int]]:
    """Every save-layer tile, for a full-county overlay that has no dirty.txt."""
    keys: list[tuple[int, int, int]] = []
    seen: set[tuple[int, int, int]] = set()
    if not save_dir.is_dir():
        return keys
    for level in save_dir.iterdir():
        if not level.is_dir() or not level.name.isdigit():
            continue
        z = int(level.name)
        for tile in level.iterdir():
            if tile.suffix.lower() not in OVERLAY_EXTS:
                continue
            x, _, y = tile.stem.partition("_")
            if not x.lstrip("-").isdigit() or not y.lstrip("-").isdigit():
                continue
            key = (z, int(x), int(y))
            if key not in seen:
                seen.add(key)
                keys.append(key)
    return keys


def covers_keys(keys: list[tuple[int, int, int]], save_dir: Path) -> bool:
    """True when at least one planned DZI tile has a save overlay file."""
    return any(overlay_path(save_dir, z, x, y) is not None for z, x, y in keys)


def composite_keys(dirty: Path, save_dir: Path) -> list[tuple[int, int, int]]:
    """Planned dirty/leaf keys plus every overlay file that actually exists.

    A region job's leaves are the cell AABB. Save sprites often land a couple
    of DZI tiles away, so walking *only* the leaves reports 0 composites.
    """
    text = dirty.read_text(encoding="utf-8") if dirty.is_file() else ""
    planned = parse_dirty(text) if text.strip() else []
    overlay_keys = list_overlay_keys(save_dir)
    if not planned:
        return overlay_keys
    seen = set(planned)
    keys = list(planned)
    for key in overlay_keys:
        if key not in seen:
            keys.append(key)
            seen.add(key)
    return keys


def extra_overlay_lines(dirty: Path, save_dir: Path) -> list[str]:
    """Overlay DZI keys that are not already in dirty/leaves, for packing."""
    have: set[str] = set()
    if dirty.is_file():
        for line in dirty.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                have.add(line)
    extra = []
    for z, x, y in list_overlay_keys(save_dir):
        line = f"{z}/{x}_{y}"
        if line not in have:
            extra.append(line)
    return extra


def composite(dirty: Path, base_dir: Path, save_dir: Path) -> int:
    painted = 0
    for z, x, y in composite_keys(dirty, save_dir):
        if composite_one(base_dir, save_dir, z, x, y):
            painted += 1
    return painted


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--covers":
        leaves = Path(sys.argv[2])
        save_dir = Path(sys.argv[3])
        text = leaves.read_text(encoding="utf-8") if leaves.is_file() else ""
        keys = parse_dirty(text) if text.strip() else []
        raise SystemExit(0 if covers_keys(keys, save_dir) else 1)
    if len(sys.argv) == 4 and sys.argv[1] == "--append-dirty":
        dirty = Path(sys.argv[2])
        extra = extra_overlay_lines(dirty, Path(sys.argv[3]))
        if extra:
            with dirty.open("a", encoding="utf-8") as handle:
                handle.write("\n".join(extra) + "\n")
            print(f"pack also {len(extra)} overlay tile(s) the cell AABB missed")
        raise SystemExit(0)
    if len(sys.argv) != 4:
        print(
            "usage: composite.py <dirty.txt> <base layer0_files> <save layer0_files>",
            file=sys.stderr,
        )
        print(
            "       composite.py --covers <leaves.txt> <save layer0_files>",
            file=sys.stderr,
        )
        print(
            "       composite.py --append-dirty <dirty.txt> <save layer0_files>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    dirty, base_dir, save_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    if not save_dir.is_dir():
        print(f"save overlay missing at {save_dir}; packing vanilla tiles")
        raise SystemExit(0)
    n = composite(dirty, base_dir, save_dir)
    print(f"composited {n} save tiles onto the base")
