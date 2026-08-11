#!/bin/bash
# Check every game API the Knox Relay Lua calls actually exists.
#
# Three releases in a row shipped calls that Build 42 had moved or never had —
# BodyDamage accessors that wanted a BodyPartType, the Stats getters that became
# Stats.get(CharacterStat), getXP treated as an object, and `next`, which PZ's
# Lua runtime does not provide at all. Each one raised at runtime, was swallowed
# by KR_Vitals' own pcall guard, and returned a default. The export looked
# healthy while being fabricated, and the unit tests passed throughout because
# their stubs agreed with the code rather than with the game.
#
# So this checks the code against the shipped game instead: every method name
# the mod calls on an object must appear somewhere in zombie.*, and every
# math./table./string./os. call must be one the runtime actually registers.
#
# What it cannot see, and what covers that instead:
#
#   - A real method called on the wrong class. 1.7 asked BodyDamage for
#     getSkinTemperature, which exists — on BodyPart. The name resolves, so this
#     script passes it.
#   - A wrong argument type, such as a String where a BodyPartType belongs.
#   - A wrong assumption about a return value, such as treating the float from
#     getXP as an object.
#
# Those three are the job of kr-vitals.test.lua, whose stubs define only methods
# the real class has, raise on a String where an enum belongs, and hand back the
# types the engine hands back. The two together are the check; neither alone is.
#
# It needs the game jar, which only exists once SteamCMD has run. Without it the
# script skips rather than fails, so it stays runnable on a bare checkout.
#
# Usage: bash game-server/tests/kr-api-surface.test.sh   (exit 0 = all pass)

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
LUA_DIR="${REPO}/game-server/mods/KnoxRelay/42/media/lua"
JAR="${PZ_JAR:-${REPO}/data/server/java/projectzomboid.jar}"

if [ ! -f "$JAR" ]; then
    echo "SKIP: no game jar at ${JAR#"${REPO}/"} — run the server once, or set PZ_JAR."
    exit 0
fi

pass=0
fail=0
ok()  { pass=$((pass + 1)); echo "PASS: $1"; }
ng()  { fail=$((fail + 1)); echo "FAIL: $1 — $2"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ── The game's own classes ───────────────────────────────────────────────────
unzip -q -o "$JAR" -d "$work/classes" 'zombie/*' 2>/dev/null
classes="$(find "$work/classes" -name '*.class' | wc -l | tr -d ' ')"

if [ "$classes" -eq 0 ]; then
    ng "game classes extract from the jar" "nothing under zombie/ in $JAR"
    echo "Passed: ${pass}, Failed: ${fail}"
    exit 1
fi
ok "game classes extracted from the jar (${classes})"

# ── What the runtime registers as Lua globals ────────────────────────────────
# PZ runs Kahlua, whose libraries are a subset of stock Lua 5.1 — no `next`, for
# one. Collect the names each library registers so a missing one is visible.
for lib in stdlib.BaseLib stdlib.TableLib stdlib.StringLib stdlib.OsLib \
           stdlib.CoroutineLib stdlib.RandomLib j2se.MathLib; do
    javap -c -p -cp "$JAR" "se.krka.kahlua.$lib" 2>/dev/null
done | grep -oE '// String [a-zA-Z_]+' | sed 's|// String ||' | sort -u > "$work/globals.txt"

if [ ! -s "$work/globals.txt" ]; then
    ng "Kahlua library names read from the jar" "no names found"
else
    ok "Kahlua library names read from the jar ($(wc -l < "$work/globals.txt" | tr -d ' '))"
fi

# ── Library calls: math.floor, table.insert, os.time, ... ────────────────────
# `min` and `max` are deliberately exempt: Kahlua's MathLib does not register
# them, yet the game's own env.lua calls both at startup, so the runtime has
# them from somewhere and asserting otherwise would be a false alarm.
#
# Comments are stripped first: the codec's header names os.rename while
# explaining that the runtime lacks it, which is documentation, not a call.
find "$LUA_DIR" -name '*.lua' -exec sed 's/--.*//' {} + > "$work/code.lua"

missing_lib=""
while read -r call; do
    fn="${call#*.}"
    case "$fn" in min|max) continue ;; esac
    grep -qx "$fn" "$work/globals.txt" || missing_lib="$missing_lib $call"
done < <(grep -ohE '\b(math|table|string|os|coroutine)\.[a-zA-Z_]+' "$work/code.lua" | sort -u)

if [ -z "$missing_lib" ]; then
    ok "every math/table/string/os call is one the runtime registers"
else
    ng "every math/table/string/os call is one the runtime registers" "missing:$missing_lib"
fi

# ── `next` specifically, since it reads as ordinary Lua and is not there ─────
if grep -rqE '[^a-zA-Z_.:]next\(' "$LUA_DIR"; then
    ng "no use of next(), which PZ's Lua does not provide" \
       "$(grep -rlE '[^a-zA-Z_.:]next\(' "$LUA_DIR" | sed "s|${REPO}/||" | tr '\n' ' ')"
else
    ok "no use of next(), which PZ's Lua does not provide"
fi

# ── Method names called on objects ───────────────────────────────────────────
# Anything the mod defines itself is not a game API, so it is excluded. A name
# absent from every game class is the signal: it cannot be a method on one.
grep -rhoE '^[[:space:]]*(local )?function [A-Za-z_][A-Za-z0-9_.]*[:.][a-zA-Z_][a-zA-Z0-9_]*' "$LUA_DIR" \
    | sed 's/.*[:.]//' | sort -u > "$work/own.txt"

# Lua's own string/table methods arrive via the colon syntax too.
cat > "$work/lua-methods.txt" <<'LUA'
gsub
match
find
sub
byte
char
format
len
lower
upper
rep
reverse
LUA

# A method the code probes for before calling — `if stream.writeBytes then` —
# is one it already knows may be absent, so its absence is not a defect.
grep -ohE '\.([a-zA-Z_][a-zA-Z0-9_]*)[[:space:]]+then' "$work/code.lua" \
    | sed 's/^\.//;s/[[:space:]]*then$//' | sort -u > "$work/probed.txt"

unresolved=""
while read -r method; do
    grep -qx "$method" "$work/own.txt" && continue
    grep -qx "$method" "$work/lua-methods.txt" && continue
    grep -qx "$method" "$work/probed.txt" && continue
    grep -rlq --binary-files=binary "$method" "$work/classes" 2>/dev/null || unresolved="$unresolved $method"
done < <(grep -ohE ':[a-zA-Z_][a-zA-Z0-9_]*\(' "$work/code.lua" | sed 's/^://;s/(//' | sort -u)

if [ -z "$unresolved" ]; then
    ok "every method called on a game object exists in zombie.*"
else
    ng "every method called on a game object exists in zombie.*" "unresolved:$unresolved"
fi

echo "----------------------------------------"
echo "Passed: ${pass}, Failed: ${fail}"
[ "$fail" -eq 0 ]
