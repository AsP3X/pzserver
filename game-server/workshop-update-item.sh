#!/usr/bin/env bash
#
# Download one Steam Workshop item into the dedicated server's cache.
#
# Called from the admin panel via docker exec so a single mod can be refreshed
# without restarting the whole container. SteamCMD writes the files; the running
# PZ process keeps whatever it already loaded until the next boot.
#
# Usage: workshop-update-item.sh <workshop_id>
set -u

WID="${1:-}"
if ! [[ "$WID" =~ ^[0-9]{1,20}$ ]]; then
    echo "STATUS=error"
    echo "Need a Workshop file id."
    exit 1
fi

# Same install-dir detection as configure-server.sh so SteamCMD writes where
# PZ will later read.
if [ -z "${PZ_INSTALL_DIR:-}" ]; then
    for candidate in \
        "${PZ_STEAM_HOME:-/home/steam}/ZomboidDedicatedServer" \
        "${PZ_STEAM_HOME:-/home/steam}/pzserver" \
        /home/steam/ZomboidDedicatedServer \
        /home/steam/pzserver
    do
        if [ -x "$candidate/ProjectZomboid64" ] || [ -d "$candidate/steamapps" ]; then
            PZ_INSTALL_DIR="$candidate"
            break
        fi
    done
fi
PZ_INSTALL_DIR="${PZ_INSTALL_DIR:-${PZ_STEAM_HOME:-/home/steam}/ZomboidDedicatedServer}"

PZ_WORKSHOP_APP_ID="108600"
WORKSHOP_CACHE_ROOT="${PZ_INSTALL_DIR}/steamapps/workshop/content/${PZ_WORKSHOP_APP_ID}"

STEAMCMD_BIN=""
for candidate in \
    "${PZ_STEAMCMD_BIN:-}" \
    "$(command -v steamcmd.sh 2>/dev/null || true)" \
    "$(command -v steamcmd 2>/dev/null || true)" \
    "${PZ_STEAM_HOME:-}/Steam/steamcmd.sh" \
    "/home/steam/Steam/steamcmd.sh" \
    "/opt/steamcmd/steamcmd.sh" \
    "/home/root/.local/steamcmd/steamcmd.sh"
do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        STEAMCMD_BIN="$candidate"
        break
    fi
done

if [ -z "$STEAMCMD_BIN" ]; then
    echo "STATUS=error"
    echo "SteamCMD not found. Set PZ_STEAMCMD_BIN to its path."
    exit 1
fi

SCMD_ARGS=("+@sSteamCmdForcePlatformType" "linux" \
    "+force_install_dir" "$PZ_INSTALL_DIR" "+login" "anonymous" \
    "+workshop_download_item" "$PZ_WORKSHOP_APP_ID" "$WID" "+quit")

SCMD_LOG="$(mktemp)"
SCMD_STATUS=0
if command -v FEXBash >/dev/null 2>&1; then
    steamcmd_cmd="$STEAMCMD_BIN"
    for arg in "${SCMD_ARGS[@]}"; do
        steamcmd_cmd="$steamcmd_cmd $(printf '%q' "$arg")"
    done
    echo "[workshop-update] Running SteamCMD under FEXBash ($(uname -m)) for $WID"
    FEXBash "$steamcmd_cmd" > "$SCMD_LOG" 2>&1 || SCMD_STATUS=$?
else
    echo "[workshop-update] Running SteamCMD for $WID"
    "$STEAMCMD_BIN" "${SCMD_ARGS[@]}" > "$SCMD_LOG" 2>&1 || SCMD_STATUS=$?
fi
cat "$SCMD_LOG"

if grep -qE "ERROR!|Failed to install workshop item" "$SCMD_LOG"; then
    echo "STATUS=error"
    rm -f "$SCMD_LOG"
    exit 1
fi

if [ "$SCMD_STATUS" -ne 0 ] && ! grep -q "Success. Downloaded item" "$SCMD_LOG"; then
    echo "STATUS=error"
    echo "SteamCMD exited ${SCMD_STATUS}."
    rm -f "$SCMD_LOG"
    exit 1
fi
rm -f "$SCMD_LOG"

# B42-only mods ship 42/mod.info; PZ discovers the root-level file.
ITEM_ROOT="${WORKSHOP_CACHE_ROOT}/${WID}"
if [ -d "$ITEM_ROOT/mods" ]; then
    for mod_dir in "$ITEM_ROOT/mods"/*; do
        [ -d "$mod_dir" ] || continue
        if [ ! -f "$mod_dir/mod.info" ] && [ -f "$mod_dir/42/mod.info" ]; then
            cp "$mod_dir/42/mod.info" "$mod_dir/mod.info"
        fi
        for asset in poster.png icon.png preview.png; do
            if [ -f "$mod_dir/42/$asset" ] && [ ! -f "$mod_dir/$asset" ]; then
                cp "$mod_dir/42/$asset" "$mod_dir/$asset"
            fi
        done
    done
fi

VERSION=""
for info in \
    "$ITEM_ROOT/mods"/*/42/mod.info \
    "$ITEM_ROOT/mods"/*/mod.info
do
    [ -f "$info" ] || continue
    VERSION="$(sed -n 's/^modversion=//p' "$info" | head -1 | tr -d '\r')"
    if [ -n "$VERSION" ]; then
        break
    fi
done

echo "STATUS=ok"
echo "VERSION=${VERSION:-}"
exit 0
