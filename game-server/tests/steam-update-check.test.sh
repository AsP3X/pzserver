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

# Every throwaway tree the suite makes lands under one root, so the trap can
# sweep them in a single rm instead of leaving ~20 mktemp dirs behind per run.
# mktemp honours TMPDIR, so the helpers below need no changes. The trap must
# never mask a failure, so it neither runs exit nor touches $fail.
TEST_TMP_ROOT="$(mktemp -d)"
export TMPDIR="$TEST_TMP_ROOT"
cleanup() {
    rm -rf "$TEST_TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

# Shared dir used by the most recent assert_repair, so a test can read back
# what the script actually wrote.
LAST_SHARED=""

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

# Install tree whose manifest body is taken verbatim from stdin, for the shapes
# make_install cannot express: corrupt, empty, or missing keys entirely.
make_raw_install() {
    local dir
    dir="$(mktemp -d)"
    mkdir -p "$dir/steamapps"
    touch "$dir/ProjectZomboid64"
    cat > "$dir/steamapps/appmanifest_380870.acf"
    printf '%s' "$dir"
}

# Crude single-field reader. Enough for flat, one-line report JSON.
json_field() {
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$1" | head -1
}

# assert_verdict <desc> <install-dir> <expected-verdict> <expected-rc>
#               [<expected-booted: true|false>]
assert_verdict() {
    local desc="$1" install="$2" expected="$3" expected_rc="$4" want_booted="${5:-}"
    local shared out rc verdict booted

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

    if [ -n "$want_booted" ]; then
        booted="$(json_field "$shared/.update_status" booted)"
        if [ "$booted" != "$want_booted" ]; then
            echo "FAIL: ${desc} - booted ${booted}, expected ${want_booted}"
            echo "${out}" | sed 's/^/    /'
            fail=$((fail + 1))
            return
        fi
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

# ok used to be the else branch, so every manifest the parser could not read
# fell through to "healthy" and booted - the exact silent stale boot this script
# exists to prevent. These must not claim ok. They still boot, because an
# unreadable manifest is not evidence the build is behind and halting on
# ambiguity turns a non-issue into an outage, so booted must stay true.
corrupt_install="$(make_raw_install <<'ACF'
this is not an acf at all
ACF
)"
assert_verdict "unparseable manifest is unverifiable, not ok" \
    "$corrupt_install" unverifiable 0 true

assert_verdict "empty manifest is unverifiable, not ok" \
    "$(make_raw_install < /dev/null)" unverifiable 0 true

# 128 = files corrupt, 32 = files missing, 1 = uninstalled. None of them set
# bit 4, so none of them is a fully installed build.
assert_verdict "files-corrupt StateFlags is unverifiable, not ok" \
    "$(make_install 128 24775771 24775771)" unverifiable 0 true

assert_verdict "files-missing StateFlags is unverifiable, not ok" \
    "$(make_install 32 24775771 24775771)" unverifiable 0 true

assert_verdict "uninstalled StateFlags is unverifiable, not ok" \
    "$(make_install 1 24775771 24775771)" unverifiable 0 true

assert_verdict "zero StateFlags is unverifiable, not ok" \
    "$(make_install 0 24775771 24775771)" unverifiable 0 true

# Fully installed, but nothing to compare - ok has to be positively asserted.
assert_verdict "manifest with no build ids is unverifiable, not ok" \
    "$(make_raw_install <<'ACF'
"AppState"
{
	"StateFlags"		"4"
}
ACF
)" unverifiable 0 true

# assert_pinned <desc> <install-dir> <expected-manifest|"none">
assert_pinned() {
    local desc="$1" install="$2" expected="$3"
    local shared got
    shared="$(mktemp -d)"

    BASE_GAME_DIR="$install" PZ_SHARED_DIR="$shared" GAME_VERSION=public \
        STEAMCMD_LOG=/nonexistent bash "$CHECK" >/dev/null 2>&1

    got="$(json_field "$shared/.update_status" pinned_manifest)"
    if [ "$expected" = "none" ]; then
        expected="null"
    fi

    if [ "$got" = "$expected" ]; then
        echo "PASS: ${desc}"
        pass=$((pass + 1))
    else
        echo "FAIL: ${desc} - pinned_manifest ${got}, expected ${expected}"
        fail=$((fail + 1))
    fi
}

assert_pinned "pinned manifest is read from the manifest" \
    "$(make_install 4 24775771 24775771)" 4041863939978451180

# Steam writes StagedDepots during an interrupted update - precisely the state
# this script inspects - and it carries the same depot id. Answering with the
# staged manifest would name a build that is not on disk.
assert_pinned "staged depot does not shadow the installed manifest" \
    "$(make_raw_install <<'ACF'
"AppState"
{
	"StateFlags"		"4"
	"buildid"		"24775771"
	"TargetBuildID"		"24775771"
	"StagedDepots"
	{
		"380871"
		{
			"manifest"		"1111111111111111111"
		}
	}
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
)" 4041863939978451180

