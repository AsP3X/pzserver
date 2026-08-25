"""List the vanilla tiles the live save contradicts, per world square.

A door the player opened still has its *closed* sprite in the lotpack, and
vanilla paints it. The save layer then draws the open sprite, which is mostly
a hole, so the closed door shows through. The fix is to stop vanilla painting
that one tile — not the whole square.

Skipping the whole square is what put black notches in the map: a square
carries its floor and its wall as well as its door, and the save chunk only
stores the door. Drop the floor and the wall and nothing paints them back.

So each entry here is `x,y,tile-name`: suppress *that* sprite at *that*
square and leave everything else on it alone. Names come from the same
`load_tile_defs` + `WorldDictionary` map the save renderer resolves sprite
ids through, so they match what the lotpack hands `BaseRender.square`.
"""
from __future__ import annotations

import sys
from pathlib import Path

from chunk_sprites import visual_sprite_id
from chunks import iter_chunks


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


def open_squares(save: Path, tiledef: dict) -> list[tuple[int, int, str]]:
    """`(world x, world y, tile name)` for every sprite the save overrides."""
    import pzdataspec.utils as utils

    found: list[tuple[int, int, str]] = []
    seen: set[tuple[int, int, str]] = set()
    unresolved = 0
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
            for grid_square in square.squares:
                for obj in grid_square.objects:
                    default = _default_id(obj)
                    if visual_sprite_id(obj) == default:
                        continue
                    key = _sprite_key(default)
                    name = tiledef.get(key) if key is not None else None
                    if not name:
                        unresolved += 1
                        continue
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
    if len(sys.argv) not in (3, 4, 5):
        print(
            "usage: open_squares.py <save snapshot> <out.txt> [pz_root] [mod_root]",
            file=sys.stderr,
        )
        raise SystemExit(2)
    save, dest = Path(sys.argv[1]), Path(sys.argv[2])
    pz_root = sys.argv[3] if len(sys.argv) > 3 else None
    mod_root = sys.argv[4] if len(sys.argv) > 4 else None
    try:
        tiledef = load_tiledef(save, pz_root, mod_root)
        squares = open_squares(save, tiledef)
    except Exception as error:
        print(f"open-square scan skipped: {error}", file=sys.stderr)
        dest.write_text("", encoding="utf-8")
        raise SystemExit(0)
    write_squares(dest, squares)
    print(f"open-square skip: {len(squares)} sprite(s) on {len({(x, y) for x, y, _ in squares})} square(s)")
