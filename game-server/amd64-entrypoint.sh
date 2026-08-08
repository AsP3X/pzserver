#!/bin/bash
# Wrapper entrypoint for the AMD64 game server image (renegademaster).
# Patches run_server.sh to run configure-server.sh AFTER SteamCMD validate
# but BEFORE start_server.
#
# Also installs a ProjectZomboid64 wrapper so JVM -Xmx always has a unit
# (fixes "Too small maximum heap" when the image writes -Xmx8192 without m).

# --- Root-only init: fix volume permissions ---
if [ "$(id -u)" = "0" ]; then
    echo "[entrypoint] Fixing volume permissions..."
    mkdir -p /home/steam/Zomboid/Lua/inventory \
             /home/steam/Zomboid/Server \
             /home/steam/Zomboid/db \
             /home/steam/Zomboid/Saves 2>/dev/null || true
    # Lua bridge must be world-writable (game + Laravel app).
    # Do NOT use sticky 1777: it blocks rename/replace of files owned by the other UID.
    find /home/steam/Zomboid/Lua -type d -exec chmod 777 {} + 2>/dev/null || chmod -R 777 /home/steam/Zomboid/Lua 2>/dev/null || true
    find /home/steam/Zomboid/Lua -type f -exec chmod 666 {} + 2>/dev/null || true

    chmod 777 /home/steam/Zomboid/Server 2>/dev/null || true
    chmod 777 /home/steam/Zomboid/db 2>/dev/null || true
    chmod 777 /home/steam/Zomboid/Saves 2>/dev/null || true
    # Parent bind mount sometimes arrives as 755 root-only on host
    chmod 777 /home/steam/Zomboid 2>/dev/null || true
fi

CONFIGURE_SCRIPT="/home/steam/configure-server.sh"
FIX_HEAP_SCRIPT="/home/steam/fix-heap.sh"

# Normalize MAX_RAM: pure digits → megabytes
if [ -n "${MAX_RAM:-}" ]; then
    _ram=$(printf '%s' "$MAX_RAM" | tr -d '[:space:]')
    if printf '%s' "$_ram" | grep -Eq '^[0-9]+$'; then
        export MAX_RAM="${_ram}m"
        echo "[entrypoint] MAX_RAM normalized to ${MAX_RAM}"
    else
        export MAX_RAM="$_ram"
    fi
fi
# Some image scripts only keep digits — also export a form they might pass through
export PZ_MAX_RAM="${PZ_MAX_RAM:-$MAX_RAM}"

# Clean up previously injected ZM files and empty mod directory from base game.
for dir in /home/steam/ZomboidDedicatedServer/media/lua/server /home/steam/ZomboidDedicatedServer/media/lua/client; do
    if ls "$dir"/ZM_*.lua 1>/dev/null 2>&1; then
        rm -f "$dir"/ZM_*.lua
        echo "[entrypoint] Cleaned up old injected ZM files from $dir"
    fi
done

if [ -f "$CONFIGURE_SCRIPT" ] && ! grep -q "configure-server.sh" /home/steam/run_server.sh 2>/dev/null; then
    sed -i '/^start_server$/i bash '"$CONFIGURE_SCRIPT" /home/steam/run_server.sh
    echo "[entrypoint] Patched run_server.sh to run configure-server.sh before start"
fi

# Heap fix: configure-server installs ProjectZomboid64 wrapper after Steam update.
# Also inject an extra call before start_server for safety.
if [ -f "$FIX_HEAP_SCRIPT" ]; then
    chmod +x "$FIX_HEAP_SCRIPT" 2>/dev/null || true
    if ! grep -q "fix-heap.sh" /home/steam/run_server.sh 2>/dev/null; then
        sed -i '/^start_server$/i bash /home/steam/fix-heap.sh' /home/steam/run_server.sh
        echo "[entrypoint] Patched run_server.sh to run fix-heap.sh before start_server"
    fi
fi

# Branch override from shared volume
OVERRIDE_FILE="/home/steam/Zomboid/.steam_branch"
if [ -f "$OVERRIDE_FILE" ]; then
    GAME_VERSION=$(tr -d '[:space:]' < "$OVERRIDE_FILE")
    echo "[entrypoint] Branch override from $OVERRIDE_FILE: $GAME_VERSION"
fi
export GAME_VERSION="${GAME_VERSION:-public}"
echo "[entrypoint] Steam branch: $GAME_VERSION"

# ---------------------------------------------------------------------------
# Fix install_server.scmd branch flag.
#
# Renegade-Master always runs:  app_update 380870 -beta <GAME_VERSION> validate
# For the public branch that becomes `-beta public`, which SteamCMD often
# rejects with "App '380870' state is 0x6 after update job" and leaves a
# half-installed tree (start-server.sh present, ProjectZomboid64 missing).
# Public must use no -beta flag; only non-public branches pass -beta.
# ---------------------------------------------------------------------------
STEAM_INSTALL_FILE="/home/steam/install_server.scmd"
if [ -f "$STEAM_INSTALL_FILE" ]; then
    if [ "$GAME_VERSION" = "public" ] || [ -z "$GAME_VERSION" ]; then
        sed -i 's|app_update 380870.*|app_update 380870 validate|' "$STEAM_INSTALL_FILE"
        echo "[entrypoint] SteamCMD: public branch (no -beta flag)"
    else
        sed -i "s|app_update 380870.*|app_update 380870 -beta ${GAME_VERSION} validate|" "$STEAM_INSTALL_FILE"
        echo "[entrypoint] SteamCMD: branch -beta ${GAME_VERSION}"
    fi
