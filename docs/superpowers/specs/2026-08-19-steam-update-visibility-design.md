# Making a failed game update visible

A SteamCMD failure boots a stale server in silence. On 2026-08-18 `app_update 380870 validate` failed with `Error! App '380870' state is 0x6 after update job.` on every boot from 18:32. The entrypoint ignored it, booted the stale 42.20.2 build, and the base image printed `### Project Zomboid Server updated.` regardless. The PZ client meanwhile auto-updated to 42.20.3, so players hung at "Joining game..." with a `BufferUnderflowException` in `ChunkNotReadyPacket.parse` — a wire-format mismatch. Nothing surfaced it. It was found by reading SteamCMD's `content_log.txt` by hand.

## Why the existing guard missed it

`amd64-entrypoint.sh` already retries SteamCMD, cleans half-installs, and halts with instructions when the binary is gone. All of it sits behind `if ! game_binary_present`. A **stale** binary is present, so the whole block is skipped and control reaches `exec /home/steam/run_server.sh`, where the base image's update runs and reports success unconditionally. `exec` replaces the process, so there is no post-check either.

The gap is not missing logic. It is that the only failure the entrypoint can see is a missing file.

## Signals

The manifest is primary. `${BASE_GAME_DIR}/steamapps/appmanifest_380870.acf` is written by SteamCMD itself, survives the base image, and needs no stdout capture.

| Field | Use |
|---|---|
| `StateFlags` | bitfield — `4` fully installed, `2` update required (`6` = both) |
| `buildid` | what is installed |
| `TargetBuildID` | what Steam expects to be installed |
| `LastUpdated` | age of the install |
| `InstalledDepots.380871.manifest` | the pinned manifest that goes stale |

`StateFlags` is tested with `(( flags & 2 ))`, never `== 6`, so an unrelated bit cannot mask the failure.

The log is secondary and only refines a diagnosis that already exists. When the manifest says something is wrong, the newest `logs/content_log.txt` found across the candidate SteamCMD homes is scanned for `Failed to get manifest request code` / `Access Denied`. Candidates are the directory of whichever `steamcmd.sh` resolves on `PATH`, the entrypoint's existing fallback `/home/root/.local/steamcmd`, and `/home/steam/Steam`; newest mtime wins. A missing log is not a failure — the verdict simply stays generic. It never originates a verdict.

## Verdicts

| Verdict | Trigger | Boots? |
|---|---|---|
| `ok` | binary present, `flags & 4`, `buildid == TargetBuildID` | yes |
| `behind` | `buildid != TargetBuildID` | no — halt |
| `update_required` | `flags & 2` | no — halt |
| `manifest_retired` | either of the above, plus the log signature | repair once, else halt |
| `missing` | no binary — today's case, behaviour unchanged | no — halt |
| `unknown` | no manifest yet (first boot) | yes |
| `unverifiable` | manifest present but not readable enough to judge | yes, but not healthy |

A failure where Steam was merely unreachable leaves `buildid == TargetBuildID`: no newer build is known, so nothing is stale. It logs at ERROR and boots. The "halt only when actually behind" rule falls out of the data rather than needing a special case.

`ok` is a positive assertion, never a fallthrough. It requires the binary, bit 4, and two non-empty build ids that agree. Everything left over — a truncated manifest, one Steam never marked fully installed, one with no build ids — is `unverifiable`, which is the one verdict that boots while not being healthy.

That split is deliberate. An unreadable manifest is not evidence the build is behind, so halting on it would turn ambiguity into an outage; but it does mean the ability to detect being behind has been lost, which is exactly the kind of silence this change exists to end. The report's `booted` field already carries that second axis, so the panel can warn without the server going down. Treating this case as `ok` is what made a corrupt manifest boot stale in silence.

## Where the check runs

`game-server/steam-update-check.sh` — standalone, pure bash, no side effects beyond its report, so the tests can run the real script against throwaway directories.

It is injected into `start_server()` by the same `sed` patching the entrypoint already uses for `configure-server.sh`, `fix-heap.sh` and `PZ_BINARY_GUARD`. That position runs after the base image's `update_server`, reading the manifest exactly as SteamCMD left it. `ensure_game_binary.sh` folds into it as the `missing` verdict.

Halting uses `sleep infinity`, matching the existing guard. With `restart: unless-stopped` the container sits up-but-dead rather than crash-looping, which is what makes the panel banner load-bearing.

## Auto-repair

