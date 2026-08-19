# Steam update visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed SteamCMD update must stop the stale server from booting silently, and must be visible in the panel instead of only in `content_log.txt`.

**Architecture:** A standalone bash script reads SteamCMD's own `appmanifest_380870.acf` after the base image's update step, decides a verdict, writes a JSON report into the directory web-api already mounts, and returns an exit code. It never sleeps and never starts anything — a six-line snippet injected into `run_server.sh` acts on the code. Repair is not reimplemented: the retired-manifest case writes the existing `.force_update` flag and exits non-zero, so Docker restarts the container and the entrypoint's existing wipe-and-reinstall path runs. A stamp keyed to `TargetBuildID` stops that looping. The Rust panel reads the report file; `diagnosis` is admin-only because `/api/health/detailed` is unauthenticated in this stack.

**Tech Stack:** bash (GNU sed/awk, bash 4 arrays), Rust (axum, serde, tokio), React 19 + TanStack Query + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-19-steam-update-visibility-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `game-server/steam-update-check.sh` | **Create.** Pure decision: parse manifest, refine from log, write report + stamp + flag, exit 0/1/2. Never sleeps. |
| `game-server/tests/steam-update-check.test.sh` | **Create.** Runs the real script against synthesized `.acf` fixtures in throwaway dirs. |
| `game-server/amd64-entrypoint.sh` | **Modify.** Ship the new script, inject the acting snippet into `start_server()`, retire `ensure_game_binary.sh`. |
| `game-server/Dockerfile.amd64` | **Modify.** `COPY` + `chmod` the new script. |
| `docker-compose.amd64.yml` | **Modify.** Live-edit read-only mount for the new script. |
| `Makefile` | **Modify.** Run the new test suite in `test-game-server`. |
| `web/api/crates/pz-bridge/src/steam_update.rs` | **Create.** Report reader. Never errors. |
| `web/api/crates/pz-bridge/src/lib.rs` | **Modify.** Declare and re-export the module. |
| `web/api/crates/pz-api/src/routes/admin.rs` | **Modify.** Extend `UpdateStatus` with the full report. |
| `web/api/crates/pz-api/src/services/status.rs` | **Modify.** Carry the public-safe verdict on `ServerStatus`. |
| `web/api/crates/pz-api/src/routes/health.rs` | **Modify.** Same public-safe fields on `/health/detailed`. |
| `web/ui/src/lib/api.ts` | **Modify.** Types for both shapes. |
| `web/ui/src/routes/admin/overview.tsx` | **Modify.** Banner + build id in the dialog. |
| `web/ui/src/routes/landing/status-band.tsx` | **Modify.** One muted public line. |
| `web/ui/src/i18n/en.json`, `de.json` | **Modify.** Keys for both surfaces. |

## Contract (referenced by every task)

Exit codes from `steam-update-check.sh`:

| Code | Meaning | Caller does |
|---|---|---|
| 0 | current enough to boot | nothing, server starts |
| 1 | clean reinstall queued (`.force_update` written) | `exit 1`, Docker restarts the container |
| 2 | halt, a human is needed | `sleep infinity` |

Report at `$PZ_SHARED_DIR/.update_status`, all keys always present:

```json
{"verdict":"behind","installed_build":"24775771","target_build":"24801442",
 "state_flags":6,"branch":"public","pinned_manifest":"4041863939978451180",
 "last_updated":1787089316,"checked_at":1787100000,"booted":false,
 "auto_repaired":true,"diagnosis":"..."}
```

`verdict` is one of `ok`, `behind`, `update_required`, `manifest_retired`, `missing`, `unverifiable`, `unknown`. String fields are `null` when unknown; `state_flags` and the timestamps are numbers or `null`; `booted`/`auto_repaired` are booleans.


