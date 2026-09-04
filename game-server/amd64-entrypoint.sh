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
if ! grep -q ".admin_password.env" /home/steam/run_server.sh 2>/dev/null; then
    sed -i '/^start_server$/i [ -r /home/steam/Zomboid/Server/.admin_password.env ] \&\& . /home/steam/Zomboid/Server/.admin_password.env' /home/steam/run_server.sh
    echo "[entrypoint] Patched run_server.sh to apply the panel admin password before start"
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
export PZ_SHARED_DIR="/home/steam/Zomboid"
export BASE_GAME_DIR="${BASE_GAME_DIR:-/home/steam/ZomboidDedicatedServer}"
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
BASE_GAME_DIR="${BASE_GAME_DIR:-/home/steam/ZomboidDedicatedServer}"
STEAM_INSTALL_FILE="/home/steam/install_server.scmd"

write_steam_install_script() {
    local with_validate="${1:-validate}"
    local app_line="app_update 380870"
    if [ "$GAME_VERSION" != "public" ] && [ -n "$GAME_VERSION" ]; then
        app_line="app_update 380870 -beta ${GAME_VERSION}"
    fi
    if [ "$with_validate" = "validate" ]; then
        app_line="${app_line} validate"
    fi

    cat > "$STEAM_INSTALL_FILE" <<EOF
@ShutdownOnFailedCommand 0
@NoPromptForPassword 1
force_install_dir ${BASE_GAME_DIR}
login anonymous
${app_line}
quit
EOF
    echo "[entrypoint] SteamCMD script: ${app_line}"
}

write_steam_install_script validate

# Base image apply_preinstall_config rewrites install_server.scmd to always use
# `-beta $GAME_VERSION`. Neutralize that sed so our script sticks.
if [ -f /home/steam/run_server.sh ] && ! grep -q 'PZ_SKIP_BETA_REWRITE' /home/steam/run_server.sh 2>/dev/null; then
    sed -i \
        's|sed -i "s/beta \.\* /beta $GAME_VERSION /g" "$STEAM_INSTALL_FILE"|true # PZ_SKIP_BETA_REWRITE|' \
        /home/steam/run_server.sh
    if grep -q 'PZ_SKIP_BETA_REWRITE' /home/steam/run_server.sh 2>/dev/null; then
        echo "[entrypoint] Disabled base-image beta rewrite of install_server.scmd"
    else
        echo "[entrypoint] WARNING: could not disable base-image beta rewrite — check run_server.sh"
    fi
fi

# The base image prints "### Project Zomboid Server updated." whether or not
# SteamCMD worked. Inject our own check at the top of start_server(), which by
# definition runs after the image's update step, so it reads the manifest
# exactly as SteamCMD left it. Exit codes are documented in the script.
cat > /home/steam/run_update_check.sh << 'EOF'
#!/bin/bash
# PZ_UPDATE_GUARD
bash /home/steam/steam-update-check.sh
_rc=$?
if [ "$_rc" -eq 1 ]; then
    printf '\n### Restarting the container to run a clean reinstall.\n'
    exit 1
elif [ "$_rc" -ne 0 ]; then
    printf '\n### Refusing to start on a stale build.\n'
    printf '### Clients that already updated would hang at "Joining game...".\n'
    printf '### Container staying up for debugging: docker logs pz-game-server\n'
    sleep infinity
    exit 1
fi
EOF
chmod +x /home/steam/run_update_check.sh

if [ -f /home/steam/run_server.sh ] && ! grep -q 'PZ_UPDATE_GUARD' /home/steam/run_server.sh 2>/dev/null; then
    # Inject at the top of start_server() - GNU sed.
    sed -i 's|^function start_server() {$|function start_server() {\n    # PZ_UPDATE_GUARD\n    bash /home/steam/run_update_check.sh \|\| exit $?|' \
        /home/steam/run_server.sh
    if grep -q 'PZ_UPDATE_GUARD' /home/steam/run_server.sh 2>/dev/null; then
        echo "[entrypoint] Patched run_server.sh with the Steam update guard"
    else
        echo "[entrypoint] WARNING: update guard patch failed - a failed update will boot stale"
    fi
