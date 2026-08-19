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

# A content log carrying the retired-manifest signature turns a generic
# "behind" into the specific diagnosis. Only a clean reinstall fixes this one,
# so saying "No connection" sends the operator down the wrong path.
retired_log="$(mktemp)"
cat > "$retired_log" <<'LOG'
[2026-08-18 18:32:04] AppID 380870 state changed : Update Required,
[2026-08-18 18:32:05] AppID 380870 update changed : Manifest not available,
[2026-08-18 18:32:05] Failed to get manifest request code for depot 380871, manifest 4041863939978451180, result 'Access Denied'
LOG

STEAMCMD_LOG="$retired_log" assert_verdict "retired manifest is named, not guessed" \
    "$(make_install 6 24775771 24801442)" manifest_retired 1

# The same log must not change a healthy verdict. A stale log file from an old
# failure sits around indefinitely, so it can only ever refine, never originate.
STEAMCMD_LOG="$retired_log" assert_verdict "stale log cannot condemn a healthy install" \
    "$(make_install 4 24775771 24775771)" ok 0

# assert_repair <desc> <install-dir> <stamp-contents|"none"> <expected-verdict>
#               <expected-rc> <expect-force-flag: yes|no>
assert_repair() {
    local desc="$1" install="$2" stamp="$3" expected="$4" expected_rc="$5" want_flag="$6"
    local shared out rc verdict flagged

    shared="$(mktemp -d)"
    if [ "$stamp" != "none" ]; then
        printf '%s' "$stamp" > "$shared/.update_repair_attempt"
    fi

    out="$(BASE_GAME_DIR="$install" PZ_SHARED_DIR="$shared" GAME_VERSION=public \
        STEAMCMD_LOG="$retired_log" bash "$CHECK" 2>&1)"
    rc=$?

    verdict="$(json_field "$shared/.update_status" verdict)"
    if [ -f "$shared/.force_update" ]; then flagged=yes; else flagged=no; fi

    if [ "$verdict" != "$expected" ] || [ "$rc" -ne "$expected_rc" ] || [ "$flagged" != "$want_flag" ]; then
        echo "FAIL: ${desc}"
        echo "    verdict ${verdict} (want ${expected}), exit ${rc} (want ${expected_rc}), force flag ${flagged} (want ${want_flag})"
        echo "${out}" | sed 's/^/    /'
        fail=$((fail + 1))
        return
    fi

    echo "PASS: ${desc}"
    pass=$((pass + 1))
}

# First encounter: queue the reinstall the entrypoint already knows how to do.
assert_repair "first retired manifest queues a reinstall" \
    "$(make_install 6 24775771 24801442)" none manifest_retired 1 yes

# Second encounter for the same build: the clean reinstall already failed once,
# so asking Docker to restart again would just burn 7GB in a loop.
assert_repair "repeat for the same build halts instead of looping" \
    "$(make_install 6 24775771 24801442)" 24801442 manifest_retired 2 no

# A newer build is a different problem and deserves its own attempt.
assert_repair "a new target build earns a fresh attempt" \
    "$(make_install 6 24775771 24801442)" 24700000 manifest_retired 1 yes

# A healthy boot clears the stamp so the next genuine failure can repair.
clear_shared="$(mktemp -d)"
printf '24801442' > "$clear_shared/.update_repair_attempt"
BASE_GAME_DIR="$(make_install 4 24775771 24775771)" PZ_SHARED_DIR="$clear_shared" \
    GAME_VERSION=public STEAMCMD_LOG=/nonexistent bash "$CHECK" >/dev/null 2>&1
if [ -f "$clear_shared/.update_repair_attempt" ]; then
    echo "FAIL: healthy boot clears the repair stamp - stamp still present"
    fail=$((fail + 1))
else
    echo "PASS: healthy boot clears the repair stamp"
    pass=$((pass + 1))
fi

# The panel parses this file. It must be valid JSON in every branch, including
# when a diagnosis contains quotes.
json_shared="$(mktemp -d)"
BASE_GAME_DIR="$(make_install 6 24775771 24801442)" PZ_SHARED_DIR="$json_shared" \
    GAME_VERSION=public STEAMCMD_LOG="$retired_log" bash "$CHECK" >/dev/null 2>&1
if command -v python3 >/dev/null 2>&1; then
    if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$json_shared/.update_status" 2>/dev/null; then
        echo "PASS: report is valid JSON"
        pass=$((pass + 1))
    else
        echo "FAIL: report is not valid JSON"
        cat "$json_shared/.update_status" | sed 's/^/    /'
        fail=$((fail + 1))
    fi
else
    echo "SKIP: report JSON validity needs python3"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
