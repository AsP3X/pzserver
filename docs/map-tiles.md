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

## First-time deploy

`make init` (or `make up` on an already-configured host) is the stack. It does
**not** spend hours rendering Knox County. The isometric pack is optional:

1. **Vector map works immediately.** No tiles required.
2. **Isometric map** needs `tiles.sqlite` on the `pz-map-tiles-sqlite` volume
   **and** PZ client texture packs in `data/server/media/texturepacks/`.

Pick one for the pack:

| How | Command |
|-----|---------|
| Generate on this machine (hours, ~24 GB, needs texture packs first; overlays the live save and **replaces** the pack) | `make map-tiles` |
| Upload a pack built elsewhere | copy it to `data/map-tiles/tiles.sqlite`, then `make up` (imports into the volume if empty) or `make map-tiles-import` |

```bash
# One-command stack. Drop tiles.sqlite in place first if you have one.
make init          # wizard + up, first machine
make up            # afterwards

# Texture packs (once, ~527 MB, from a PZ client)
# <Steam>/steamapps/common/ProjectZomboid/media/texturepacks/*.pack
# → data/server/media/texturepacks/

# Regional redraw after the pack exists (minutes)
make map-tiles-region CELLS="41,38"
```

`make init` writes **absolute** `PZ_DATA_HOST` / `PZ_SERVER_HOST` /
`PZ_MAP_TILES_HOST` / `PZ_TEXTUREPACKS_HOST` so the panel can spawn render
jobs. Relative `./data/...` is enough for compose and for `make map-tiles-region`.

`make up` seeds `data/map-tiles/html/map_data/base/map_info.json` (pyramid
geometry) and creates the empty texture-pack directory. Regional jobs no
longer depend on leftover HTML from a previous full render.

Do **not** insert rows into `map_tile_jobs` by hand. `status='running'` is a
dry-run animation. A real job is `POST /api/v1/admin/map-tiles/rerender` or
`make map-tiles-region`. CLI region jobs write `job_progress.json` (including
the cell rects) so the player map still shows the construction overlay.

```bash
make map-tiles-import
```

```powershell
.\make.ps1 map-tiles-import
```

Import with `web-api` down, or against an empty volume. Overwriting a pack
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

The county pack starts from vanilla map files. Player construction and
environment damage live in the dedicated-server save
(`Saves/Multiplayer/<name>/map/{x}/{y}.bin` on B42). A **full**
`make map-tiles` is a clean slate of that world: vanilla county, jumbo tree
margin, BOX downsampling, then a save overlay on every cell that has a chunk,
packed with `--replace --wal` into the live `tiles.sqlite`. Without
`--replace` a re-run paints for hours and stores 0 tiles (the previous JPEGs
lose to the rows already in the pack, then get unlinked). `PZ_MAP_VANILLA_ONLY=1`
skips the overlay.

After that, a **manual** regional job (`make map-tiles-region`, the admin
Map tab, or `POST /api/v1/admin/map-tiles/rerender`) is how you refresh
cells after a game update or a mod that adds map tiles. Player placement
and door / window state are not auto-painted.

> **Skip the lotpack leaf; paint only mapped door/window/tree/carpentry sprites.**
> A world-change job skips the closed/intact lotpack leaf, then paints save
> sprites whose ids were correlated from unique matches (B42 chunks still use
> file-0 ids). `load_tile_defs` is **not** used for the overlay — merging the
> lotpack map onto it paints window frames on every road and parking square
> that has a save object. Unknown ids stay unpainted; vanilla already drew
> them. `PZ_MAP_SAVE_SPRITES=1` forces paint even if that map file is empty.

A **world-change job** is the same regional job, plus a save overlay:

1. Snapshot the dirty cells' chunks (the live files stay with PZ).
2. Scan the snapshot for sprites the live world contradicts and write them to
   `save_skip.txt` as `x,y,tile-name` — one **sprite**, not one square.
3. Paint vanilla `base` for those cells, suppressing exactly those named
   tiles, then `render save`.
4. Alpha-composite the save PNGs over the base, unmasked; then fill any
   still-unpainted cell-range corner from the pristine underlay.
5. WAL-replace those rows in `tiles.sqlite`.

Step 2 is per-sprite for a reason. A square carries its floor and its wall as
well as its door, and a B42 save chunk only stores the door — so skipping the
whole square leaves a black notch nothing can paint back, and skipping the
whole 8-square block turns the cell black with a few doors floating on it.
There is also deliberately **no pixel-space mask** in the composite: a PZ
sprite is anchored bottom-centre and stands about three diamond heights above
its square, so clipping the overlay to that square's ground diamond keeps the
doorstep and throws the door away.

