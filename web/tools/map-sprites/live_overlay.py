"""Live save-state patches for the sprite map.

Doors, windows, curtains, trees and burnt/replaced floors from B42 chunks,
mapped onto atlas ids in sprites.sqlite. The client swaps occupancy sprites
instead of re-rendering JPEG tiles.

Binary: magic `LIVE`, u32 unix mtime, u32 count, then count records of
`{ wx:u16, wy:u16, z:i8, pad:u8, remove:u32, add:u32 }`.
`remove` hides that atlas id on the square; `add` 0 means a hole (open door).
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import struct
import sys
import time
from pathlib import Path

from occupancy import decode as decode_occupancy

CELL = 256
MAGIC = b"LIVE"
HEADER = struct.Struct("<4sII")
RECORD = struct.Struct("<HHbBII")


def _tools_on_path() -> None:
    here = Path(__file__).resolve().parent
    tools = here.parent / "map-tiles"
    for path in (here, tools, Path("/tools")):
        text = str(path)
        if path.is_dir() and text not in sys.path:
            sys.path.insert(0, text)


_tools_on_path()


def encode(mtime: int, rows: list[tuple[int, int, int, int, int]]) -> bytes:
    out = bytearray(HEADER.size + RECORD.size * len(rows))
    HEADER.pack_into(out, 0, MAGIC, mtime & 0xFFFFFFFF, len(rows))
    offset = HEADER.size
    for wx, wy, z, remove, add in rows:
        RECORD.pack_into(
            out,
            offset,
            wx & 0xFFFF,
            wy & 0xFFFF,
            int(z),
            0,
            remove & 0xFFFFFFFF,
            add & 0xFFFFFFFF,
        )
        offset += RECORD.size
    return bytes(out)


def decode(blob: bytes) -> tuple[int, list[tuple[int, int, int, int, int]]]:
    if len(blob) < HEADER.size:
        raise ValueError("live overlay too short")
    magic, mtime, count = HEADER.unpack_from(blob, 0)
    if magic != MAGIC:
        raise ValueError(f"bad live overlay magic {magic!r}")
    need = HEADER.size + RECORD.size * count
    if len(blob) < need:
        raise ValueError("live overlay truncated")
    rows = []
    offset = HEADER.size
    for _ in range(count):
        wx, wy, z, _pad, remove, add = RECORD.unpack_from(blob, offset)
        rows.append((wx, wy, z, remove, add))
        offset += RECORD.size
    return mtime, rows


class OccupancyIndex:
    def __init__(self, con: sqlite3.Connection):
        self.con = con
        self.names = {int(i): str(n) for i, n in con.execute("SELECT id, name FROM sprites")}
        self.ids = {n: i for i, n in self.names.items()}
        self._cells: dict[tuple[int, int], list[tuple[int, int, int, int]]] = {}

    def sprites_at(self, wx: int, wy: int, z: int) -> list[tuple[int, str]]:
        cx, lx = divmod(wx, CELL)
        cy, ly = divmod(wy, CELL)
        out: list[tuple[int, str]] = []
        for olx, oly, oz, sid in self._cell(cx, cy):
            if olx == lx and oly == ly and oz == z:
                out.append((sid, self.names.get(sid, "")))
        return out

    def _cell(self, cx: int, cy: int) -> list[tuple[int, int, int, int]]:
        key = (cx, cy)
        if key in self._cells:
            return self._cells[key]
        row = self.con.execute(
            "SELECT occupancy FROM cells WHERE cx = ? AND cy = ?", (cx, cy)
        ).fetchone()
        records: list[tuple[int, int, int, int]] = []
        if row and row[0]:
            try:
                records = decode_occupancy(bytes(row[0]))
            except ValueError:
                records = []
        self._cells[key] = records
        return records


def visual_name(obj, leaf: str, mapping: dict, tiledef: dict) -> str | None:
    from chunk_sprites import visual_sprite_id
    from tiledef_map import sibling_name

    vis = visual_sprite_id(obj)
    if vis is None:
        return None
    if hasattr(vis, "value") and not isinstance(vis, (int, float)):
        vis = vis.value
    if not isinstance(vis, int):
        return None
    named = mapping.get(vis) or tiledef.get(vis)
    if named:
        return named
    return sibling_name(leaf, 2)


def patch_object(
    wx: int,
    wy: int,
    z: int,
    obj,
    occ: OccupancyIndex,
    mapping: dict,
    tiledef: dict,
) -> list[tuple[int, int, int, int, int]]:
    from chunk_sprites import overlay_kind, visual_sprite_id
    from lotpack_leaves import leaves_for
    from open_squares import _default_id, _lotpack_stale

    if not _lotpack_stale(obj):
        return []
    kind = overlay_kind(obj)
    here = [name for _sid, name in occ.sprites_at(wx, wy, z) if name]
    leaves: list[str] = []
    if kind:
        leaves = leaves_for(kind, here)
    if not leaves:
        default = _default_id(obj)
        if visual_sprite_id(obj) != default:
            leaves = leaves_for("wall", here) or leaves_for("floor", here)
    if not leaves:
        return []
    out = []
    vis = visual_sprite_id(obj)
    for name in leaves:
        remove = occ.ids.get(name, 0)
        add = 0
        if vis is not None:
            add_name = visual_name(obj, name, mapping, tiledef)
            if add_name:
                add = occ.ids.get(add_name, 0)
        if add == remove:
            add = 0
        if remove or add:
            out.append((wx, wy, z, remove, add))
    return out


def walk_layers(square):
    flags = getattr(square, "layer_flags", 0) or 0
    layer = 0
    bit = 1
    for grid in getattr(square, "squares", []) or []:
        while layer < 16 and (flags & bit) == 0:
            bit <<= 1
            layer += 1
        yield layer, getattr(grid, "objects", []) or []
        bit <<= 1
        layer += 1


def build(
    save: Path,
    sprites: Path,
    pz_root: Path | None = None,
) -> tuple[int, list[tuple[int, int, int, int, int]]]:
    from chunks import iter_chunks
    from open_squares import load_tiledef, record_unique_leaf

    mtime = int(time.time())
    if not sprites.is_file():
        return mtime, []
    con = sqlite3.connect(f"file:{sprites.as_posix()}?mode=ro", uri=True)
    occ = OccupancyIndex(con)
    mapping: dict = {}
    tiledef: dict = {}
    try:
        tiledef = load_tiledef(save, str(pz_root) if pz_root else None, None)
    except Exception as error:
        print(f"live overlay: tiledef skipped ({error})", flush=True)
    rows: list[tuple[int, int, int, int, int]] = []
    seen: set[tuple[int, int, int, int, int]] = set()
    try:
        import pzdataspec.utils as utils
    except Exception as error:
        print(f"live overlay: pzdataspec unavailable ({error})", flush=True)
        con.close()
        return mtime, []
    newest = 0
    for cx, cy, unit, blob in iter_chunks(save):
        try:
            newest = max(newest, int(blob.stat().st_mtime))
            data = utils.load_chunk(str(blob), version=42)
        except Exception:
            continue
        raw = data.raw
        bs = int(raw.block_size)
        origin_x, origin_y = cx * unit, cy * unit
        for idx, square in enumerate(raw.squares):
            lx, ly = divmod(idx, bs)
            wx, wy = origin_x + lx, origin_y + ly
            for z, objs in walk_layers(square):
                if not objs:
                    continue
                names = [n for _sid, n in occ.sprites_at(wx, wy, z)]
                for kind in ("door", "window", "curtain", "tree", "thumpable"):
                    record_unique_leaf(mapping, objs, names, kind)
                for obj in objs:
                    for patch in patch_object(wx, wy, z, obj, occ, mapping, tiledef):
                        if patch not in seen:
                            seen.add(patch)
                            rows.append(patch)
    con.close()
    if newest:
        mtime = newest
    print(f"live overlay: {len(rows)} patch(es)", flush=True)
    return mtime, rows


def write(path: Path, mtime: int, rows: list[tuple[int, int, int, int, int]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(encode(mtime, rows))
    tmp.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build live sprite-map overlays from the save")
    parser.add_argument("--save", default=os.environ.get("PZ_SAVE_PATH", ""))
    parser.add_argument("--sprites", default="/sprites/sprites.sqlite")
    parser.add_argument("--out", default="/sprites/live.bin")
    parser.add_argument("--pz", default=os.environ.get("PZ_ROOT", "/pz"))
    args = parser.parse_args()
    save = Path(args.save) if args.save else _default_save()
    sprites = Path(args.sprites)
    out = Path(args.out)
    pz = Path(args.pz) if args.pz else None
    if not save.is_dir():
        print(f"live overlay: no save at {save}", flush=True)
        write(out, int(time.time()), [])
        return
    mtime, rows = build(save, sprites, pz)
    write(out, mtime, rows)


def _default_save() -> Path:
    game = os.environ.get("PZ_SAVE_GAME", "Multiplayer/ZomboidServer")
    root = Path(os.environ.get("PZ_SAVES", "/saves"))
    return root.joinpath(*[part for part in game.replace("\\", "/").split("/") if part])


if __name__ == "__main__":
    main()
