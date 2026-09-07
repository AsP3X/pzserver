#!/usr/bin/env bash
# Seed the Knox Relay trees the Project Zomboid *client* actually loads.
#
# Default folder order is workshop,steam,mods. The in-game uploader folder
# (~/Zomboid/Workshop/KnoxRelay/Contents/) is scanned first, so a Steam-cache
# seed alone is ignored and the Desk reverts to whatever was last packaged.
# Never writes workshop.txt (that file holds id=3777446787).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/game-server/mods/KnoxRelay"
if [ ! -d "${SRC}/42/media/lua" ]; then
    echo "ERROR: missing Knox Relay source at ${SRC}" >&2
    exit 1
fi

APP_ID=108600
ITEM_ID=3777446787

steam_app_candidates=(
    "${HOME}/Library/Application Support/Steam/steamapps/workshop/content/${APP_ID}"
    "${HOME}/.steam/steam/steamapps/workshop/content/${APP_ID}"
    "${HOME}/.local/share/Steam/steamapps/workshop/content/${APP_ID}"
)

UPLOAD_ROOT="${HOME}/Zomboid/Workshop/KnoxRelay"
UPLOAD="${UPLOAD_ROOT}/Contents/mods/KnoxRelay"
LEFTOVER="${HOME}/Zomboid/mods/KnoxRelay"

seed() {
    local dest="$1"
    mkdir -p "${dest}"
    rsync -a --delete --exclude '.DS_Store' "${SRC}/" "${dest}/"
    echo "Seeded ${dest}"
}

seeded=0
for app in "${steam_app_candidates[@]}"; do
    if [ -d "${app}" ]; then
        seed "${app}/${ITEM_ID}/mods/KnoxRelay"
        seeded=$((seeded + 1))
    fi
done
if [ "${seeded}" -eq 0 ]; then
    echo "WARNING: no Steam workshop cache found; skipped Steam seed" >&2
fi

if [ -f "${UPLOAD_ROOT}/workshop.txt" ]; then
    seed "${UPLOAD}"
else
    echo "WARNING: ${UPLOAD_ROOT}/workshop.txt missing; skipped upload Contents seed" >&2
fi

if [ -e "${LEFTOVER}" ]; then
    rm -rf "${LEFTOVER}"
    echo "Removed leftover ${LEFTOVER} (third KnoxRelay copy; PZ scans it last)"
fi

echo
echo "PZ loads Knox Relay from Contents/ first (workshop,steam,mods)."
echo "A Steam download of 3777446787 does not replace Contents/; this seed does."
echo "Fully quit Project Zomboid and relaunch — disconnect/reconnect keeps old Lua."
echo "In-game the Desk title must read 'KNOX DESK  X.Y' for the seeded version."
