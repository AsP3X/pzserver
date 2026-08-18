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

# A mod already in the ARM64 Workshop cache must still be re-checked against
# Steam, get its B42 manifest surfaced to the mod root, and be linked into
# Zomboid/mods/. With the AMD64 default all three of these quietly did nothing.
assert_cached_arm64_mod_pipeline() {
    local home cfg args out mod_dir
    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    args="$(mktemp)"
    install_marker "$home/pzserver"
    seed_workshop_mod "$home/pzserver" 3777446787 KnoxRelay
    mod_dir="$home/pzserver/steamapps/workshop/content/108600/3777446787/mods/KnoxRelay"

    out="$(WORKSHOP_IDS=3777446787 run_configure "$home" "$cfg" "$args")"

    # An already-cached mod used to be skipped, which pinned it forever to the
    # version that happened to arrive first: publishing an update and
    # restarting kept the old copy, with nothing in the log to say so.
    # workshop_download_item is a no-op when the local copy is current, so
    # asking every boot costs a round trip and buys correctness.
    # One argument per line in the capture, so flatten before matching.
    if tr '\n' ' ' < "$args" | grep -q '+workshop_download_item 108600 3777446787'; then
        ok "cached Workshop mod is still re-checked against Steam"
    else
        ng "cached Workshop mod is still re-checked against Steam" \
           "steamcmd ran with: $(tr '\n' ' ' < "$args" 2>/dev/null)"
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

# The ARM64 entrypoint already runs SteamCMD under FEXBash. Workshop sync used
# to call the x86 binary directly, hit qemu-i386 / ld-linux.so.2, and skip the
# download. If FEXBash is on PATH it has to be the thing that launches steamcmd.
assert_workshop_sync_uses_fexbash_when_present() {
    local desc="Workshop sync runs SteamCMD under FEXBash when it is on PATH"
    local home cfg args bin fexlog
    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    args="$(mktemp)"
    fexlog="$(mktemp)"
    bin="$(mktemp -d)"
    make_steamcmd_stub "$bin"
    cat > "$bin/FEXBash" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "${FEX_LOG:-/dev/null}"
eval "$1"
EOF
    chmod +x "$bin/FEXBash"
    mkdir -p "$cfg/Server"
    seed_ini "$cfg/Server/ZomboidServer.ini"
    install_marker "$home/pzserver"

    PATH="$bin:$PATH" STEAMCMD_ARGS_FILE="$args" FEX_LOG="$fexlog" \
        PZ_STEAM_HOME="$home" PZ_CONFIG_DIR="$cfg" SERVER_NAME="ZomboidServer" \
        PZ_INSTALL_DIR="$home/pzserver" PZ_WORKSHOP_IDS="3777446787" \
        bash "$CONFIGURE" >/dev/null

    if grep -q 'steamcmd.sh' "$fexlog" && grep -q 'workshop_download_item' "$fexlog"; then
        ok "$desc"
    else
        ng "$desc" "FEXBash saw: $(tr '\n' ' ' < "$fexlog")"
    fi
    rm -rf "$home" "$cfg" "$bin"
    rm -f "$args" "$fexlog"
}
assert_workshop_sync_uses_fexbash_when_present

# --- Retiring PZServerPulse --------------------------------------------------

# The character dashboard used to ship as its own mod, seeded into Zomboid/mods/
# from the image on every boot. It is part of Knox Relay now, and PZ loads what
# it finds on disk once `Mods=` names it, so a leftover copy would mean two mods
# writing the same heartbeats. Every boot has to clear it out.
assert_retired_pulse_mod_is_removed() {
    local desc home cfg args
    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    args="$(mktemp)"
    install_marker "$home/pzserver"

    # What an earlier boot left behind, next to the mod that must survive it.
    mkdir -p "$cfg/mods/PZServerPulse/42/media/lua/server"
    printf 'name=PZServerPulse\nid=PZServerPulse\n' > "$cfg/mods/PZServerPulse/42/mod.info"
    mkdir -p "$cfg/mods/KnoxRelay/42"
    printf 'name=Knox Relay\nid=KnoxRelay\n' > "$cfg/mods/KnoxRelay/42/mod.info"

    run_configure "$home" "$cfg" "$args" > /dev/null

    desc="a leftover PZServerPulse install is removed"
    if [ -e "$cfg/mods/PZServerPulse" ]; then
        ng "$desc" "still present at $cfg/mods/PZServerPulse"
    else
        ok "$desc"
    fi

    desc="KnoxRelay is left alone"
    if [ -f "$cfg/mods/KnoxRelay/42/mod.info" ]; then
        ok "$desc"
    else
        ng "$desc" "KnoxRelay went missing from $cfg/mods"
    fi

    rm -rf "$home" "$cfg" "$args"
}
assert_retired_pulse_mod_is_removed

# An upgrade keeps whatever PZ_MOD_IDS it was configured with, so a server that
# had the dashboard enabled still names a mod that no longer exists. Say so
# rather than letting PZ fail to find it quietly.
assert_stale_pulse_mod_id_warns() {
    local desc home args out cfg_stale cfg_clean
    home="$(mktemp -d)"
    args="$(mktemp)"
    # Each run needs its own config dir: the first boot writes .mod_state, which
    # then outranks PZ_MOD_IDS on every boot after it.
    cfg_stale="$(mktemp -d)"
    cfg_clean="$(mktemp -d)"
    install_marker "$home/pzserver"

    out="$(PZ_MOD_IDS="KnoxRelay;PZServerPulse" run_configure "$home" "$cfg_stale" "$args")"

    desc="a Mods= line still listing PZServerPulse warns"
    case "$out" in
        *"Mods= still lists PZServerPulse"*) ok "$desc" ;;
        *) ng "$desc" "no warning in output" ;;
    esac

    out="$(PZ_MOD_IDS=KnoxRelay run_configure "$home" "$cfg_clean" "$args")"

    desc="no warning once PZServerPulse is out of Mods="
    case "$out" in
        *"Mods= still lists PZServerPulse"*) ng "$desc" "warned anyway" ;;
        *) ok "$desc" ;;
    esac

    rm -rf "$home" "$cfg_stale" "$cfg_clean" "$args"
}
assert_stale_pulse_mod_id_warns

