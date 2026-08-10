#!/bin/bash
# Package PZServerPulse mod files into the Workshop upload structure.
# Copies Lua sources, mod.info, and images into the Build 42 layout.
#
# Usage: bash scripts/workshop-package-pzsp.sh
#
# After running this, the mod is ready to upload via the PZ in-game
# Workshop submit screen. Point the uploader at:
#   workshop/PZServerPulse/Contents/

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_MOD="${REPO_ROOT}/game-server/mods/PZServerPulse"
DST_MOD="${REPO_ROOT}/workshop/PZServerPulse/Contents/mods/PZServerPulse/42"

echo "=== PZServerPulse Workshop Packager ==="
echo "Source: ${SRC_MOD}"
echo "Target: ${DST_MOD}"
echo ""

# Source is inside the B42 42/ subdirectory
SRC_42="${SRC_MOD}/42"

# Version check: mod.info and SP_Bridge.VERSION must match
INFO_VERSION="$(sed -n 's/^modversion=//p' "${SRC_42}/mod.info" | tr -d '\r')"
LUA_VERSION="$(sed -n 's/^SP_Bridge\.VERSION *= *"\(.*\)"$/\1/p' "${SRC_42}/media/lua/server/SP_Bridge.lua")"

if [ "${INFO_VERSION}" != "${LUA_VERSION}" ]; then
    echo "ERROR: version mismatch — mod.info says '${INFO_VERSION}', SP_Bridge.VERSION says '${LUA_VERSION}'."
    echo "Update both before packaging."
    exit 1
fi

echo "Version: ${INFO_VERSION}"
echo ""

# Clean previous build artifacts
rm -rf "${DST_MOD}/media"
echo "Cleaned previous media/ artifacts"

# Copy Lua files
mkdir -p "${DST_MOD}/media/lua"
cp -r "${SRC_42}/media/lua/server" "${DST_MOD}/media/lua/server"
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
# of the mod directory.
DST_MOD_ROOT="$(dirname "${DST_MOD}")"
cp "${SRC_42}/mod.info" "${DST_MOD_ROOT}/mod.info"
if [ -f "${SRC_42}/poster.png" ]; then
    cp "${SRC_42}/poster.png" "${DST_MOD_ROOT}/poster.png"
fi
echo "Copied mod.info + poster.png to mod root (for PZ discovery)"

# Strip macOS metadata
find "${DST_MOD_ROOT}" -name '.DS_Store' -delete 2>/dev/null || true

# The in-game uploader reads these two from the item root
ITEM_ROOT="${REPO_ROOT}/workshop/PZServerPulse"
for required in workshop.txt preview.png; do
    if [ ! -f "${ITEM_ROOT}/${required}" ]; then
        echo "WARNING: missing ${ITEM_ROOT#${REPO_ROOT}/}/${required} — the in-game uploader needs it"
    fi
done

# Summary
echo ""
echo "=== Package Summary ==="
echo "Files packaged:"
find "${DST_MOD_ROOT}" -type f | sort | while read -r f; do
    echo "  ${f#${REPO_ROOT}/}"
done
echo ""
echo "Workshop upload dir: workshop/PZServerPulse/Contents/"
echo ""
echo "To publish on Steam Workshop:"
echo "  1. Open Project Zomboid"
echo "  2. Go to Main Menu → Workshop → Your Items"
echo "  3. Click 'Create New Item'"
echo "  4. Point the uploader at: workshop/PZServerPulse/Contents/"
echo "  5. Fill in the metadata from workshop.txt"
echo "  6. Publish!"
