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
starts it.

### What it costs

| Fact | Value |
|---|---|
| Levels rendered | 8–20 |
| Tiles | ~27,000 |
| Result on disk | ~15 GB |
| Free space needed | **~25 GB**, for the loose tree ahead of the packer |
| Runtime | Hours |

Depth is the whole cost. Levels 21 and 22 would take the pyramid to ~360,000
tiles and ~200 GB, so `omit_levels: 2` in `web/tools/map-tiles/conf.yaml` drops
them. `DEFAULT_ISO_SCALE` resolves to level 20, so the view you get when
centring on a survivor is still native resolution; zooming past it upscales from
level 20 through `IsoTileCache.ancestor()`.

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
4. **pack** — `pack.py` folds every tile into `/out/tiles.sqlite`, deleting each
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

The store is opened once at API start-up, so a render against a running stack
needs a restart before the API sees it:

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml restart web-api
```

Then:

```bash
curl -s http://127.0.0.1:8100/api/v1/map-tiles/meta
```

```json
{"generated":true,"min_level":8,"max_level":20,"game_version":"42.20.0"}
```

Before any render the same endpoint answers
`{"generated":false,"min_level":null,"max_level":null,"game_version":null}` and
every tile is a `404`. That is the correct state, not a failure — the UI reads it
and tells staff the tiles have not been generated yet.

## On-disk layout

Host bind (default): `./data/map-tiles/` → container `/out` for the renderer,
`/map-tiles` read-only for the API.

```
data/map-tiles/
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

The cache header is deliberately **not** `immutable`: the URL carries no version,
so re-rendering for a new game build returns different bytes at the same path. A
week of staleness after a re-render is the accepted cost of keeping the URL
simple.

`rusqlite::Connection` is `!Sync`, so the store holds one mutex-guarded read-only
connection and reads it inside `spawn_blocking`.

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `PZ_MAP_TILES_HOST` | `./data/map-tiles` | Host bind mount |
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
the vector basemap and saying so. If it says `true`, check that `web-api` was
restarted after the render.

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