# A partially installed depot has no manifest key. Reporting the next depot's
# id would send an operator chasing a manifest this install never used.
assert_pinned "a depot with no manifest key reports nothing, not the next depot" \
    "$(make_raw_install <<'ACF'
"AppState"
{
	"StateFlags"		"4"
	"buildid"		"24775771"
	"TargetBuildID"		"24775771"
	"InstalledDepots"
	{
		"380871"
		{
			"size"		"6886825943"
		}
		"380873"
		{
			"manifest"		"4894029153115054997"
		}
	}
}
ACF
)" none

# assert_repair <desc> <install-dir> <stamp-contents|"none"> <expected-verdict>
#               <expected-rc> <expect-force-flag: yes|no>
assert_repair() {
    local desc="$1" install="$2" stamp="$3" expected="$4" expected_rc="$5" want_flag="$6"
    local shared out rc verdict flagged

    shared="$(mktemp -d)"
    LAST_SHARED="$shared"
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

# The stamp is the only thing bounding repair to one attempt, and it is only
# useful if it records WHICH build was attempted. Every case below pre-seeds the
# stamp, so without this the suite passes with the write replaced by printf "1"
# - a boolean, which would read a genuinely new target build as a repeat.
stamp_written="$(tr -d '[:space:]' < "${LAST_SHARED}/.update_repair_attempt" 2>/dev/null || true)"
if [ "$stamp_written" = "24801442" ]; then
    echo "PASS: the queued reinstall stamps the target build id"
    pass=$((pass + 1))
else
    echo "FAIL: the queued reinstall stamps the target build id - stamp held '${stamp_written}', expected 24801442"
    fail=$((fail + 1))
fi

# Second encounter for the same build: the clean reinstall already failed once,
# so asking Docker to restart again would just burn 7GB in a loop.
assert_repair "repeat for the same build halts instead of looping" \
    "$(make_install 6 24775771 24801442)" 24801442 manifest_retired 2 no

# A newer build is a different problem and deserves its own attempt.
assert_repair "a new target build earns a fresh attempt" \
    "$(make_install 6 24775771 24801442)" 24700000 manifest_retired 1 yes

# StateFlags 6 alone earns update_required, which the retired-manifest log then
# upgrades, so this arm is reachable with no TargetBuildID at all. The stamp
# stored the literal "unknown" while the halt arm compared against
# "$target_build" behind a -n guard, so the comparison never ran: every boot
# re-queued the wipe and the container re-downloaded 7GB forever. Same shared
# dir twice, so the second run reads the stamp the first run wrote.
notarget_install="$(make_raw_install <<'ACF'
"AppState"
{
	"StateFlags"		"6"
	"buildid"		"24775771"
}
ACF
)"
notarget_shared="$(mktemp -d)"

BASE_GAME_DIR="$notarget_install" PZ_SHARED_DIR="$notarget_shared" GAME_VERSION=public \
    STEAMCMD_LOG="$retired_log" bash "$CHECK" >/dev/null 2>&1
notarget_rc1=$?
rm -f "$notarget_shared/.force_update"
BASE_GAME_DIR="$notarget_install" PZ_SHARED_DIR="$notarget_shared" GAME_VERSION=public \
    STEAMCMD_LOG="$retired_log" bash "$CHECK" >/dev/null 2>&1
notarget_rc2=$?

if [ "$notarget_rc1" -eq 1 ] && [ "$notarget_rc2" -eq 2 ]; then
    echo "PASS: a missing target build id still bounds repair to one attempt"
    pass=$((pass + 1))
else
    echo "FAIL: a missing target build id still bounds repair to one attempt - exits ${notarget_rc1} then ${notarget_rc2}, expected 1 then 2"
    fail=$((fail + 1))
fi

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
# when a diagnosis contains quotes and in the verdicts where fields come out
# null because the manifest is absent or unreadable.
#
# assert_json <desc> <install-dir> <content-log>
assert_json() {
    local desc="$1" install="$2" log="$3"
    local shared
    shared="$(mktemp -d)"

    BASE_GAME_DIR="$install" PZ_SHARED_DIR="$shared" GAME_VERSION=public \
        STEAMCMD_LOG="$log" bash "$CHECK" >/dev/null 2>&1

    if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$shared/.update_status" 2>/dev/null; then
        echo "PASS: ${desc}"
        pass=$((pass + 1))
    else
        echo "FAIL: ${desc}"
        sed 's/^/    /' "$shared/.update_status" 2>/dev/null
        fail=$((fail + 1))
    fi
}

if command -v python3 >/dev/null 2>&1; then
    assert_json "manifest_retired report is valid JSON" \
        "$(make_install 6 24775771 24801442)" "$retired_log"
    assert_json "unknown report is valid JSON" \
        "$(make_install nomanifest 0 0)" /nonexistent
    assert_json "missing report is valid JSON" \
        "$(make_install 4 24775771 24775771 nobinary)" /nonexistent
    assert_json "unverifiable report is valid JSON" \
        "$corrupt_install" /nonexistent
else
    echo "SKIP: report JSON validity needs python3"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
