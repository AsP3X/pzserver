#!/usr/bin/env bash
#
# Tests for game-server/configure-server.sh setting precedence and for the
# server install-dir detection that every Workshop step depends on.
#
# Regression guard for issue #33: on the AMD64 (renegademaster) image the game
# settings arrive under bare env-var names (MAX_PLAYERS, ADMIN_PASSWORD, ...),
# while the ARM64 (joyfui) image uses PZ_* names. configure-server.sh runs last
# on boot and must honour BOTH names, otherwise it clobbers the value the AMD64
# image already applied (a user who picked 24 players silently ended up with 16).
#
# Second guard: the two images install the server to different roots (ARM64 ->
# /home/steam/pzserver, AMD64 -> /home/steam/ZomboidDedicatedServer). The script
# used to hardcode the AMD64 path as its default, so on ARM64 the whole Workshop
# pipeline pointed at a tree that never existed and failed silently.
#
# The script is run for real against a throwaway PZ_STEAM_HOME / PZ_CONFIG_DIR /
# PZ_INSTALL_DIR so we exercise the actual expansions, not a re-implementation
# of them.
#
# Usage: bash game-server/tests/configure-server.test.sh   (exit 0 = all pass)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIGURE="${SCRIPT_DIR}/../configure-server.sh"

pass=0
fail=0

seed_ini() {
    # Simulate the INI PZ generates on first boot (its own defaults).
    cat > "$1" <<'EOF'
DefaultPort=16261
UDPPort=16262
MaxPlayers=32
Public=false
RCONPassword=changeme
AdminPassword=admin
EOF
}

ini_get() {
    grep -m1 "^$2=" "$1" | sed "s/^$2=//"
}

# assert_setting <desc> <ini-key> <expected>
# Env vars for the script and an optional CONFIG_STATE (newline-separated
# key=val lines written to .config_state) are taken from the caller's env.
assert_setting() {
    local desc="$1" key="$2" expected="$3"
    local cfg install ini out rc actual

    cfg="$(mktemp -d)"
    install="$(mktemp -d)"
    mkdir -p "$cfg/Server"
    ini="$cfg/Server/ZomboidServer.ini"
    seed_ini "$ini"

    if [ -n "${CONFIG_STATE:-}" ]; then
        printf '%s\n' "$CONFIG_STATE" > "$cfg/.config_state"
    fi

    out="$(PZ_CONFIG_DIR="$cfg" PZ_INSTALL_DIR="$install" SERVER_NAME="ZomboidServer" \
        bash "$CONFIGURE" 2>&1)"
    rc=$?

    if [ "$rc" -ne 0 ]; then
        echo "FAIL: ${desc} — configure-server.sh exited ${rc}"
        echo "${out}" | sed 's/^/    /'
        fail=$((fail + 1))
        rm -rf "$cfg" "$install"
        return
    fi

    actual="$(ini_get "$ini" "$key")"
    if [ "$actual" = "$expected" ]; then
        echo "PASS: ${desc} (${key}=${actual})"
        pass=$((pass + 1))
    else
        echo "FAIL: ${desc} — expected ${key}=${expected}, got ${key}=${actual}"
        fail=$((fail + 1))
    fi

    rm -rf "$cfg" "$install"
}

echo "Running configure-server.sh precedence tests..."

# --- MaxPlayers (issue #33) ---------------------------------------------------
MAX_PLAYERS=24 \
    assert_setting "AMD64 MAX_PLAYERS is honoured when PZ_MAX_PLAYERS is unset" MaxPlayers 24

PZ_MAX_PLAYERS=20 \
    assert_setting "ARM64 PZ_MAX_PLAYERS is honoured" MaxPlayers 20

PZ_MAX_PLAYERS=20 MAX_PLAYERS=24 \
    assert_setting "PZ_MAX_PLAYERS wins over MAX_PLAYERS when both are set" MaxPlayers 20

CONFIG_STATE="MaxPlayers=50" MAX_PLAYERS=24 \
    assert_setting ".config_state (web UI) overrides env vars" MaxPlayers 50

assert_setting "falls back to default 16 when nothing is set" MaxPlayers 16

# --- PauseEmpty ---------------------------------------------------------------
# PZ only reads the INI at startup and rewrites it from memory on shutdown, so a
# web UI toggle survives a restart only via .config_state. These pin the whole
# chain: default -> env (both image names) -> .config_state.
assert_setting "PauseEmpty defaults to true when nothing is set" PauseEmpty true

