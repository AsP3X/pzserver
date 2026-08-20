# Where we left off

Running list of open work, grouped under the main task it belongs to. Newest
main task first. Update the date when you touch it.

**Last updated:** 2026-08-20

## Orientation

| Branch | Contains | Remote |
|---|---|---|
| `main` | — | in sync |
| `rust-web-stack` | shipped work, plus the tile spec and plan | in sync at `b5de35f` |
| `map-tiles-local` | tile render work in progress, branched from `b5de35f` | in sync at `4b755fe` |

Windows host has no `make`; use `.\make.ps1 <target>`. All compose commands take
the same three files:

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml
```

---

## 1. Local isometric map tiles — IN PROGRESS

Render the basemap from the server's own game files instead of pulling every
tile from `tiles.pzmap.org`, pack it into one SQLite file, serve it from our own
API. After this the map works with no internet at all.

- **Spec:** `docs/superpowers/specs/2026-08-20-local-map-tiles-design.md`
- **Plan:** `docs/superpowers/plans/2026-08-20-local-map-tiles.md` — 8 tasks,
  each with full code and exact commands
- **Branch:** `map-tiles-local`
- **Shape:** levels 8–20, ~27,000 tiles, ~15 GB, no CDN fallback at all

### Done

- [x] **Task 1 — render container and geometry gate** (`9faae33`, `421a25e`)
      Image builds, config written, gate passes on a real render and rejects a
      shifted `x0`, a halved `sqr`, a missing cell rect and a half-height map.

### Open

- [ ] **Task 2 — pack the DZI tree into `tiles.sqlite`**
      `web/tools/map-tiles/pack.py`. Deletes each tile as it stores it, so peak
      disk stays near 15 GB instead of 30. Resumable. Plan has the full code and
      two pytest cases.
- [ ] **Task 3 — compose service and make targets**
      `map-tiles` service behind a `tools` profile so it never starts with the
      stack, `run.sh`, `map-tiles` target in `Makefile` and `make.ps1`, and a
      read-only `data/map-tiles` mount on `web-api`.
- [ ] **Task 4 — Rust store module**
      `web/api/crates/pz-api/src/services/map_tiles.rs`. `rusqlite` is already a
      workspace dep via `pz-bridge`. Four tests in the plan.
- [ ] **Task 5 — API routes**
      `GET /api/v1/map-tiles/{z}/{x}_{y}.jpg` and `/map-tiles/meta`. Miss is a
      404, never a fallback to the CDN.
- [ ] **Task 6 — point the client at it**
      `ISO_TILE_URL` goes relative, `ISO_TILE_HOST` is deleted, and CSP drops
      `tiles.pzmap.org` so `img-src` becomes `'self' data:`.
- [ ] **Task 7 — clamp zoom to what was rendered**
      Without it every deep zoom fires 404s for levels that cannot exist, and
      an ungenerated store says "not answering" instead of "not generated yet".
- [ ] **Task 8 — the real render** *(hours, and yours)*
      `.\make.ps1 map-tiles`. Needs ~25 GB free. Safe to interrupt; re-running
      resumes. Ends with a signed-in check that pins sit on the right buildings
      — the thing the whole geometry gate exists to protect.

### Decision waiting on you

- [ ] **Subagents or inline for Tasks 2–7.** You picked subagent-driven, which
      is ~3 dispatches per task (implementer, spec review, quality review). One
      agent was already lost to the monthly spend limit. Inline is much cheaper
      but the only review is mine.

### Things already learned the hard way — do not rediscover

All are written up in the plan's "What Task 1 established" section:

- `MSYS_NO_PATHCONV=1` is required on any hand-run `docker run` from Git Bash,
  or the bind mount silently does not happen and it looks like the game files
  are missing.
- `conf.yaml` must overwrite pzmap2dzi's own `conf/conf.yaml`. It resolves map
  descriptions relative to the config file's directory.
- `omit_levels` does **not** corrupt geometry. It divides `w`/`h`, leaves
  `x0`/`y0`/`sqr` alone, and records the reduction as `skip`. Client tile
  indices line up unchanged.
- `render_cell_range` does **not** make a test render cheap — the pyramid still
  walks every level. Gate on `map_info.json`, which lands ~10s in.
- Output is `/out/html/map_data/base/…`. There is no `default` path segment.

---

## 2. Map documentation still describes deleted features

Written before the Laravel app was removed in `36e213d`, and never updated.
Anyone following these chases commands and settings that do not exist.

- [ ] `docs/map-tiles.md`
- [ ] `docs/map-vector.md`
- [ ] `docs/commands.md`
- [ ] `docs/troubleshooting.md`
- [ ] `README.md` (map sections)

What is wrong in them:

- `PZ_MAP_BASEMAP` — grepped across the whole Rust stack, zero hits.
- `zomboid:generate-map-tiles`, `tiles.sqlite` serving, pzmap2dzi in the app
  image — all Laravel-era, all gone.
- Every one of them still names `map.projectzomboid.com`, which The Indie Stone
  took down on 7 Aug 2026.

Best done **after** task 1 lands, so the docs can describe the real
`make map-tiles` flow in one pass rather than being rewritten twice.

---

## 3. Fold the branches back together

- [ ] Merge `map-tiles-local` into `rust-web-stack` once tiles are working.
- [ ] Decide whether `rust-web-stack` merges to `main`, and when. It has been
      the working branch for the whole Rust migration and `main` is well behind.

---

## Recently closed — no action needed

Kept briefly so nobody re-opens them.

- **Isometric basemap repointed** to `tiles.pzmap.org` after the old host went
  away, with automatic fallback to the schematic if tiles stop arriving
  (`4acc32f`). Live locally and on `pz.corespace.de`.
- **Security headers actually reach the browser.** They were being silently
  dropped on every HTML and asset response by nginx's `add_header` inheritance
  rule. Fixing it turned CSP on for the first time, which immediately blocked
  Vite's inlined `data:` fonts — also fixed. Verified live on both.
- **Sidebar double-highlight** on Player map, caused by prefix matching on
  nested routes, now resolved by longest match (`ce65e57`). Live on both.
- **`pz-game-server`** finished its SteamCMD verification and is healthy.
