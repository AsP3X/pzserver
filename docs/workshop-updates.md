# Publishing a Knox Relay update to the Steam Workshop

Knox Relay is published as Workshop item **3777446787**. Production servers load
it from the Workshop (`PZ_WORKSHOP_IDS` / `PZ_BRIDGE_WORKSHOP_ID` in `.env`), not
from the copy in this repo — so a Lua change is not deployed until the running
server is on that same version.

**When to use this doc:** only after the user answers **yes** to the question
dialog “Prepare the next Knox Relay Workshop release?” Do not bump the version,
package, or sync the upload folder on a no.

Saying no does **not** skip putting the new Lua on the dedicated server **and**
the PZ client. That still happens in the same sitting — see `AGENTS.md`.

**Version lock (after a yes):** bump `modversion=` and `KR_Bridge.VERSION`
together, then put the local dedicated server on that same build before you
stop. After Steam publish, the Workshop item and `game_state.json`
`mod_version` must agree. Packaging without recreating `game-server` is
unfinished work.

## The four copies of the mod

Knowing which copy you are looking at prevents most of the confusion here.

| Copy | Path | Role |
|------|------|------|
| **Source** | `game-server/mods/KnoxRelay/42/` | The only copy you edit. Tracked in git. |
| **Staging** | `workshop/KnoxRelay/` | Upload-shaped tree, rebuilt by `make workshop-package`. Tracked in git. |
| **Upload folder** | `~/Zomboid/Workshop/KnoxRelay/` | What the in-game uploader reads. **Not** in git, and it holds settings the staging copy does not. |
| **Live server** | Steam Workshop cache inside the game container (seeded from `/opt/knox-relay` in the image) | What PZ actually executes. Must match source. |

## Update flow

### 1. Check the Lua before it leaves the machine

Project Zomboid runs Lua 5.1, so `luajit` is the right syntax checker (Homebrew's
`lua` is 5.4 and rejects 5.1-only constructs such as the `%z` pattern class):

```bash
for f in game-server/mods/KnoxRelay/42/media/lua/{server,client}/*.lua; do luajit -bl "$f" >/dev/null || echo "SYNTAX FAIL $f"; done
```

A syntax error that reaches the Workshop takes the bridge down for every server
running the mod, and the fix has to go through this whole flow again.

### 2. Bump the version and write a changenote

Only do this step after a **yes**. The version lives in two places and
`make workshop-package` refuses to run if they disagree:

- `modversion=` in `game-server/mods/KnoxRelay/42/mod.info` — metadata
- `KR_Bridge.VERSION` in `KR_Bridge.lua` — what a running server reports in
  `game_state.json`, so the panel can tell which bridge features it has

The changenote is optional, but it is the only record players and future-you
get: `"changenote"` in `workshop/workshop_upload.vdf`.

### 3. Re-package

```bash
make workshop-package
```

Copies the source tree into `workshop/KnoxRelay/Contents/mods/KnoxRelay/`, placing
`mod.info` and `poster.png` at both the `42/` level and the mod root (the
dedicated server discovers mods by scanning for a root-level `mod.info`), and
strips `.DS_Store` files, which PZ rejects on submit.

### 4. Sync into the upload folder — `Contents/` only

```bash
rsync -a --delete workshop/KnoxRelay/Contents/ ~/Zomboid/Workshop/KnoxRelay/Contents/
```

> **Do not copy `workshop.txt` over.** The two copies have diverged on purpose.
> The upload folder's version carries `id=3777446787` and `tags=Build 42;Multiplayer`;
> the staging copy has neither. That `id=` line is what tells the in-game uploader
> to **update** the existing item. Overwrite it and the next upload publishes a
> **second, duplicate Workshop item** instead.

`preview.png` and `workshop.txt` only need re-copying when you deliberately change
the store page — and then you must re-add the `id=` line afterwards.

### 5. Publish

