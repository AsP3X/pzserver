#!/usr/bin/env bash
# Render, verify, pack. Re-running resumes: pzmap2dzi skips work it has already
# done, and the packer skips tiles already stored.
#
# Set PZ_MAP_SQUARES and/or PZ_MAP_CELLS to redraw only part of the map instead
# of all of it -- see "regional re-render" below.
set -euo pipefail

# Docker API create Env can replace the image ENV. The skip/sprite patches
# live in /tools and workers import them via PYTHONPATH.
export PYTHONPATH="/tools${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUNBUFFERED=1

CONF=conf/conf.yaml
OUT=/out
TREE="$OUT/html/map_data/base"   # verified layout; there is no `default` segment
# Live pack lives on the named volume, not the host bind. /out is still the
# render scratch (html tree, texture cache). Regional jobs update this same
# file the API is serving.
PACK=/pack/tiles.sqlite
# Underlay: the pack we are updating, not the shipped one.
#
# A leaf tile straddles cells. Painting cell 41,39 leaves the part that
# belongs to 41,38 unpainted, and fill_unpainted recovers it from here. Take
# that from the original county pack and every job silently reverts whatever
# its neighbours fixed on the shared boundary tile -- redrawing region by
# region would never converge, and the redraw that fixed a clipped tree in
# 41,38 was undone by the very next job on 41,39. The live pack already holds
# every fix so far, and for z21 the county pack holds nothing at all.
UNDERLAY="$PACK"
# Original county pack, left on the host bind after import. Kept only for
# heal_black and PZ_MAP_HEAL_ONLY: a pack that packed a black frame cannot
# heal itself, because there the underlay *is* the black rectangle.
PRISTINE="$PACK"
if [ -s /out/tiles.sqlite ] && [ /out/tiles.sqlite != "$PACK" ]; then
    PRISTINE=/out/tiles.sqlite
fi
PACK_ARGS=""
MAP_INFO_BAK=
PROGRESS=/pack/job_progress.json
PROGRESS_WATCH=
set_progress() {
    python /tools/progress.py write "$PROGRESS" "$1" "$2" || true
}
watch_progress() {
    # stage base span logfile
    stop_progress_watch
    python /tools/progress.py watch "$PROGRESS" "$4" "$1" "$2" "$3" &
    PROGRESS_WATCH=$!
}
stop_progress_watch() {
    if [ -n "${PROGRESS_WATCH:-}" ]; then
        kill "$PROGRESS_WATCH" 2>/dev/null || true
        wait "$PROGRESS_WATCH" 2>/dev/null || true
        PROGRESS_WATCH=
    fi
}
restore_map_info() {
    if [ -n "$MAP_INFO_BAK" ] && [ -f "$MAP_INFO_BAK" ]; then
        cp "$MAP_INFO_BAK" "$TREE/map_info.json"
    fi
}
on_exit() {
    stop_progress_watch
    rm -f "$PROGRESS" "$PROGRESS.tmp"
    restore_map_info
}
trap on_exit EXIT
set_progress starting 1

cd /opt/pzmap2dzi
python /tools/patch_scheduler.py
python /tools/patch_save_render.py
python /tools/patch_base_skip.py
python /tools/patch_unit_range.py
python /tools/patch_render_margin.py
echo "==> PYTHONPATH=$PYTHONPATH"

# Fail before the hours, not after them.
#
# The dedicated server download has no media/texturepacks: it never draws
# anything. pzmap2dzi does, and without them it renders every tile untextured
# and finishes with a blank map. verify.py cannot catch that — it reads
# map_info.json, which is geometry, not pixels. So check the art up front.
TEXTURES=/pz/media/texturepacks
if [ -z "${PZ_MAP_HEAL_ONLY:-}" ]; then
    if [ -z "$(ls -A "$TEXTURES"/*.pack 2>/dev/null)" ]; then
        echo "FAIL: no texture packs at $TEXTURES" >&2
        echo >&2
        echo "The dedicated server install does not ship them. Point" >&2
        echo "PZ_TEXTUREPACKS_HOST at a PZ client install's media/texturepacks" >&2
        echo "(about 527 MB), or copy that folder onto the server once." >&2
        echo "Rendering without it produces a blank map. See docs/map-tiles.md." >&2
        exit 1
    fi
    echo "==> textures: $(ls "$TEXTURES"/*.pack | wc -l) packs found"
