"""List the vanilla tiles the live save contradicts, per world square.

A door the player opened still has its *closed* sprite in the lotpack, and
vanilla paints it. The save layer then draws the open sprite, which is mostly
a hole, so the closed door shows through. The fix is to stop vanilla painting
that one tile — not the whole square.

Skipping the whole square is what put black notches in the map: a square
carries its floor and its wall as well as its door, and the save chunk only
stores the door. Drop the floor and the wall and nothing paints them back.

So each entry here is `x,y,tile-name`: suppress *that* sprite at *that*
square and leave everything else on it alone.

Names come from the lotpack, not from chunk sprite ids. B42 saves write ids
in the old file-0 space (`fixtures_doors_01_0` is 11264) while
`load_tile_defs` numbers `newtiledefinitions.tiles` from 110000. Using the
id map paints window frames on roads. The lotpack already has the closed
leaf's name on that square.
"""
from __future__ import annotations

import sys
from pathlib import Path

from chunk_sprites import _flag, _is_open, visual_sprite_id
from chunks import iter_chunks
from lotpack_leaves import leaves_for


def _default_id(obj):
    wrapper = getattr(obj, "object", obj)
    base = getattr(wrapper, "base_object", None)
    return getattr(base, "sprite_id", None) if base is not None else None


def _sprite_key(sid):
    """Sprite ids arrive as ints or as kaitai wrappers around one."""
    if hasattr(sid, "value") and not isinstance(sid, (int, float)):
        sid = sid.value
    return sid if isinstance(sid, int) else None


def load_tiledef(save: Path, pz_root: str | None, mod_root: str | None) -> dict:
    """`sprite id -> tile name`, the same map the save renderer builds.

    Missing pieces are not fatal: an unresolved id simply means we cannot
    name the tile to suppress, and vanilla keeps painting it.
    """
    import pzdataspec.utils as utils

    tiledef: dict = {}
    if pz_root:
        try:
            tiledef.update(utils.load_tile_defs(pz_root, mod_root or None, 42))
        except Exception as error:  # pragma: no cover - depends on game files
            print(f"tile defs unavailable: {error}", file=sys.stderr)
    world_dict = save / "WorldDictionary.bin"
    if world_dict.is_file():
        try:
            tiledef.update(utils.load_world_dict_sprites(str(world_dict), 42))
        except Exception as error:  # pragma: no cover - depends on save files
            print(f"world dictionary sprites unavailable: {error}", file=sys.stderr)
    return tiledef


CELL_SIZE = 256


def _lotpack_stale(obj) -> bool:
    """True when vanilla lotpack still shows the closed/intact sprite.

    An open IsoDoor writes the *open* id as `sprite_id`, so visual_sprite_id
    equals the default and the old `visual != default` check skipped nothing.
    The lotpack name is still the closed leaf. Use the open/smashed flags.
    """
    wrapper = getattr(obj, "object", obj)
    sub = getattr(wrapper, "subclass_object", None)
    kind = _kind(obj)
    if kind in ("door", "curtain"):
        return sub is not None and _is_open(sub)
    if kind == "window" and sub is not None:
        return (
            _flag(getattr(sub, "open", 0))
            or _flag(getattr(sub, "destroyed", 0))
            or _flag(getattr(sub, "glass_removed", 0))
        )
    return visual_sprite_id(obj) != _default_id(obj)


def _kind(obj) -> str | None:
    """door / window / curtain, from the subclass the chunk parser built."""
    wrapper = getattr(obj, "object", obj)
    sub = getattr(wrapper, "subclass_object", None)
    cid = getattr(wrapper, "class_id", None)
    if sub is None and cid is None:
        return None
    if hasattr(sub, "other_sprite_id") and hasattr(sub, "barricade_strength"):
        return "curtain"
    if hasattr(sub, "destroyed") and hasattr(sub, "glass_removed"):
        return "window"
    if hasattr(sub, "curtain_flags") and (
        hasattr(sub, "open_sprite_id") or hasattr(sub, "closed_sprite_id")
    ):
        return "door"
    if cid == 26:
        return "window"
    if cid == 17:
        return "door"
    return None


