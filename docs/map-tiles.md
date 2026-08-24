# Map tiles (3D isometric basemap)

The admin **Player map** (`/admin/players/map`) plots player markers on a
basemap, and offers two of them. This document covers the **3D isometric** one:
game-like tiles rendered from the dedicated server's own game files, packed into
a single SQLite file, and served by this stack's own API.

Nothing leaves the origin. After a render the map works with no internet
connection at all.

For the default schematic basemap, see **[map-vector.md](map-vector.md)**.

## Map view: Vector vs 3D isometric

Admin → Player map → the **Vector (2D) / 3D isometric** switch above the map
(stored in browser `localStorage` as `pz-map-view-mode`):

| Mode | What you see | Needs |
|------|--------------|-------|
| **Vector (2D)** | Schematic worldmap (default) | Nothing — a static JSON pack ships with the UI |
| **3D isometric** | Game-like isometric tiles | A local render (below) |

There is **no CDN fallback**. The isometric tiles previously came from
`map.projectzomboid.com` and then the community `tiles.pzmap.org`; both are gone
from this stack. A server that has not rendered its tiles shows the vector
basemap and says so, rather than putting its traffic on a host someone else pays
for.

## Before you can render: texture packs

**The dedicated server install is not enough on its own.** It ships
`media/maps` — the cells — but not `media/texturepacks`, because a server never
draws anything. pzmap2dzi does, and without those packs it renders every tile
untextured and finishes with a blank map.

The geometry gate cannot save you here: `verify.py` reads `map_info.json`, which
is geometry, not pixels, so it passes happily on a blank render. `run.sh`
therefore checks for the packs itself and refuses to start without them:

```
FAIL: no texture packs at /pz/media/texturepacks
```

The packs are ~527 MB and ship with the PZ **client**, at
`<Steam>/steamapps/common/ProjectZomboid/media/texturepacks`. Pick one:

| Situation | What to do |
|---|---|
| The render host has a PZ client | Point `PZ_TEXTUREPACKS_HOST` at that folder |
| Headless server, no client | Copy the folder once into `data/server/media/texturepacks` — the default path, no override needed |
| Neither | Render on a machine that has the client and copy the finished `tiles.sqlite` over. It is one file; that is much of why it is packed that way |

```bash
# Windows dev box, in .env
PZ_TEXTUREPACKS_HOST=C:/Program Files (x86)/Steam/steamapps/common/ProjectZomboid/media/texturepacks
```

A correct run says so before it starts:

```
==> textures: 24 packs found
```

## Generating the tiles

```bash
make map-tiles
```

```powershell
.\make.ps1 map-tiles
```

That builds the render image and runs it once. Both wrap a build and a
`--profile tools run --rm map-tiles`. The service lives in
`docker-compose.web.yml` behind the `tools` profile, so a normal `make up` never
starts it. The packed `tiles.sqlite` is written to the `pz-map-tiles-sqlite`
volume, not `./data/map-tiles`. To move an existing host pack onto the volume:

```bash
make map-tiles-import
```

```powershell
.\make.ps1 map-tiles-import
```

Do that with `web-api` down, or against an empty volume. Overwriting a pack
the API already has open is the Windows filename-reservation trap. A 14–24 GB
copy takes a while; the command rewrites one progress line (percent, rate, ETA)
while it runs, or prints occasional lines if stdout is not a terminal.

### Regional / tile jobs

After a full pack exists, re-render a region without rebuilding the whole
pyramid:

```
make map-tiles-region SQUARES="8704,7680,256,256"
make map-tiles-region CELLS="34,30,4,4"
make map-tiles-detail CELLS="34,30"          # z21 only; leaves z20 in place
POST /api/v1/admin/map-tiles/rerender  {"cells":[[34,30,4,4]]}
GET  /api/v1/admin/map-tiles/jobs/{id}
```

A full county of z21 is ~60–80 GB, so it is never part of `make map-tiles`.
Regional jobs (and the admin rerender endpoint) write z21 for just those cells.
Until a cell has z21, the client asks for it, gets 404, and upscales z20.

### World changes (player builds, fire, smashed tiles)

The county pack is vanilla map files. Player construction and environment
damage live in the dedicated-server save
(`Saves/Multiplayer/<name>/map/{x}/{y}.bin` on B42).

