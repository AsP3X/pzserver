#!/usr/bin/env python3
"""Bake atlas + occupancy + cell thumbs from lotpacks and texture packs.

Run inside the map-tiles image so pzmap2dzi can read cells and .pack files.
Does not write tiles.sqlite.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import multiprocessing
import os
import re
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from atlas import pack as pack_atlas
from iso import CELL
from occupancy import encode as encode_occupancy
from progress import Bar
from store import open_write, write_atlas, write_cell, write_meta
from thumbs import png_bytes, render_thumb, scale_stamp, thumb_scale

LOTPACK = re.compile(r"^world_(-?\d+)_(-?\d+)\.lotpack$")
# Compact per-cell occupancy while names are still strings (before atlas ids).
_NAMED = struct.Struct("<BBbH")

_load_cell = None
_THUMB_STAMPS: dict = {}
_THUMB_IDS: dict = {}
_THUMB_OXOY: dict = {}


def map_roots(maps: Path) -> list[Path]:
    if not maps.is_dir():
        return []
    roots = []
    for child in sorted(maps.iterdir()):
        if child.is_dir() and any(child.glob("world_*.lotpack")):
            roots.append(child)
    return roots


def worker_count() -> int:
    raw = os.environ.get("MAP_SPRITES_WORKERS", "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    return max(1, os.cpu_count() or 2)


def _mp_ctx():
    # The bake image is Linux; fork shares the pre-scaled stamp dict via COW.
    method = "fork" if sys.platform.startswith("linux") else "spawn"
    return multiprocessing.get_context(method)


def load_textures(texture_dir: Path):
    try:
        pzmap = Path("/opt/pzmap2dzi")
        if pzmap.is_dir() and str(pzmap) not in sys.path:
            sys.path.insert(0, str(pzmap))
        from pzmap2dzi.texture import TextureLibrary
    except Exception as error:
        print(f"FAIL: texture library unavailable: {error}", file=sys.stderr)
        raise SystemExit(1)

    lib = TextureLibrary(texture_path=[str(texture_dir)])
    packs = sorted(texture_dir.glob("*.pack"))
    if not packs:
        print(f"FAIL: no texture packs at {texture_dir}", file=sys.stderr)
        print(file=sys.stderr)
        print("The dedicated server install does not ship them. Copy a PZ", file=sys.stderr)
        print("client's media/texturepacks (about 527 MB, *.pack files) onto", file=sys.stderr)
        print("the host at data/server/media/texturepacks/, then retry", file=sys.stderr)
        print("make map-sprites. Same packs as make map-tiles. See", file=sys.stderr)
        print("docs/map-sprites.md.", file=sys.stderr)
        raise SystemExit(1)
    print(f"==> textures: {len(packs)} packs", flush=True)
    with Bar("packs", len(packs)) as bar:
        for pack in packs:
            # add_pack writes "Processing pages: n/m" with CR on stdout, which
            # fights the progress line on a merged docker log.
            with contextlib.redirect_stdout(io.StringIO()):
                lib.add_pack(str(pack))
            bar.tick(extra=pack.name)
        bar.finish()
    # Lotpack names like vegetation_trees_01_10 and jumbo_tree_01_0 are not in
    # the .pack files. pzmap2dzi blends real e_* / d_plants_1_* tiles for them.
    lib.config_plants(
        {
            "season": "summer2",
            "snow": False,
            "flower": False,
            "large_bush": False,
            "tree_size": 2,
            "jumbo_tree_size": 4,
            "jumbo_tree_type": 1,
        }
    )
    return lib


def _ensure_load_cell():
    global _load_cell
    if _load_cell is not None:
        return _load_cell
    try:
        pzmap = Path("/opt/pzmap2dzi")
        if pzmap.is_dir() and str(pzmap) not in sys.path:
            sys.path.insert(0, str(pzmap))
        from pzmap2dzi.cell import load_cell as load
    except Exception as error:
        print(f"FAIL: lotpack reader unavailable: {error}", file=sys.stderr)
        raise SystemExit(1)
    _load_cell = load
    return load


def load_cell(maps: Path, cx: int, cy: int):
    return _ensure_load_cell()(str(maps), cx, cy)


def cell_records(cell) -> list[tuple[int, int, int, str]]:
    """Occupied squares only. get_square over 256×256×z is the slow path."""
    if getattr(cell, "blocks", None) is not None and getattr(cell, "header", None):
        return _records_from_blocks(cell)
    return _records_from_squares(cell)


def _records_from_squares(cell) -> list[tuple[int, int, int, str]]:
    rows: list[tuple[int, int, int, str]] = []
    size = getattr(cell, "cell_size", CELL)
    z0 = getattr(cell, "minlayer", 0)
    z1 = getattr(cell, "maxlayer", 1)
    for z in range(z0, z1):
        for sx in range(size):
            for sy in range(size):
                tiles = cell.get_square(sx, sy, z)
                if not tiles:
                    continue
                for name in tiles:
                    if name:
                        rows.append((sx, sy, z, name))
    return rows


def _records_from_blocks(cell) -> list[tuple[int, int, int, str]]:
    """Same occupancy as get_square, without visiting empty z/rows."""
    rows: list[tuple[int, int, int, str]] = []
    tiles_index = cell.header["tiles"]
    block_size = cell.block_size
    bpc = cell.block_per_cell
    z0 = cell.minlayer
    z1 = cell.maxlayer
    for bi, block in enumerate(cell.blocks):
        if not block:
            continue
        bx = bi // bpc
        by = bi % bpc
        ox = bx * block_size
        oy = by * block_size
        n = len(block)
        for z in range(z0, z1):
            layer = block[z] if 0 <= z < n else None
            if not layer:
                continue
            for x, row in enumerate(layer):
                if not row:
                    continue
                sx = ox + x
                for y, tile_ids in enumerate(row):
                    if not tile_ids:
                        continue
                    sy = oy + y
                    for tid in tile_ids:
                        name = tiles_index[tid]
                        if name:
                            rows.append((sx, sy, z, name))
    return rows


def pack_named_rows(rows: list[tuple[int, int, int, str]]) -> tuple[list[str], bytes]:
    names: list[str] = []
    index: dict[str, int] = {}
    buf = bytearray(_NAMED.size * len(rows))
    offset = 0
    for lx, ly, z, name in rows:
        nid = index.get(name)
        if nid is None:
            nid = len(names)
            if nid > 65535:
                continue
            index[name] = nid
            names.append(name)
        _NAMED.pack_into(buf, offset, lx, ly, z, nid)
        offset += _NAMED.size
    return names, bytes(buf[:offset])


def iter_named_rows(names: list[str], blob: bytes):
    for offset in range(0, len(blob), _NAMED.size):
        lx, ly, z, nid = _NAMED.unpack_from(blob, offset)
        yield lx, ly, z, names[nid]


def merge_named(
    left: tuple[list[str], bytes], right: tuple[list[str], bytes]
) -> tuple[list[str], bytes]:
    rows = list(iter_named_rows(*left)) + list(iter_named_rows(*right))
    return pack_named_rows(rows)


def _init_scan() -> None:
    _ensure_load_cell()


def _scan_one(job: tuple[str, str, str]):
    root, map_name, filename = job
    match = LOTPACK.match(filename)
    if not match:
        return None
    cx, cy = int(match.group(1)), int(match.group(2))
    try:
        cell = load_cell(Path(root), cx, cy)
    except Exception as error:
        return ("err", map_name, cx, cy, str(error))
    if cell is None:
        return None
    rows = cell_records(cell)
    if not rows:
        return None
    names, blob = pack_named_rows(rows)
    z_min = min(z for _lx, _ly, z, _name in rows)
    z_max = max(z for _lx, _ly, z, _name in rows) + 1
    return ("ok", map_name, cx, cy, names, blob, z_min, z_max)


def _thumb_one(item):
    cx, cy, names, blob = item
    numbered = []
    blit = []
    for lx, ly, z, name in iter_named_rows(names, blob):
        sprite_id = _THUMB_IDS.get(name)
        if sprite_id is None:
            continue
        numbered.append((lx, ly, z, sprite_id))
        ox, oy = _THUMB_OXOY[name]
        blit.append((lx, ly, z, _THUMB_STAMPS[name], ox, oy))
    blit.sort(key=lambda row: (row[0] + row[1], row[2]))
    thumb = render_thumb(blit, cx, cy, pre_scaled=True)
    return cx, cy, encode_occupancy(numbered), thumb


def extract(maps: Path, textures: Path, out: Path, game_version: str) -> None:
    roots = map_roots(maps)
    if not roots:
        print(f"FAIL: no lotpacks under {maps}", file=sys.stderr)
        raise SystemExit(1)

    lotpacks: list[tuple[str, str, str]] = []
    for root in roots:
        for lotpack in sorted(root.glob("world_*.lotpack")):
            if LOTPACK.match(lotpack.name):
                lotpacks.append((str(root), root.name, lotpack.name))
    workers = worker_count()
    print(f"==> maps: {len(roots)}  lotpacks: {len(lotpacks)}  workers: {workers}", flush=True)

    cells: dict[tuple[int, int], tuple[list[str], bytes]] = {}
    unique: set[str] = set()
    z_min, z_max = 0, 0
    errors = 0
    chunksize = 8 if len(lotpacks) > 32 else 1
    with _mp_ctx().Pool(workers, initializer=_init_scan) as pool:
        with Bar("scan", len(lotpacks) or 1) as bar:
            iterator = (
                pool.imap_unordered(_scan_one, lotpacks, chunksize=chunksize)
                if lotpacks
                else []
            )
            for result in iterator:
                if result is None:
                    bar.tick()
                    continue
                if result[0] == "err":
                    _kind, map_name, cx, cy, message = result
                    errors += 1
                    print(f"FAIL: {map_name} {cx},{cy}: {message}", file=sys.stderr, flush=True)
                    bar.tick(extra=f"{map_name} {cx},{cy}")
                    continue
                _kind, map_name, cx, cy, names, blob, cell_z0, cell_z1 = result
                key = (cx, cy)
                packed = (names, blob)
                cells[key] = merge_named(cells[key], packed) if key in cells else packed
                unique.update(names)
                z_min = min(z_min, cell_z0)
                z_max = max(z_max, cell_z1)
                bar.tick(extra=f"{map_name} {cx},{cy}")
            bar.finish()
    if errors:
        print(f"==> scan errors: {errors} (those cells skipped)", flush=True)

    lib = load_textures(textures)
    used: dict[str, object] = {}
    missing: set[str] = set()
    names_sorted = sorted(unique)
    print(f"==> lookup {len(names_sorted)} tile names", flush=True)
    getter = getattr(lib, "get_by_name_ignore_filter", None) or lib.get_by_name
    with Bar("lookup", len(names_sorted) or 1) as bar:
        with contextlib.redirect_stdout(io.StringIO()):
            for name in names_sorted:
                texture = getter(name)
                if texture is not None and texture.im.size[0] > 0:
                    used[name] = texture
                else:
                    missing.add(name)
                bar.tick()
        bar.finish()

    if missing:
        sample = ", ".join(sorted(missing)[:8])
        more = "" if len(missing) <= 8 else f" (+{len(missing) - 8} more)"
        print(f"==> {len(missing)} textures not in the packs: {sample}{more}", flush=True)
    print(f"==> packing {len(used)} sprites", flush=True)
    sprite_list = [
        (name, texture.im, int(texture.ox), int(texture.oy)) for name, texture in used.items()
    ]
    pages, packed = pack_atlas(sprite_list)
    con = open_write(out)
    ids = write_atlas(con, [png_bytes(page) for page in pages], packed)

    reach = 0
    oxoy: dict[str, tuple[int, int]] = {}
    for sprite in packed:
        reach = max(reach, abs(sprite.ox) + sprite.w, abs(sprite.oy) + sprite.h)
        oxoy[sprite.name] = (sprite.ox, sprite.oy)

    scale = thumb_scale()
    stamps = {name: scale_stamp(texture.im, scale) for name, texture in used.items()}
    global _THUMB_STAMPS, _THUMB_IDS, _THUMB_OXOY
    _THUMB_STAMPS = stamps
    _THUMB_IDS = ids
    _THUMB_OXOY = oxoy

    items = sorted((cx, cy, names, blob) for (cx, cy), (names, blob) in cells.items())
    print(f"==> thumbs: {len(items)} cells", flush=True)
    thumb_chunk = 4 if len(items) > 16 else 1
    with _mp_ctx().Pool(workers) as pool:
        with Bar("cells", len(items) or 1) as bar:
            iterator = pool.imap_unordered(_thumb_one, items, chunksize=thumb_chunk) if items else []
            for cx, cy, occupancy, thumb in iterator:
                write_cell(con, cx, cy, occupancy, thumb)
                bar.tick(extra=f"{cx},{cy}")
            bar.finish()

    write_meta(
        con,
        {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "game_version": game_version,
            "pages": str(len(pages)),
            "sprites": str(len(packed)),
            "cells": str(len(cells)),
            "z_min": str(z_min),
            "z_max": str(z_max),
            "thumb_scale": "512",
            "max_reach": str(reach),
            "cell_size": str(CELL),
        },
    )
    con.commit()
    con.close()
    print(f"==> wrote {out}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Bake the sprite isometric catalogue")
    parser.add_argument("--maps", default=os.environ.get("PZ_MAPS", "/pz/media/maps"))
    parser.add_argument(
        "--textures",
        default=os.environ.get("PZ_TEXTUREPACKS", "/pz/media/texturepacks"),
    )
    parser.add_argument("--out", default=os.environ.get("MAP_SPRITES_PATH", "/sprites/sprites.sqlite"))
    parser.add_argument("--game-version", default=os.environ.get("PZ_GAME_VERSION", "unknown"))
    args = parser.parse_args()
    extract(Path(args.maps), Path(args.textures), Path(args.out), args.game_version)


if __name__ == "__main__":
    main()