> **Correction, applied after Tasks 1-3 were implemented.** Review found two defects in the code these tasks prescribe, both reproduced:
>
> 1. **Critical.** The repair stamp wrote `${target_build:-unknown}` while the halt arm guarded on `[ -n "$target_build" ]`, so a manifest with no `TargetBuildID` could never match its own stamp. Since `update_required` needs only the `StateFlags` bit, that path was reachable — and with Task 4 wiring exit 1 to a container restart, it wiped and re-downloaded ~7.2GB on every boot, forever. Both sides must use the same fallback.
> 2. **Important.** `ok` was an `else` fallthrough, so a truncated manifest, a zero-byte one, or `StateFlags` without bit 4 all booted as healthy — the exact silent-stale-boot being fixed. `ok` is now a positive assertion and the leftovers become `unverifiable`, which boots but is not healthy.
>
> A third defect (the `pinned_manifest` awk reading a `StagedDepots` block instead of `InstalledDepots`) and a test hole (the stamp's written value was never read back, which is what hid defect 1) were fixed alongside. The task text below is left as written; the corrections are in a follow-up commit.
---

### Task 1: Manifest parsing and the core verdicts

The base image prints `### Project Zomboid Server updated.` whether or not the update worked, so its output is not evidence. SteamCMD's own `appmanifest_380870.acf` is.

**Files:**
- Create: `game-server/tests/steam-update-check.test.sh`
- Create: `game-server/steam-update-check.sh`

- [ ] **Step 1: Write the failing test**

Create `game-server/tests/steam-update-check.test.sh`:

```bash
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash game-server/tests/steam-update-check.test.sh
```

Expected: all six cases FAIL with `no report written`, because `steam-update-check.sh` does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `game-server/steam-update-check.sh`:

```bash
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

case "$verdict" in
    ok|unknown) booted=true; rc=0 ;;
    *)          rc=2 ;;
esac

write_report

if [ "$rc" -eq 0 ]; then
    echo "[update-check] ${verdict}: ${diagnosis}"
else
    echo "### ERROR: the game server install is not usable."
    echo "### ${diagnosis}"
fi

exit "$rc"
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
chmod +x game-server/steam-update-check.sh && bash game-server/tests/steam-update-check.test.sh
```

Expected: `6 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add game-server/steam-update-check.sh game-server/tests/steam-update-check.test.sh && git commit -m "Read the Steam manifest instead of trusting the update log."
```

---

### Task 2: Name the retired-manifest failure

A generic "No connection" is actively misleading here. Once installed, the depot pins a manifest id; when Steam retires it the delta update fails with `Failed to get manifest request code, 'Access Denied'` and no retry, cache clear, or SteamCMD upgrade helps. Only a clean reinstall does. The log is the only place that distinction appears, so it refines an existing verdict — it never originates one.

**Files:**
- Modify: `game-server/tests/steam-update-check.test.sh`
- Modify: `game-server/steam-update-check.sh`

- [ ] **Step 1: Write the failing test**

Append to `game-server/tests/steam-update-check.test.sh`, immediately **before** the final `echo` / `echo "${pass} passed..."` lines:

```bash
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash game-server/tests/steam-update-check.test.sh
```

Expected: `retired manifest is named, not guessed` FAILs with `verdict was behind, expected manifest_retired`. The healthy case already passes.

- [ ] **Step 3: Write the implementation**

In `game-server/steam-update-check.sh`, add this function after `pinned_manifest()`:

```bash
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
```

Then, in the verdict section, insert this **between** the `if/elif/else` chain that sets `verdict` and the `case "$verdict"` block:

```bash
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
```

Finally, extend the `case` so the new verdict is distinguishable. Replace:

```bash
case "$verdict" in
    ok|unknown) booted=true; rc=0 ;;
    *)          rc=2 ;;
esac
```

with:

```bash
case "$verdict" in
    ok|unknown)       booted=true; rc=0 ;;
    manifest_retired) rc=1 ;;
    *)                rc=2 ;;
esac
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash game-server/tests/steam-update-check.test.sh
```

Expected: `8 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add game-server/steam-update-check.sh game-server/tests/steam-update-check.test.sh && git commit -m "Name the retired-manifest failure instead of guessing at it."
```

> **Do not deploy between here and the end of Task 3.** Exit code 1 means "restart me", but the `.force_update` flag that makes the restart productive is not written until Task 3. A container wired to act on that code right now would restart into the identical state forever. Task 4 is what does the wiring, and it comes after Task 3 for exactly this reason — keep that order.

---

### Task 3: Repair once, keyed to the build

Exit code 1 means "restart me". With `restart: unless-stopped`, Docker brings the container back, the entrypoint sees `.force_update` and runs its existing wipe-and-reinstall path. No repair logic is duplicated here. The stamp is what stops that becoming a loop, and it holds the `TargetBuildID` rather than a boolean so a *new* Steam build earns a fresh attempt instead of being locked out by a stale flag.

**Files:**
- Modify: `game-server/tests/steam-update-check.test.sh`
- Modify: `game-server/steam-update-check.sh`

- [ ] **Step 1: Write the failing test**

Append to `game-server/tests/steam-update-check.test.sh`, before the final `echo` lines:

```bash
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash game-server/tests/steam-update-check.test.sh
```

Expected: `first retired manifest queues a reinstall` FAILs with `force flag no (want yes)` — the flag is never written yet. `repeat for the same build halts` FAILs on `exit 1 (want 2)`.

- [ ] **Step 3: Write the implementation**

In `game-server/steam-update-check.sh`, add the two paths next to `REPORT`:

```bash
STAMP="${PZ_SHARED_DIR}/.update_repair_attempt"
FORCE_FLAG="${PZ_SHARED_DIR}/.force_update"
```

Then replace the whole `case "$verdict" in ... esac` block with:

```bash
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
```

And replace the closing output block so a queued repair does not read as a dead end:

```bash
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash game-server/tests/steam-update-check.test.sh
```

Expected: `13 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add game-server/steam-update-check.sh game-server/tests/steam-update-check.test.sh && git commit -m "Queue one clean reinstall per build, then stop trying."
```

---

### Task 4: Run the check where the base image cannot hide the failure

The stale-build path never enters the entrypoint's own SteamCMD block — that is gated behind `if ! game_binary_present`, and a stale binary is present. `exec run_server.sh` then rules out a post-check. So the check is injected into `start_server()` using the same `sed` patching the file already does for `configure-server.sh`, `fix-heap.sh` and `PZ_BINARY_GUARD`. That position runs after the base image's `update_server`, reading the manifest as SteamCMD left it.

**Files:**
- Modify: `game-server/amd64-entrypoint.sh:120-145` (the `PZ_BINARY_GUARD` block)
- Modify: `game-server/Dockerfile.amd64:10-20`
- Modify: `docker-compose.amd64.yml:56-59`
- Modify: `Makefile:228-230`

- [ ] **Step 1: Replace the binary guard with the update check**

In `game-server/amd64-entrypoint.sh`, delete the entire `cat > /home/steam/ensure_game_binary.sh << 'EOF' ... EOF` block **and** its `chmod +x` line, then replace the `PZ_BINARY_GUARD` injection block that follows with:

```bash
# The base image prints "### Project Zomboid Server updated." whether or not
# SteamCMD worked. Inject our own check at the top of start_server(), which by
# definition runs after the image's update step, so it reads the manifest
# exactly as SteamCMD left it. Exit codes are documented in the script.
cat > /home/steam/run_update_check.sh << 'EOF'
#!/bin/bash
# PZ_UPDATE_GUARD
bash /home/steam/steam-update-check.sh
_rc=$?
if [ "$_rc" -eq 1 ]; then
    printf '\n### Restarting the container to run a clean reinstall.\n'
    exit 1
elif [ "$_rc" -ne 0 ]; then
    printf '\n### Refusing to start on a stale build.\n'
    printf '### Clients that already updated would hang at "Joining game...".\n'
    printf '### Container staying up for debugging: docker logs pz-game-server\n'
    sleep infinity
    exit 1
fi
EOF
chmod +x /home/steam/run_update_check.sh

if [ -f /home/steam/run_server.sh ] && ! grep -q 'PZ_UPDATE_GUARD' /home/steam/run_server.sh 2>/dev/null; then
    # Inject at the top of start_server() - GNU sed.
    sed -i 's|^function start_server() {$|function start_server() {\n    # PZ_UPDATE_GUARD\n    bash /home/steam/run_update_check.sh \|\| exit $?|' \
        /home/steam/run_server.sh
    if grep -q 'PZ_UPDATE_GUARD' /home/steam/run_server.sh 2>/dev/null; then
        echo "[entrypoint] Patched run_server.sh with the Steam update guard"
    else
        echo "[entrypoint] WARNING: update guard patch failed - a failed update will boot stale"
    fi
fi
```

Export the branch the check should report, by adding this right after the existing `export GAME_VERSION=...` line:

```bash
export PZ_SHARED_DIR="/home/steam/Zomboid"
export BASE_GAME_DIR="${BASE_GAME_DIR:-/home/steam/ZomboidDedicatedServer}"
```

Note `BASE_GAME_DIR` is already assigned further down; make that line `BASE_GAME_DIR="${BASE_GAME_DIR:-/home/steam/ZomboidDedicatedServer}"` so the export above is not clobbered.

- [ ] **Step 2: Ship the script in the image**

In `game-server/Dockerfile.amd64`, add to the existing `COPY` group:

```dockerfile
COPY steam-update-check.sh /home/steam/steam-update-check.sh
```

and add it to the `chmod +x` list:

```dockerfile
RUN chmod +x /home/steam/amd64-entrypoint.sh \
              /home/steam/configure-server.sh \
              /home/steam/fix-heap.sh \
              /home/steam/steam-update-check.sh \
    && mkdir -p /home/steam/Zomboid/mods /home/steam/Zomboid/Lua/inventory
```

- [ ] **Step 3: Add the live-edit mount**

In `docker-compose.amd64.yml`, under `game-server.volumes`, after the `fix-heap.sh` line:

```yaml
      - ./game-server/steam-update-check.sh:/home/steam/steam-update-check.sh:ro
```

- [ ] **Step 4: Wire the tests into make**

In `Makefile`, in the `test-game-server` target, after the `configure-server.test.sh` line:

```makefile
	@bash game-server/tests/steam-update-check.test.sh
```

- [ ] **Step 5: Verify the suite runs through make**

```bash
make test-game-server
```

Expected: the configure-server suite passes, then `13 passed, 0 failed` from the update-check suite. On Windows use `.\make.ps1 test-game-server`.

- [ ] **Step 6: Verify the injection against the real image**

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml build game-server
```

Then confirm the sed target still matches the base image's `run_server.sh`:

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml run --rm --entrypoint bash game-server -c "grep -c '^function start_server() {$' /home/steam/run_server.sh"
```

Expected: `1`. If it prints `0`, the base image changed its function signature and the `sed` pattern in Step 1 needs updating — the entrypoint's `WARNING: update guard patch failed` line would be the only symptom at runtime.

- [ ] **Step 7: Commit**

```bash
git add game-server/amd64-entrypoint.sh game-server/Dockerfile.amd64 docker-compose.amd64.yml Makefile && git commit -m "Check the install where the base image cannot paper over it."
```

---

### Task 5: A reader for the report

Sits with the other file-based integrations (`ini.rs`, `lua.rs`, `player_file.rs`) and follows their rule: a missing file is the normal state of a stopped server, not an error worth surfacing.

**Files:**
- Create: `web/api/crates/pz-bridge/src/steam_update.rs`
- Modify: `web/api/crates/pz-bridge/src/lib.rs:12-26`

- [ ] **Step 1: Write the failing test**

Create `web/api/crates/pz-bridge/src/steam_update.rs` containing **only** the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const BEHIND: &str = r#"{"verdict":"behind","installed_build":"24775771",
"target_build":"24801442","state_flags":6,"branch":"public",
"pinned_manifest":"4041863939978451180","last_updated":1787089316,
"checked_at":1787100000,"booted":false,"auto_repaired":true,
"diagnosis":"Installed build 24775771, but Steam expects 24801442."}"#;

    #[test]
    fn parses_a_full_report() {
        let report = UpdateReport::parse(BEHIND);

        assert_eq!(report.verdict, UpdateVerdict::Behind);
        assert_eq!(report.installed_build.as_deref(), Some("24775771"));
        assert_eq!(report.target_build.as_deref(), Some("24801442"));
        assert_eq!(report.state_flags, Some(6));
        assert!(report.auto_repaired);
        assert!(!report.booted);
        assert!(report.diagnosis.is_some());
    }

    #[test]
    fn absent_report_is_unknown_and_not_an_error() {
        let report = UpdateReport::default();

        assert_eq!(report.verdict, UpdateVerdict::Unknown);
        assert!(report.verdict.is_healthy());
    }

    #[test]
    fn garbage_does_not_panic_or_condemn_the_server() {
        let report = UpdateReport::parse("not json at all");

        assert_eq!(report.verdict, UpdateVerdict::Unknown);
        assert!(report.verdict.is_healthy());
    }

    /// Boots, but is not healthy. If this ever flips to healthy, a corrupt
    /// manifest goes back to booting stale in silence.
    #[test]
    fn unverifiable_boots_but_is_not_healthy() {
        let report = UpdateReport::parse(r#"{"verdict":"unverifiable","booted":true}"#);

        assert_eq!(report.verdict, UpdateVerdict::Unverifiable);
        assert!(report.booted);
        assert!(!report.verdict.is_healthy());
    }

    /// A newer script may grow a verdict this build has never heard of. That
    /// must not read as a failure, or a panel upgrade lag would take the
    /// server offline in the UI for no reason.
    #[test]
    fn unrecognised_verdict_falls_back_to_unknown() {
        let report = UpdateReport::parse(r#"{"verdict":"something_new"}"#);

        assert_eq!(report.verdict, UpdateVerdict::Unknown);
    }

    /// The public shape must never carry the diagnosis: `/health/detailed` is
    /// unauthenticated in this stack.
    #[test]
    fn public_view_drops_the_diagnosis() {
        let public = UpdateReport::parse(BEHIND).public();

        assert_eq!(public.verdict, UpdateVerdict::Behind);
        assert!(!public.healthy);
        assert_eq!(public.installed_build.as_deref(), Some("24775771"));

        let json = serde_json::to_string(&public).expect("serialises");
        assert!(!json.contains("diagnosis"));
        assert!(!json.contains("Steam expects"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd web/api && cargo test -p pz-bridge steam_update
```

Expected: compile error — `steam_update` is not declared in `lib.rs`, and `UpdateReport` does not exist.

- [ ] **Step 3: Write the implementation**

Prepend to `web/api/crates/pz-bridge/src/steam_update.rs`, above the test module:

```rust
//! Reader for the game server's boot-time update report.
//!
//! `steam-update-check.sh` writes `.update_status` into the shared data
//! directory on every boot. It is the only place a failed SteamCMD update
//! shows up: the base image reports success either way, and a stale build is
//! indistinguishable from a healthy one from the outside.
//!
//! Like every reader here, a missing or unreadable file is a state, not an
//! error — and specifically a state that must never read as "broken", or a
//! fresh install would look condemned before it has booted once.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// What the last boot concluded about the install.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateVerdict {
    /// Installed build matches what Steam expects.
    Ok,
    /// Steam knows a newer build exists and this install does not have it.
    /// Clients that auto-updated cannot join.
    Behind,
    /// Steam flagged the install as needing an update.
    UpdateRequired,
    /// The pinned depot manifest was retired. Retries cannot recover; only a
    /// clean reinstall of the game directory does.
    ManifestRetired,
    /// No game binary at all.
    Missing,
    /// The manifest is there but could not be read well enough to judge.
    /// Boots, but must not read as healthy - losing the ability to detect a
    /// stale build is itself the failure this change exists to surface.
    Unverifiable,
    /// No report yet, or one this build does not understand.
    #[default]
    Unknown,
}

impl UpdateVerdict {
    /// Whether the server can actually serve players.
    ///
    /// `Unknown` counts as healthy on purpose: absence of evidence is not
    /// evidence of a broken install.
    pub fn is_healthy(self) -> bool {
        matches!(self, Self::Ok | Self::Unknown)
    }

    fn from_tag(tag: &str) -> Self {
        match tag {
            "ok" => Self::Ok,
            "behind" => Self::Behind,
            "update_required" => Self::UpdateRequired,
            "manifest_retired" => Self::ManifestRetired,
            "missing" => Self::Missing,
            "unverifiable" => Self::Unverifiable,
            _ => Self::Unknown,
        }
    }
}

/// Deserialised as written by the script. Every field is optional so a report
/// from a newer script still parses.
#[derive(Debug, Default, Deserialize)]
struct RawReport {
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    installed_build: Option<String>,
    #[serde(default)]
    target_build: Option<String>,
    #[serde(default)]
    state_flags: Option<i64>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    pinned_manifest: Option<String>,
    #[serde(default)]
    last_updated: Option<i64>,
    #[serde(default)]
    checked_at: Option<i64>,
    #[serde(default)]
    booted: bool,
    #[serde(default)]
    auto_repaired: bool,
    #[serde(default)]
    diagnosis: Option<String>,
}

/// The full report. Staff-only — `diagnosis` can name filesystem paths and
/// echo SteamCMD errors.
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateReport {
    pub verdict: UpdateVerdict,
    pub installed_build: Option<String>,
    pub target_build: Option<String>,
    pub state_flags: Option<i64>,
    pub branch: Option<String>,
    pub pinned_manifest: Option<String>,
    pub last_updated: Option<i64>,
    pub checked_at: Option<i64>,
    /// Whether the check let the server start. `false` with a non-`Ok` verdict
    /// means the container is up but deliberately holding the game down —
    /// which from outside looks identical to a slow world load.
    pub booted: bool,
    pub auto_repaired: bool,
    pub diagnosis: Option<String>,
}

/// The subset that is safe on an unauthenticated endpoint.
///
/// Build ids are public Steam data. The diagnosis is not.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PublicUpdate {
    pub verdict: UpdateVerdict,
    pub healthy: bool,
    pub installed_build: Option<String>,
    pub target_build: Option<String>,
}

impl UpdateReport {
    /// Read the report, or a default `Unknown` one when it is absent or
    /// unreadable. Never returns an error.
    pub async fn read(path: impl AsRef<Path>) -> Self {
        match tokio::fs::read_to_string(path.as_ref()).await {
            Ok(contents) => Self::parse(&contents),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(source) => {
                tracing::warn!(%source, "update report unreadable");
                Self::default()
            }
        }
    }

    fn parse(contents: &str) -> Self {
        let raw: RawReport = match serde_json::from_str(contents) {
            Ok(raw) => raw,
            Err(source) => {
                tracing::warn!(%source, "update report is not valid JSON");
                return Self::default();
            }
        };

        Self {
            verdict: UpdateVerdict::from_tag(&raw.verdict),
            installed_build: raw.installed_build,
            target_build: raw.target_build,
            state_flags: raw.state_flags,
            branch: raw.branch,
            pinned_manifest: raw.pinned_manifest,
            last_updated: raw.last_updated,
            checked_at: raw.checked_at,
            booted: raw.booted,
            auto_repaired: raw.auto_repaired,
            diagnosis: raw.diagnosis,
        }
    }

    /// The view safe for players and for unauthenticated monitoring.
    pub fn public(&self) -> PublicUpdate {
        PublicUpdate {
            verdict: self.verdict,
            healthy: self.verdict.is_healthy(),
            installed_build: self.installed_build.clone(),
            target_build: self.target_build.clone(),
        }
    }
}
```

Then in `web/api/crates/pz-bridge/src/lib.rs`, add the module declaration alongside the others:

```rust
pub mod steam_update;
```

and the re-export next to `pub use ini::ServerIni;`:

```rust
pub use steam_update::{PublicUpdate, UpdateReport, UpdateVerdict};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web/api && cargo test -p pz-bridge steam_update
```

Expected: `test result: ok. 6 passed`.

- [ ] **Step 5: Commit**

```bash
git add web/api/crates/pz-bridge/src/steam_update.rs web/api/crates/pz-bridge/src/lib.rs && git commit -m "Read the boot-time update report into the panel."
```

---

### Task 6: Give staff the full report

`GET /api/v1/admin/server/update` already backs the update card on the overview page, so the report rides along with the branch list rather than needing a new endpoint or a new query.

**Files:**
- Modify: `web/api/crates/pz-api/src/services/admin.rs:141-151`
- Modify: `web/api/crates/pz-api/src/routes/admin.rs:583-596`

- [ ] **Step 1: Add the service function**

In `web/api/crates/pz-api/src/services/admin.rs`, directly after `steam_branch()`, add:

```rust
/// What the last boot concluded about the install.
///
/// Written by the game server's own entrypoint check, not by us — so it is
/// still readable when the game container is down or deliberately halted.
pub async fn update_report(state: &AppState) -> UpdateReport {
    UpdateReport::read(state.config.data_path.join(".update_status")).await
}
```

Add `UpdateReport` to the `pz_bridge` import at the top of that file. If the existing import is a single-item `use pz_bridge::X;`, widen it to a braced list including `UpdateReport`.

- [ ] **Step 2: Widen the response**

In `web/api/crates/pz-api/src/routes/admin.rs`, replace the `UpdateStatus` struct and its handler:

```rust
#[derive(Serialize)]
struct UpdateStatus {
    branch: String,
    branches: Vec<String>,
    /// Staff-only: carries the diagnosis, which can name paths.
    report: pz_bridge::UpdateReport,
}

async fn update_status(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<UpdateStatus>> {
    Ok(Json(UpdateStatus {
        branch: admin::steam_branch(&state).await,
        branches: admin::STEAM_BRANCHES.iter().map(|s| (*s).to_owned()).collect(),
        report: admin::update_report(&state).await,
    }))
}
```

Note the report is nested rather than flattened: it has its own `branch` field, which would collide with the branch the *next* boot will install.

- [ ] **Step 3: Verify it compiles and the shape is right**

```bash
cd web/api && cargo check -p pz-api
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/api/crates/pz-api/src/services/admin.rs web/api/crates/pz-api/src/routes/admin.rs && git commit -m "Carry the update report on the admin update endpoint."
```

---

### Task 7: The public-safe verdict on both open endpoints

`health::routes()` is merged at `/api` with no auth layer, so `/api/health/detailed` is reachable by anyone. Both it and `/server/status` get `PublicUpdate` — verdict and build ids, never the diagnosis.

**Files:**
- Modify: `web/api/crates/pz-api/src/services/status.rs:44-70,120-166`
- Modify: `web/api/crates/pz-api/src/routes/health.rs:22-40,48-76`

- [ ] **Step 1: Carry it on `ServerStatus`**

In `web/api/crates/pz-api/src/services/status.rs`, add to the `use pz_bridge::...` line: `PublicUpdate, UpdateReport`.

Add the field to the struct, after `data_source`:

```rust
    /// What the last boot concluded about the game install. Public-safe.
    pub update: PublicUpdate,
```

Change the `offline` constructor to take it, since a halted install is exactly when this matters most:

```rust
    fn offline(container: ContainerState, update: PublicUpdate) -> Self {
        Self {
            state: GameState::Offline,
            online: false,
            container,
            player_count: 0,
            players: Vec::new(),
            max_players: None,
            map: None,
            uptime_seconds: None,
            data_source: DataSource::None,
            update,
            checked_at: Utc::now(),
        }
    }
```

- [ ] **Step 2: Populate it in `resolve`**

In `resolve()`, read the report **before** the offline early-return, then thread it through. Replace the opening of `resolve` down to the `if !container.running` block with:

```rust
    async fn resolve(&self) -> ServerStatus {
        // Read first: a container that never started is precisely the case
        // where the operator needs to know the install is the reason.
        let update = UpdateReport::read(self.config.data_path.join(".update_status"))
            .await
            .public();

        let container = match self.docker.status().await {
            Ok(status) => status,
            Err(error) => {
                // Losing sight of Docker is worth a log line, but the site still
                // needs an answer.
                tracing::warn!(%error, "docker status unavailable");
                ContainerStatus::unknown()
            }
        };

        if !container.running {
            return ServerStatus::offline(container.state, update);
        }
```

and add `update,` to the `ServerStatus { ... }` literal at the end of `resolve`, next to `data_source,`.

- [ ] **Step 3: Add it to detailed health**

In `web/api/crates/pz-api/src/routes/health.rs`, extend the struct:

```rust
#[derive(Serialize)]
struct GameServerHealth {
    state: crate::services::status::GameState,
    player_count: usize,
    /// Public-safe. No diagnosis: this endpoint has no auth layer.
    update: pz_bridge::PublicUpdate,
}
```

and the handler's return, so monitoring can alert on a stale build without anyone opening the panel:

```rust
    let server_status = state.status.current().await;
    let update_healthy = server_status.update.healthy;

    Json(DetailedHealth {
        status: if database.reachable && update_healthy {
            "ok"
        } else {
            "degraded"
        },
        version: env!("CARGO_PKG_VERSION"),
        database,
        game_server: GameServerHealth {
            state: server_status.state,
            player_count: server_status.player_count,
            update: server_status.update,
        },
    })
```

- [ ] **Step 4: Verify it compiles**

```bash
cd web/api && cargo check -p pz-api && cargo clippy -p pz-api -- -D warnings
```

Expected: no errors, no warnings.

- [ ] **Step 5: Commit**

```bash
git add web/api/crates/pz-api/src/services/status.rs web/api/crates/pz-api/src/routes/health.rs && git commit -m "Report update health on the open endpoints, without the diagnosis."
```

---

### Task 8: The banner that says why

When the check halts, the container stays up and `status.rs` reports `Starting` forever, because from outside a held-down game is indistinguishable from a slow world load. This banner is the only thing that says which one it is.

**Files:**
- Modify: `web/ui/src/lib/api.ts:30-42,810-816`
- Modify: `web/ui/src/routes/admin/overview.tsx:228-235,355-375`
- Modify: `web/ui/src/i18n/en.json`, `web/ui/src/i18n/de.json`

- [ ] **Step 1: Add the types**

In `web/ui/src/lib/api.ts`, add above `export interface ServerStatus`:

```ts
export type UpdateVerdict =
  | 'ok'
  | 'behind'
  | 'update_required'
  | 'manifest_retired'
  | 'missing'
  | 'unverifiable'
  | 'unknown'

/** Public-safe view. Never carries the diagnosis. */
export interface PublicUpdate {
  verdict: UpdateVerdict
  healthy: boolean
  installed_build: string | null
  target_build: string | null
}

/** Staff-only. `diagnosis` can name filesystem paths. */
export interface UpdateReport {
  verdict: UpdateVerdict
  installed_build: string | null
  target_build: string | null
  state_flags: number | null
  branch: string | null
  pinned_manifest: string | null
  last_updated: number | null
  checked_at: number | null
  /** False with a bad verdict means the game is deliberately held down. */
  booted: boolean
  auto_repaired: boolean
  diagnosis: string | null
}
```

Add to `ServerStatus`, after `data_source`:

```ts
  update: PublicUpdate
```

And replace the `UpdateStatus` interface:

```ts
/** Steam branch the next game-server boot will install, plus install health. */
export interface UpdateStatus {
  branch: string
  branches: string[]
  report: UpdateReport
}
```

- [ ] **Step 2: Add the translation keys**

In `web/ui/src/i18n/en.json`, add alongside the other `admin.update.*` keys (keep the file's alphabetical order):

```json
  "admin.update.health_builds": "Installed build :installed — Steam expects :target.",
  "admin.update.health_halted_title": "The server is being held down: its game build is out of date",
  "admin.update.health_last_checked": "Checked :when",
  "admin.update.health_repairing": "A clean reinstall has been queued. The container restarts to run it.",
  "admin.update.health_stale_title": "The game build is out of date",
  "admin.update.installed_build": "Installed build",
```

In `web/ui/src/i18n/de.json`, the same keys:

```json
  "admin.update.health_builds": "Installierter Build :installed — Steam erwartet :target.",
  "admin.update.health_halted_title": "Der Server wird angehalten: sein Spiel-Build ist veraltet",
  "admin.update.health_last_checked": "Geprüft :when",
  "admin.update.health_repairing": "Eine Neuinstallation wurde eingeplant. Der Container startet neu, um sie auszuführen.",
  "admin.update.health_stale_title": "Der Spiel-Build ist veraltet",
  "admin.update.installed_build": "Installierter Build",
```

- [ ] **Step 3: Render the banner**

In `web/ui/src/routes/admin/overview.tsx`, inside the controls `<Panel>` body, insert immediately after the `controls_hint` paragraph and before the `{error ? ...}` line:

```tsx
        {updateStatus.data && !['ok', 'unknown'].includes(updateStatus.data.report.verdict) ? (
          <div
            role="alert"
            className={
              updateStatus.data.report.booted
                ? 'border border-hazard/40 bg-hazard-soft px-3 py-2 text-sm text-hazard'
                : 'border border-blood/40 bg-blood-soft px-3 py-2 text-sm text-blood'
            }
          >
            <p className="font-semibold">
              {updateStatus.data.report.booted
                ? t('admin.update.health_stale_title')
                : t('admin.update.health_halted_title')}
            </p>
            <p className="mt-1">
              {t('admin.update.health_builds', {
                installed: updateStatus.data.report.installed_build ?? '?',
                target: updateStatus.data.report.target_build ?? '?',
              })}
            </p>
            {updateStatus.data.report.diagnosis ? (
              <p className="mt-1 text-bone">{updateStatus.data.report.diagnosis}</p>
            ) : null}
            {updateStatus.data.report.auto_repaired ? (
              <p className="mt-1 text-bone">{t('admin.update.health_repairing')}</p>
            ) : null}
          </div>
        ) : null}
```

- [ ] **Step 4: Show the installed build in the update dialog**

In the same file, inside the update `ConfirmDialog`'s `description`, immediately after the branch `<label>` block and before the `admin.update.warning` paragraph:

```tsx
            {updateStatus.data?.report.installed_build ? (
              <p className="text-sm text-dust">
                {t('admin.update.installed_build')}:{' '}
                <span className="font-mono text-bone">
                  {updateStatus.data.report.installed_build}
                </span>
                {updateStatus.data.report.last_updated
                  ? ` — ${t('admin.update.health_last_checked', {
                      when: new Date(
                        updateStatus.data.report.last_updated * 1000,
                      ).toLocaleString(intlLocale),
                    })}`
                  : ''}
              </p>
            ) : null}
```

`intlLocale` is already destructured from `useTranslation()` at the top of the page component. If the controls component does not have it, add it: `const { t, intlLocale } = useTranslation()`.

- [ ] **Step 5: Verify types and lint**

```bash
cd web/ui && npm run build
```

Expected: a clean build. A missing translation key fails the `TranslationKey` type check, so this also proves Step 2 landed.

- [ ] **Step 6: Commit**

```bash
git add web/ui/src/lib/api.ts web/ui/src/routes/admin/overview.tsx web/ui/src/i18n/en.json web/ui/src/i18n/de.json && git commit -m "Tell staff the build is stale instead of showing Starting forever."
```

---

### Task 9: One line for players

A player who cannot join deserves better than a silent timeout. No diagnosis here — just the fact.

**Files:**
- Modify: `web/ui/src/routes/landing/status-band.tsx:15-40`
- Modify: `web/ui/src/i18n/en.json`, `web/ui/src/i18n/de.json`

- [ ] **Step 1: Add the translation keys**

`web/ui/src/i18n/en.json`:

```json
  "status.update_behind": "This server is on an older game build than the current client. Joining will not work until an admin updates it.",
```

`web/ui/src/i18n/de.json`:

```json
  "status.update_behind": "Dieser Server läuft auf einem älteren Spiel-Build als der aktuelle Client. Beitreten funktioniert erst, wenn ein Admin ihn aktualisiert.",
```

- [ ] **Step 2: Render it**

In `web/ui/src/routes/landing/status-band.tsx`, inside the `<Section>` and directly after the `<SectionHeading ... />` element:

```tsx
        {status && !status.update.healthy ? (
          <p
            role="status"
            className="mt-4 border border-hazard/40 bg-hazard-soft px-3 py-2 text-sm text-hazard"
          >
            {t('status.update_behind')}
          </p>
        ) : null}
```

- [ ] **Step 3: Verify**

```bash
cd web/ui && npm run build
```

Expected: a clean build.

- [ ] **Step 4: Commit**

```bash
git add web/ui/src/routes/landing/status-band.tsx web/ui/src/i18n/en.json web/ui/src/i18n/de.json && git commit -m "Tell players why they cannot join."
```

---

### Task 10: Prove it end to end

The unit tests cover the decision. This proves the wiring: that the check actually runs inside the real image, and that a bad manifest reaches the panel.

**Files:** none — verification only.

- [ ] **Step 1: Rebuild and start the stack**

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml up -d --build --force-recreate game-server
```

- [ ] **Step 2: Confirm the guard was injected and the install is healthy**

```bash
docker logs pz-game-server 2>&1 | grep -E "update guard|update-check"
```

Expected: `[entrypoint] Patched run_server.sh with the Steam update guard` and `[update-check] ok: Installed build ... matches what Steam expects.`

If instead you see `WARNING: update guard patch failed`, the base image changed `start_server()`'s signature — fix the `sed` pattern in Task 4 Step 1 before going further, because a silent failure here is exactly the bug being fixed.

- [ ] **Step 3: Confirm the report reached the panel**

```bash
cat data/zomboid/.update_status
```

Expected: one line of JSON with `"verdict":"ok"` and `"booted":true`.

- [ ] **Step 4: Confirm the API serves it**

```bash
curl -s localhost:8080/api/health/detailed
```

Expected: `"update":{"verdict":"ok","healthy":true,...}` and `"status":"ok"`. Adjust the port if `API_BIND` differs.

- [ ] **Step 5: Force the failure and watch it get caught**

Corrupt the manifest so it looks like the 2026-08-18 state, then restart:

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml stop game-server && sed -i 's/"StateFlags"\t\t"4"/"StateFlags"\t\t"6"/' data/server/steamapps/appmanifest_380870.acf && docker compose -f docker-compose.yml -f docker-compose.amd64.yml start game-server
```

Then:

```bash
docker logs pz-game-server 2>&1 | tail -20
```

Expected: `### ERROR: the game server install is not usable.` and `### Refusing to start on a stale build.` The container stays up; the game does not start.

Confirm the panel says why:

```bash
curl -s localhost:8080/api/health/detailed
```

Expected: `"status":"degraded"` and `"verdict":"update_required"`. Open `/admin` and confirm the red banner reads "The server is being held down".

- [ ] **Step 6: Restore**

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml stop game-server && sed -i 's/"StateFlags"\t\t"6"/"StateFlags"\t\t"4"/' data/server/steamapps/appmanifest_380870.acf && docker compose -f docker-compose.yml -f docker-compose.amd64.yml start game-server
```

Confirm `[update-check] ok:` in the logs and a green panel before finishing.

- [ ] **Step 7: Run the whole suite**

```bash
make test-game-server
```

```bash
cd web/api && cargo test && cargo clippy -- -D warnings
```

```bash
cd web/ui && npm run build
```

Expected: all green.

---

## Notes for the implementer

**ARM64 is out of scope.** `docker-compose.arm64.yml` uses a different base image and `game-server/entrypoint.sh`, which has its own SteamCMD invocation with a `&& break` retry loop. The incident was on AMD64 and the manifest layout differs enough to warrant its own change. Do not half-wire it.

**Do not bump Knox Relay.** No Lua changes here, so `modversion=` and `KR_Bridge.VERSION` stay where they are.

**`data/server/.gitkeep` is currently showing as deleted** in the working tree — collateral from the `rm -rf data/server` recovery that fixed the original incident. Restore it (`git checkout -- data/server/.gitkeep`) before the branch lands; it is unrelated to this work but will otherwise ride along in a commit.
