#!/bin/bash
# Pre-configure PZ server settings before first launch.
# This script is run by the entrypoint wrapper to set up RCON, admin password,
# and other settings that the joyfui ARM64 image doesn't handle via env vars.

set -e

# The renegademaster image exposes the server name as SERVER_NAME (with the
# underscore); accept both for safety so configure-server.sh always writes
# the same INI that PZ reads via `-servername`. Without this, the script
# silently fell back to ZomboidServer.ini while PZ kept reading IsnarmServ.ini
# (or whatever PZ_SERVER_NAME the user picked), and no mod ever made it into
# the live config.
SERVER_NAME="${SERVERNAME:-${SERVER_NAME:-${PZ_SERVER_NAME:-ZomboidServer}}}"

# Root directories. Overridable so the script can be exercised against a
# temporary tree in tests; the defaults are the real in-container paths, so
# production behaviour is unchanged (these vars are never set in the images).
PZ_STEAM_HOME="${PZ_STEAM_HOME:-/home/steam}"
PZ_CONFIG_DIR="${PZ_CONFIG_DIR:-${PZ_STEAM_HOME}/Zomboid}"

# The two base images install the server to different roots:
#   ARM64 (joyfui)         -> ${PZ_STEAM_HOME}/pzserver
#   AMD64 (renegademaster) -> ${PZ_STEAM_HOME}/ZomboidDedicatedServer
# Guessing wrong is silent but total: every Workshop step below derives its
# cache root from PZ_INSTALL_DIR, so a root that doesn't exist makes the scan
# report "all mods already cached", points SteamCMD's +force_install_dir at the
# wrong tree, skips the B42 root-level mod.info surfacing, and links nothing
# into Zomboid/mods/. Prefer a root holding an actual install over one that
# merely exists — on first boot the ARM64 bind mount is an empty directory and
# SteamCMD hasn't run yet. An explicit PZ_INSTALL_DIR always wins (compose sets
# it; tests point it at a throwaway tree).
if [ -z "${PZ_INSTALL_DIR:-}" ]; then
    for candidate in "${PZ_STEAM_HOME}/pzserver" "${PZ_STEAM_HOME}/ZomboidDedicatedServer"; do
        if [ -f "${candidate}/start-server.sh" ]; then
            PZ_INSTALL_DIR="$candidate"
            break
        fi
    done
fi
if [ -z "${PZ_INSTALL_DIR:-}" ]; then
    for candidate in "${PZ_STEAM_HOME}/pzserver" "${PZ_STEAM_HOME}/ZomboidDedicatedServer"; do
        if [ -d "$candidate" ]; then
            PZ_INSTALL_DIR="$candidate"
            break
        fi
    done
fi
PZ_INSTALL_DIR="${PZ_INSTALL_DIR:-${PZ_STEAM_HOME}/ZomboidDedicatedServer}"
echo "[configure-server] Server install dir: ${PZ_INSTALL_DIR}"

INI_DIR="${PZ_CONFIG_DIR}/Server"
INI_FILE="${INI_DIR}/${SERVER_NAME}.ini"
SANDBOX_FILE="${INI_DIR}/${SERVER_NAME}_SandboxVars.lua"

# Wait for the INI file to exist (created on first PZ server boot)
# If it doesn't exist yet, create a minimal one so the server can start
if [ ! -f "$INI_FILE" ]; then
    echo "[configure-server] INI file not found, creating initial config..."
    mkdir -p "$INI_DIR"
    cat > "$INI_FILE" << 'EOINI'
DefaultPort=16261
UDPPort=16262
ResetID=0
Map=Muldraugh, KY
Mods=
WorkshopItems=
RCONPort=27015
RCONPassword=changeme
Password=
MaxPlayers=16
Public=true
PauseEmpty=true
Open=true
AutoCreateUserInWhiteList=true
AutoSave=true
SaveWorldEveryMinutes=15
AdminPassword=changeme
SteamVAC=true
EOINI
    chmod 666 "$INI_FILE" 2>/dev/null || true
    echo "[configure-server] Initial INI created."
fi

# Apply settings from environment variables (with web UI overrides)
echo "[configure-server] Applying configuration..."

