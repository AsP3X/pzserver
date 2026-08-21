#!/usr/bin/env bash
# Render, verify, pack. Re-running resumes: pzmap2dzi skips work it has already
# done, and the packer skips tiles already stored.
set -euo pipefail

CONF=conf/conf.yaml
OUT=/out
TREE="$OUT/html/map_data/base"   # verified layout; there is no `default` segment

cd /opt/pzmap2dzi

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