fi

game_binary_present() {
    [ -e "$BASE_GAME_DIR/ProjectZomboid64" ] || [ -e "$BASE_GAME_DIR/ProjectZomboid64.real" ]
}

# Incomplete install (scripts/json without binary) makes SteamCMD validate fail
# immediately with state 0x6. Wipe the game install volume so the next app_update
# can do a clean download. Saves/config live in /home/steam/Zomboid — untouched.
clean_incomplete_install() {
    echo "[entrypoint] Incomplete install detected (ProjectZomboid64 missing) — cleaning ${BASE_GAME_DIR}"
    if [ ! -d "$BASE_GAME_DIR" ]; then
        mkdir -p "$BASE_GAME_DIR"
        return 0
    fi
    # Prefer targeted wipe of Steam state + known broken tree.
    find "$BASE_GAME_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || \
        rm -rf "${BASE_GAME_DIR:?}/"* 2>/dev/null || true
    mkdir -p "$BASE_GAME_DIR"
    echo "[entrypoint] Cleaned game install dir for fresh SteamCMD download"
}

FORCE_FILE="/home/steam/Zomboid/.force_update"
if [ -f "$FORCE_FILE" ]; then
    echo "[entrypoint] Force update flag detected — clearing install for re-download (keeps saves)"
    rm -f "$FORCE_FILE"
    clean_incomplete_install
elif ! game_binary_present; then
    # Half-install from a previous failed SteamCMD (0x6) — clean before retry.
    if [ -f "$BASE_GAME_DIR/start-server.sh" ] \
        || [ -f "$BASE_GAME_DIR/ProjectZomboid64.json" ] \
        || [ -d "$BASE_GAME_DIR/steamapps" ]; then
        clean_incomplete_install
    fi
fi

# Pre-install with retries when the binary is missing. The base image always
# prints "Server updated" even when SteamCMD fails; doing the download here
# with real retries gives a clean install before run_server.sh starts.
if ! game_binary_present; then
    echo "[entrypoint] Game binary missing — running SteamCMD install (retries)..."
    STEAMCMD_BIN="$(command -v steamcmd.sh || true)"
    if [ -z "$STEAMCMD_BIN" ] && [ -x /home/root/.local/steamcmd/steamcmd.sh ]; then
        STEAMCMD_BIN=/home/root/.local/steamcmd/steamcmd.sh
    fi
    if [ -n "$STEAMCMD_BIN" ]; then
        for attempt in 1 2 3; do
            # Attempt 1-2: validate. Attempt 3: no validate (sometimes unblocks 0x6).
            if [ "$attempt" -eq 3 ]; then
                write_steam_install_script novalidate
            else
                write_steam_install_script validate
            fi
            echo "[entrypoint] SteamCMD attempt ${attempt}/3..."
            if "$STEAMCMD_BIN" +runscript "$STEAM_INSTALL_FILE"; then
                :
            fi
            if game_binary_present; then
                echo "[entrypoint] SteamCMD install OK (ProjectZomboid64 present)"
                break
            fi
            echo "[entrypoint] SteamCMD attempt ${attempt}/3 did not produce ProjectZomboid64"
            if [ "$attempt" -lt 3 ]; then
                clean_incomplete_install
                sleep 5
            fi
        done
        # Restore validate script for any later base-image update pass
        write_steam_install_script validate
    else
        echo "[entrypoint] WARNING: steamcmd.sh not found — relying on base image update"
    fi

    if ! game_binary_present; then
        echo "[entrypoint] FATAL: SteamCMD could not install Project Zomboid after 3 attempts."
        echo "[entrypoint] Common causes: no disk space, network/CDN block, Steam outage."
        echo "[entrypoint] Check: df -h ; docker logs pz-game-server"
        echo "[entrypoint] Container staying up for debugging."
        sleep infinity
        exit 1
    fi
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