A **world-change job** is the same regional job, plus a save overlay:

1. Snapshot the dirty cells' chunks (the live files stay with PZ).
2. Paint vanilla `base` for those cells, then `render save`.
3. Composite the save PNGs onto the base JPEGs for dirty keys only.
4. WAL-replace those rows in `tiles.sqlite`.

The API scans 8-square block mtimes every `MAP_TILES_WORLD_SCAN_SECS`
(default 120). The first pass seeds `map_tile_blocks` and does not enqueue.
Later passes collect dirty blocks (a door or a window sheet is one block)
and enqueue them as small square rects once either:

- at least `batch_blocks` (default 8) dirty spots have piled up, or
- `max_wait_secs` (default 300) has passed since the first pending spot.

Staff toggle this on the player map under **World changes**. Off means the
isometric pack stays as last painted. Each door, curtain or sheet action
counts as one, even when they share an 8-square block — ten blinds in one
room still reach the batch. Oldest dirty blocks go first so a quiet door is
not starved by a busy cell. One job at a time; a running job skips the tick.
Set the scan interval to `0` to disable the scanner itself.

**Debug overlay** (same panel) draws the running count above the player in
game on each counted action, and `PAINT` when a job actually starts.

`make map-tiles-region` does the same overlay when `/saves` is mounted.
`make map-tiles-detail` does not — that is a vanilla z21 fill.

While a job is `queued` or `running`, `GET /api/v1/map-tiles/meta` includes
those cells as `updating` (rects, `stage`, `percent`). The player map paints a
yellow-and-black construction border and a speech bubble with live progress.
The renderer writes `/pack/job_progress.json` as it goes; the bubble drops
when the job finishes (`generated_at` moves, tile URLs cache-bust).

The scanner only starts a container when `PZ_DATA_HOST` (and the other
renderer binds) are **absolute** host paths. Relative `./data/zomboid` is
fine for `make map-tiles-region`; the API spawn cannot use it.

#### Do

1. **Speak squares (or cells as a helper).** Public contract is a game-world
   rectangle in squares — the same coords as pins. A cell is
   `x*256, y*256, 256, 256`. Both become DZI tiles internally.
2. **Expand to whole tiles before rendering.** `render_cell_range` paints only
   the cells it is handed. A tile that straddles the edge comes back
   part-drawn and part-black. `expand_to_whole_tiles` is mandatory. Measured:
   tile `20/134_59` went from 12.5% black to 62.4% when this was skipped.
3. **Dirty every packed ancestor.** A level-20 change without rebuilding
   19…0 leaves zoom-out stale or black. Dirty set is the covering tiles at
   max packed level plus every parent down to 0.
4. **Restore merge siblings, never dirty tiles.** Parents merge four children
   from disk. Missing siblings → three-quarters black. Dirty tiles must stay
   *absent* so pzmap2dzi does not skip them.
5. **Pack only dirty keys.** `--replace --only dirty.txt`. Restored siblings
   are already correct; rewriting them is wasted I/O and can unlink files the
   next merge still needs if a run is interrupted.
6. **Update the live pack in place.** WAL, then `wal_checkpoint(TRUNCATE)`.
   web-api stays up. Bump `generated_at` so `?v=` cache-busts.
7. **Keep the map-tiles volume writable for web-api.** WAL readers write a
   slot in the `-shm` file. A `:ro` mount breaks in-place updates. The API
   still opens the database `SQLITE_OPEN_READ_ONLY`; only the directory needs
   write.
8. **One job at a time.** The container name is `pz-map-tiles`. A second CLI
   or API run while it exists is a conflict, not a queue.
9. **Fail before paint** when there is no pack, no `map_info.json`, no
   texture packs, a geometry mismatch, or a cache peak within 5% of the limit.
10. **Leave an interrupted region re-runnable.** `.pending` is deleted with
    its half-drawn `.jpg`. Mid-pack kills leave a mix of old and new dirty
    rows; the same job planned again overwrites them.

#### Do not

1. **Do not stop `web-api` for a region.** That takes the whole site down
   (nginx resolves `web-api` at start and crash-loops). The old “stop because
   Windows locks the filename” rule applied to *renaming* the pack, which we
   no longer do.