Door, window, curtain and tree sprites come from the save object's *state*
(`open` / smashed / glass-removed / `damage`), not the default `sprite_id`.
PZ's `IsoDoor.save` writes the closed sprite as `sprite_id` and the live
picture as `open` + `openSprite.ID` (PZwiki: open tiles are tilesheet
offset +2 and are not flagged Door — they are mostly a hole).
Player-built doors, windows and carpentry are `IsoThumpable` (class 18),
same idea on `bit_header`. Chopped trees are `IsoTree` (class 1) until the
stump replaces them. Opening a door only updates Java memory until `save`
— the renderer issues RCON `save` (and the API does too) and waits for
chunk mtimes before the snapshot. Vanilla lotpack paint drops the one
contradicted leaf on that square so the closed door / standing tree cannot
show through; everything else on the square still paints. The panel job
must pass `PYTHONPATH=/tools` into the renderer; without it the skip/sprite
patches never load and the door stays shut on the map.

#### The pyramid's size is measured, never assumed

The client lays every tile out on the width and height the **pack** declares:
`tileBounds()` in `web/ui/src/lib/iso-tiles.ts` clamps each tile's destination
rectangle to them, so an edge tile is drawn exactly as wide as it really is.

That size is **not a constant**. It depends on the game files the pack was
rendered from. This install's county is **2 318 464 × 1 015 776**; the public
pyramid the constants were copied from was 2 318 656 × 1 019 040 — 3 264 px
taller. `verify.py` used to wave that through on a 16 384 tolerance, reasoning
it cost "at most one tile row at the bottom edge". It did not: every level was
drawn short by the ratio, and the further out you zoomed the worse it looked,
because at z12 a single tile row spans the entire map.

So:

- `pack_size.py` reads the render's own `map_info.json` (`w`/`h` × 2^`skip`)
  and `run.sh` writes that into the pack's `meta` table.
- `/api/v1/map-tiles/meta` returns `width` and `height`.
- The client calls `setPackSize()` from that and falls back to `ISO_DZI`
  only for a pack too old to carry them.
- `verify.py` no longer pins the size — it sanity-checks it is Knox County at
  all (±5%) and keeps `x0`/`y0`/`sqr`/`cell_rects` exact, because *those* place
  every pin.

To correct an existing pack without re-rendering, update the two rows:

```bash
docker run --rm -v pz-map-tiles-sqlite:/pack --entrypoint python pzserver-map-tiles:local -c "import sqlite3; con=sqlite3.connect('/pack/tiles.sqlite'); con.execute(\"UPDATE meta SET value='2318464' WHERE key='width'\"); con.execute(\"UPDATE meta SET value='1015776' WHERE key='height'\"); con.commit()"
```

#### Render margin: the rectangle over a tree

`render_conf.render_margin` decides how far outside a tile pzmap2dzi looks for
squares whose sprite reaches into it. Get it too small and a tree standing
just outside the tile is never considered, so its canopy is chopped along a
straight line — a rectangle sitting over the tree.

pzmap2dzi offers two named sizes, both derived from an assumed texture, and
**both are too small for B42**:

| margin | assumed texture | `[left, top, right, bottom]` |
|---|---|---|
| `normal` | 128×256 | `[0, 0, 0, 6]` — no horizontal reach at all |
| `large` | 384×512 | `[-2, 0, 2, 14]` |

Measured against this install's texture packs:

| texture | size | offset |
|---|---|---|
| `vegetation_trees_01_3` | 115×176 | (-63, -194) |
| `jumbo_tree_01_0` | 110×227 | (-58, -238) |
| `e_redmapleJUMBO_1_3` | 229×449 | (-115, -462) |
| `e_redmapleJUMBOXL_1_3` | **515×727** | **(-259, -729)** |

Knox County puts JUMBOXL trees straight in the lotpack — cell 41,38 has one at
square 10723,9765. It reaches 259 px left and 729 px up, past `large` in both
axes. So `conf.yaml` sets an explicit numeric margin instead,
`[-5, 0, 5, 25]` (320 px across, 800 px up), and `patch_render_margin.py`
stops `BaseRender.update_options` from overwriting it.

**Older packs were rendered without this**, so chopped canopies are baked in
until those cells are redrawn. A full `make map-tiles` rebuild clears it
county-wide; `map-tiles-region` fixes the cells you name.

#### Sprite ids vs lotpack names

A chunk stores each object's sprite as an **id**. `load_tile_defs` numbers
B42 `newtiledefinitions.tiles` from **110000** (page size 1000). The save
writes the old file-0 ids: `fixtures_doors_01_0` is **11264** in the chunk
and **122000** in the tiledef file. WorldDictionary.bin reports
`num_sprites = 0`.

A world-change job therefore skips the closed lotpack *name* on that square
and builds an id map from unique door/window matches (one object, one leaf
anchors a 512-wide sheet). Save-sprite paint uses **only** that map — not
`load_tile_defs` — and only for door/window/curtain/tree/thumpable objects.
Floors and containers in the save stay off the overlay. Ids that never
anchor drop rather than paint the wrong sheet.

