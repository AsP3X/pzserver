#!/usr/bin/env bash
#
# Tests for game-server/steam-update-check.sh.
#
# Regression guard for 2026-08-18: SteamCMD failed with "state is 0x6" on every
# boot, the entrypoint booted the stale 42.20.2 build anyway, and clients that
# had auto-updated to 42.20.3 hung forever at "Joining game...". Nothing
# surfaced the failure - it was found by reading content_log.txt by hand.
#
# The script is run for real against throwaway BASE_GAME_DIR / PZ_SHARED_DIR
# trees so we exercise the actual acf parsing, not a re-implementation of it.
#
# Usage: bash game-server/tests/steam-update-check.test.sh   (exit 0 = all pass)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="${SCRIPT_DIR}/../steam-update-check.sh"

pass=0
fail=0

# Throwaway install tree. $1 = StateFlags, $2 = buildid, $3 = TargetBuildID.
# $1 = "nomanifest" omits the acf; $4 = "nobinary" omits ProjectZomboid64.
make_install() {
    local flags="$1" build="$2" target="$3" mode="${4:-binary}"
    local dir
    dir="$(mktemp -d)"
    mkdir -p "$dir/steamapps"

    if [ "$mode" != "nobinary" ]; then
        touch "$dir/ProjectZomboid64"
    fi

    if [ "$flags" != "nomanifest" ]; then
        cat > "$dir/steamapps/appmanifest_380870.acf" <<ACF
"AppState"
{
	"appid"		"380870"
	"name"		"Project Zomboid Dedicated Server"
	"StateFlags"		"${flags}"
	"LastUpdated"		"1787089316"
	"buildid"		"${build}"
	"TargetBuildID"		"${target}"
	"InstalledDepots"
	{
		"1006"
		{
			"manifest"		"6403079453713498174"
		}
		"380871"
		{
			"manifest"		"4041863939978451180"
		}
	}
}
ACF
    fi

    printf '%s' "$dir"
}

# Crude single-field reader. Enough for flat, one-line report JSON.
json_field() {
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$1" | head -1
}

# assert_verdict <desc> <install-dir> <expected-verdict> <expected-rc>
assert_verdict() {
    local desc="$1" install="$2" expected="$3" expected_rc="$4"
    local shared out rc verdict

    shared="$(mktemp -d)"

    out="$(BASE_GAME_DIR="$install" PZ_SHARED_DIR="$shared" GAME_VERSION=public \
        STEAMCMD_LOG="${STEAMCMD_LOG:-/nonexistent}" bash "$CHECK" 2>&1)"
    rc=$?

    if [ ! -f "$shared/.update_status" ]; then
        echo "FAIL: ${desc} - no report written"
        echo "${out}" | sed 's/^/    /'
        fail=$((fail + 1))
        return
    fi

    verdict="$(json_field "$shared/.update_status" verdict)"

    if [ "$verdict" != "$expected" ]; then
        echo "FAIL: ${desc} - verdict was ${verdict}, expected ${expected}"
        echo "${out}" | sed 's/^/    /'
        fail=$((fail + 1))
        return
    fi

    if [ "$rc" -ne "$expected_rc" ]; then
        echo "FAIL: ${desc} - exit ${rc}, expected ${expected_rc}"
        echo "${out}" | sed 's/^/    /'
        fail=$((fail + 1))
        return
    fi

    echo "PASS: ${desc}"
    pass=$((pass + 1))
}

# A healthy install boots. The common case, and it must stay cheap.
assert_verdict "healthy manifest boots" \
    "$(make_install 4 24775771 24775771)" ok 0

# The 2026-08-18 failure: Steam knows a newer build exists and we do not have
# it. Booting here is what stranded clients at "Joining game...".
assert_verdict "installed build behind target halts" \
    "$(make_install 4 24775771 24801442)" behind 2

# StateFlags is a bitfield: 6 = 4 (fully installed) | 2 (update required).
assert_verdict "update-required bit halts" \
    "$(make_install 6 24775771 24775771)" update_required 2

# Bit 2 alongside unrelated bits must still be caught. Testing == 6 misses this.
assert_verdict "update-required bit found among other flags" \
    "$(make_install 1030 24775771 24775771)" update_required 2

# Today's already-guarded case, kept working.
assert_verdict "missing binary halts" \
    "$(make_install 4 24775771 24775771 nobinary)" missing 2

# First boot has no manifest yet. Nothing to compare against, so let it run.
assert_verdict "no manifest yet boots" \
    "$(make_install nomanifest 0 0)" unknown 0

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
