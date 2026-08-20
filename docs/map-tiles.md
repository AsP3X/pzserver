# Map tiles (3D isometric basemap)

> **Currently unavailable.** This was a Laravel feature of the `app` container,
> parked in `c318e99`. The Rust API that replaced it has no map routes, so the
> `artisan` commands here have nothing to run in. Kept as the reference for what
> the feature did and how the tile pyramids are laid out.

The admin **Player map** (`/admin/players/map`) plots player markers on a basemap. The same basemap config is reused for safe zones, moderation, and the player portal map widget.

## Default: vector basemap (no tile generation)

Out of the box the panel uses a **compact vector pack** baked from vanilla `worldmap.xml` (~1.5 MB, Canvas-rendered). See **[map-vector.md](map-vector.md)**.

- No `pzmap2dzi` run, no multi-file pyramid
- Schematic “in-game world map” look (water, roads, buildings, labels)

## Map view: Vector vs 3D isometric

Admin → Player map → the **Vector (2D) / 3D isometric** switch above the map (stored in browser `localStorage` as `pz-map-view-mode`):

| Mode | What you see | Server load |
|------|----------------|-------------|
| **Vector (2D)** | Schematic worldmap (default) | Minimal (static JSON) |
| **3D isometric** | Game-like isometric tiles | **Live CDN** immediately; optional local pack |

Backend: `MapConfigBuilder::buildModes()` exposes both configs (`vector` + `isometric`). Isometric = local `tiles.sqlite` when ready, else public proxy so the UI always has something live to render.

### Live first (no wait)

Switching to **3D isometric** always shows tiles **right away** via **map.projectzomboid.com** when local tiles are not ready. Optional local generation runs in the background and **never blanks the map**.

CDN isometric is **vanilla** Knox Country. Custom map mods need a **local** generate for accurate art (vector mode already merges `Map=` packs).

### Efficient local generation (`--profile=lite` default)

When you need offline / modded isometric tiles, generate with the **lite** profile (Admin UI default):

| Setting | Lite | Full |
|---------|------|------|
| Layers | Ground only `[0,0]` | Ground + walls `[0,1]` |
| `omit_levels` | 5 (fewer high-zoom tiles) | 3 |
| Workers | 1 (config default) | 1+ (`PZ_MAP_WORKERS`) |
| Priority | nice + ionice | same |
| Output | WebP → pack `tiles.sqlite` | same |

```bash
# Lite (recommended on a live server)
docker exec -it pz-app php artisan zomboid:generate-map-tiles --force --profile=lite

# Full detail (heavier — prefer when idle)
docker exec -it pz-app php artisan zomboid:generate-map-tiles --force --profile=full

# Compose / Make
docker compose exec app php artisan zomboid:generate-map-tiles --force --profile=lite
make exec CMD="php artisan zomboid:generate-map-tiles --force --profile=lite"
```

**Admin UI:** **Basemap setup** (page header) → **Isometric tiles (Advanced)** → choose Lite/Full → Generate.  
API: `POST /admin/players/map/generate-tiles` body `{ "profile": "lite"|"full", "force"?: true, "resume"?: true }`.

After a successful pack, 3D mode automatically prefers **local** tiles over the CDN.

### Env / force defaults

| Env | Meaning |
|-----|---------|
| `PZ_MAP_BASEMAP=auto` | Prefer vector for default page config (UI still offers both modes) |
| `PZ_MAP_BASEMAP=vector` | Force vector for `build()` |
| `PZ_MAP_BASEMAP=local` | Force local tiles when usable |
| `PZ_MAP_BASEMAP=proxy` | Force public isometric CDN |
| `PZ_MAP_PROXY_URL` | CDN tile URL template |
| `PZ_MAP_WORKERS` | Render worker count (default 1) |

## Optional: proxy tiles only

Set `PZ_MAP_BASEMAP=proxy` (or fall back when the vector pack is missing) to use tiles from **map.projectzomboid.com** without offering vector as the server default.

- No local disk usage beyond the panel itself
- Requires outbound HTTPS from the browser (or users) to the proxy host

## Optional: local tiles (packed SQLite)

