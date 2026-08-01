#!/bin/bash
# Package ZomboidManager mod files into the Workshop upload structure.
# Copies Lua sources, mod.info, and images into the Build 42 layout.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_MOD="${REPO_ROOT}/game-server/mods/ZomboidManager"
DST_MOD="${REPO_ROOT}/workshop/ZomboidManager/Contents/mods/ZomboidManager/42"

echo "=== ZomboidManager Workshop Packager ==="
echo "Source: ${SRC_MOD}"
echo "Target: ${DST_MOD}"
echo ""

# Source is now inside the B42 42/ subdirectory
SRC_42="${SRC_MOD}/42"

# Clean previous build artifacts
rm -rf "${DST_MOD}/media"
echo "Cleaned previous media/ artifacts"

# Copy Lua files
mkdir -p "${DST_MOD}/media/lua"
cp -r "${SRC_42}/media/lua/server" "${DST_MOD}/media/lua/server"
cp -r "${SRC_42}/media/lua/client" "${DST_MOD}/media/lua/client"
echo "Copied Lua files"

# Copy mod.info into 42/ (for B42 Lua loading)
cp "${SRC_42}/mod.info" "${DST_MOD}/mod.info"
echo "Copied mod.info to 42/"

# Copy poster if source has one
if [ -f "${SRC_42}/poster.png" ]; then
    cp "${SRC_42}/poster.png" "${DST_MOD}/poster.png"
    echo "Copied poster.png to 42/"
fi

# Also copy mod.info + poster to the MOD ROOT (parent of 42/).
# PZ B42 dedicated server discovers mods by scanning for mod.info at the root
# of the mod directory — without this, ZomboidFileSystem.loadModAndRequired
# reports "required mod not found".
DST_MOD_ROOT="$(dirname "${DST_MOD}")"
cp "${SRC_42}/mod.info" "${DST_MOD_ROOT}/mod.info"
if [ -f "${SRC_42}/poster.png" ]; then
    cp "${SRC_42}/poster.png" "${DST_MOD_ROOT}/poster.png"
fi
echo "Copied mod.info + poster.png to mod root (for PZ discovery)"

# Summary
echo ""
echo "=== Package Summary ==="
echo "Files packaged:"
find "${DST_MOD_ROOT}" -type f | sort | while read -r f; do
    echo "  ${f#${REPO_ROOT}/}"
done
echo ""
echo "Workshop upload dir: workshop/ZomboidManager/Contents/"
echo "Ready for SteamCMD upload via workshop/workshop_upload.vdf"
