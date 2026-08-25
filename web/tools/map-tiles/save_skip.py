"""Which vanilla sprites the save overrides, looked up per world square.

Read by the patched `BaseRender.square` (see patch_base_skip.py) once per
worker process. The file is `x,y,tile-name` lines from open_squares.py.

Suppressing the named tile and nothing else is the point: the square keeps
its floor and its wall, so the only thing missing from the vanilla paint is
the closed door the save layer is about to redraw open.
"""
from pathlib import Path

_MAP: dict[tuple[int, int], frozenset[str]] | None = None
SQUARES_FILE = Path("/tmp/save_skip.txt")


def parse(text: str) -> dict[tuple[int, int], frozenset[str]]:
    """`"10,20,walls_doors_01_12\\n"` -> `{(10, 20): {"walls_doors_01_12"}}`."""
    out: dict[tuple[int, int], set[str]] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        # Split twice only: a tile name is free to contain commas.
        parts = line.split(",", 2)
        if len(parts) != 3:
            raise ValueError(f"save-skip line must be x,y,name -- got {line!r}")
        x, y, name = int(parts[0]), int(parts[1]), parts[2].strip()
        if name:
            out.setdefault((x, y), set()).add(name)
    return {key: frozenset(names) for key, names in out.items()}


def load_map(path: Path = SQUARES_FILE) -> dict[tuple[int, int], frozenset[str]]:
    if not path.is_file():
        print(f"save-square skip: {path} missing; vanilla closed doors will show")
        return {}
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        print(f"save-square skip: {path} empty; vanilla closed doors will show")
        return {}
    mapping = parse(text)
    print(f"save-square skip: {sum(len(v) for v in mapping.values())} sprite(s) on {len(mapping)} square(s) from {path}")
    return mapping


def suppressed(sx: int, sy: int, mapping=None) -> frozenset[str]:
    """Tile names vanilla must not paint at world square (sx, sy)."""
    global _MAP
    if mapping is None:
        if _MAP is None:
            _MAP = load_map()
        mapping = _MAP
    return mapping.get((sx, sy), frozenset())
