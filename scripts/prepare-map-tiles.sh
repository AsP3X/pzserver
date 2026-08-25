#!/usr/bin/env bash
# Host-side map-tile prep for first boot. Safe to re-run.
#
# - Creates the texture-pack mount and scratch tree
# - Seeds map_info.json so a regional job does not need leftover HTML
# - If the operator dropped data/map-tiles/tiles.sqlite and the named volume
#   is empty, imports it (the 15–24 GB pack is never built by `make up`)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mkdir -p \
    data/server/media/texturepacks \
    data/map-tiles/html/map_data/base

VANILLA="$ROOT/web/tools/map-tiles/map_info.vanilla.json"
DEST="$ROOT/data/map-tiles/html/map_data/base/map_info.json"
if [ ! -f "$DEST" ] && [ -f "$VANILLA" ]; then
    cp "$VANILLA" "$DEST"
    echo "seeded $DEST"
fi

HOST_PACK="$ROOT/data/map-tiles/tiles.sqlite"
if [ -f "$HOST_PACK" ]; then
    docker volume create pz-map-tiles-sqlite >/dev/null
    if docker run --rm -v pz-map-tiles-sqlite:/pack alpine:3.20 \
        sh -c 'test -s /pack/tiles.sqlite'; then
        echo "pz-map-tiles-sqlite already has a pack; left it in place"
    else
        echo "importing $HOST_PACK into pz-map-tiles-sqlite"
        make map-tiles-import
    fi
fi

if ! ls "$ROOT/data/server/media/texturepacks"/*.pack >/dev/null 2>&1; then
    echo "note: copy PZ client media/texturepacks/*.pack (~527 MB) into"
    echo "      data/server/media/texturepacks/ before a regional isometric rerender"
fi
