# Agent rules

These rules apply to every coding agent working in this repository (Claude, Grok, Cursor, Codex, Copilot, and anything else that reads `AGENTS.md` or `CLAUDE.md`).

## Knox Relay — updating the mod means updating the local server

When the user updates Knox Relay (Lua, `mod.info`, Workshop prep, publish, or "the mod is updated"), the **local dedicated server must be running that same build before you stop**. Packaging, staging, and writing a rule are not a deploy. "The files on disk already say the right version" is not a deploy.

The published Workshop item (3777446787) and the running server must not drift. If Steam shows 1.13 and `game_state.json` shows anything else — or the other way around — the job is not done.

The version is two strings that must match each other **and** the live process:

- `modversion=` in `game-server/mods/KnoxRelay/42/mod.info`
- `KR_Bridge.VERSION` in `game-server/mods/KnoxRelay/42/media/lua/server/KR_Bridge.lua`

`make workshop-package` / `scripts/workshop-package.sh` refuses to run if those two disagree. That check is not a deploy.

PZ loads Workshop item **3777446787** from the Steam cache inside the game container, not from git. A restart runs SteamCMD and can replace a newer local copy with whatever Steam last published. The image seed (`COPY` to `/opt/knox-relay`, then `configure-server.sh` into the cache) is how the local server gets a build that is not yet on Steam — or how it keeps a just-published build if SteamCMD is stale. That seed only exists if you **rebuild the game-server image**. `docker compose restart` / `make restart` does not rebuild the image.

**Same-turn deploy, every time the mod changes:**

1. If this is a Workshop prep: package, then sync **`Contents/` only** into `~/Zomboid/Workshop/KnoxRelay/Contents/`. Never overwrite the upload folder's `workshop.txt` (`id=3777446787`).
2. Rebuild the game-server image and **recreate** the container:
   `docker compose -f docker-compose.yml -f docker-compose.amd64.yml up -d --build --force-recreate game-server`
   (ARM64: `docker-compose.arm64.yml`.)
3. Wait until PZ is up. Confirm the **running** server, not just the tree:
   - Boot: `[KnoxRelay] Initializing server-side bridge mod vX.Y`
   - Boot: `Seeded Knox Relay X.Y` or `Keeping installed Knox Relay X.Y` — same X.Y
   - `data/zomboid/Lua/game_state.json` → `"mod_version":"X.Y"`
   - After a Steam publish: Steam change notes and the server report that same X.Y

Do not leave "restart the server later" for the user. Do not call the work done while Workshop and the local server disagree.

Full publish flow: `docs/workshop-updates.md`.
