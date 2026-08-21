#!/usr/bin/env bash
# Render, verify, pack. Re-running resumes: pzmap2dzi skips work it has already
# done, and the packer skips tiles already stored.
#
# Set PZ_MAP_CELLS to redraw only part of the map instead of all of it -- see
# "regional re-render" below.
set -euo pipefail

CONF=conf/conf.yaml
OUT=/out
TREE="$OUT/html/map_data/base"   # verified layout; there is no `default` segment
PACK="$OUT/tiles.sqlite"
PACK_ARGS=""

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
# Redraws only the cells named in PZ_MAP_CELLS and leaves the rest of the pack
# alone. Use it when part of the world has changed -- a new build, a base
# someone flattened -- instead of paying for the whole map again.
#
#   PZ_MAP_CELLS="34,30,4,4"     x, y, width, height, in map cells
#   PZ_MAP_CELLS="34,30"         a single cell
#   PZ_MAP_CELLS="34,30;40,12"   several, semicolon-separated
# ---------------------------------------------------------------------------
REGION="${PZ_MAP_CELLS:-}"

if [ -n "$REGION" ]; then
    if [ ! -f "$PACK" ]; then
        echo "FAIL: PZ_MAP_CELLS asks for a regional re-render, but there is no" >&2
        echo "pack at $PACK to update. Run a full render first." >&2
        exit 1
    fi
    if [ ! -f "$TREE/map_info.json" ]; then
        echo "FAIL: $TREE/map_info.json is missing, so cell-to-tile geometry" >&2
        echo "cannot be read. The packer leaves it in place; if it is gone," >&2
        echo "run a full render." >&2
        exit 1
    fi

    echo "==> planning regional re-render: $REGION"
    read -r MIN_LEVEL MAX_LEVEL < <(python /tools/levels.py "$PACK")
    python /tools/region.py "$TREE/map_info.json" "$REGION" "$MIN_LEVEL" "$MAX_LEVEL" /tmp

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
    # whole run is a no-op.
    PACK_ARGS="--replace"
fi

echo "==> deploy"
python main.py -c "$CONF" deploy

echo "==> unpack"
python main.py -c "$CONF" unpack

if [ -n "$REGION" ]; then
    echo "==> render region"
else
    echo "==> render base (hours; ctrl-c is safe, re-run resumes)"
fi
python main.py -c "$CONF" render base

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
