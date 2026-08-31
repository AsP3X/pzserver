#!/usr/bin/env python3
"""Bake atlas + occupancy + cell thumbs from lotpacks and texture packs.

Run inside the map-tiles image so pzmap2dzi can read cells and .pack files.
Does not write tiles.sqlite.
"""

from __future__ import annotations

import argparse
import contextlib
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
from progress import Bar
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


def lookup_texture(lib, name):
    """Resolve a lotpack tile name. Older pzmap2dzi has no ignore-filter helper."""
    getter = getattr(lib, "get_by_name_ignore_filter", None) or lib.get_by_name
    with contextlib.redirect_stdout(io.StringIO()):
        return getter(name)


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
    missing: set[str] = set()
    cells: dict[tuple[int, int], list[tuple[int, int, int, str]]] = {}
    z_min, z_max = 0, 0

    lotpacks: list[tuple[Path, Path]] = []
    for root in roots:
        for lotpack in sorted(root.glob("world_*.lotpack")):
            if LOTPACK.match(lotpack.name):
                lotpacks.append((root, lotpack))
    print(f"==> maps: {len(roots)}  lotpacks: {len(lotpacks)}", flush=True)

    with Bar("scan", len(lotpacks) or 1) as bar:
        for root, lotpack in lotpacks:
            match = LOTPACK.match(lotpack.name)
            if not match:
                bar.tick()
                continue
            cx, cy = int(match.group(1)), int(match.group(2))
            cell = load_cell(root, cx, cy)
            if cell is None:
                bar.tick(extra=f"{cx},{cy}")
                continue
            rows = cell_records(cell)
            if rows:
                key = (cx, cy)
                cells[key] = cells.get(key, []) + rows
                for _lx, _ly, z, name in rows:
                    z_min = min(z_min, z)
                    z_max = max(z_max, z + 1)
                    if name not in used and name not in missing:
                        texture = lookup_texture(lib, name)
                        if texture is not None and texture.im.size[0] > 0:
                            used[name] = texture
                        else:
                            missing.add(name)
            bar.tick(extra=f"{root.name} {cx},{cy}")
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
    page_map = {sprite.name: sprite for sprite in packed}

    reach = 0
    for sprite in packed:
        reach = max(reach, abs(sprite.ox) + sprite.w, abs(sprite.oy) + sprite.h)

    items = sorted(cells.items())
    print(f"==> thumbs: {len(items)} cells", flush=True)
    with Bar("cells", len(items) or 1) as bar:
        for (cx, cy), rows in items:
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