PZ_PAUSE_ON_EMPTY=false \
    assert_setting "ARM64 PZ_PAUSE_ON_EMPTY is honoured" PauseEmpty false

PAUSE_ON_EMPTY=false \
    assert_setting "AMD64 PAUSE_ON_EMPTY is honoured when PZ_PAUSE_ON_EMPTY is unset" PauseEmpty false

CONFIG_STATE="PauseEmpty=true" PZ_PAUSE_ON_EMPTY=false \
    assert_setting "web UI PauseEmpty=true survives a restart against PZ_PAUSE_ON_EMPTY=false" PauseEmpty true

CONFIG_STATE="PauseEmpty=false" PZ_PAUSE_ON_EMPTY=true \
    assert_setting "web UI PauseEmpty=false survives a restart against PZ_PAUSE_ON_EMPTY=true" PauseEmpty false

# --- Passwords (same both-names fix) -----------------------------------------
ADMIN_PASSWORD="s3cret-admin" \
    assert_setting "AMD64 ADMIN_PASSWORD is honoured when PZ_ADMIN_PASSWORD is unset" AdminPassword "s3cret-admin"

RCON_PASSWORD="rcon-pw" \
    assert_setting "AMD64 RCON_PASSWORD is honoured when PZ_RCON_PASSWORD is unset" RCONPassword "rcon-pw"

# --- Server install-dir detection --------------------------------------------
#
# WORKSHOP_CACHE_ROOT is derived from PZ_INSTALL_DIR, so picking the wrong root
# breaks every Workshop step at once — and does it silently, which is why these
# assert the downstream effects and not just the resolved path.

ok() { echo "PASS: $1"; pass=$((pass + 1)); }
ng() { echo "FAIL: $1 — $2"; fail=$((fail + 1)); }

# The PZ dedicated server ships start-server.sh at its install root; that is
# what "this root holds a real install" means to the detection.
install_marker() {
    mkdir -p "$1"
    : > "$1/start-server.sh"
}

# seed_workshop_mod <install-root> <workshop-id> <mod-name>
# A B42-only mod laid out the way the Workshop downloader leaves it: manifest
# under 42/, nothing at the mod root.
seed_workshop_mod() {
    local mod_dir="$1/steamapps/workshop/content/108600/$2/mods/$3"
    mkdir -p "$mod_dir/42"
    printf 'name=%s\nid=%s\n' "$3" "$3" > "$mod_dir/42/mod.info"
}

# Fake steamcmd on PATH: keeps a missing-mod run off the network and records the
# args the script would have passed (so +force_install_dir can be asserted).
make_steamcmd_stub() {
    mkdir -p "$1"
    cat > "$1/steamcmd.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${STEAMCMD_ARGS_FILE:-/dev/null}"
EOF
    chmod +x "$1/steamcmd.sh"
}

# run_configure <steam-home> <config-dir> <steamcmd-args-file>
# PZ_INSTALL_DIR is left unset unless the caller exports FORCE_INSTALL_DIR, so
# detection is what's under test. Echoes the script's combined output.
run_configure() {
    local home="$1" cfg="$2" args_file="$3" bin
    bin="$(mktemp -d)"
    make_steamcmd_stub "$bin"
    mkdir -p "$cfg/Server"
    seed_ini "$cfg/Server/ZomboidServer.ini"
    PATH="$bin:$PATH" STEAMCMD_ARGS_FILE="$args_file" \
        PZ_STEAM_HOME="$home" PZ_CONFIG_DIR="$cfg" SERVER_NAME="ZomboidServer" \
        PZ_INSTALL_DIR="${FORCE_INSTALL_DIR:-}" PZ_WORKSHOP_IDS="${WORKSHOP_IDS:-}" \
        bash "$CONFIGURE" 2>&1
    rm -rf "$bin"
}

detected_dir() {
    printf '%s\n' "$1" | sed -n 's/^\[configure-server\] Server install dir: //p' | tail -1
}

# assert_detects <desc> <layout> <expected-path-relative-to-steam-home>
#   arm64 = only pzserver installed (joyfui)
#   amd64 = only ZomboidDedicatedServer installed (renegademaster)
#   both  = both dirs present, only ZomboidDedicatedServer actually installed
#   none  = nothing installed yet
assert_detects() {
    local desc="$1" layout="$2" expected_sub="$3"
    local home cfg out actual

    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    case "$layout" in
        arm64) install_marker "$home/pzserver" ;;
        amd64) install_marker "$home/ZomboidDedicatedServer" ;;
        both)  mkdir -p "$home/pzserver"; install_marker "$home/ZomboidDedicatedServer" ;;
        none)  : ;;
    esac

    out="$(run_configure "$home" "$cfg" /dev/null)"
    actual="$(detected_dir "$out")"

    if [ "$actual" = "$home/$expected_sub" ]; then
        ok "${desc} (${expected_sub})"
    else
        ng "$desc" "expected $home/$expected_sub, got ${actual:-<none>}"
    fi
    rm -rf "$home" "$cfg"
}