# --- Knox Relay image seeding -------------------------------------------------

# Zomboid/ is bind-mounted, so the copy the Dockerfiles place in Zomboid/mods/ is
# hidden at runtime and the Workshop mirror is the only thing that lands there.
# When the published Workshop item lags the image the server runs old bridge Lua,
# and the app — which gates whole pages on the version the bridge reports — draws
# nothing at all. These pin the precedence in both directions.

# write_mod_info <mod-dir> <version>
write_mod_info() {
    mkdir -p "$1/42"
    printf 'name=Knox Relay\nid=KnoxRelay\nmodversion=%s\n' "$2" > "$1/42/mod.info"
}

# assert_seeding <desc> <staged-version> <workshop-version> <expected-version>
# An empty workshop-version means nothing is installed there at all.
#
# What is asserted is the version the *game* would load, read through the
# symlink, and — when this is a Workshop mod — the version sitting in the
# Workshop cache itself. Those are the same thing, and that is the point: the
# seed used to write a real directory over Zomboid/mods/KnoxRelay and call it
# done, but PZ resolves a mod named in WorkshopItems= out of the cache and never
# opens the local mods dir. This suite passed throughout, because it looked in
# the same wrong place the seed wrote to.
assert_seeding() {
    local desc="$1" staged="$2" workshop="$3" expected="$4"
    local home cfg staged_dir live actual cached

    home="$(mktemp -d)"
    cfg="$(mktemp -d)"
    staged_dir="$(mktemp -d)"
    install_marker "$home/pzserver"
    write_mod_info "$staged_dir" "$staged"

    if [ -n "$workshop" ]; then
        write_mod_info \
            "$home/pzserver/steamapps/workshop/content/108600/3777446787/mods/KnoxRelay" "$workshop"
        KR_STAGED_DIR="$staged_dir" WORKSHOP_IDS=3777446787 \
            run_configure "$home" "$cfg" /dev/null > /dev/null
    else
        KR_STAGED_DIR="$staged_dir" run_configure "$home" "$cfg" /dev/null > /dev/null
    fi

    live="$cfg/mods/KnoxRelay"
    actual="$(sed -n 's/^modversion=//p' "$live/42/mod.info" 2>/dev/null | head -1)"

    if [ "$actual" != "$expected" ]; then
        ng "$desc" "the game would load Knox Relay ${actual:-<nothing>}, expected $expected"
        rm -rf "$home" "$cfg" "$staged_dir"
        return
    fi

    # The copy PZ actually resolves for a Workshop mod. Checking only through
    # Zomboid/mods/ is what let the old bug hide.
    if [ -n "$workshop" ]; then
        cached="$(sed -n 's/^modversion=//p' \
            "$home/pzserver/steamapps/workshop/content/108600/3777446787/mods/KnoxRelay/42/mod.info" \
            2>/dev/null | head -1)"
        if [ "$cached" != "$expected" ]; then
            ng "$desc" "the Workshop cache holds ${cached:-<nothing>}, expected $expected"
            rm -rf "$home" "$cfg" "$staged_dir"
            return
        fi
    fi

    ok "$desc"
    rm -rf "$home" "$cfg" "$staged_dir"
}

assert_seeding "a newer staged Knox Relay replaces a stale Workshop download" \
    1.7 1.5 1.7
assert_seeding "a newer Workshop Knox Relay is kept over an older staged one" \
    1.5 1.7 1.7
assert_seeding "an equal Workshop version is replaced by the staged image copy" \
    1.7 1.7 1.7
assert_seeding "the staged copy seeds when no Workshop copy is installed" \
    1.7 "" 1.7
assert_seeding "version comparison is numeric, not lexical (1.10 beats 1.9)" \
    1.10 1.9 1.10

echo "----------------------------------------"
echo "Passed: ${pass}, Failed: ${fail}"
[ "$fail" -eq 0 ]