fi

if [ ! -d /pack ]; then
    echo "FAIL: /pack is not mounted. tiles.sqlite lives on the pz-map-tiles-sqlite volume," >&2
    echo "shared with web-api, not on the host bind at /out." >&2
    exit 1
fi

# An interrupted run leaves a .pending marker beside a tile it was part way
# through drawing. The .jpg is a complete, valid file -- it is just only partly
# painted -- so leaving it behind means the next run treats it as done and the
# half-drawn tile is permanent. Clear both. This is not hypothetical: it is how
# a black rectangle ended up baked into the middle of the map.
STALE=0
if [ -d "$TREE/layer0_files" ]; then
    while IFS= read -r marker; do
        [ -n "$marker" ] || continue
        rm -f "$marker" "${marker%.pending}.jpg"
        STALE=$((STALE + 1))
    done < <(find "$TREE/layer0_files" -name '*.pending' 2>/dev/null)
fi
[ "$STALE" -gt 0 ] && echo "==> discarded $STALE half-drawn tile(s) from an interrupted run"

# ---------------------------------------------------------------------------
# Regional re-render
#
# Redraws only the world squares (or cells converted to squares) named below
# and leaves the rest of the pack alone. Use it when part of the world has
# changed -- a new build, a base someone flattened -- instead of paying for
# the whole map again.
#
#   PZ_MAP_SQUARES="8704,7680,256,256"   x, y, width, height, in world squares
#   PZ_MAP_CELLS="34,30,4,4"             x, y, width, height, in map cells
#   PZ_MAP_CELLS="34,30"                 a single cell
#   PZ_MAP_CELLS="34,30;40,12"           several, semicolon-separated
# ---------------------------------------------------------------------------
SQUARES="${PZ_MAP_SQUARES:-}"
CELLS="${PZ_MAP_CELLS:-}"
REGION=
if [ -n "$SQUARES" ] || [ -n "$CELLS" ]; then
    REGION=1
fi