assert_detects "ARM64 (joyfui) install under pzserver is detected" \
    arm64 "pzserver"
assert_detects "AMD64 (renegademaster) install under ZomboidDedicatedServer is detected" \
    amd64 "ZomboidDedicatedServer"
assert_detects "a real install wins over a bare directory when both roots exist" \
    both "ZomboidDedicatedServer"
assert_detects "falls back to the AMD64 path when nothing is installed yet" \
    none "ZomboidDedicatedServer"

# First boot on ARM64: SteamCMD hasn't run, so the bind mount is an empty dir
# and no start-server.sh exists anywhere. It must still resolve to pzserver.
assert_first_boot_arm64() {
    local desc="ARM64 first boot (empty bind mount, nothing installed) resolves to pzserver"
    local home cfg actual
    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    mkdir -p "$home/pzserver"

    actual="$(detected_dir "$(run_configure "$home" "$cfg" /dev/null)")"
    if [ "$actual" = "$home/pzserver" ]; then
        ok "$desc"
    else
        ng "$desc" "expected $home/pzserver, got ${actual:-<none>}"
    fi
    rm -rf "$home" "$cfg"
}
assert_first_boot_arm64

# An explicit PZ_INSTALL_DIR (what the compose files now set) beats detection.
assert_explicit_override() {
    local desc="explicit PZ_INSTALL_DIR overrides detection"
    local home cfg actual
    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    install_marker "$home/pzserver"

    actual="$(FORCE_INSTALL_DIR="$home/elsewhere" run_configure "$home" "$cfg" /dev/null)"
    actual="$(detected_dir "$actual")"
    if [ "$actual" = "$home/elsewhere" ]; then
        ok "$desc"
    else
        ng "$desc" "expected $home/elsewhere, got ${actual:-<none>}"
    fi
    rm -rf "$home" "$cfg"
}
assert_explicit_override

# --- What the wrong root silently broke on ARM64 -----------------------------

# A mod already in the ARM64 Workshop cache must be reported cached, get its B42
# manifest surfaced to the mod root, and be linked into Zomboid/mods/. With the
# AMD64 default all three of these quietly did nothing.
assert_cached_arm64_mod_pipeline() {
    local home cfg args out mod_dir
    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    args="$(mktemp)"
    install_marker "$home/pzserver"
    seed_workshop_mod "$home/pzserver" 3777446787 KnoxRelay
    mod_dir="$home/pzserver/steamapps/workshop/content/108600/3777446787/mods/KnoxRelay"

    out="$(WORKSHOP_IDS=3777446787 run_configure "$home" "$cfg" "$args")"

    if [ ! -s "$args" ]; then
        ok "cached ARM64 Workshop mod triggers no SteamCMD download"
    else
        ng "cached ARM64 Workshop mod triggers no SteamCMD download" \
           "steamcmd ran with: $(tr '\n' ' ' < "$args")"
    fi

    if [ -f "$mod_dir/mod.info" ]; then
        ok "B42 manifest is surfaced to the mod root in the ARM64 cache"
    else
        ng "B42 manifest is surfaced to the mod root in the ARM64 cache" "no mod.info at $mod_dir"
    fi

    if [ -e "$cfg/mods/KnoxRelay" ]; then
        ok "ARM64 cached mod is linked into Zomboid/mods/"
    else
        ng "ARM64 cached mod is linked into Zomboid/mods/" "nothing at $cfg/mods/KnoxRelay"
    fi

    case "$out" in
        *"$home/pzserver/steamapps/workshop"*)
            ok "Workshop cache root is reported under the ARM64 install dir" ;;
        *)
            ng "Workshop cache root is reported under the ARM64 install dir" \
               "cache root absent from output" ;;
    esac
    rm -rf "$home" "$cfg" "$args"
}
assert_cached_arm64_mod_pipeline

