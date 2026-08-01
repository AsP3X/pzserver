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

FORCE_FILE="/home/steam/Zomboid/.force_update"
if [ -f "$FORCE_FILE" ]; then
    echo "[entrypoint] Force update flag detected"
    rm -f "$FORCE_FILE"
    rm -f /home/steam/ZomboidDedicatedServer/ProjectZomboid64
    rm -f /home/steam/ZomboidDedicatedServer/ProjectZomboid64.real
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