def _lotpack_square(map_root: Path, cache: dict, wx: int, wy: int) -> list[str]:
    """Tile names the vanilla lotpack paints at this world square, layer 0."""
    cx, sx = divmod(wx, CELL_SIZE)
    cy, sy = divmod(wy, CELL_SIZE)
    key = (cx, cy)
    if key not in cache:
        try:
            # `python /tools/open_squares.py` puts /tools on sys.path[0], not cwd.
            pzmap = Path("/opt/pzmap2dzi")
            if pzmap.is_dir() and str(pzmap) not in sys.path:
                sys.path.insert(0, str(pzmap))
            from pzmap2dzi.cell import load_cell
        except Exception as error:
            print(f"lotpack reader unavailable: {error}", file=sys.stderr)
            cache[key] = None
            return []
        cache[key] = load_cell(str(map_root), cx, cy)
    cell = cache[key]
    if cell is None:
        return []
    tiles = cell.get_square(sx, sy, 0)
    return list(tiles) if tiles else []


def open_squares(
    save: Path,
    tiledef: dict,
    map_root: Path | None = None,
) -> list[tuple[int, int, str]]:
    """`(world x, world y, tile name)` for every sprite the save overrides."""
    import pzdataspec.utils as utils

    found: list[tuple[int, int, str]] = []
    seen: set[tuple[int, int, str]] = set()
    unresolved = 0
    cells: dict = {}
    for cx, cy, unit, blob in iter_chunks(save):
        try:
            data = utils.load_chunk(str(blob), version=42)
        except Exception:
            continue
        raw = data.raw
        bs = int(raw.block_size)
        for idx, square in enumerate(raw.squares):
            lx, ly = divmod(idx, bs)
            wx, wy = cx * unit + lx, cy * unit + ly
            lot: list[str] | None = None
            for grid_square in square.squares:
                for obj in grid_square.objects:
                    if not _lotpack_stale(obj):
                        continue
                    default = _default_id(obj)
                    names: list[str] = []
                    kind = _kind(obj)
                    if map_root is not None and kind:
                        if lot is None:
                            lot = _lotpack_square(map_root, cells, wx, wy)
                        names = leaves_for(kind, lot)
                    if not names:
                        key = _sprite_key(default)
                        name = tiledef.get(key) if key is not None else None
                        if name:
                            names = [name]
                    if not names:
                        unresolved += 1
                        continue
                    for name in names:
                        entry = (wx, wy, name)
                        if entry not in seen:
                            seen.add(entry)
                            found.append(entry)
    if unresolved:
        print(f"open-square scan: {unresolved} sprite(s) had no tile name; vanilla keeps them")
    return found


def write_squares(path: Path, squares) -> None:
    path.write_text(
        "".join(f"{x},{y},{name}\n" for x, y, name in squares), encoding="utf-8"
    )


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4, 5, 6):
        print(
            "usage: open_squares.py <save snapshot> <out.txt> [pz_root] [mod_root] [map_root]",
            file=sys.stderr,
        )
        raise SystemExit(2)
    save, dest = Path(sys.argv[1]), Path(sys.argv[2])
    pz_root = sys.argv[3] if len(sys.argv) > 3 else None
    mod_root = sys.argv[4] if len(sys.argv) > 4 else None
    map_root = Path(sys.argv[5]) if len(sys.argv) > 5 else None
    if map_root is None and pz_root:
        candidate = Path(pz_root) / "media" / "maps" / "Muldraugh, KY"
        if candidate.is_dir():
            map_root = candidate
    try:
        tiledef = load_tiledef(save, pz_root, mod_root)
        squares = open_squares(save, tiledef, map_root=map_root)
    except Exception as error:
        print(f"open-square scan skipped: {error}", file=sys.stderr)
        dest.write_text("", encoding="utf-8")
        raise SystemExit(0)
    write_squares(dest, squares)
    print(f"open-square skip: {len(squares)} sprite(s) on {len({(x, y) for x, y, _ in squares})} square(s)")
