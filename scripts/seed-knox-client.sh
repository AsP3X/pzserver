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
LOADER_SRC="${ROOT}/game-server/mods/KnoxRelayLoader"
if [ ! -d "${SRC}/42/media/lua" ]; then
    echo "ERROR: missing Knox Relay source at ${SRC}" >&2
    exit 1
fi
if [ ! -f "${LOADER_SRC}/42/media/lua/client/KR_Steam.lua" ]; then
    echo "ERROR: missing Knox Relay Loader at ${LOADER_SRC}" >&2
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
UPLOAD_LOADER="${UPLOAD_ROOT}/Contents/mods/KnoxRelayLoader"
LEFTOVER="${HOME}/Zomboid/mods/KnoxRelay"
LEFTOVER_LOADER="${HOME}/Zomboid/mods/KnoxRelayLoader"

seed() {
    local dest="$1"
    local src="${2:-${SRC}}"
    mkdir -p "${dest}"
    rsync -a --delete --exclude '.DS_Store' --exclude '.knox-dev' "${src}/" "${dest}/"
    echo "Seeded ${dest}"
}

seeded=0
for app in "${steam_app_candidates[@]}"; do
    if [ -d "${app}" ]; then
        seed "${app}/${ITEM_ID}/mods/KnoxRelay" "${SRC}"
        seed "${app}/${ITEM_ID}/mods/KnoxRelayLoader" "${LOADER_SRC}"
        seeded=$((seeded + 1))
    fi
done
if [ "${seeded}" -eq 0 ]; then
    echo "WARNING: no Steam workshop cache found; skipped Steam seed" >&2
fi

# Always seed Contents/. PZ loads this tree first (workshop,steam,mods),
# including after a join-server workshop update. Do not require workshop.txt
# — that file only holds the Steam item id for the in-game uploader.
mkdir -p "${UPLOAD}"
seed "${UPLOAD}" "${SRC}"
# Marks this Contents tree as the one under test so KnoxRelayLoader does
# not replace unpublished Lua with the Steam copy. Never write this marker
# into the Steam cache or the Workshop package.
printf 'dev\n' > "${UPLOAD}/.knox-dev"
seed "${UPLOAD_LOADER}" "${LOADER_SRC}"
if [ ! -f "${UPLOAD_ROOT}/workshop.txt" ]; then
    echo "WARNING: ${UPLOAD_ROOT}/workshop.txt missing; Contents was still seeded" >&2
fi

if [ -e "${LEFTOVER}" ]; then
    rm -rf "${LEFTOVER}"
    echo "Removed leftover ${LEFTOVER} (third KnoxRelay copy; PZ scans it last)"
fi
if [ -e "${LEFTOVER_LOADER}" ]; then
    rm -rf "${LEFTOVER_LOADER}"
    echo "Removed leftover ${LEFTOVER_LOADER}"
fi

echo
echo "PZ loads Knox Relay from Contents/ first (workshop,steam,mods)."
echo "A Steam download of 3777446787 does not replace Contents/; this seed does."
echo "Fully quit Project Zomboid and relaunch — disconnect/reconnect keeps old Lua."
echo "In-game the Desk title must read 'KNOX DESK  X.Y' for the seeded version."