Local tiles are rendered with [pzmap2dzi](https://github.com/cff29546/pzmap2dzi) from the dedicated server game files (`media/`, workshop content). The tool is installed in the **app** image at `/opt/pzmap2dzi`.

### Why not keep the raw DZI pyramid?

`pzmap2dzi` writes a Deep Zoom Image pyramid: one small `.webp`/`.jpg` per tile under nested zoom folders. A full isometric basemap is commonly **hundreds of thousands to millions of files**.

That layout is painful for operators:

| Operation | Multi-file pyramid | Single pack |
|-----------|--------------------|-------------|
| Delete / regenerate | Minutes–hours (inode thrash) | Unlink one file |
| Host backup / rsync / tar | Extremely slow | One large file |
| Disk checks / antivirus | Pathological | Normal |

This stack therefore **always packs** the pyramid after a successful render:

1. **Render** — temporary multi-file pyramid under `/map-tiles/html/map_data/base/layer0_files/`
2. **Pack** — all tiles + `map_info` metadata into **`/map-tiles/tiles.sqlite`**
3. **Cleanup** — remove the loose `layer0_files/` tree (`rm -rf`)

The HTTP tile endpoint (`GET /admin/map-tiles/{level}/{tile}`) reads blobs from SQLite (and still understands legacy loose files if packing has not been run yet).

### On-disk layout

Host bind (default): `./data/map-tiles/` → container `/map-tiles`.

```
data/map-tiles/
├── tiles.sqlite              # canonical basemap (required for local tiles)
└── html/map_data/base/
    └── map_info.json         # small sidecar (also stored inside the pack meta table)
```

During generation only (then deleted):

```
data/map-tiles/html/map_data/base/layer0_files/{z}/{x}_{y}.webp
```

### How to generate

**UI:** Admin → **Player map** → **Basemap setup** → **Isometric tiles (Advanced)** (Generate / Stop / Resume / Start over + progress bar).

**CLI (Docker — preferred for logs / SSH):**

The artisan command runs in the **app** container (`container_name: pz-app`). Stack must already be up (`make up` / `docker compose up -d`).

```bash
# Full generate: render → pack into tiles.sqlite → remove loose files
docker exec -it pz-app php artisan zomboid:generate-map-tiles --force

# Pack only (no re-render)
docker exec -it pz-app php artisan zomboid:generate-map-tiles --pack-only
```

Equivalent via Compose service name:

```bash
docker compose exec app php artisan zomboid:generate-map-tiles --force
docker compose exec app php artisan zomboid:generate-map-tiles --pack-only
```

Make / PowerShell wrappers (optional):

```bash
make exec CMD="php artisan zomboid:generate-map-tiles --force"
```

```powershell
.\make.ps1 exec php artisan zomboid:generate-map-tiles --force
.\make.ps1 exec php artisan zomboid:generate-map-tiles --pack-only
```

Generation is **not** scheduled and **not** run automatically on container start (too heavy).

#### Artisan options

| Option | Description |
|--------|-------------|
| `--force` | Delete existing pack and loose tiles, then re-render and pack |
| `--pack-only` | Pack an existing loose pyramid into `tiles.sqlite` without re-rendering |
| `--status` | Report what is on disk (per-level tile counts, pack size, progress state) |
| `--keep-loose` | Keep the multi-file pyramid after packing (not recommended) |
| `--workers=N` | Render worker processes (default: detected CPU cores) |
| `--map=` | Specific map name passed to pzmap2dzi (default: vanilla / all) |

### Migrating an existing multi-file install

If you already generated tiles **before** packing existed, you likely have a huge `layer0_files/` tree. Convert without re-rendering:

```bash
docker exec -it pz-app php artisan zomboid:generate-map-tiles --pack-only
```

After it finishes you should see `./data/map-tiles/tiles.sqlite` and the loose pyramid removed. Backups and deletes become normal again.

If packing is interrupted, re-run `--pack-only` (or regenerate with `--force`).

### Resource expectations / disk lag

Local isometric render is **extremely disk-heavy** (millions of small tile writes). On the same disk as the game world this can briefly push **disk util to 100%** and lag the dedicated server.

This stack throttles generation by default:

| Control | Default | Env |
|---------|---------|-----|
| Render workers | **1** | `PZ_MAP_WORKERS` |
| CPU/I/O priority | `nice -n 15` + `ionice -c 2 -n 7` (low, not idle) | `PZ_MAP_LOW_PRIORITY`, `PZ_MAP_IONICE_CLASS` |
| Pack micro-pauses | every 100 tiles, 10ms | `PZ_MAP_PACK_PAUSE_EVERY` / `PZ_MAP_PACK_PAUSE_US` |

> **Note:** `ionice -c 3` (idle) was tried earlier but can leave render stuck in “preparing” for a very long time while the game server keeps the disk busy. Default is now best-effort low priority so prepare/scan still progresses.

Still plan for:

- Long runtime (hours with 1 worker is normal and intentional)
- Temporary disk use while the loose pyramid exists **before** pack+delete
- Prefer generating when few players are online

Quieter host (even slower generate):

```bash
# in .env / app env
PZ_MAP_WORKERS=1
PZ_MAP_LOW_PRIORITY=true
PZ_MAP_PACK_PAUSE_EVERY=50
PZ_MAP_PACK_PAUSE_US=20000
```

Faster generate (more lag risk):

```bash
PZ_MAP_WORKERS=4
# or one-shot:
docker exec -it pz-app php artisan zomboid:generate-map-tiles --force --workers=4
```

### Progress

While generation runs, progress is written to `app/storage/app/map-tiles.progress.json` and shown:

- **CLI** — live status line (`job: done/total`, saved tiles, elapsed time) when using `docker exec -it`
- **Admin UI** — progress bar in the Player map's Basemap setup panel (polls every 5s, 3s while generating)

Inspect progress manually:

```bash
docker exec pz-app php artisan zomboid:generate-map-tiles --status
```

```bash
docker exec pz-app tail -f /var/www/html/storage/logs/pzmap2dzi.log
```

**`saved tiles` staying at 0 early in a render is normal.** pzmap2dzi walks tiles in
Z-order starting at the top-left of the DZI bounding box, which in isometric projection
is outside the map diamond — void area. Void tiles are written as zero-byte `.empty`
sentinels, not images, so the image counter stays at 0 until the walk reaches actual map
data. `--status` shows both columns, so a level with a large `empty` count and zero
images is proof the renderer is working, not stalled.

The basemap keeps using proxy tiles for the whole render. pzmap2dzi builds the pyramid
bottom-up, so the zoom levels Leaflet requests are the last ones written; the map only
switches to local tiles once `tiles.sqlite` exists (step 3), or once a loose pyramid is
present with no render running.

### Stop & resume

You can interrupt generation without losing the multi-file pyramid, then continue later (pzmap2dzi is incremental).

| Action | Docker / CLI | Admin UI |
|--------|--------------|----------|
| **Stop** (keep partial tiles) | `docker exec -it pz-app php artisan zomboid:generate-map-tiles --stop` | **Stop generation** |
| **Resume** | `docker exec -it pz-app php artisan zomboid:generate-map-tiles --resume` | **Resume generation** |
| **Clear everything** | `docker exec -it pz-app php artisan zomboid:generate-map-tiles --clear` | **Start over** (confirm) |

`--clear` renames large tile trees to `.trash-*` and deletes them **in the background** so the command returns quickly. Live paths are empty immediately; disk space free-up may continue for a while (`storage/logs/map-tiles-purge.log`, `ls data/map-tiles/.trash-*`).
| **Full regenerate** | `docker exec -it pz-app php artisan zomboid:generate-map-tiles --force` | **Start over** / regenerate |

Notes:

- **Do not use `--force`** if you want to resume — it deletes the partial pyramid.
- Auto-resume: if loose tiles exist and you run without flags, the command continues incrementally.
- After a full successful run, only `tiles.sqlite` remains (loose files removed).

Logs:

- Artisan / UI background job: `app/storage/logs/map-tiles.log`
- pzmap2dzi subprocess: `app/storage/logs/pzmap2dzi.log`
- Shared progress JSON: `app/storage/app/map-tiles.progress.json`

### Configuration

| Env / config | Default | Meaning |
|--------------|---------|---------|
| `PZ_MAP_TILES_PATH` | `/map-tiles` | Path **inside** the app container |
| `PZ_MAP_TILES_HOST` | `./data/map-tiles` | Host bind mount (compose) |
| `config('zomboid.map.*')` | see `app/config/zomboid.php` | Zoom defaults, proxy URL/DZI, tile size |

Detection order in `MapConfigBuilder` (`PZ_MAP_BASEMAP=auto`):

1. Vector pack (`public/map-vector/vanilla/map.json`) → `source: vector`
2. Local pack (`tiles.sqlite`) or legacy loose tiles → `source: local`
3. Else public proxy → `source: proxy`

Force with `PZ_MAP_BASEMAP=vector|local|proxy`.

### Implementation pointers (developers)

| Piece | Location |
|-------|----------|
| Generate + pack command | `app/Console/Commands/GenerateMapTiles.php` (`--profile=lite\|full`) |
| Background UI spawn | `app/Services/MapTileGenerator.php` |
| SQLite pack / serve store | `app/Services/MapTileStore.php` |
| Dual modes + defaults | `app/Services/MapConfigBuilder.php` → `build()` / `buildModes()` |
| Admin Map view + generate | `resources/js/pages/admin/player-map.tsx` |
| Tile HTTP route | `GET /map-tiles/{level}/{tile}` (and admin alias) |
| Unit tests | `tests/Unit/MapTileStoreTest.php`, `MapConfigBuilderTest.php` |

Pack schema (version `1`):

- `meta(key, value)` — includes `map_info` JSON, `version`, `created_at`
- `tiles(z, x, y, format, data)` — primary key `(z, x, y)`, `format` = `webp` or `jpg`

### Related docs

- [Command reference](commands.md) — vector bake + isometric generate (docker variants)
- [Vector basemap](map-vector.md) — default 2D schematic pack
- [Troubleshooting](troubleshooting.md) — map / disk issues
- [README — Map basemap](../README.md#map-basemap-admin-player-map) — short operator summary