Staff start a regional job from Configuration → **Map** (cells as `x,y` or
`x,y,w,h`, several separated by semicolons) or from
`make map-tiles-region`. One job at a time; a second run while one is
already painting is a conflict, not a queue.

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
2. **Paint only the requested cells.** Expanding to whole DZI tiles (then
   +1 cell) re-renders neighbors; those JPEGs never pixel-match the original
   pack (half-cell seams, floating tree stamps). Unpainted corners of the
   tiles that *do* straddle the request are filled from the pristine underlay.
3. **Dirty every packed ancestor, but do not let pzmap2dzi merge them.** A
   level-20 change without rebuilding 19…0 leaves zoom-out stale. Restore
   those ancestors so the renderer skips them, paint the leaves, then
   `rebuild_pyramid.py` writes each parent from its four children. Letting
   pzmap2dzi merge during paint bakes JPEG-black corners into every zoom.
4. **Restore merge siblings and ancestors; leave leaves absent.** Missing
   siblings → three-quarters black. Dirty *leaf* tiles must stay absent so
   pzmap2dzi redraws them. After paint, `fill_unpainted.py` copies vanilla
   back into any JPEG-black corner from a snapshot of the previous leaf.
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
4. **Do not restore dirty *leaf* tiles.** pzmap2dzi treats an existing `.jpg`
   as done. Restoring the hole makes the run a no-op. Dirty ancestors *are*
   restored so the renderer skips them; `rebuild_pyramid.py` overwrites them
   after the leaves are finished.
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
10. **Do not invent a second render path for world changes.** A manual
    region job is the same pipeline. Save overlay is composited onto dirty
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

**Regional job fails with `map_info mismatch` / `Render stopped`.** pzmap2dzi
compares on-disk `w`/`h`/`skip` to the size it computes from the game files.
A seeded ISO_DZI file is a few hundred pixels off. Current `run.sh` deletes
`map_info.json` after planning so pzmap2dzi can write a matching one.

**Save overlay: `No module named 'lark'`.** The pzdataspec zip needs `lark`.
The map-tiles image installs it. Rebuild that image (`make map-tiles-region`
already does).

**Save overlay: `No such file .../pzdataspec/spec`.** The GitHub *source*
clone is not importable (parsers live in the *release zip*). The image
installs `pzdataspec-v1.12.249.zip` under `/opt`. Do not put the git tree
on `PYTHONPATH`.

**Giant black square after a region job.** A DZI tile is an axis-aligned
square; a map cell is a diamond in that square. `render_cell_range` paints
only the diamond, JPEG fills the unpainted corners with black, and packing
the zoom-out parents freezes that black rectangle (town in the middle,
original map around it). The live volume cannot heal from itself once those
bytes are packed. The original county pack at `data/map-tiles/tiles.sqlite`
(left there after import) is the underlay: leaf corners are copied from it,
and any ancestor that is still mostly black is replaced from it. Keep that
file. To drop the black square immediately:

```
make map-tiles-heal CELLS="41,38"
```

That copies the original tiles over the region (seconds). Then
`make map-tiles-region CELLS="41,38"` paints live save on top. Hard-refresh
the player map.

**Door still closed after a region job.** `open-square skip: N` means the
snapshot saw the open door. `Affected tiles: 0` / `composited 0 save tiles`
means the overlay was then dropped: pzmap2dzi compared save-chunk (block)
coords to `render_cell_range` as if they were cells. The renderer patches
that.

**Town looks like a barcode of vertical ticks.** The save overlay painted
every square in the cell (trees/fences on roofs and roads) and replaced
vanilla. Overlay is now clipped to the punched door diamonds. Restore with
`make map-tiles-heal CELLS="x,y"`, then re-run `make map-tiles-region`.

**`RCON save skipped: Connection refused`.** RCON only listens after the
dedicated server has finished loading the world. `./deploy.sh` recreates
`game-server`, so a region job started immediately will refuse until the
healthcheck is green. The renderer now retries for three minutes. Check
with `docker compose ps` — wait until `game-server` is healthy, then rerun.

**The render says it cannot find the game files.** On Windows, a hand-run
`docker run` needs `MSYS_NO_PATHCONV=1` from Git Bash or the bind mount silently
does not happen and it looks like the install is missing. `make map-tiles` and
`.\make.ps1 map-tiles` are unaffected.

**`pzmap2dzi` fails looking for map descriptions.** `conf.yaml` has to sit beside
`vanilla.txt`, `default_b42.txt` and `mod/` — pzmap2dzi resolves those relative to
the config file's own directory. The Dockerfile copies it over pzmap2dzi's
shipped `conf/conf.yaml` for exactly this reason.
