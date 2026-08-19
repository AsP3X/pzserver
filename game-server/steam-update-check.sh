#!/bin/bash
# Decides whether the installed game is current enough to boot.
#
# The base image prints "### Project Zomboid Server updated." whether or not
# SteamCMD succeeded, so its output is not evidence. SteamCMD's own
# appmanifest_380870.acf is: it records what is installed and what Steam
# expects to be installed.
#
# This script never sleeps and never starts anything. It writes a report and
# returns a verdict as an exit code; the caller decides what to do.
#
#   0  current enough - boot
#   1  clean reinstall queued (.force_update written) - restart the container
#   2  halt, a human is needed
#
# Env:
#   BASE_GAME_DIR   game install root    (default /home/steam/ZomboidDedicatedServer)
#   PZ_SHARED_DIR   report + stamp home  (default /home/steam/Zomboid)
#   GAME_VERSION    steam branch         (default public)
#   STEAMCMD_LOG    explicit content_log.txt, else the newest candidate

set -u

BASE_GAME_DIR="${BASE_GAME_DIR:-/home/steam/ZomboidDedicatedServer}"
PZ_SHARED_DIR="${PZ_SHARED_DIR:-/home/steam/Zomboid}"
GAME_VERSION="${GAME_VERSION:-public}"

APP_ID=380870
CONTENT_DEPOT=380871
MANIFEST="${BASE_GAME_DIR}/steamapps/appmanifest_${APP_ID}.acf"
REPORT="${PZ_SHARED_DIR}/.update_status"
STAMP="${PZ_SHARED_DIR}/.update_repair_attempt"
FORCE_FLAG="${PZ_SHARED_DIR}/.force_update"

# --- reading the manifest -------------------------------------------------

# First value of a top-level "key" "value" pair.
acf_get() {
    [ -f "$MANIFEST" ] || return 1
    sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$MANIFEST" | head -1
}

