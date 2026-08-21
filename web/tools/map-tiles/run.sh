#!/usr/bin/env bash
# Render, verify, pack. Re-running resumes: pzmap2dzi skips work it has already
# done, and the packer skips tiles already stored.
set -euo pipefail

CONF=conf/conf.yaml
OUT=/out
TREE="$OUT/html/map_data/base"   # verified layout; there is no `default` segment

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

echo "==> deploy"
python main.py -c "$CONF" deploy

echo "==> unpack"
python main.py -c "$CONF" unpack

echo "==> render base (hours; ctrl-c is safe, re-run resumes)"
python main.py -c "$CONF" render base

echo "==> verify geometry"
python /tools/verify.py "$TREE/map_info.json"

echo "==> pack"
python /tools/pack.py "$TREE/layer0_files" "$OUT/tiles.sqlite" \
    "game_version=${PZ_GAME_VERSION:-42.20.0}" \
    "tile_size=2048" \
    "width=2318656" \
    "height=1019040" \
    "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "==> done"
ls -lh "$OUT/tiles.sqlite"
