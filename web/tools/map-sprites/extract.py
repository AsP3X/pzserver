#!/usr/bin/env python3
"""Bake atlas + occupancy + cell thumbs from lotpacks and texture packs.

Run inside the map-tiles image so pzmap2dzi can read cells and .pack files.
Does not write tiles.sqlite.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import multiprocessing
import os
import re
import signal
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from atlas import pack as pack_atlas
from iso import CELL
from occupancy import encode as encode_occupancy
from progress import Bar
from store import (
    bake_get,
    bake_set,
    load_sprite_ids,
    load_sprite_oxoy,
    open_work,
    publish_work,
    reset_work,
    work_path,
    write_atlas,
    write_cell,
    write_meta,
    written_cells,
)
from thumbs import png_bytes, render_thumb, scale_stamp, thumb_scale

LOTPACK = re.compile(r"^world_(-?\d+)_(-?\d+)\.lotpack$")
# Compact per-cell occupancy while names are still strings (before atlas ids).
_NAMED = struct.Struct("<BBbH")

_load_cell = None
_THUMB_STAMPS: dict = {}
_THUMB_IDS: dict = {}
_THUMB_OXOY: dict = {}
_COMMIT_EVERY = 8


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


class StopFlag:
    def __init__(self) -> None:
        self.stop = False

    def arm(self) -> None:
        signal.signal(signal.SIGINT, self._on)
        signal.signal(signal.SIGTERM, self._on)

    def _on(self, signum: int, _frame: object) -> None:
        if self.stop:
            sys.stderr.write("\n==> second interrupt: aborting without a further checkpoint\n")
            sys.stderr.flush()
            os._exit(130)
        self.stop = True
        name = "Ctrl+C" if signum == signal.SIGINT else "SIGTERM"
        sys.stderr.write(
            f"\n==> {name}: writing checkpoint. Re-run make map-sprites to resume.\n"
        )
        sys.stderr.flush()


def _ignore_signals() -> None:
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)


def fingerprint(lotpacks: list[tuple[str, str, str]], textures: Path, game_version: str) -> str:
    digest = hashlib.sha256()
    digest.update(game_version.encode())
    digest.update(b"\n")
    for root, map_name, filename in lotpacks:
        path = Path(root) / filename
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        digest.update(f"{map_name}/{filename}:{size}\n".encode())
    if textures.is_dir():
        for pack in sorted(textures.glob("*.pack")):
            try:
                size = pack.stat().st_size
            except OSError:
                size = 0
            digest.update(f"pack:{pack.name}:{size}\n".encode())
    return digest.hexdigest()


def job_coords(filename: str) -> tuple[int, int] | None:
    match = LOTPACK.match(filename)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


class Checkpointer:
    def __init__(self, con) -> None:
        self.con = con
        self.pending = 0

    def persist_scan(
        self,
        map_name: str,
        cx: int,
        cy: int,
        *,
        empty: bool,
        names: list[str] | None = None,
        blob: bytes | None = None,
        z_min: int = 0,
        z_max: int = 0,
    ) -> None:
        self.con.execute(
            """INSERT OR REPLACE INTO scan_cell
               (map_name, cx, cy, empty, names, blob, z_min, z_max)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                map_name,
                cx,
                cy,
                1 if empty else 0,
                json.dumps(names) if names is not None else None,
                blob,
                z_min,
                z_max,
            ),
        )
        self.flush()

    def flush(self, *, force: bool = False) -> None:
        if not force:
            self.pending += 1
            if self.pending < _COMMIT_EVERY:
                return
        self.con.commit()
        self.pending = 0

    def load_scan(
        self,
    ) -> tuple[
        dict[tuple[int, int], tuple[list[str], bytes]],
        set[str],
        int,
        int,
        set[tuple[str, int, int]],
    ]:
        cells: dict[tuple[int, int], tuple[list[str], bytes]] = {}
        unique: set[str] = set()
        z_min, z_max = 0, 0
        done: set[tuple[str, int, int]] = set()
        rows = self.con.execute(
            "SELECT map_name, cx, cy, empty, names, blob, z_min, z_max FROM scan_cell"
        )
        for map_name, cx, cy, empty, names_json, blob, cell_z0, cell_z1 in rows:
            done.add((str(map_name), int(cx), int(cy)))
            if empty:
                continue
            names = json.loads(names_json)
            packed = (list(names), bytes(blob or b""))
            key = (int(cx), int(cy))
            cells[key] = merge_named(cells[key], packed) if key in cells else packed
            unique.update(names)
            z_min = min(z_min, int(cell_z0))
            z_max = max(z_max, int(cell_z1))
        return cells, unique, z_min, z_max, done


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
    _ignore_signals()
    _ensure_load_cell()


