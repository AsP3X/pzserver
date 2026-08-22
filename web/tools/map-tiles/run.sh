#!/usr/bin/env bash
# Render, verify, pack. Re-running resumes: pzmap2dzi skips work it has already
# done, and the packer skips tiles already stored.
#
# Set PZ_MAP_SQUARES and/or PZ_MAP_CELLS to redraw only part of the map instead
# of all of it -- see "regional re-render" below.
set -euo pipefail

CONF=conf/conf.yaml
OUT=/out
TREE="$OUT/html/map_data/base"   # verified layout; there is no `default` segment
# Live pack lives on the named volume, not the host bind. /out is still the
# render scratch (html tree, texture cache). Regional jobs update this same
# file the API is serving.
PACK=/pack/tiles.sqlite
PACK_ARGS=""
MAP_INFO_BAK=
restore_map_info() {
    if [ -n "$MAP_INFO_BAK" ] && [ -f "$MAP_INFO_BAK" ]; then
        cp "$MAP_INFO_BAK" "$TREE/map_info.json"
    fi
}
trap restore_map_info EXIT

cd /opt/pzmap2dzi

# Fail before the hours, not after them.
#
# The dedicated server download has no media/texturepacks: it never draws
# anything. pzmap2dzi does, and without them it renders every tile untextured
# and finishes with a blank map. verify.py cannot catch that — it reads
# map_info.json, which is geometry, not pixels. So check the art up front.
TEXTURES=/pz/media/texturepacks
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
    if [ ! -f "$TREE/map_info.json" ]; then
        echo "FAIL: $TREE/map_info.json is missing, so square/cell-to-tile geometry" >&2
        echo "cannot be read. The packer leaves it in place; if it is gone," >&2
        echo "run a full render." >&2
        exit 1
    fi

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
    read -r MIN_LEVEL MAX_LEVEL < <(python /tools/levels.py "$PACK")
    # z21 is omitted from a full county run (~80 GB). A region can write it
    # for just these cells: either a world-change redraw (dirty 0–21) or a
    # detail-only fill (paint z21, restore z20…0 so they skip).
    DETAIL="${PZ_MAP_DETAIL:-}"
    DETAIL_ONLY="${PZ_MAP_DETAIL_ONLY:-}"
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

    # Only the siblings the merges need. The target tiles are deliberately NOT
    # restored: pzmap2dzi treats a tile already on disk as done, so the hole is
    # what tells it to redraw.
    echo "==> restoring merge inputs from the pack"
    python /tools/unpack.py "$PACK" "$TREE/layer0_files" --only /tmp/restore.txt

    # dzi_cell_range is left alone, so the pyramid's geometry -- and therefore
    # every tile index the client computes -- is identical to a full render.
    # verify.py still gates on it below.
    # The widened range, not the one asked for -- see region.py.
    echo "==> limiting the render to those cells"
    python /tools/set_render_range.py "$CONF" "$(cat /tmp/render_cells.txt)"

    # Without this the fresh bytes lose to the rows already in the pack and the
    # whole run is a no-op. Only dirty keys; WAL so a live reader can keep going.
    PACK_ARGS="--replace --only /tmp/dirty.txt --wal"
fi

echo "==> deploy"
python main.py -c "$CONF" deploy

echo "==> unpack"
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

if [ -n "$REGION" ]; then
    echo "==> render region"
else
    echo "==> render base (hours; ctrl-c is safe, re-run resumes)"
fi
# Keep the render's own output so the cache gate below can read it. Losing it
# is how a run with 13,000 destroyed tiles got mistaken for a good one.
RENDER_LOG=/tmp/render.log
python main.py -c "$CONF" render base 2>&1 | tee "$RENDER_LOG"

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

echo "==> pack"
python /tools/pack.py "$TREE/layer0_files" "$PACK" \
    "game_version=${PZ_GAME_VERSION:-42.20.0}" \
    "tile_size=2048" \
    "width=2318656" \
    "height=1019040" \
    "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    $PACK_ARGS

echo "==> done"
ls -lh "$PACK"
restore_map_info
MAP_INFO_BAK=
# web-api reads as uid 10001; WAL readers write -shm in this directory. The
# packer runs as root, so without this the next tile request can 500.
chown 10001:10001 "$PACK" "$(dirname "$PACK")" 2>/dev/null || true
chmod 664 "$PACK" 2>/dev/null || true
chmod 775 "$(dirname "$PACK")" 2>/dev/null || true
