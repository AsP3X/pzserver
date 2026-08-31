#!/usr/bin/env python3
"""Bake atlas + occupancy + cell thumbs from lotpacks and texture packs.

Run inside the map-tiles image so pzmap2dzi can read cells and .pack files.
Does not write tiles.sqlite.
"""

from __future__ import annotations

import argparse
import io
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from atlas import pack as pack_atlas
from iso import CELL
from store import open_write, write_atlas, write_cell, write_meta
from thumbs import render_thumb

LOTPACK = re.compile(r"^world_(-?\d+)_(-?\d+)\.lotpack$")


def map_roots(maps: Path) -> list[Path]:
    if not maps.is_dir():
        return []
    roots = []
    for child in sorted(maps.iterdir()):
        if child.is_dir() and any(child.glob("world_*.lotpack")):
            roots.append(child)
    return roots


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
        raise SystemExit(1)
    for pack in packs:
        print(f"==> pack {pack.name}", flush=True)
        lib.add_pack(str(pack))
    return lib


def load_cell(maps: Path, cx: int, cy: int):
    try:
        from pzmap2dzi.cell import load_cell as load
    except Exception as error:
        print(f"FAIL: lotpack reader unavailable: {error}", file=sys.stderr)
        raise SystemExit(1)
    return load(str(maps), cx, cy)


def cell_records(cell) -> list[tuple[int, int, int, str]]:
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


def png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def extract(maps: Path, textures: Path, out: Path, game_version: str) -> None:
    roots = map_roots(maps)
    if not roots:
        print(f"FAIL: no lotpacks under {maps}", file=sys.stderr)
        raise SystemExit(1)

    lib = load_textures(textures)
    used: dict[str, object] = {}
    cells: dict[tuple[int, int], list[tuple[int, int, int, str]]] = {}
    z_min, z_max = 0, 0

    for root in roots:
        print(f"==> map {root.name}", flush=True)
        for lotpack in sorted(root.glob("world_*.lotpack")):
            match = LOTPACK.match(lotpack.name)
            if not match:
                continue
            cx, cy = int(match.group(1)), int(match.group(2))
            cell = load_cell(root, cx, cy)
            if cell is None:
                continue
            rows = cell_records(cell)
            if not rows:
                continue
            key = (cx, cy)
            cells[key] = cells.get(key, []) + rows
            for _lx, _ly, z, name in rows:
                z_min = min(z_min, z)
                z_max = max(z_max, z + 1)
                if name not in used:
                    texture = lib.get_by_name(name)
                    if texture is not None and texture.im.size[0] > 0:
                        used[name] = texture

    sprite_list = [
        (name, texture.im, int(texture.ox), int(texture.oy)) for name, texture in used.items()
    ]
    pages, packed = pack_atlas(sprite_list)
    con = open_write(out)
    ids = write_atlas(con, [png_bytes(page) for page in pages], packed)
    page_map = {sprite.name: sprite for sprite in packed}

    reach = 0
    for sprite in packed:
        reach = max(reach, abs(sprite.ox) + sprite.w, abs(sprite.oy) + sprite.h)

    for (cx, cy), rows in sorted(cells.items()):
        numbered = []
        blit = []
        for lx, ly, z, name in rows:
            sprite_id = ids.get(name)
            if sprite_id is None:
                continue
            numbered.append((lx, ly, z, sprite_id))
            sprite = page_map[name]
            texture = used[name]
            blit.append((lx, ly, z, texture.im, sprite.ox, sprite.oy))
        blit.sort(key=lambda row: (row[0] + row[1], row[2]))
        thumb = render_thumb(blit, cx, cy)
        write_cell(con, cx, cy, numbered, thumb)
        print(f"    cell {cx},{cy} {len(numbered)} sprites", flush=True)

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