def _init_thumbs() -> None:
    _ignore_signals()


def _scan_one(job: tuple[str, str, str]):
    root, map_name, filename = job
    coords = job_coords(filename)
    if not coords:
        return None
    cx, cy = coords
    try:
        cell = load_cell(Path(root), cx, cy)
    except Exception as error:
        return ("err", map_name, cx, cy, str(error))
    if cell is None:
        return ("skip", map_name, cx, cy)
    rows = cell_records(cell)
    if not rows:
        return ("skip", map_name, cx, cy)
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


def _pause(check: Checkpointer, bar: Bar | None, _stop: StopFlag, done: int, total: int) -> None:
    if bar is not None:
        bar.interrupt()
    check.flush(force=True)
    print(f"==> paused at {done}/{total}. Re-run make map-sprites to resume.", flush=True)
    raise SystemExit(130)


def extract(maps: Path, textures: Path, out: Path, game_version: str) -> None:
    roots = map_roots(maps)
    if not roots:
        print(f"FAIL: no lotpacks under {maps}", file=sys.stderr)
        raise SystemExit(1)

    lotpacks: list[tuple[str, str, str]] = []
    sizes: dict[tuple[str, int, int], int] = {}
    for root in roots:
        for lotpack in sorted(root.glob("world_*.lotpack")):
            coords = job_coords(lotpack.name)
            if not coords:
                continue
            cx, cy = coords
            lotpacks.append((str(root), root.name, lotpack.name))
            try:
                size = lotpack.stat().st_size
            except OSError:
                size = 1
            sizes[(root.name, cx, cy)] = max(1, size)

    workers = worker_count()
    sig = fingerprint(lotpacks, textures, game_version)
    work = work_path(out)
    print(f"==> maps: {len(roots)}  lotpacks: {len(lotpacks)}  workers: {workers}", flush=True)
    print("==> Ctrl+C checkpoints; re-run make map-sprites to resume", flush=True)

    if work.is_file():
        con = open_work(work)
        stored = bake_get(con, "fingerprint")
        if stored is not None and stored != sig:
            print("==> maps or textures changed; starting a new bake", flush=True)
            con.close()
            con = reset_work(work)
            stored = None
    else:
        con = open_work(work)
        stored = None

    if stored != sig:
        bake_set(con, "fingerprint", sig)
        bake_set(con, "stage", "scan")
        con.commit()
    elif bake_get(con, "stage") is None:
        bake_set(con, "stage", "scan")
        con.commit()

    if bake_get(con, "stage") == "done":
        print("==> previous bake finished; publishing", flush=True)
        publish_work(con, work, out)
        print(f"==> wrote {out}", flush=True)
        return

    check = Checkpointer(con)
    stop = StopFlag()
    cells, unique, z_min, z_max, scanned = check.load_scan()
    pending_scan = []
    for job in lotpacks:
        coords = job_coords(job[2])
        if coords is None:
            continue
        if (job[1], coords[0], coords[1]) not in scanned:
            pending_scan.append(job)

    already_scan = len(lotpacks) - len(pending_scan)
    if already_scan:
        print(f"==> resume: {already_scan}/{len(lotpacks)} lotpacks already scanned", flush=True)

    stop.arm()
    if pending_scan and bake_get(con, "stage") == "scan":
        work_total = float(sum(sizes.values()) or 1)
        work_done = float(
            sum(sz for (map_name, cx, cy), sz in sizes.items() if (map_name, cx, cy) in scanned)
        )
        chunksize = 8 if len(pending_scan) > 32 else 1
        bar = Bar(
            "scan",
            len(lotpacks) or 1,
            done=already_scan,
            work_done=work_done,
            work_total=work_total,
        )
        errors = 0
        try:
            with _mp_ctx().Pool(workers, initializer=_init_scan) as pool:
                for result in pool.imap_unordered(_scan_one, pending_scan, chunksize=chunksize):
                    if result is None:
                        bar.tick()
                        if stop.stop:
                            _pause(check, bar, stop, bar.done, bar.total)
                        continue
                    kind = result[0]
                    map_name, cx, cy = result[1], result[2], result[3]
                    weight = float(sizes.get((map_name, cx, cy), 1))
                    if kind == "err":
                        errors += 1
                        print(f"FAIL: {map_name} {cx},{cy}: {result[4]}", file=sys.stderr, flush=True)
                        check.persist_scan(map_name, cx, cy, empty=True)
                    elif kind == "skip":
                        check.persist_scan(map_name, cx, cy, empty=True)
                    else:
                        names, blob, cell_z0, cell_z1 = result[4], result[5], result[6], result[7]
                        check.persist_scan(
                            map_name,
                            cx,
                            cy,
                            empty=False,
                            names=names,
                            blob=blob,
                            z_min=cell_z0,
                            z_max=cell_z1,
                        )
                        key = (cx, cy)
                        packed = (names, blob)
                        cells[key] = merge_named(cells[key], packed) if key in cells else packed
                        unique.update(names)
                        z_min = min(z_min, cell_z0)
                        z_max = max(z_max, cell_z1)
                    bar.tick(extra=f"{map_name} {cx},{cy}", work=weight)
                    if stop.stop:
                        _pause(check, bar, stop, bar.done, bar.total)
        except KeyboardInterrupt:
            stop.stop = True
            _pause(check, bar, stop, bar.done, bar.total)
        bar.finish()
        check.flush(force=True)
        if errors:
            print(f"==> scan errors: {errors} (those cells skipped)", flush=True)
        bake_set(con, "stage", "atlas")
        con.commit()
    elif bake_get(con, "stage") == "scan" and not pending_scan:
        bake_set(con, "stage", "atlas")
        con.commit()

    if stop.stop:
        _pause(check, None, stop, already_scan, len(lotpacks))

    # Atlas + thumbs need textures in this process. Skip packing if thumbs already started.
    stage = bake_get(con, "stage") or "atlas"
    used: dict[str, object] = {}
    pages_count = int(bake_get(con, "pages") or 0)
    sprites_count = int(bake_get(con, "sprites") or 0)
    reach = int(bake_get(con, "max_reach") or 0)

    need_textures = stage in ("atlas", "thumbs")
    if need_textures:
        lib = load_textures(textures)
        if stop.stop:
            _pause(check, None, stop, 0, 1)
        names_sorted = sorted(unique)
        print(f"==> lookup {len(names_sorted)} tile names", flush=True)
        getter = getattr(lib, "get_by_name_ignore_filter", None) or lib.get_by_name
        missing: set[str] = set()
        bar = Bar("lookup", len(names_sorted) or 1)
        with contextlib.redirect_stdout(io.StringIO()):
            for name in names_sorted:
                texture = getter(name)
                if texture is not None and texture.im.size[0] > 0:
                    used[name] = texture
                else:
                    missing.add(name)
                bar.tick()
                if stop.stop:
                    _pause(check, bar, stop, bar.done, bar.total)
        bar.finish()
        if missing:
            sample = ", ".join(sorted(missing)[:8])
            more = "" if len(missing) <= 8 else f" (+{len(missing) - 8} more)"
            print(f"==> {len(missing)} textures not in the packs: {sample}{more}", flush=True)

        if stage == "atlas":
            print(f"==> packing {len(used)} sprites", flush=True)
            sprite_list = [
                (name, texture.im, int(texture.ox), int(texture.oy)) for name, texture in used.items()
            ]
            pages, packed = pack_atlas(sprite_list)
            ids = write_atlas(con, [png_bytes(page) for page in pages], packed)
            reach = 0
            for sprite in packed:
                reach = max(reach, abs(sprite.ox) + sprite.w, abs(sprite.oy) + sprite.h)
            pages_count = len(pages)
            sprites_count = len(packed)
            bake_set(con, "pages", str(pages_count))
            bake_set(con, "sprites", str(sprites_count))
            bake_set(con, "max_reach", str(reach))
            bake_set(con, "stage", "thumbs")
            con.commit()
        else:
            ids = load_sprite_ids(con)
            if not ids:
                print("==> atlas missing from checkpoint; packing again", flush=True)
                sprite_list = [
                    (name, texture.im, int(texture.ox), int(texture.oy))
                    for name, texture in used.items()
                ]
                pages, packed = pack_atlas(sprite_list)
                ids = write_atlas(con, [png_bytes(page) for page in pages], packed)
                pages_count = len(pages)
                sprites_count = len(packed)
                reach = 0
                for sprite in packed:
                    reach = max(reach, abs(sprite.ox) + sprite.w, abs(sprite.oy) + sprite.h)
                bake_set(con, "pages", str(pages_count))
                bake_set(con, "sprites", str(sprites_count))
                bake_set(con, "max_reach", str(reach))
                con.commit()

        oxoy = load_sprite_oxoy(con)
        scale = thumb_scale()
        stamps = {name: scale_stamp(texture.im, scale) for name, texture in used.items() if name in ids}
        global _THUMB_STAMPS, _THUMB_IDS, _THUMB_OXOY
        _THUMB_STAMPS = stamps
        _THUMB_IDS = ids
        _THUMB_OXOY = oxoy

    already_thumbs = written_cells(con)
    all_items = sorted((cx, cy, names, blob) for (cx, cy), (names, blob) in cells.items())
    pending_thumbs = [item for item in all_items if (item[0], item[1]) not in already_thumbs]
    thumb_weight = {(cx, cy): float(max(1, len(blob))) for cx, cy, _names, blob in all_items}
    if already_thumbs:
        print(
            f"==> resume: {len(already_thumbs)}/{len(all_items)} cell thumbs already written",
            flush=True,
        )
    print(f"==> thumbs: {len(all_items)} cells", flush=True)
    if pending_thumbs:
        work_total = float(sum(thumb_weight.values()) or 1)
        work_done = float(
            sum(thumb_weight[key] for key in thumb_weight if key in already_thumbs)
        )
        thumb_chunk = 4 if len(pending_thumbs) > 16 else 1
        bar = Bar(
            "cells",
            len(all_items) or 1,
            done=len(already_thumbs),
            work_done=work_done,
            work_total=work_total,
        )
        try:
            with _mp_ctx().Pool(workers, initializer=_init_thumbs) as pool:
                for cx, cy, occupancy, thumb in pool.imap_unordered(
                    _thumb_one, pending_thumbs, chunksize=thumb_chunk
                ):
                    write_cell(con, cx, cy, occupancy, thumb)
                    check.flush()
                    bar.tick(extra=f"{cx},{cy}", work=thumb_weight.get((cx, cy), 1.0))
                    if stop.stop:
                        _pause(check, bar, stop, bar.done, bar.total)
        except KeyboardInterrupt:
            stop.stop = True
            _pause(check, bar, stop, bar.done, bar.total)
        bar.finish()
        check.flush(force=True)

    write_meta(
        con,
        {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "game_version": game_version,
            "pages": str(pages_count),
            "sprites": str(sprites_count),
            "cells": str(len(cells)),
            "z_min": str(z_min),
            "z_max": str(z_max),
            "thumb_scale": "512",
            "max_reach": str(reach),
            "cell_size": str(CELL),
        },
    )
    bake_set(con, "stage", "done")
    con.commit()
    publish_work(con, work, out)
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