# Web UI persistence file — written by Laravel when config is saved via dashboard/API.
# Values here take priority over env var defaults so web UI changes survive restarts.
#
# Lives in Server/ (next to the INI and .mod_state) because that is the directory
# the app container (www-data) can write on the shared volume; the data root above
# is root-owned and not app-writable. Older builds wrote it to the data root, so
# migrate that file into Server/ once if it's still there.
CONFIG_STATE_FILE="${INI_DIR}/.config_state"
LEGACY_CONFIG_STATE_FILE="${PZ_CONFIG_DIR}/.config_state"
if [ ! -f "$CONFIG_STATE_FILE" ] && [ -f "$LEGACY_CONFIG_STATE_FILE" ]; then
    if mv "$LEGACY_CONFIG_STATE_FILE" "$CONFIG_STATE_FILE" 2>/dev/null; then
        chmod 666 "$CONFIG_STATE_FILE" 2>/dev/null || true
        echo "[configure-server] Migrated .config_state into Server/"
    fi
fi

# Read a value from .config_state, or return empty string.
read_config_state() {
    local key="$1"
    if [ -r "$CONFIG_STATE_FILE" ]; then
        grep "^${key}=" "$CONFIG_STATE_FILE" 2>/dev/null | sed "s/^${key}=//" | tail -1
    fi
}

# Portable in-place sed: GNU sed (Linux) requires `sed -i "expr" file`,
# BSD/macOS sed requires `sed -i '' "expr" file`. Use a temp-file + mv
# pattern so the script runs identically on both hosts.
sed_inplace() {
    local expr="$1"
    local file="$2"
    local tmp
    tmp=$(mktemp "${file}.XXXXXX")
    sed "$expr" "$file" > "$tmp" && mv "$tmp" "$file"
}