# A mod that is NOT cached must be downloaded into the detected root — the old
# default aimed +force_install_dir at a tree the ARM64 server never reads.
assert_missing_arm64_mod_downloads_to_install_dir() {
    local desc="missing Workshop mod downloads into the detected ARM64 install dir"
    local home cfg args
    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    args="$(mktemp)"
    install_marker "$home/pzserver"

    WORKSHOP_IDS=1234567890 run_configure "$home" "$cfg" "$args" > /dev/null

    if grep -qxF -- "+force_install_dir" "$args" \
        && grep -qxF -- "$home/pzserver" "$args" \
        && grep -qxF -- "1234567890" "$args"; then
        ok "$desc"
    else
        ng "$desc" "steamcmd args: $(tr '\n' ' ' < "$args")"
    fi
    rm -rf "$home" "$cfg" "$args"
}
assert_missing_arm64_mod_downloads_to_install_dir

# --- PZServerPulse seeding --------------------------------------------------

# PZServerPulse ships in the image rather than the Workshop, staged outside the
# bind-mounted Zomboid/ so the volume cannot shadow it. It must land in
# Zomboid/mods/ on every boot, and replace whatever a previous boot left there,
# otherwise a rebuilt image keeps serving the old Lua.
assert_pulse_is_seeded_fresh_each_boot() {
    local desc home cfg args src
    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    args="$(mktemp)"
    src="$(mktemp -d)/pzserver-pulse"
    install_marker "$home/pzserver"
    mkdir -p "$src/42/media/lua/server"
    printf 'name=PZServerPulse\nid=PZServerPulse\n' > "$src/42/mod.info"
    printf 'SP_Bridge.VERSION = "2.0"\n' > "$src/42/media/lua/server/SP_Bridge.lua"

    # A stale copy from an earlier boot, which the seed must overwrite.
    mkdir -p "$cfg/mods/PZServerPulse/42/media/lua/server"
    printf 'SP_Bridge.VERSION = "1.0"\n' > "$cfg/mods/PZServerPulse/42/media/lua/server/SP_Bridge.lua"

    PZSP_SOURCE_DIR="$src" run_configure "$home" "$cfg" "$args" > /dev/null

    desc="PZServerPulse is seeded into Zomboid/mods/"
    if [ -f "$cfg/mods/PZServerPulse/42/mod.info" ]; then
        ok "$desc"
    else
        ng "$desc" "no mod.info at $cfg/mods/PZServerPulse/42/"
    fi

    desc="a rebuilt image replaces the previous boot's Lua"
    if grep -q '"2.0"' "$cfg/mods/PZServerPulse/42/media/lua/server/SP_Bridge.lua" 2>/dev/null; then
        ok "$desc"
    else
        ng "$desc" "stale SP_Bridge.lua survived the seed"
    fi

    rm -rf "$home" "$cfg" "$args" "$(dirname "$src")"
}
assert_pulse_is_seeded_fresh_each_boot

# Seeding the mod is not the same as loading it: PZ only loads what `Mods=`
# lists. A server upgrading from before PZServerPulse existed keeps its old
# PZ_MOD_IDS, and the dashboard would sit empty with nothing explaining why.
assert_pulse_warns_when_not_enabled() {
    local desc home args src out cfg_off cfg_on
    home="$(mktemp -d)"
    args="$(mktemp)"
    src="$(mktemp -d)/pzserver-pulse"
    # Each run needs its own config dir: the first boot writes .mod_state, which
    # then outranks PZ_MOD_IDS on every boot after it.
    cfg_off="$(mktemp -d)"
    cfg_on="$(mktemp -d)"
    install_marker "$home/pzserver"
    mkdir -p "$src/42"
    printf 'name=PZServerPulse\nid=PZServerPulse\n' > "$src/42/mod.info"

    out="$(PZSP_SOURCE_DIR="$src" PZ_MOD_IDS=KnoxRelay run_configure "$home" "$cfg_off" "$args")"

    desc="seeding PZServerPulse without enabling it warns"
    case "$out" in
        *"PZServerPulse is seeded but not in Mods="*) ok "$desc" ;;
        *) ng "$desc" "no warning in output" ;;
    esac

    out="$(PZSP_SOURCE_DIR="$src" PZ_MOD_IDS="KnoxRelay;PZServerPulse" run_configure "$home" "$cfg_on" "$args")"

    desc="no warning once PZServerPulse is in Mods="
    case "$out" in
        *"PZServerPulse is seeded but not in Mods="*) ng "$desc" "warned anyway" ;;
        *) ok "$desc" ;;
    esac

    rm -rf "$home" "$cfg_off" "$cfg_on" "$args" "$(dirname "$src")"
}
assert_pulse_warns_when_not_enabled

echo "----------------------------------------"
echo "Passed: ${pass}, Failed: ${fail}"
[ "$fail" -eq 0 ]