if [ -n "$REGION" ]; then
    if [ ! -f "$PACK" ]; then
        echo "FAIL: PZ_MAP_SQUARES/PZ_MAP_CELLS asks for a regional re-render, but there is no" >&2
        echo "pack at $PACK to update. Run a full render first." >&2
        exit 1
    fi
    echo "==> ensure map_info.json for cell/tile geometry"
    python /tools/ensure_map_info.py "$TREE/map_info.json" "$PACK"

    if [ -n "$CELLS" ]; then
        printf '%s' "$CELLS" > /tmp/cells.txt
        CELL_SQUARES=$(python -c "
from cells import Geometry, cells_as_squares, parse_rects
from pathlib import Path
geo = Geometry.from_map_info(Path('$TREE/map_info.json'))
rects = cells_as_squares(geo, parse_rects(Path('/tmp/cells.txt').read_text()))
print(';'.join(f'{x},{y},{w},{h}' for x,y,w,h in rects))
")
        if [ -n "$SQUARES" ]; then
            SQUARES="${SQUARES};${CELL_SQUARES}"
        else
            SQUARES="$CELL_SQUARES"
        fi
    fi

    echo "==> planning regional re-render: $SQUARES"
    set_progress plan 6
    read -r MIN_LEVEL MAX_LEVEL < <(python /tools/levels.py "$PACK")
    # z21 is omitted from a full county run (~80 GB). A region can write it
    # for just these cells with --detail-only. A world-change job must paint
    # at the packed depth (z20): omit_levels 1 merges z20 from z21 children,
    # and those siblings are not in the pack, so parents come out black.
    DETAIL="${PZ_MAP_DETAIL:-}"
    DETAIL_ONLY="${PZ_MAP_DETAIL_ONLY:-}"
    WANT_SAVE="${PZ_MAP_SAVE:-}"
    if [ -z "$DETAIL_ONLY" ] && { [ -n "$WANT_SAVE" ] || [ -n "${PZ_SAVE_GAME:-}" ]; } && [ -n "$DETAIL" ]; then
        echo "==> world-change paint at packed level $MAX_LEVEL (not z$DETAIL: those tiles are not in the pack)"
        DETAIL=
    fi
    if [ -n "$DETAIL_ONLY" ]; then
        DETAIL="${DETAIL:-21}"
        echo "==> detail-only fill: level $DETAIL"
        python /tools/set_omit_levels.py "$CONF" 1
        python /tools/region.py "$TREE/map_info.json" "$SQUARES" "$MIN_LEVEL" "$DETAIL" /tmp --detail-only
    elif [ -n "$DETAIL" ]; then
        echo "==> regional redraw including detail level $DETAIL"
        python /tools/set_omit_levels.py "$CONF" 1
        python /tools/region.py "$TREE/map_info.json" "$SQUARES" "$MIN_LEVEL" "$DETAIL" /tmp
    else
        python /tools/region.py "$TREE/map_info.json" "$SQUARES" "$MIN_LEVEL" "$MAX_LEVEL" /tmp
    fi

    # Only the siblings the merges need, plus the dirty *ancestors*. Leaves
    # stay absent so pzmap2dzi redraws them. Ancestors go back on disk so it
    # does *not* merge them from half-painted children — that merge is the
    # black rectangle at zoom-out. We rebuild them from the finished leaves
    # after paint.
    echo "==> restoring merge inputs from the live pack $UNDERLAY"
    if [ "$PRISTINE" = "$PACK" ]; then
        echo "==> no /out/tiles.sqlite; a tile that packed black cannot be healed"
    else
        echo "==> original county pack $PRISTINE kept for heal_black"
    fi
    set_progress restore 10
    python /tools/unpack.py "$UNDERLAY" "$TREE/layer0_files" --only /tmp/restore.txt
    if [ -s /tmp/keep.txt ]; then
        echo "==> restoring ancestors from the live pack (rebuilt after paint)"
        python /tools/unpack.py "$UNDERLAY" "$TREE/layer0_files" --only /tmp/keep.txt
    fi
    if [ -s /tmp/leaves.txt ]; then
        echo "==> snapshot leaf tiles as underlay from the live pack"
        python /tools/unpack.py "$UNDERLAY" /tmp/underlay --only /tmp/leaves.txt
    fi

    if [ -n "${PZ_MAP_HEAL_ONLY:-}" ]; then
        if [ "$PRISTINE" = "$PACK" ]; then
            echo "FAIL: heal-only needs the original county pack at /out/tiles.sqlite" >&2
            echo "(data/map-tiles/tiles.sqlite on the host, left there after import)." >&2
            exit 1
        fi
        echo "==> heal-only: copy pristine tiles over the black region (no re-render)"
        python /tools/unpack.py "$PRISTINE" "$TREE/layer0_files" --only /tmp/dirty.txt
        python /tools/pack.py "$TREE/layer0_files" "$PACK" \
            "game_version=${PZ_GAME_VERSION:-42.20.0}" \
            "tile_size=2048" \
            "width=2318656" \
            "height=1019040" \
            "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --replace --only /tmp/dirty.txt --wal
        echo "==> healed; re-run without PZ_MAP_HEAL_ONLY to paint live save on top"
        ls -lh "$PACK"
        chown 10001:10001 "$PACK" "$(dirname "$PACK")" 2>/dev/null || true
        chmod 664 "$PACK" 2>/dev/null || true
        chmod 775 "$(dirname "$PACK")" 2>/dev/null || true
        exit 0
    fi

    # dzi_cell_range is left alone, so the pyramid's geometry -- and therefore
    # every tile index the client computes -- is identical to a full render.
    # verify.py still gates on it below.
    # The widened range, not the one asked for -- see region.py.
    echo "==> limiting the render to those cells"
    python /tools/set_render_range.py "$CONF" "$(cat /tmp/render_cells.txt)"

    # Without this the fresh bytes lose to the rows already in the pack and the
    # whole run is a no-op. Only dirty keys; WAL so a live reader can keep going.
    PACK_ARGS="--replace --only /tmp/dirty.txt --wal"

    # World-change jobs paint the live save on top of vanilla. Detail-only
    # fills (z21 of the shipped map) skip this — they have no world state.
    SAVE_GAME="${PZ_SAVE_GAME:-}"
    WANT_SAVE="${PZ_MAP_SAVE:-}"

    # The overlay is off until chunk sprite ids resolve to tile names.
    #
    # This world's WorldDictionary.bin parses (5103 items, 46 objects) but
    # reports num_sprites = 0, so load_world_dict_sprites returns nothing and
    # load_tile_defs is the whole map. Its key space starts at 110000 --
    # update_tile_defs uses index_offset 110000 for newtiledefinitions.tiles
    # and refuses file_no <= 0 -- while the save writes ids like 17463 and
    # 94229. A miss is dropped (3875 distinct "missing tiledef for sprite" in
    # one cell) and a hit lands in the wrong sheet, so fence posts render as
    # window frames and hedges as curtains, on every square.
    #
    # No compositing strategy fixes that; clipping the overlay to the door's
    # ground diamond only hid it behind black notches. Paint vanilla, which is
    # correct, until the mapping is. PZ_MAP_SAVE_SPRITES=1 re-enables it for
    # whoever is working on the id space.
    if [ -n "$WANT_SAVE$SAVE_GAME" ] && [ -z "${PZ_MAP_SAVE_SPRITES:-}" ]; then
        echo "==> save overlay off (chunk sprite ids do not resolve; see run.sh)"
        echo "    region paints vanilla only; set PZ_MAP_SAVE_SPRITES=1 to work on it"
        WANT_SAVE=
        SAVE_GAME=
    fi

    if [ -z "$DETAIL_ONLY" ] && { [ -n "$WANT_SAVE" ] || [ -n "$SAVE_GAME" ]; }; then
        SAVE_GAME="${SAVE_GAME:-Multiplayer/${PZ_SERVER_NAME:-ZomboidServer}}"
        LIVE_SAVE="/saves/${SAVE_GAME}"
        if [ ! -d "$LIVE_SAVE" ]; then
            if [ -n "$WANT_SAVE" ]; then
                echo "FAIL: PZ_MAP_SAVE is set but $LIVE_SAVE is missing." >&2
                echo "Mount the dedicated-server Saves folder at /saves." >&2
                exit 1
            fi
            echo "==> no save at $LIVE_SAVE; region will be vanilla tiles only"
        else
            SNAP="/out/save-snapshot/${SAVE_GAME}"
            echo "==> flush live chunks so door/window state is on disk"
            set_progress snapshot 2
            BEFORE_MTIME=$(python -c "
from pathlib import Path
from chunks import parse_cell_rects
from wait_save import max_mtime
rects = parse_cell_rects(Path('/tmp/render_cells.txt').read_text())
newest, n = max_mtime(Path('$LIVE_SAVE'), rects)
print(f'{newest}')
")
            if ! python /tools/rcon_save.py; then
                echo "FAIL: RCON save did not run. Open doors live in Java memory" >&2
                echo "until the dedicated server flushes map/{x}/{y}.bin." >&2
                exit 1
            fi
            # Autosave may already have flushed these files, so mtimes often
            # do not move. RCON returned "World saved"; snapshot anyway.
            sleep 2
            if ! python /tools/wait_save.py "$LIVE_SAVE" /tmp/render_cells.txt "$BEFORE_MTIME"; then
                echo "==> chunk mtimes unchanged after save (already on disk); snapshotting"
            fi
            echo "==> snapshot save $SAVE_GAME for overlay"
            set_progress snapshot 4
            rm -rf "/out/save-snapshot"
            python /tools/snapshot_save.py "$LIVE_SAVE" "$SNAP" /tmp/render_cells.txt /tmp/save_chunks.txt
            # One sprite per line, not a square and never a whole 8x8 chunk.
            # A square carries its floor and wall as well as its door, and the
            # save chunk only stores the door: skip the square and nothing
            # paints the rest back (black notches), skip the chunk and the
            # whole cell goes black.
            python /tools/open_squares.py "$SNAP" /tmp/save_skip.txt \
                /pz /pz/steamapps/workshop/content/108600 || true
            if [ ! -f "$SNAP/WorldDictionary.bin" ]; then
                echo "==> save has no WorldDictionary.bin; region will be vanilla tiles only"
                WANT_SAVE=
            elif [ ! -d "$SNAP/map" ] && [ -z "$(ls "$SNAP"/map_*_*.bin 2>/dev/null)" ]; then
                echo "==> those cells have no save chunks; region will be vanilla tiles only"
                WANT_SAVE=
            else
                python /tools/set_save_game.py "$CONF" /out/save-snapshot "$SAVE_GAME"
                export SAVE_GAME
                SAVE_TREE="$OUT/html/map_data/saves/$(python -c "from chunks import sanitize_save_name; import os; print(sanitize_save_name(os.environ['SAVE_GAME']))")/base"
                # Fresh geometry for this omit_levels; leftover skip values abort.
                rm -f "$SAVE_TREE/map_info.json" "$SAVE_TREE/sources.json"
                WANT_SAVE=1
            fi
        fi
    fi
fi

echo "==> deploy"
set_progress prepare 16
python main.py -c "$CONF" deploy

echo "==> unpack"
set_progress prepare 18
python main.py -c "$CONF" unpack

# omit_levels: 1 writes z21, but the tree's map_info is from the omit 2 pack.
# pzmap2dzi stops rather than mix skip values. Rescale w/h for this run, then
# put the original file back so the next omit-2 job still matches.
MAP_INFO_BAK=
if [ -n "${DETAIL:-}${DETAIL_ONLY:-}" ] && [ -f "$TREE/map_info.json" ]; then
    MAP_INFO_BAK=/tmp/map_info.orig.json
    cp "$TREE/map_info.json" "$MAP_INFO_BAK"
    python /tools/align_map_info_skip.py "$TREE/map_info.json" 1
fi
# pzmap2dzi compares on-disk w/h/skip to the size it just computed from the
# lotheaders. A seeded ISO_DZI file (or skip-aligned copy) is a few hundred
# pixels off and it stops. Planning already used x0/y0/sqr; let it write a
# fresh map_info for this omit_levels.
rm -f "$TREE/map_info.json"

if [ -n "$REGION" ]; then
    echo "==> render region"
else
    echo "==> render base (hours; ctrl-c is safe, re-run resumes)"
fi
# Keep the render's own output so the cache gate below can read it. Losing it
# is how a run with 13,000 destroyed tiles got mistaken for a good one.
RENDER_LOG=/tmp/render.log
: > "$RENDER_LOG"
watch_progress render 20 50 "$RENDER_LOG"
python main.py -c "$CONF" render base 2>&1 | tee "$RENDER_LOG"
stop_progress_watch
if grep -q "map_info mismatch" "$RENDER_LOG" || grep -q "Render stopped" "$RENDER_LOG"; then
    echo "FAIL: pzmap2dzi refused the base render (map_info mismatch)." >&2
    exit 1
fi
set_progress render 70

if [ -n "${WANT_SAVE:-}" ]; then
    echo "==> render save overlay"
    # Leftover save tiles look "complete" to incremental mode and the overlay
    # paints nothing (Affected tiles: 0). The snapshot is the authority.
    rm -rf "${SAVE_TREE:-/tmp/missing-save}/layer0_files"
    rm -f "${SAVE_TREE:-/tmp/missing-save}/map_info.json" "${SAVE_TREE:-/tmp/missing-save}/sources.json"
    watch_progress save 70 15 "$RENDER_LOG"
    python main.py -c "$CONF" render save 2>&1 | tee -a "$RENDER_LOG"
    stop_progress_watch
    if grep -q "Failed to load parser utils" "$RENDER_LOG"; then
        echo "FAIL: save overlay parser did not load (need lark in the image)." >&2
        exit 1
    fi
    echo "==> composite save onto base"
    set_progress composite 88
    COMPOSITE_KEYS=/tmp/dirty.txt
    if [ -s /tmp/leaves.txt ]; then
        COMPOSITE_KEYS=/tmp/leaves.txt
    fi
    COMP_OUT=$(python /tools/composite.py "$COMPOSITE_KEYS" "$TREE/layer0_files" "$SAVE_TREE/layer0_files")
    echo "$COMP_OUT"
    if [ -s /tmp/save_skip.txt ] && echo "$COMP_OUT" | grep -q "composited 0 "; then
        echo "FAIL: save overlay painted nothing but open-square skip listed doors." >&2
        echo "The live door state was snapshotted and then dropped (unit-range filter)." >&2
        exit 1
    fi
fi

# After the overlay, not before. The live world is on the tile by now, so
# whatever is still JPEG-black is a genuinely unpainted cell-range corner and
# the vanilla underlay is the right thing to put there. Doing this first is
# what forced the old open-door mask; there is no hole to protect any more.
if [ -n "$REGION" ] && [ -s /tmp/leaves.txt ] && [ -d /tmp/underlay ]; then
    echo "==> fill unpainted leaf corners from underlay"
    set_progress composite 90
    python /tools/fill_unpainted.py /tmp/leaves.txt "$TREE/layer0_files" /tmp/underlay
    python /tools/heal_black.py /tmp/leaves.txt "$TREE/layer0_files" "$PRISTINE"
fi

# Before anything is packed. If the cache filled up, the render evicted tiles
# to make room -- and the levels omit_levels drops are never written to disk,
# so evicting one destroys it and its parent merges a black quadrant. The run
# still exits 0 and still passes the geometry gate, so this is the only thing
# that catches it.
CACHE_LIMIT=$(grep -oE "^[ 	]*cache_limit_mb:[ 	]*[0-9]+" "$CONF" | grep -oE "[0-9]+$")
echo "==> verify nothing was evicted"
python /tools/check_cache.py "$RENDER_LOG" "${CACHE_LIMIT:-0}"

echo "==> verify geometry"
python /tools/verify.py "$TREE/map_info.json"

if [ -n "$REGION" ] && [ -s /tmp/keep.txt ]; then
    echo "==> rebuild ancestor tiles from children"
    python /tools/rebuild_pyramid.py /tmp/keep.txt "$TREE/layer0_files"
    echo "==> replace any still-black ancestors from pristine"
    python /tools/heal_black.py /tmp/keep.txt "$TREE/layer0_files" "$PRISTINE"
fi

echo "==> pack"
set_progress pack 92
python /tools/pack.py "$TREE/layer0_files" "$PACK" \
    "game_version=${PZ_GAME_VERSION:-42.20.0}" \
    "tile_size=2048" \
    "width=2318656" \
    "height=1019040" \
    "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    $PACK_ARGS

echo "==> done"
set_progress pack 100
ls -lh "$PACK"
restore_map_info
MAP_INFO_BAK=
# web-api reads as uid 10001; WAL readers write -shm in this directory. The
# packer runs as root, so without this the next tile request can 500.
chown 10001:10001 "$PACK" "$(dirname "$PACK")" 2>/dev/null || true
chmod 664 "$PACK" 2>/dev/null || true
chmod 775 "$(dirname "$PACK")" 2>/dev/null || true
