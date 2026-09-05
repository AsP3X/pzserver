# Agent rules

These rules apply to every coding agent working in this repository (Claude, Grok, Cursor, Codex, Copilot, and anything else that reads `AGENTS.md` or `CLAUDE.md`).

## The UI panel is the single point of truth

The admin web panel is the source of truth for how this server is configured. `.env`, SteamCMD, a stock `server.ini`, and a Workshop download are bootstraps or caches — never the authority once the panel has written a value.

What the panel last saved wins:

- Mods and Workshop items: `data/zomboid/Server/.mod_state` (the panel writes this). `PZ_MOD_IDS` / `PZ_WORKSHOP_IDS` seed only a first boot that has no `.mod_state` yet.
- Server settings the panel edits: `data/zomboid/Server/.config_state`.
- Site copy, shop, translations, automations, vault settings: the panel’s Postgres rows.

Do not “fix” a missing Knox Relay, a mod list, or a setting by writing `.env` defaults over those files. Do not delete `.mod_state`, `.config_state`, `server.ini`, sandbox, or spawn files on a world wipe. After a wipe or a restore, re-apply the panel’s saved state — do not generate a stock ini and hope Steam or compose env fills it in. `configure-server.sh` already treats `.mod_state` / `.config_state` as authoritative; keep it that way.

## Knox Relay — server and client always get the latest Lua

When the user updates Knox Relay (Lua, `mod.info`, Workshop prep, publish, or "the mod is updated"), **both** the local dedicated server **and** the Project Zomboid client must be running that same Lua before you stop. A “no” to a Workshop release does **not** skip or delay this. Packaging, staging, writing a rule, and “the version string did not move” are not a deploy.

### Server — every Lua change

PZ loads Workshop item **3777446787** from the Steam cache inside the game container, not from git. A restart runs SteamCMD and can replace a newer local copy with whatever Steam last published. The image seed (`COPY` to `/opt/knox-relay`, then `configure-server.sh` into the cache) is how the local server gets a build that is not yet on Steam — or how it keeps a just-published build if SteamCMD is stale. That seed only exists if you **rebuild the game-server image**. `docker compose restart` / `make restart` does not rebuild the image.

1. Rebuild the game-server image and **recreate** the container:
   `docker compose -f docker-compose.yml -f docker-compose.amd64.yml up -d --build --force-recreate game-server`
   (ARM64: `docker-compose.arm64.yml`.)
2. Wait until PZ is up. Confirm the **running** server, not just the tree:
   - Boot: `[KnoxRelay] Initializing server-side bridge mod vX.Y`
   - Boot: `Seeded Knox Relay …` or `Keeping installed Knox Relay …` — the seeded **tree** is the Lua you just shipped
   - `data/zomboid/Lua/game_state.json` → `"mod_version":"X.Y"` matching the two version strings currently in source

Do not leave “restart the server later” for the user.

### Client — every Lua change

The Desk and other client Lua run on the **game client**, not in the container. The client loads item **3777446787** from the Steam workshop cache, not from git and not from the upload folder:

`%ProgramFiles(x86)%\Steam\steamapps\workshop\content\108600\3777446787\mods\KnoxRelay`

Copy the current source tree into that cache (root + `42/` + `common/`, same files the image seed uses). Then the user must **fully quit** Project Zomboid and relaunch — disconnect/reconnect keeps the old client Lua. Confirm the cache `42/mod.info` and `common/mod.info` are the tree you just shipped.

Steam can overwrite this cache with the last **published** Workshop build. Re-seed it after every change until that build is on Steam.

### Version numbers are release numbers only

Do **not** bump the version unless the user has explicitly answered **yes** to a Workshop release question (below). Local-only fixes keep the last released version string. Do not invent 1.22 because you edited a file.

Not bumping the version is **not** permission to leave server or client on old Lua. Deploy both anyway.

The version is four strings that must match each other (and the live `mod_version` after deploy):

- `modversion=` in `game-server/mods/KnoxRelay/42/mod.info`
- `modversion=` in `game-server/mods/KnoxRelay/common/mod.info`
- `modversion=` in `game-server/mods/KnoxRelay/mod.info`
- `KR_Bridge.VERSION` in `game-server/mods/KnoxRelay/42/media/lua/server/KR_Bridge.lua`

`make workshop-package` / `scripts/workshop-package.sh` and `game-server/tests/knox-manifest.test.sh` refuse if they disagree. That check is not a deploy. Do not run the packager just to “keep staging in sync” after a no.

### Knox Relay Version is never blank; other mods may be

PZ’s in-game Mods **Version** row (`ChooseGameInfo.getModVersion`) and the admin Mods Version column only show `modversion=` from the file PZ actually reads: `{mod}/<versionDir>/mod.info` (for us `42/`) then `{mod}/common/mod.info`. A Steam install date is not a version. Mods that never wrote `modversion=` stay blank (`—` on the panel). Do not invent a number for them, and do not fill the column from `timeupdated`.

Knox Relay must always have a version. Keep the four strings above in lockstep. Seed the **whole** tree (root + `42/` + `common/`), not only `42/`. After deploy, all of these report the same X.Y:

- Boot: `[KnoxRelay] Initializing server-side bridge mod vX.Y`
- `data/zomboid/Lua/game_state.json` → `"mod_version":"X.Y"`
- Admin Mods row for KnoxRelay
- In-game Mods detail panel Version row when Knox Relay is selected

The panel reads Knox’s cached `mod.info` first, then live `game_state.json` `mod_version` if the cache read misses. It still never falls back to a calendar date.

### Always ask before a Workshop release

After any sitting that changed Knox Relay, **after** server and client are on the new Lua, ask with the **question dialog** (`AskQuestion` / the TUI question UI) — not a sentence at the end of a reply, not a yes/no buried in prose:

**“Prepare the next Knox Relay Workshop release?”**

- **Yes** — then bump both version strings, write the changenote, package, sync `Contents/` only, and deploy server **and** client on that new version.
- **No** — leave `modversion=` and `KR_Bridge.VERSION` unchanged. Do not package, do not touch `~/Zomboid/Workshop/KnoxRelay/` (the upload folder), do not write a changenote. Server and client still already have the new Lua from the steps above.

Never bump first and ask later. Never treat “the UI is done” as permission to cut a release.

### Workshop prep (only after Yes)

1. Bump both version strings together. Write `"changenote"` in `workshop/workshop_upload.vdf`.
2. `make workshop-package`, then sync **`Contents/` only** into `~/Zomboid/Workshop/KnoxRelay/Contents/`. Never overwrite the upload folder's `workshop.txt` (`id=3777446787`).
3. Deploy server and client on that new version (same recreate + client cache seed + confirm as above).
4. After the user publishes on Steam: Steam change notes, the server, and the client must report that same X.Y. If Steam shows 1.13 and `game_state.json` shows anything else — or the other way around — the job is not done.

Full publish flow: `docs/workshop-updates.md`.

## Rust: never silence unused code

`#[allow(dead_code)]` (and `cfg_attr(..., allow(dead_code))`) is forbidden. The workspace `deny`s `dead_code`. `scripts/check-no-dead-code-allow.sh` / `make web-check` greps for the attribute so it cannot be used to silence that deny.

If rustc says an item is unused: delete it, or wire it into a real path. Do not add an allow, an `expect`, or a dummy read. Reserved constants belong on an allowlist that production code consults (see `WALLET_SOURCES`), not behind a lint exception.