2. **Do not rename `tiles.sqlite` while it is open.** That is the Windows
   filename reservation trap. In-place UPDATE only.
3. **Do not VACUUM a region.** VACUUM rebuilds the 24 GB file beside itself.
   It is for a full first pack only.
4. **Do not restore dirty tiles.** pzmap2dzi treats an existing `.jpg` as
   done. Restoring the hole makes the run a no-op.
5. **Do not pack restored siblings.** They are merge inputs, not outputs.
6. **Do not change `dzi_cell_range` on a region.** Pyramid geometry and every
   client tile index are fixed by the first full render. `verify.py` still
   gates on `ISO_DZI`.
7. **Do not treat a region as a first render.** No pack / no `map_info.json`
   → exit 1 / job `failed`. Run `make map-tiles` first.
8. **Do not evict skip-level children whose parent is still pending.**
   `omit_levels: 2` plus LRU eviction paints black quadrants. The image-build
   pin (`patch_scheduler.py`) stays; `check_cache.py` still fails a run that
   grazes the ceiling.
9. **Do not wait on HTTP for the render.** A region takes minutes. `POST`
   returns `202` + job id.
10. **Do not invent a second render path for world changes.** Chunk mtimes
    emit cells into this same job. Save overlay is composited onto dirty
    keys, not a second pack.

### What it costs

| Fact | Value |
|---|---|
| Levels rendered (full run) | 0–20 |
| Tiles | ~22,000 |
| Result on disk | ~24 GB at JPEG quality 85; ~14–18 GB after a quality-70 recompress |
| Free space needed | **~25 GB**, for the loose tree ahead of the packer |
| Runtime | Hours |
| Level 21 (close-up) | Filled region by region, not in the full run. ~100 MB per cell. A full county of z21 is ~60–80 GB. |

Depth is the whole cost. A full county of levels 21 and 22 would be ~80 GB and
~200 GB. `omit_levels: 2` on `make map-tiles` drops them. Street-level
(`DEFAULT_ISO_SCALE`) is still native z20. Zooming closer requests z21; missing
tiles 404 and the client upscales from z20 until a regional job writes them:

```
make map-tiles-detail CELLS="34,30"
make map-tiles-region CELLS="34,30,4,4"   # also writes z21 for those cells
```

JPEG quality 85 is why the current pack is 24 GB (20 GB of that is z20). New
tiles save at 70. To shrink the existing pack without re-rendering:

```
make map-tiles-recompress
```

That rewrites blobs in place (WAL) and does **not** VACUUM — free pages stay
in the file for later z21 rows. VACUUM would copy the whole 24 GB beside itself.

Check there is room first:

```bash
df -h .
```

### It is safe to interrupt

Ctrl-C and re-run. `pzmap2dzi` is incremental and skips tiles it has already
painted, and the packer skips `(z, x, y)` rows already in the database. A reboot
mid-render costs nothing but the time already spent.

### What the run does

`web/tools/map-tiles/run.sh`, in order:

0. **texture check** — refuses to start if `media/texturepacks` is empty (above)
1. **deploy** / **unpack** — pzmap2dzi's own preparation steps
2. **render base** — paints the loose DZI pyramid into
   `/out/html/map_data/base/layer0_files/{z}/{x}_{y}.jpg` (hours)
3. **verify** — `verify.py` checks the geometry, and **stops here on a
   mismatch** (see below)
4. **pack** — `pack.py` folds every tile into `/pack/tiles.sqlite` (the named
   volume the API reads), deleting each
   file as it stores it

Step 4 deletes as it walks deliberately. Holding the whole loose tree and the
finished database at once costs roughly double the final size; unlinking each
tile once it is safely stored keeps the peak near 15 GB rather than 30.

### The geometry gate

The client hardcodes the pyramid's bounds in `web/ui/src/lib/iso-tiles.ts`:

```ts
export const ISO_DZI = {
  width: 2_318_656, height: 1_019_040,
  x0: 1_040_384, y0: -139_296,
  sqr: 128, tileSize: 2048, maxLevel: 22, minLevel: 8,
} as const
```

`worldToDzi()` places every pin using `x0`/`y0`/`sqr`. If a render produces
different bounds, **every pin lands in the wrong place while the tiles still
look plausible** — the worst kind of failure, because it looks like it works.

