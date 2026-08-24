#!/usr/bin/env bash
#
# workshop-update-item.sh: argument check, SteamCMD invocation, B42 surfacing.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE="${SCRIPT_DIR}/../workshop-update-item.sh"

pass=0
fail=0

ok() { echo "PASS: $1"; pass=$((pass + 1)); }
ng() { echo "FAIL: $1 — $2"; fail=$((fail + 1)); }

# Rejects junk so docker exec cannot pass an arbitrary SteamCMD argument.
out="$(bash "$UPDATE" 'not-an-id' 2>&1)" || true
if printf '%s' "$out" | grep -q 'STATUS=error'; then
    ok "rejects a non-numeric Workshop id"
else
    ng "rejects a non-numeric Workshop id" "$out"
fi

home="$(mktemp -d)"
install="$home/ZomboidDedicatedServer"
mkdir -p "$install/steamapps"
# A marker so the script treats this as the install dir.
touch "$install/ProjectZomboid64"
chmod +x "$install/ProjectZomboid64" 2>/dev/null || true

bin="$(mktemp -d)"
cat > "$bin/steamcmd.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${STEAMCMD_ARGS_FILE:-/dev/null}"
echo "Success. Downloaded item ${STEAMCMD_FAKE_ID:-0} to /tmp"
EOF
chmod +x "$bin/steamcmd.sh"

args="$(mktemp)"
mod_dir="$install/steamapps/workshop/content/108600/3777446787/mods/KnoxRelay"
mkdir -p "$mod_dir/42"
printf 'name=Knox Relay\nid=KnoxRelay\nmodversion=1.24\n' > "$mod_dir/42/mod.info"

out="$(
    PATH="$bin:$PATH" \
    STEAMCMD_ARGS_FILE="$args" \
    STEAMCMD_FAKE_ID=3777446787 \
    PZ_INSTALL_DIR="$install" \
    PZ_STEAMCMD_BIN="$bin/steamcmd.sh" \
    bash "$UPDATE" 3777446787 2>&1
)" || rc=$?
rc="${rc:-0}"

if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'STATUS=ok'; then
    ok "reports STATUS=ok after a successful SteamCMD download"
else
    ng "reports STATUS=ok after a successful SteamCMD download" "rc=$rc out=$out"
fi

if printf '%s' "$out" | grep -q 'VERSION=1.24'; then
    ok "prints modversion from the B42 manifest"
else
    ng "prints modversion from the B42 manifest" "$out"
fi

if [ -f "$mod_dir/mod.info" ]; then
    ok "surfaces 42/mod.info to the mod root"
else
    ng "surfaces 42/mod.info to the mod root" "missing $mod_dir/mod.info"
fi

if tr '\n' ' ' < "$args" | grep -q '+workshop_download_item 108600 3777446787'; then
    ok "SteamCMD is asked for this Workshop item only"
else
    ng "SteamCMD is asked for this Workshop item only" "$(tr '\n' ' ' < "$args")"
fi

rm -rf "$home" "$bin" "$args"

echo
echo "workshop-update-item.sh: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