# The manifest id this install is pinned to for the content depot. It is
# nested, so acf_get would return whichever depot came first instead.
pinned_manifest() {
    [ -f "$MANIFEST" ] || return 1
    awk -v depot="\"${CONTENT_DEPOT}\"" '
        $1 == depot { found = 1; next }
        found && $1 == "\"manifest\"" { gsub(/"/, "", $2); print $2; exit }
    ' "$MANIFEST"
}

# Newest content_log.txt we can find. SteamCMD's install location varies by
# image, so try the resolved binary first and then the known fallbacks.
newest_content_log() {
    if [ -n "${STEAMCMD_LOG:-}" ]; then
        [ -f "$STEAMCMD_LOG" ] && printf '%s' "$STEAMCMD_LOG"
        return 0
    fi

    local candidates=() resolved newest="" candidate
    resolved="$(command -v steamcmd.sh 2>/dev/null || true)"
    if [ -n "$resolved" ]; then
        candidates+=("$(dirname "$resolved")/logs/content_log.txt")
    fi
    candidates+=(/home/root/.local/steamcmd/logs/content_log.txt)
    candidates+=(/home/steam/Steam/logs/content_log.txt)

    for candidate in "${candidates[@]}"; do
        [ -f "$candidate" ] || continue
        if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
            newest="$candidate"
        fi
    done

    printf '%s' "$newest"
}

game_binary_present() {
    [ -e "$BASE_GAME_DIR/ProjectZomboid64" ] || [ -e "$BASE_GAME_DIR/ProjectZomboid64.real" ]
}

is_number() {
    printf '%s' "${1:-}" | grep -Eq '^[0-9]+$'
}

# --- writing the report ---------------------------------------------------

json_string() {
    if [ -z "${1:-}" ]; then
        printf 'null'
    else
        printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    fi
}

json_number() {
    if is_number "${1:-}"; then printf '%s' "$1"; else printf 'null'; fi
}

# Written atomically so the panel never reads a half file, and world-writable
# because the game's uid is not web-api's.
write_report() {
    local tmp="${REPORT}.tmp.$$"

    mkdir -p "$PZ_SHARED_DIR" 2>/dev/null || true

    {
        printf '{"verdict":%s,'        "$(json_string "$verdict")"
        printf '"installed_build":%s,' "$(json_string "$installed_build")"
        printf '"target_build":%s,'    "$(json_string "$target_build")"
        printf '"state_flags":%s,'     "$(json_number "$state_flags")"
        printf '"branch":%s,'          "$(json_string "$GAME_VERSION")"
        printf '"pinned_manifest":%s,' "$(json_string "$pinned")"
        printf '"last_updated":%s,'    "$(json_number "$last_updated")"
        printf '"checked_at":%s,'      "$(date +%s)"
        printf '"booted":%s,'          "$booted"
        printf '"auto_repaired":%s,'   "$auto_repaired"
        printf '"diagnosis":%s}'       "$(json_string "$diagnosis")"
        printf '\n'
    } > "$tmp"

    mv -f "$tmp" "$REPORT"
    chmod 0666 "$REPORT" 2>/dev/null || true
}

# --- verdict --------------------------------------------------------------

state_flags="$(acf_get StateFlags || true)"
installed_build="$(acf_get buildid || true)"
target_build="$(acf_get TargetBuildID || true)"
last_updated="$(acf_get LastUpdated || true)"
pinned="$(pinned_manifest || true)"

booted=false
auto_repaired=false

if ! game_binary_present; then
    verdict="missing"
    diagnosis="ProjectZomboid64 is not installed. SteamCMD never produced a usable build."
elif [ ! -f "$MANIFEST" ]; then
    verdict="unknown"
    diagnosis="No Steam app manifest yet, so there is nothing to compare against."
elif [ -n "$installed_build" ] && [ -n "$target_build" ] && [ "$installed_build" != "$target_build" ]; then
    verdict="behind"
    diagnosis="Installed build ${installed_build}, but Steam expects ${target_build}. Clients on the newer build cannot join this server."
elif is_number "$state_flags" && [ $(( state_flags & 2 )) -ne 0 ]; then
    verdict="update_required"
    diagnosis="Steam has flagged the install as needing an update (StateFlags ${state_flags})."
else
    verdict="ok"
    diagnosis="Installed build ${installed_build:-unknown} matches what Steam expects."
fi

# Refinement only. A log file outlives the failure that wrote it, so it may
# sharpen a verdict that is already bad but must never create one.
if [ "$verdict" = "behind" ] || [ "$verdict" = "update_required" ]; then
    content_log="$(newest_content_log)"
    if [ -n "$content_log" ] \
        && grep -qE "Failed to get manifest request code" "$content_log" 2>/dev/null; then
        verdict="manifest_retired"
        diagnosis="Steam retired the depot manifest this install is pinned to (depot ${CONTENT_DEPOT}, manifest ${pinned:-unknown}). Retrying, clearing the cache and upgrading SteamCMD all fail against this - only a clean reinstall of the game directory recovers it."
    fi
fi

stamp_target=""
if [ -f "$STAMP" ]; then
    stamp_target="$(tr -d '[:space:]' < "$STAMP")"
fi

case "$verdict" in
    ok)
        # Whatever went wrong is over. Let the next failure repair again.
        rm -f "$STAMP" 2>/dev/null || true
        booted=true
        rc=0
        ;;
    unknown)
        booted=true
        rc=0
        ;;
    manifest_retired)
        if [ -n "$target_build" ] && [ "$stamp_target" = "$target_build" ]; then
            diagnosis="${diagnosis} A clean reinstall was already attempted for build ${target_build} and did not fix it, so this needs a human."
            rc=2
        else
            mkdir -p "$PZ_SHARED_DIR" 2>/dev/null || true
            printf '%s' "${target_build:-unknown}" > "$STAMP"
            # The entrypoint already knows how to act on this: wipe the install
            # dir (saves live elsewhere) and re-run SteamCMD with retries.
            date +%s > "$FORCE_FLAG"
            chmod 0666 "$STAMP" "$FORCE_FLAG" 2>/dev/null || true
            auto_repaired=true
            diagnosis="${diagnosis} A clean reinstall has been queued and the container is restarting to run it."
            rc=1
        fi
        ;;
    *)
        rc=2
        ;;
esac

write_report

if [ "$rc" -eq 0 ]; then
    echo "[update-check] ${verdict}: ${diagnosis}"
elif [ "$rc" -eq 1 ]; then
    echo "### The game install cannot be updated in place."
    echo "### ${diagnosis}"
else
    echo "### ERROR: the game server install is not usable."
    echo "### ${diagnosis}"
    echo "### Installed build: ${installed_build:-unknown}  Steam expects: ${target_build:-unknown}"
    echo "### To reinstall by hand, on the host:"
    echo "###   docker stop pz-game-server && rm -rf data/server/* && docker start pz-game-server"
fi

exit "$rc"