`verify.py` reads `map_info.json` and refuses to let the run reach the packer
unless the geometry matches. It is not optional, and it is cheap: `map_info.json`
is written about ten seconds into a render, long before any tile is painted.

If it ever fails, the fix is a corrected `dzi_cell_range` in `conf.yaml` and a
re-render — **not** editing `ISO_DZI` to match. The client's coordinate maths is
the contract.

## After a render

A pack updates `tiles.sqlite` in place (WAL, then `wal_checkpoint(TRUNCATE)`).
web-api stays up; it does not need a restart. Tile reads go to the live file,
`GET /map-tiles/meta` re-reads `generated_at`, and the client cache-busts JPEG
URLs with `?v=generated_at` (falling back to `game_version`).

```bash
curl -s http://127.0.0.1:8100/api/v1/map-tiles/meta
```

```json
{"generated":true,"min_level":8,"max_level":20,"game_version":"42.20.0","generated_at":"2026-08-22T00:00:00Z"}
```

Before any render the same endpoint answers
`{"generated":false,"min_level":null,"max_level":null,"game_version":null,"generated_at":null}`
and every tile is a `404`. That is the correct state, not a failure — the UI
reads it and tells staff the tiles have not been generated yet.

## On-disk layout

Two mounts, on purpose:

| Mount | Where | Holds |
|---|---|---|
| Host bind `./data/map-tiles/` → `/out` | Renderer only | Scratch: html tree, texture cache |
| Named volume `pz-map-tiles-sqlite` → `/pack` (renderer) and `/map-tiles` (API) | Both | Live `tiles.sqlite` |

The pack is a 24 GB random-read SQLite file. On Windows a bind of that file
through Docker Desktop's 9p is ~600 ms TTFB per JPEG; the named volume sits on
the VM's own ext4 and the same read is tens of milliseconds. Linux servers can
bind-mount natively and would not need the volume, but sharing one layout keeps
region jobs and the API on the same file everywhere.

The API still opens the database `SQLITE_OPEN_READ_ONLY`. The directory is
writable because WAL readers write a slot in the `-shm` file.

```
volume pz-map-tiles-sqlite/
└── tiles.sqlite              # the whole basemap, one file
```

During generation only, then deleted as it packs:

```
data/map-tiles/html/map_data/base/
├── layer0.dzi
├── map_info.json             # geometry, checked by verify.py
└── layer0_files/{z}/{x}_{y}.jpg
```

### Why one file instead of the pyramid

`pzmap2dzi` writes a Deep Zoom pyramid: one small JPEG per tile under nested
zoom folders. That layout is painful for operators:

| Operation | Multi-file pyramid | Single pack |
|-----------|--------------------|-------------|
| Delete / regenerate | Minutes–hours (inode thrash) | Unlink one file |
| Host backup / rsync / tar | Extremely slow | One large file |
| Disk checks / antivirus | Pathological | Normal |

### Schema

