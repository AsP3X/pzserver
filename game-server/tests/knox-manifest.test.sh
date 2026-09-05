#!/usr/bin/env bash
# PZ ChooseGameInfo.getModVersion reads modversion= from versionDir/mod.info
# (42/) then common/mod.info. Root mod.info is the discovery fallback.
# All three plus KR_Bridge.VERSION must match so Knox Relay is never blank.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/game-server/mods/KnoxRelay"
pass=0
fail=0
ok() { echo "PASS: $1"; pass=$((pass + 1)); }
ng() { echo "FAIL: $1 — $2"; fail=$((fail + 1)); }

version_of() { sed -n 's/^modversion=//p' "$1" | tr -d '\r' | head -1; }

if [ -f "$SRC/mod.info" ]; then
    ok "mod root has mod.info"
else
    ng "mod root has mod.info" "missing $SRC/mod.info"
fi
if [ -f "$SRC/42/mod.info" ]; then
    ok "42/ has mod.info"
else
    ng "42/ has mod.info" "missing $SRC/42/mod.info"
fi
if [ -f "$SRC/common/mod.info" ]; then
    ok "common/ has mod.info"
else
    ng "common/ has mod.info" "missing $SRC/common/mod.info"
fi

root_v="$(version_of "$SRC/mod.info" 2>/dev/null || true)"
b42_v="$(version_of "$SRC/42/mod.info" 2>/dev/null || true)"
common_v="$(version_of "$SRC/common/mod.info" 2>/dev/null || true)"
lua_v="$(sed -n 's/^KR_Bridge\.VERSION *= *"\(.*\)"$/\1/p' "$SRC/42/media/lua/server/KR_Bridge.lua" | tr -d '\r')"

if [ -n "$root_v" ]; then
    ok "root modversion is $root_v"
else
    ng "root modversion is set" "empty"
fi
if [ "$root_v" = "$b42_v" ] && [ "$root_v" = "$common_v" ] && [ "$root_v" = "$lua_v" ]; then
    ok "root, 42/, common/, and KR_Bridge.VERSION agree ($root_v)"
else
    ng "root, 42/, common/, and KR_Bridge.VERSION agree" "root=$root_v 42=$b42_v common=$common_v lua=$lua_v"
fi

echo
echo "knox-manifest: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
