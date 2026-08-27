"""Map B42 save-chunk sprite ids to lotpack tile names.

`load_tile_defs` numbers newtiledefinitions.tiles from 110000 with page 1000.
The save still writes the old file-0 ids (`fixtures_doors_01_0` is 11264).
Using the built-in map paints the wrong sheet. The lotpack has the names;
one unique door/window match anchors a whole 512-wide sheet.
"""
from __future__ import annotations


PAGE = 512


def split_name(name: str) -> tuple[str, int] | None:
    prefix, sep, idx = name.rpartition("_")
    if not sep or not idx.isdigit():
        return None
    return prefix, int(idx)


def sibling_name(name: str, delta: int) -> str:
    parts = split_name(name)
    if parts is None:
        return name
    prefix, idx = parts
    return f"{prefix}_{idx + delta}"


def expand_sheet(mapping: dict[int, str], sprite_id: int, name: str) -> None:
    """Record only the id the lotpack actually confirmed.

    This used to stamp `PAGE` (512) consecutive ids from a single anchor, on
    the assumption that a sheet fills a whole page. It does not: a real sheet
    is tens of tiles, so the other 511 ids were asserted without evidence and
    landed on whatever sheets happened to follow — floors, walls, vegetation.
    The save renderer then drew those objects as doors and windows, which is
    the map covered in door and window sprites.

    One lotpack match is evidence about one id. Anything else stays unmapped,
    and an unmapped id is simply not painted by the overlay.
    """
    mapping[sprite_id] = name


def write_map(path, mapping: dict[int, str]) -> None:
    lines = "".join(f"{i},{n}\n" for i, n in sorted(mapping.items()))
    path.write_text(lines, encoding="utf-8")


def read_map(path) -> dict[int, str]:
    out: dict[int, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or "," not in line:
            continue
        sid, name = line.split(",", 1)
        if sid.lstrip("-").isdigit() and name:
            out[int(sid)] = name
    return out


def merge_into(tiledef: dict, extra: dict[int, str]) -> int:
    """Overwrite tiledef with correlated ids. Returns how many keys landed."""
    n = 0
    for sid, name in extra.items():
        tiledef[sid] = name
        n += 1
    return n