```sql
CREATE TABLE tiles (
  z INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (z, x, y)
) WITHOUT ROWID;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

`WITHOUT ROWID` because the primary key is the only lookup a tile read ever
does, and a second index would be dead weight across 27,000 rows of blob.

Grid positions with no tile have **no row**. pzmap2dzi emits nothing for empty
regions — about 53% of level-22 grid positions never existed at all — so absence
is the answer, not a sentinel.

`meta` holds `game_version`, `min_level`, `max_level`, `tile_size`, `width`,
`height`, `generated_at`, `tile_count`.

## Serving

| Route | Answers |
|---|---|
| `GET /api/v1/map-tiles/meta` | The `meta` table, as JSON |
| `GET /api/v1/map-tiles/{z}/{x}_{y}.jpg` | `200 image/jpeg`, `Cache-Control: public, max-age=604800` |

A missing row, a missing `tiles.sqlite`, or a tile name that does not parse all
answer `404` with an empty body. Both routes are public, like the rest of the map
surface — a tile is not a secret.

The cache header is deliberately **not** `immutable`. Tile URLs carry
`?v=generated_at`, so a re-render gets a new query string and the browser
fetches the new bytes. A week of caching is then safe for that revision.

`rusqlite::Connection` is `!Sync`, so the store holds a pool of eight
mutex-guarded read-only connections and reads them inside `spawn_blocking`.
Each connection sets `mmap_size` (256 MiB) and `cache_size` (64 MiB) so a
viewport of JPEG blobs stays in RAM on the named volume.

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `PZ_MAP_TILES_HOST` | `./data/map-tiles` | Host bind for render scratch (`/out`) |
| `MAP_TILES_VOLUME` | `pz-map-tiles-sqlite` | Named volume holding `tiles.sqlite` |
| `MAP_TILES_PATH` | `/map-tiles/tiles.sqlite` | Path inside the API container |
| `PZ_SERVER_HOST` | `./data/server` | Game install the render reads (mounted read-only) |
| `PZ_TEXTUREPACKS_HOST` | `./data/server/media/texturepacks` | Texture packs for the render (see above) |
| `PZ_GAME_VERSION` | `42.20.0` | Recorded in `meta.game_version` |
| `PZ_MAP_TILES_IMAGE` | `pzserver-map-tiles:local` | Render image tag |

Render settings — tile size, level depth, layer cap, JPEG quality — live in
`web/tools/map-tiles/conf.yaml`. `tile_size: 2048` and the `.jpg` format are
load-bearing: the client's `tileSpan()` maths and its tile URLs both assume them,
and `verify.py` enforces the tile size.

## Custom map mods

The render reads `mod_root: /pz/steamapps/workshop/content/108600`, so workshop
map packs the server already has are available to it. `base_map: default` and
`mod_maps: []` in `conf.yaml` currently render vanilla Knox County only; add the
mod's map name to `mod_maps` to include it.

Note that the geometry gate checks the vanilla bounds. Changing what is rendered
changes those bounds, so `verify.py` and `ISO_DZI` have to move together.

## Files

| Piece | Location |
|-------|----------|
| Render image | `web/tools/map-tiles/Dockerfile` |
| pzmap2dzi settings | `web/tools/map-tiles/conf.yaml` |
| Geometry gate | `web/tools/map-tiles/verify.py` |
| Packer + its tests | `web/tools/map-tiles/pack.py`, `test_pack.py` |
| Render → verify → pack | `web/tools/map-tiles/run.sh` |
| Store (read side) | `web/api/crates/pz-api/src/services/map_tiles.rs` |
| Routes | `web/api/crates/pz-api/src/routes/map_tiles.rs` |
| Compose service | `docker-compose.web.yml`, `map-tiles` under the `tools` profile |
| Client | `web/ui/src/lib/iso-tiles.ts`, `web/ui/src/components/ui/worldmap.tsx` |

## Troubleshooting

**The map is blank in 3D mode.** Check `/api/v1/map-tiles/meta`. If it says
`generated: false`, no render has completed — the UI should already be showing
the vector basemap and saying so. If it says `true` but the picture is stale,
reload so the client picks up the new `generated_at` (`?v=`). Do not restart
web-api for a pack; the update is in place.

**Pins are offset from the buildings.** Stop and re-render. This is the failure
the geometry gate exists to prevent, so it should be unreachable; if it does
happen, the render's bounds differ from `ISO_DZI` and the answer is a corrected
`dzi_cell_range`, never an edited `ISO_DZI`.

**The render exits immediately with `no texture packs`.** Working as intended —
see the texture packs section above. This check exists because the alternative
is discovering a blank map after several hours.

**The render dies with `read-only file system` mounting
`/pz/media/texturepacks`.** Docker cannot create a mountpoint inside a read-only
bind mount, and `/pz` is one. `mkdir -p data/server/media/texturepacks` on the
host; both `make map-tiles` targets already do this for you.

**The render says it cannot find the game files.** On Windows, a hand-run
`docker run` needs `MSYS_NO_PATHCONV=1` from Git Bash or the bind mount silently
does not happen and it looks like the install is missing. `make map-tiles` and
`.\make.ps1 map-tiles` are unaffected.

**`pzmap2dzi` fails looking for map descriptions.** `conf.yaml` has to sit beside
`vanilla.txt`, `default_b42.txt` and `mod/` — pzmap2dzi resolves those relative to
the config file's own directory. The Dockerfile copies it over pzmap2dzi's
shipped `conf/conf.yaml` for exactly this reason.