A retired pinned manifest is the one failure no retry fixes — not a cache clear, not a SteamCMD upgrade. Only a clean reinstall of `data/server`.

Stamp: `/home/steam/Zomboid/.update_repair_attempt`, holding the `TargetBuildID` it attempted. It lives outside `BASE_GAME_DIR` so the wipe cannot erase it.

| Stamp state | Action |
|---|---|
| absent, or holds a different target | wipe via existing `clean_incomplete_install`, re-run the retry loop, write stamp |
| holds the current target | a clean reinstall already failed for this build — halt with the real diagnosis |
| any `ok` boot | cleared |

The stamp and the comparison must use the *same* fallback for a missing `TargetBuildID`. `update_required` needs only the `StateFlags` bit, so a manifest with no target build can still reach `manifest_retired`; if the write stores a placeholder that the comparison then refuses to match, the stamp is inert and every restart wipes and re-downloads ~7.2GB forever.

Keying on the build id rather than a boolean means a new Steam build earns a fresh repair attempt instead of being locked out by a stale stamp. `clean_incomplete_install` touches `BASE_GAME_DIR` only; saves live in `/home/steam/Zomboid` and are untouched.

## Report file

`/home/steam/Zomboid/.update_status`, following the existing `.steam_branch` / `.force_update` dotfile convention. Written atomically (temp + `mv`) so the panel never reads a half file, mode 0666 because the game's uid differs from web-api's.

No compose change: web-api already mounts that directory as `/pz-data`.

`booted` records what the check then did: `true` when the server was allowed to start, `false` when it halted. It is what lets the panel tell "stale but running" from "halted, waiting for you" — two states that otherwise look identical from outside. `branch` is the resolved `GAME_VERSION`, so a report always says which branch it is judging.

```json
{"verdict":"behind","installed_build":"24775771","target_build":"24801442",
 "state_flags":6,"branch":"public","last_updated":1787089316,
 "checked_at":1787100000,"booted":false,"auto_repaired":true,
 "diagnosis":"Steam retired the pinned depot manifest; a clean reinstall was attempted and still failed."}
```

## Rust

`pz-bridge/src/steam_update.rs`, alongside the other file-based integrations (`ini.rs`, `lua.rs`, `player_file.rs`). A missing or unparseable file yields `verdict: unknown` with empty fields. It never returns an error, matching the doctrine at the top of `status.rs`: a broken game server is a *state*, not a 500.

### Two detail levels

`health::routes()` is merged at `/api` with no auth layer, so `/api/health/detailed` is **public** in this stack — CLAUDE.md's claim that it needs an API key describes the parked Laravel panel, not this one. `diagnosis` can name filesystem paths and echo SteamCMD errors, so it is admin-only.

| Endpoint | Audience | Carries |
|---|---|---|
| `GET /admin/server/update` | staff | verdict, both build ids, `last_updated`, `auto_repaired`, `diagnosis` |
| `GET /server/status` | public | verdict, build ids |
| `GET /health/detailed` | public | verdict, build ids |

Build ids are public Steam data. The diagnosis string is not.

## UI

| Surface | Change |
|---|---|
| `admin/overview.tsx` | banner whenever `verdict != ok`, off the `adminUpdateStatusQuery` already loaded there |
| update dialog | installed build and last-updated beside the branch selector |
| `landing/status-band.tsx` | one muted line when unhealthy, no diagnosis |
| `i18n/en.json`, `i18n/de.json` | keys for all of the above |

The banner is what disambiguates the halt. The container stays up, so `status.rs` reports `Starting` forever — the banner is the only thing that says why.

This stack is en/de. `ka.json` belongs to the parked Laravel panel.

## Tests

`game-server/tests/steam-update-check.test.sh`, in the style of `configure-server.test.sh`: the real script, synthesized `.acf` fixtures, throwaway directories. Wired into the Makefile test target beside it.

| Case | Expected |
|---|---|
| healthy manifest | `ok`, boots, report written |
| `StateFlags 6` | `update_required`, halt |
| `buildid != TargetBuildID` | `behind`, halt |
| above + log signature | `manifest_retired`, repair requested |
| stamp holds current target | halt, no repair |
| stamp holds older target | repair |
| no manifest | `unknown`, boots |
| every case | report is valid JSON |

Rust: parser unit tests for absent file, garbage, and a valid report.

## Out of scope

`/api/health/detailed` being unauthenticated contradicts CLAUDE.md and is arguably a bug. This design works around it rather than changing it; fixing the auth belongs in its own change.