**In-game uploader (how this item was first published).** Launch Project Zomboid,
main menu → Workshop. Knox Relay is listed because `~/Zomboid/Workshop/KnoxRelay/`
exists; selecting it updates item 3777446787 in place.

**SteamCMD alternative**, using the already-wired publishedfileid in
`workshop/workshop_upload.vdf`:

```bash
steamcmd +login <account> +workshop_build_item /absolute/path/to/pzserver/workshop/workshop_upload.vdf +quit
```

Two things to know before choosing this route:

- The vdf's `description` is a single flat line. Uploading with it **replaces the
  formatted Workshop page description** — the `[h1]`/`[list]` version lives only in
  `workshop.txt`, which SteamCMD does not read.
- `contentfolder` and `previewfile` are relative paths, so run steamcmd from
  `workshop/` or make them absolute first.

### 6. Deploy to the server (required, same version)

A restart alone is not enough. SteamCMD downloads the **last published** Workshop
build into the cache. If that build is older than the source you just packaged,
the server silently downgrades unless the **game-server image** still stages a
newer `/opt/knox-relay` and `configure-server.sh` seeds it.

Rebuild the image (so the seed is the new version) and recreate the container:

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml build game-server
docker compose -f docker-compose.yml -f docker-compose.amd64.yml up -d game-server
```

On ARM64 use `docker-compose.arm64.yml`. `make restart` does not rebuild the image.

Then confirm the live version, not just the files on disk:

- Boot log: `[configure-server] Seeded Knox Relay X.Y` or `Keeping installed Knox Relay X.Y`
- Boot log: `[KnoxRelay] Initializing server-side bridge mod vX.Y`
- `data/zomboid/Lua/game_state.json` → `"mod_version":"X.Y"`

> Until 2026-08-13 this only ran for IDs whose directory was **missing**, so an
> already-downloaded mod was pinned to whatever version arrived first and a
> published update never reached the server. Knox Relay masked it — the image
> also stages a copy and overwrites a stale one, which is what
> `Seeded Knox Relay … from the image` means in the boot log — but no other mod
> got that rescue. Set `PZ_SKIP_WORKSHOP_SYNC=true` to trade freshness back for
> a faster boot.

Two things lag behind the restart:

- Per-player inventory snapshots on disk keep their old values until each player's
  next export, which happens on the mod's normal tick.
- Clients need `DoLuaChecksum=false` (already set by `configure-server.sh`) to
  connect while their cached Lua differs from the server's.

## Checklist

```
[ ] user answered yes to “Prepare the next Knox Relay Workshop release?”
[ ] luajit syntax check passes
[ ] modversion bumped in both mod.info and KR_Bridge.VERSION, changenote written
[ ] make workshop-package
[ ] rsync Contents/ only — workshop.txt left alone
[ ] published (in-game uploader or steamcmd)
[ ] game-server image rebuilt and container recreated (not just restarted)
[ ] live server confirmed: boot log + game_state.json mod_version match the bump
[ ] staging changes committed
```

## Verifying the PZ API before you ship Lua

Guessing a Java method name is how `KR_Stash.wear()` shipped a call to
`getMaxCondition()` — which does not exist, so the guard around it failed for
every item and the dashboard reported all durability as a flat 100%. The real
method is `getConditionMax()`.

The installed game jar answers these questions directly. Use the system `javap`;
the JRE bundled with the game does not ship one:

```bash
javap -classpath "$PZ/projectzomboid.jar" zombie.inventory.InventoryItem | grep -i condition
```

where `$PZ` is `<Steam>/steamapps/common/ProjectZomboid/Project Zomboid.app/Contents/Java`
on macOS. The game's own Lua is unpacked beside it at `$PZ/media/lua/`; grepping
it shows how vanilla uses an API — for example `ISInventoryPane.lua` draws a
condition bar only for `HandWeapon`, and shows "Remaining" via
`getCurrentUsesFloat()` for `Drainable`.

See also: [LUA_BRIDGE.md](LUA_BRIDGE.md) for how the mod talks to the panel.