fi

# Base image apply_preinstall_config rewrites install_server.scmd to always use
# `-beta $GAME_VERSION`. Replace that sed so our public/branch line sticks.
if [ -f /home/steam/run_server.sh ] && ! grep -q 'PZ_SKIP_BETA_REWRITE' /home/steam/run_server.sh 2>/dev/null; then
    # Match the exact line from renegademaster run_server.sh apply_preinstall_config
    sed -i \
        's|sed -i "s/beta \.\* /beta $GAME_VERSION /g" "$STEAM_INSTALL_FILE"|true # PZ_SKIP_BETA_REWRITE|' \
        /home/steam/run_server.sh
    if grep -q 'PZ_SKIP_BETA_REWRITE' /home/steam/run_server.sh 2>/dev/null; then
        echo "[entrypoint] Disabled base-image beta rewrite of install_server.scmd"
    else
        echo "[entrypoint] WARNING: could not disable base-image beta rewrite — check run_server.sh"
    fi
fi

# Refuse to start with a broken install (avoids restart loops after SteamCMD 0x6).
if [ -f /home/steam/run_server.sh ] && ! grep -q 'PZ_BINARY_GUARD' /home/steam/run_server.sh 2>/dev/null; then
    # Insert a guard function and call it at the top of start_server().
    # Use a marker so we only patch once per container filesystem.
    python3 - <<'PY' || true
from pathlib import Path
path = Path("/home/steam/run_server.sh")
text = path.read_text()
if "PZ_BINARY_GUARD" in text:
    raise SystemExit(0)
guard_fn = '''
# PZ_BINARY_GUARD — installed by amd64-entrypoint.sh
function ensure_game_binary() {
    if [[ ! -e "$BASE_GAME_DIR/ProjectZomboid64" && ! -e "$BASE_GAME_DIR/ProjectZomboid64.real" ]]; then
        printf "\\n### FATAL: ProjectZomboid64 binary missing after SteamCMD.\\n"
        printf "### SteamCMD likely failed (state 0x6 = content servers / corrupt install / bad -beta).\\n"
        printf "### Fix: clear game install volume (keep Saves/) or force-update after fixing network/disk.\\n"
        printf "### Container staying up for debugging: docker logs pz-game-server\\n"
        sleep infinity
        exit 1
    fi
}

'''
# Insert function before start_server definition
text = text.replace(
    "# Start the Server\nfunction start_server() {",
    "# Start the Server\n" + guard_fn + "function start_server() {\n    ensure_game_binary",
    1,
)
if "PZ_BINARY_GUARD" not in text:
    # Fallback: insert before first start_server call pattern
    text = text.replace(
        "function start_server() {",
        guard_fn + "function start_server() {\n    ensure_game_binary",
        1,
    )
path.write_text(text)
print("[entrypoint] Patched run_server.sh with ProjectZomboid64 binary guard")
PY
fi

FORCE_FILE="/home/steam/Zomboid/.force_update"
if [ -f "$FORCE_FILE" ]; then
    echo "[entrypoint] Force update flag detected — clearing Steam appmanifest (keeps saves)"
    rm -f "$FORCE_FILE"
    # Prefer re-download via manifest wipe over deleting the binary first.
    # Deleting ProjectZomboid64 before a failed SteamCMD leaves the server unstartable.
    rm -f /home/steam/ZomboidDedicatedServer/steamapps/appmanifest_380870.acf
    rm -rf /home/steam/ZomboidDedicatedServer/steamapps/downloading \
           /home/steam/ZomboidDedicatedServer/steamapps/temp 2>/dev/null || true
fi

unset MOD_NAMES
unset MOD_WORKSHOP_IDS

INI_FILE="/home/steam/Zomboid/Server/${SERVERNAME:-${SERVER_NAME:-ZomboidServer}}.ini"
MOD_STATE_BACKUP="/home/steam/Zomboid/Server/.mod_state_backup"
if [ -f "$INI_FILE" ]; then
    CURRENT_MODS=$(grep "^Mods=" "$INI_FILE" | head -1)
    CURRENT_WORKSHOP=$(grep "^WorkshopItems=" "$INI_FILE" | head -1)
    CURRENT_MODS_VALUE="${CURRENT_MODS#Mods=}"
    CURRENT_WORKSHOP_VALUE="${CURRENT_WORKSHOP#WorkshopItems=}"
    if [ -n "$CURRENT_MODS_VALUE" ] || [ -n "$CURRENT_WORKSHOP_VALUE" ]; then
        printf '%s\n%s\n' "$CURRENT_MODS" "$CURRENT_WORKSHOP" > "$MOD_STATE_BACKUP"
        echo "[entrypoint] Saved INI mod state to .mod_state_backup"
    fi
fi

exec /home/steam/run_server.sh