apply_setting() {
    local key="$1"
    local value="$2"
    local file="$3"

    if [ -z "$value" ]; then
        return
    fi

    # Escape sed metacharacters in replacement value (\ | &)
    local escaped_value
    escaped_value=$(printf '%s' "$value" | sed 's/[\\|&]/\\&/g')

    if grep -q "^${key}=" "$file" 2>/dev/null; then
        sed_inplace "s|^${key}=.*|${key}=${escaped_value}|" "$file"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

# Like apply_setting, but writes empty values too. Used for mod lists where
# the user removing every mod via the UI must actually clear the INI.
apply_setting_force() {
    local key="$1"
    local value="$2"
    local file="$3"

    local escaped_value
    escaped_value=$(printf '%s' "$value" | sed 's/[\\|&]/\\&/g')

    if grep -q "^${key}=" "$file" 2>/dev/null; then
        sed_inplace "s|^${key}=.*|${key}=${escaped_value}|" "$file"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

# Core settings — .config_state (web UI) takes priority over env var defaults.
#
# Each value falls back through two env var names: the PZ_* names used by the
# ARM64 (joyfui) image, then the bare names used by the AMD64 (renegademaster)
# image. Without the AMD64 fallback this script runs last and overwrites the
# values renegademaster already applied (e.g. MAX_PLAYERS) with these defaults,
# so a user who picked 24 players on AMD64 silently ended up with 16. Same
# both-names pattern the RCON section below already uses.
STATE_VAL=$(read_config_state "DefaultPort")
apply_setting "DefaultPort"          "${STATE_VAL:-${PZ_GAME_PORT:-${DEFAULT_PORT:-16261}}}"       "$INI_FILE"
STATE_VAL=$(read_config_state "UDPPort")
apply_setting "UDPPort"              "${STATE_VAL:-${PZ_DIRECT_PORT:-${UDP_PORT:-16262}}}"     "$INI_FILE"
STATE_VAL=$(read_config_state "MaxPlayers")
apply_setting "MaxPlayers"           "${STATE_VAL:-${PZ_MAX_PLAYERS:-${MAX_PLAYERS:-16}}}"        "$INI_FILE"
STATE_VAL=$(read_config_state "Map")
apply_setting "Map"                  "${STATE_VAL:-${PZ_MAP_NAMES:-${MAP_NAMES:-Muldraugh, KY}}}" "$INI_FILE"
STATE_VAL=$(read_config_state "Public")
apply_setting "Public"               "${STATE_VAL:-${PZ_PUBLIC_SERVER:-${PUBLIC_SERVER:-true}}}"    "$INI_FILE"
STATE_VAL=$(read_config_state "PauseEmpty")
apply_setting "PauseEmpty"           "${STATE_VAL:-${PZ_PAUSE_ON_EMPTY:-${PAUSE_ON_EMPTY:-true}}}"   "$INI_FILE"
STATE_VAL=$(read_config_state "SaveWorldEveryMinutes")
apply_setting "SaveWorldEveryMinutes" "${STATE_VAL:-${PZ_AUTOSAVE_INTERVAL:-${AUTOSAVE_INTERVAL:-15}}}" "$INI_FILE"
STATE_VAL=$(read_config_state "SteamVAC")
apply_setting "SteamVAC"             "${STATE_VAL:-${PZ_STEAM_VAC:-${STEAM_VAC:-true}}}"        "$INI_FILE"
STATE_VAL=$(read_config_state "Open")
apply_setting "Open"                 "${STATE_VAL:-${PZ_OPEN:-true}}"             "$INI_FILE"
STATE_VAL=$(read_config_state "AutoCreateUserInWhiteList")
apply_setting "AutoCreateUserInWhiteList" "${STATE_VAL:-${PZ_AUTO_CREATE_WHITELIST:-true}}" "$INI_FILE"

# UPnP hangs or crashes in many Docker/NAT environments. Default off; override
# via .config_state or PZ_UPNP=true if you really need it.
STATE_VAL=$(read_config_state "UPnP")
apply_setting "UPnP"                 "${STATE_VAL:-${PZ_UPNP:-false}}"             "$INI_FILE"

# Passwords — .config_state takes priority over env var defaults
STATE_VAL=$(read_config_state "Password")
apply_setting "Password"             "${STATE_VAL:-${PZ_SERVER_PASSWORD:-${SERVER_PASSWORD:-}}}"      "$INI_FILE"
STATE_VAL=$(read_config_state "AdminPassword")
apply_setting "AdminPassword"        "${STATE_VAL:-${PZ_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-admin}}}"  "$INI_FILE"

if [ -r "$CONFIG_STATE_FILE" ]; then
    echo "[configure-server] Applied web UI overrides from .config_state"
fi

# RCON — critical for Laravel API
# PZ_RCON_PASSWORD is used by the ARM64 image; RCON_PASSWORD by the AMD64 renegademaster image.
apply_setting "RCONPort"             "${PZ_RCON_PORT:-${RCON_PORT:-27015}}"         "$INI_FILE"
apply_setting "RCONPassword"         "${PZ_RCON_PASSWORD:-${RCON_PASSWORD:-changeme}}" "$INI_FILE"

# Mods — .mod_state (web UI) is authoritative. Env vars only seed the INI on
# the very first boot when no state file exists yet. PZ rewrites the .ini on
# shutdown and may prune entries it didn't load, so we cannot trust the .ini
# alone across restarts.
MOD_STATE_FILE="${INI_DIR}/.mod_state"
MOD_STATE_BACKUP="${INI_DIR}/.mod_state_backup"

if [ -r "$MOD_STATE_FILE" ]; then
    # `|| true` keeps the script alive under `set -e` if the state file is
    # truncated or missing one of the expected lines.
    STATE_MODS=$(grep -m1 "^Mods=" "$MOD_STATE_FILE" | sed 's/^Mods=//' || true)
    STATE_WORKSHOP=$(grep -m1 "^WorkshopItems=" "$MOD_STATE_FILE" | sed 's/^WorkshopItems=//' || true)
    # Force-write so an empty state file (user removed all mods) actually
    # clears the INI instead of letting stale entries reappear.
    apply_setting_force "Mods"          "$STATE_MODS"     "$INI_FILE"
    apply_setting_force "WorkshopItems" "$STATE_WORKSHOP" "$INI_FILE"
    echo "[configure-server] Restored mods from .mod_state (web UI)"
elif [ -n "${PZ_MOD_IDS:-}" ] || [ -n "${PZ_WORKSHOP_IDS:-}" ]; then
    # First-boot seed from .env — subsequent UI changes will own .mod_state.
    apply_setting "Mods"          "${PZ_MOD_IDS:-}"        "$INI_FILE"
    apply_setting "WorkshopItems" "${PZ_WORKSHOP_IDS:-}"   "$INI_FILE"
    echo "[configure-server] Seeded mods from environment variables (first boot)"
elif [ -r "$MOD_STATE_BACKUP" ]; then
    STATE_MODS=$(grep -m1 "^Mods=" "$MOD_STATE_BACKUP" | sed 's/^Mods=//' || true)
    STATE_WORKSHOP=$(grep -m1 "^WorkshopItems=" "$MOD_STATE_BACKUP" | sed 's/^WorkshopItems=//' || true)
    if [ -n "$STATE_MODS" ] || [ -n "$STATE_WORKSHOP" ]; then
        apply_setting "Mods"          "$STATE_MODS"          "$INI_FILE"
        apply_setting "WorkshopItems" "$STATE_WORKSHOP"      "$INI_FILE"
        echo "[configure-server] Restored mods from .mod_state_backup (INI snapshot)"
    fi
fi

# Sync Workshop mods via SteamCMD.
# The base SteamCMD script only updates the dedicated server (app 380870) and
# does NOT pull Workshop items. PZ B42 only loads mods present in the local
# Workshop cache, so any ID added via the web UI must be downloaded here
# before start_server runs — otherwise PZ silently drops the mod and may
# prune Mods= back to empty on its next ini rewrite.
#
# Every configured id is handed to SteamCMD on every boot, not just the ones
# whose directory is missing. Downloading only what was absent meant a mod was
# pinned forever to whatever version happened to arrive first: publish an
# update, restart, and the server kept running the old one with nothing in the
# log to say so. Knox Relay hid this for a long time because it is also staged
# into the image further down, which quietly replaced the stale copy — a
# rescue no other mod gets.
#
# +workshop_download_item is already the right shape for this: it is a no-op
# when the local copy is current and fetches the difference when it is not.
# The cost is a SteamCMD round trip on every start, which PZ_SKIP_WORKSHOP_SYNC
# exists to opt out of when boot time matters more than freshness.
PZ_WORKSHOP_APP_ID="108600"
WORKSHOP_CACHE_ROOT="${PZ_INSTALL_DIR}/steamapps/workshop/content/${PZ_WORKSHOP_APP_ID}"

# Re-read the final WorkshopItems= so we cover every restore path above.
CURRENT_WORKSHOP_LINE=$(grep -m1 "^WorkshopItems=" "$INI_FILE" | sed 's/^WorkshopItems=//' || true)
WORKSHOP_IDS=()
if [ -n "$CURRENT_WORKSHOP_LINE" ]; then
    IFS=';' read -ra WS_IDS <<< "$CURRENT_WORKSHOP_LINE"
    for wid in "${WS_IDS[@]}"; do
        wid="$(echo "$wid" | tr -d '[:space:]')"
        if [ -z "$wid" ]; then continue; fi
        WORKSHOP_IDS+=("$wid")
    done
fi

if [ "${#WORKSHOP_IDS[@]}" -eq 0 ]; then
    echo "[configure-server] No Workshop mods configured."
elif [ "${PZ_SKIP_WORKSHOP_SYNC:-false}" = "true" ]; then
    # Deliberate opt-out, so it reads as a choice in the log rather than as the
    # silence a skipped download used to produce.
    echo "[configure-server] PZ_SKIP_WORKSHOP_SYNC=true — not checking Steam for mod updates."
else
    echo "[configure-server] Syncing ${#WORKSHOP_IDS[@]} Workshop mod(s) via SteamCMD: ${WORKSHOP_IDS[*]}"
    # Name the root: an empty scan used to look identical to a genuinely warm
    # cache, which is how a wrong PZ_INSTALL_DIR hid for so long.
    echo "[configure-server] Workshop cache root: ${WORKSHOP_CACHE_ROOT}"
    # The two base images put SteamCMD in different places and neither one has
    # it on PATH, so look in the known locations rather than trusting a single
    # hard-coded fallback. The old fallback pointed at
    # /home/root/.local/steamcmd/steamcmd.sh, which exists in neither image —
    # it went unnoticed because this branch only ever ran for a mod that was
    # missing, and once a mod is downloaded it never was again.
    STEAMCMD_BIN=""
    for candidate in \
        "${PZ_STEAMCMD_BIN:-}" \
        "$(command -v steamcmd.sh 2>/dev/null || true)" \
        "$(command -v steamcmd 2>/dev/null || true)" \
        "${PZ_STEAM_HOME}/Steam/steamcmd.sh" \
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
        # Say so loudly. Silence here is what let a stale mod look like a
        # healthy one for as long as it did.
        echo "[configure-server] WARNING: SteamCMD not found — cannot check Steam for mod" \
             "updates. Mods will run at whatever version is already cached." \
             "Set PZ_STEAMCMD_BIN to its path."
    else
        # Same flags the ARM64 entrypoint uses for +app_update. Without
        # ForcePlatformType, FEX can ask Steam for the host arch and get nothing.
        SCMD_ARGS=("+@sSteamCmdForcePlatformType" "linux" \
            "+force_install_dir" "$PZ_INSTALL_DIR" "+login" "anonymous")
        for wid in "${WORKSHOP_IDS[@]}"; do
            SCMD_ARGS+=("+workshop_download_item" "$PZ_WORKSHOP_APP_ID" "$wid")
        done
        SCMD_ARGS+=("+quit")

        # Output is captured so a failure can be explained rather than just
        # reported. Not fatal either way: a cached copy from a previous boot
        # beats refusing to start because Steam was unreachable.
        #
        # Redirected rather than piped through tee, because a pipeline reports
        # the exit status of its *last* command — `steamcmd | tee` is always a
        # success no matter how steamcmd did, which turned this check into a
        # rubber stamp when it was first written that way.
        #
        # On the joyfui ARM64 image SteamCMD is x86. The entrypoint already
        # runs it under FEXBash for the game install; calling the binary
        # here used to die with qemu-i386 / ld-linux.so.2 and never talk
        # to Steam, which is why Workshop looked "impossible" on this box.
        SCMD_LOG="$(mktemp)"
        SCMD_STATUS=0
        if command -v FEXBash >/dev/null 2>&1; then
            steamcmd_cmd="$STEAMCMD_BIN"
            for arg in "${SCMD_ARGS[@]}"; do
                steamcmd_cmd="$steamcmd_cmd $(printf '%q' "$arg")"
            done
            echo "[configure-server] Running SteamCMD under FEXBash ($(uname -m))"
            FEXBash "$steamcmd_cmd" > "$SCMD_LOG" 2>&1 || SCMD_STATUS=$?
        else
            "$STEAMCMD_BIN" "${SCMD_ARGS[@]}" > "$SCMD_LOG" 2>&1 || SCMD_STATUS=$?
        fi
        cat "$SCMD_LOG"

        if [ "$SCMD_STATUS" -eq 0 ]; then
            echo "[configure-server] Workshop sync complete."
        elif grep -qE 'qemu-i386|ld-linux\.so\.2|Exec format error' "$SCMD_LOG"; then
            # Reached only when FEXBash is missing. The ARM64 image has it;
            # a stripped host or a bad PATH is the usual cause.
            echo "[configure-server] SteamCMD cannot run on $(uname -m) without FEXBash" \
                 "(it is a 32-bit x86 binary). Workshop mods were not refreshed."
            echo "[configure-server] Knox Relay is supplied by the image instead." \
                 "ANY OTHER Workshop mod must be pre-seeded into the cache or run on AMD64."
        else
            echo "[configure-server] WARNING: SteamCMD workshop sync exited non-zero —" \
                 "mods may be missing or stale."
            tail -5 "$SCMD_LOG" | sed 's/^/[configure-server]   /'
        fi
        rm -f "$SCMD_LOG"
    fi
fi

# Where the Workshop mirror lands, and the fallback home for a mod that was
# never a Workshop item. Defined here because the Knox Relay seed below picks
# its target from it.
ZOMBOID_MODS_DIR="${PZ_CONFIG_DIR}/mods"
mkdir -p "$ZOMBOID_MODS_DIR"

# Seed the image's own Knox Relay when it is newer than what is installed.
#
# The Dockerfiles stage the repo's copy at /opt/knox-relay, outside the
# bind-mounted Zomboid/, because anything COPYed straight into Zomboid/mods/ is
# hidden the moment that volume mounts. The Workshop mirror below then links
# whatever SteamCMD last downloaded over Zomboid/mods/KnoxRelay, so a Workshop
# item lagging the image silently downgrades the bridge. That is not a cosmetic
# mismatch: the app gates whole pages on the mod_version the bridge reports, so
# an old copy makes the live character dashboard render nothing at all.
#
# Only a strictly newer staged copy wins, so publishing a newer Workshop build
# still takes precedence and this never pins the server to the image.
#
# This runs before the manifest surfacing and the Zomboid/mods/ mirror below,
# not after them. Those two steps read the cache, and the mirror only tracks a
# later write to it when it is a real symlink — its `cp -r` fallback, used
# wherever the mount forbids symlinks, is a snapshot. Seeding afterwards left
# that snapshot holding the version the seed had just replaced, which is the
# stale bridge Lua this whole block exists to prevent. Seed first and every
# step below copies the winner.
KR_STAGED_DIR="${KR_STAGED_DIR:-/opt/knox-relay}"

# Where the seed has to land.
#
# Not Zomboid/mods/KnoxRelay, which is what this used to write. Once an id is
# in WorkshopItems=, PZ loads the mod out of the Workshop cache and ignores the
# local mods directory entirely — so seeding there produced a perfectly correct
# copy the game never opened. It looked like it worked because the Workshop
# copy usually agreed; the moment it did not, the boot log said
# "Seeded Knox Relay 1.11" and the server went on running 1.10.
#
# So the cache copy is the target when there is one, and the symlink planted
# below follows it. Zomboid/mods is the target only when this is not a Workshop
# mod at all. On AMD64 a later SteamCMD sync overwrites the cache again, which
# is correct: Steam wins whenever it can actually run.
KR_CACHE_DIR="${WORKSHOP_CACHE_ROOT}/${PZ_BRIDGE_WORKSHOP_ID:-3777446787}/mods/KnoxRelay"
if [ -d "$KR_CACHE_DIR" ]; then
    KR_LIVE_DIR="$KR_CACHE_DIR"
    KR_LIVE_LABEL="the Workshop cache"
else
    KR_LIVE_DIR="${ZOMBOID_MODS_DIR}/KnoxRelay"
    KR_LIVE_LABEL="Zomboid/mods"
fi

# Echo `modversion=` from a mod's B42 manifest, falling back to the root one.
mod_version_of() {
    local info
    for info in "$1/42/mod.info" "$1/mod.info"; do
        if [ -f "$info" ]; then
            sed -n 's/^modversion=//p' "$info" | head -1 | tr -d '\r'
            return
        fi
    done
}

if [ -d "$KR_STAGED_DIR" ]; then
    staged_version="$(mod_version_of "$KR_STAGED_DIR")"
    live_version="$(mod_version_of "$KR_LIVE_DIR")"
    newest="$(printf '%s\n%s\n' "$live_version" "$staged_version" | sort -V | tail -1)"

    # Same version still seeds: SteamCMD has just restored the Workshop copy,
    # which will not have unpublished local Lua (holds, desk fixes, …). A
    # strictly older image never overwrites a newer Workshop build.
    if [ -z "$live_version" ] \
        || [ "$newest" = "$staged_version" ]; then
        rm -rf "$KR_LIVE_DIR"
        cp -r "$KR_STAGED_DIR" "$KR_LIVE_DIR"
        echo "[configure-server] Seeded Knox Relay ${staged_version:-?} from the image into" \
             "${KR_LIVE_LABEL} (replacing ${live_version:-nothing})"
    else
        echo "[configure-server] Keeping installed Knox Relay ${live_version}" \
             "(image stages ${staged_version:-nothing})"
    fi
fi

# Surface PZ Build 42 mod manifests so the server can discover them.
# PZ B42 dedicated server scans `<workshop_id>/mods/<id>/mod.info` (root-level),
# but many B42-only mods only ship `42/mod.info`. Without root-level mod.info,
# PZ silently skips the mod. Walk every Workshop mod directory and lift the
# B42 manifest + poster up one level when it's missing.
if [ -d "$WORKSHOP_CACHE_ROOT" ]; then
    while IFS= read -r mod_dir; do
        if [ -f "$mod_dir/mod.info" ]; then continue; fi
        if [ ! -f "$mod_dir/42/mod.info" ]; then continue; fi
        cp "$mod_dir/42/mod.info" "$mod_dir/mod.info"
        for asset in poster.png icon.png preview.png; do
            if [ -f "$mod_dir/42/$asset" ] && [ ! -f "$mod_dir/$asset" ]; then
                cp "$mod_dir/42/$asset" "$mod_dir/$asset"
            fi
        done
        echo "[configure-server] Surfaced B42 manifest for mod: $(basename "$mod_dir")"
    done < <(find "$WORKSHOP_CACHE_ROOT" -maxdepth 3 -mindepth 3 -type d -path "*/mods/*")
fi

# Mirror Workshop-downloaded mods into Zomboid/mods/ so PZ's mod scanner
# discovers them. The dedicated server's Workshop discovery path expects
# proper Steam UGC subscriptions — anonymous SteamCMD downloads don't get
# subscribed, so PZ silently wipes them from `Mods=`/`WorkshopItems=` in
# the INI on startup. The `Zomboid/mods/` path is always scanned, so a
# symlink there gives PZ a reliable, always-trusted local copy.
if [ -d "$WORKSHOP_CACHE_ROOT" ]; then
    while IFS= read -r mod_dir; do
        mod_name="$(basename "$mod_dir")"
        target="$ZOMBOID_MODS_DIR/$mod_name"
        # Replace stale symlinks/dirs that may point to a removed mod.
        if [ -L "$target" ] || [ -e "$target" ]; then
            rm -rf "$target"
        fi
        if ln -s "$mod_dir" "$target" 2>/dev/null; then
            echo "[configure-server] Linked $mod_name from Workshop cache into Zomboid/mods/"
        else
            # Fallback for filesystems where symlinks aren't allowed in the mount.
            cp -r "$mod_dir" "$target"
            echo "[configure-server] Copied $mod_name from Workshop cache into Zomboid/mods/"
        fi
    done < <(find "$WORKSHOP_CACHE_ROOT" -maxdepth 3 -mindepth 3 -type d -path "*/mods/*")
fi

# Retire the standalone PZServerPulse mod, whose character dashboard now ships
# inside Knox Relay. Older boots seeded it into Zomboid/mods/, and PZ loads
# whatever it finds there once `Mods=` still names it, so leaving it in place
# would run two mods writing the same data.
PZSP_DST="${ZOMBOID_MODS_DIR}/PZServerPulse"
if [ -L "$PZSP_DST" ] || [ -e "$PZSP_DST" ]; then
    rm -rf "$PZSP_DST" \
        && echo "[configure-server] Removed the retired PZServerPulse mod (now part of KnoxRelay)"
fi
if grep -m1 "^Mods=" "$INI_FILE" 2>/dev/null | grep -q "PZServerPulse"; then
    echo "[configure-server] WARNING: Mods= still lists PZServerPulse, which no longer exists —" \
         "drop it from PZ_MOD_IDS (PZ_MOD_IDS=KnoxRelay); the live dashboard is part of KnoxRelay now"
fi

# Disable Lua checksum.
# Without this, PZ checksums mod Lua files and clients that don't have matching
# checksums get errors. This does NOT disable anti-cheat (Steam VAC).
apply_setting "DoLuaChecksum" "false" "$INI_FILE"
echo "[configure-server] Set DoLuaChecksum=false (required for Lua mods)"

# Snapshot the post-restore INI mods to .mod_state on first boot. PZ rewrites
# the .ini on shutdown and may prune mods it didn't load; without an initial
# snapshot, mods could disappear after the next restart cycle.
if [ ! -f "$MOD_STATE_FILE" ]; then
    SNAPSHOT_MODS=$(grep -m1 "^Mods=" "$INI_FILE" | sed 's/^Mods=//' || true)
    SNAPSHOT_WORKSHOP=$(grep -m1 "^WorkshopItems=" "$INI_FILE" | sed 's/^WorkshopItems=//' || true)
    if printf 'Mods=%s\nWorkshopItems=%s\n' "$SNAPSHOT_MODS" "$SNAPSHOT_WORKSHOP" > "$MOD_STATE_FILE" 2>/dev/null; then
        chmod 666 "$MOD_STATE_FILE" 2>/dev/null || true
        echo "[configure-server] Initialized .mod_state from current INI"
    fi
fi

# Snapshot what we just applied to the INI as the "running config." Laravel
# diffs this against .mod_state to decide whether mod changes are awaiting a
# restart. Always written, every boot, so the dashboard's pending-restart
# indicator clears once the user actually restarts.
APPLIED_STATE_FILE="${INI_DIR}/.mod_state_applied"
APPLIED_MODS=$(grep -m1 "^Mods=" "$INI_FILE" | sed 's/^Mods=//' || true)
APPLIED_WORKSHOP=$(grep -m1 "^WorkshopItems=" "$INI_FILE" | sed 's/^WorkshopItems=//' || true)
if printf 'Mods=%s\nWorkshopItems=%s\n' "$APPLIED_MODS" "$APPLIED_WORKSHOP" > "$APPLIED_STATE_FILE" 2>/dev/null; then
    chmod 666 "$APPLIED_STATE_FILE" 2>/dev/null || true
    echo "[configure-server] Wrote .mod_state_applied snapshot"
fi

# Pre-create Lua bridge directories for inventory / stats / position exports.
# PZ getFileWriter() cannot create intermediate dirs and fails with:
#   "cannot open file writer for <player>" / "cannot write export_requests.json"
# when Lua/ or Lua/inventory is missing or not world-writable (bind mounts).
# Use 0777 dirs + 0666 files (no sticky bit) so game (steam/root) and Laravel
# (www-data) can both open and replace each other's files.
LUA_DIR="${PZ_CONFIG_DIR}/Lua"
mkdir -p "${LUA_DIR}/inventory" 2>/dev/null \
    || echo "[configure-server] WARNING: Cannot create ${LUA_DIR}/inventory"
mkdir -p "${LUA_DIR}/vitals" 2>/dev/null \
    || echo "[configure-server] WARNING: Cannot create ${LUA_DIR}/vitals"
chmod 777 "${LUA_DIR}" 2>/dev/null || true
chmod 777 "${LUA_DIR}/inventory" 2>/dev/null || true
chmod 777 "${LUA_DIR}/vitals" 2>/dev/null || true
# Touch placeholder files so mounts exist and stay writable
for f in export_requests.json player_stats.json players_live.json game_state.json \
         items_catalog.json delivery_queue.json delivery_results.json \
         deposit_requests.json deposit_results.json; do
    if [ ! -f "${LUA_DIR}/${f}" ]; then
        : > "${LUA_DIR}/${f}" 2>/dev/null || true
    fi
    chmod 666 "${LUA_DIR}/${f}" 2>/dev/null || true
done
# Existing files under inventory/
chmod 666 "${LUA_DIR}/inventory"/* 2>/dev/null || true
find "${LUA_DIR}" -type d -exec chmod 777 {} + 2>/dev/null || true
find "${LUA_DIR}" -type f -exec chmod 666 {} + 2>/dev/null || true
if [ -d "${LUA_DIR}/inventory" ]; then
    echo "[configure-server] Lua bridge directories ready at ${LUA_DIR} (mode $(stat -c '%a' "${LUA_DIR}" 2>/dev/null || echo '?'))"
fi

# Ensure config files are world-readable/writable so both steam (game server)
# and www-data (app container) can access them on the shared volume.
chmod 666 "$INI_FILE" 2>/dev/null || true
[ -f "$SANDBOX_FILE" ] && chmod 666 "$SANDBOX_FILE" 2>/dev/null || true

# Fix JVM heap + wrap ProjectZomboid64 so -Xmx always has a unit (m/g).
# Steam validate restores the real binary each boot; we re-wrap here (after Steam).
if [ -f /home/steam/fix-heap.sh ]; then
    echo "[configure-server] Applying JVM heap fix / ProjectZomboid64 wrapper..."
    bash /home/steam/fix-heap.sh || true
fi

# Log effective values from the INI file (not env vars, which may have been overridden)
echo "[configure-server] Configuration applied:"
echo "  Port: $(grep '^DefaultPort=' "$INI_FILE" | sed 's/^DefaultPort=//')/udp"
echo "  RCON: $(grep '^RCONPort=' "$INI_FILE" | sed 's/^RCONPort=//')/tcp"
echo "  MaxPlayers: $(grep '^MaxPlayers=' "$INI_FILE" | sed 's/^MaxPlayers=//')"
echo "  Public: $(grep '^Public=' "$INI_FILE" | sed 's/^Public=//')"
echo "  PauseEmpty: $(grep '^PauseEmpty=' "$INI_FILE" | sed 's/^PauseEmpty=//')"
echo "  Mods: $(grep '^Mods=' "$INI_FILE" | sed 's/^Mods=//')"
echo "  WorkshopItems: $(grep '^WorkshopItems=' "$INI_FILE" | sed 's/^WorkshopItems=//')"
echo "[configure-server] Done."
