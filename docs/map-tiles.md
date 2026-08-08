# Map tiles (optional isometric basemap)

The admin **Player map** (`/admin/players/map`) plots player markers on a basemap. The same basemap config is reused for safe zones, moderation, and the player portal map widget.

## Default: vector basemap (no tile generation)

Out of the box the panel uses a **compact vector pack** baked from vanilla `worldmap.xml` (~1.5 MB, Canvas-rendered). See **[map-vector.md](map-vector.md)**.

- No `pzmap2dzi` run, no tile CDN, no multi-file pyramid
- Schematic “in-game world map” look (water, roads, buildings, labels)

## Optional: proxy tiles

Set `PZ_MAP_BASEMAP=proxy` (or fall back when the vector pack is missing) to use tiles from **map.projectzomboid.com** (configurable via `PZ_MAP_PROXY_URL` / `config/zomboid.php` → `map.proxy_*`).

- No local disk usage beyond the panel itself
- Requires outbound HTTPS from the browser (or users) to the proxy host

## Optional: local isometric tiles

Local generation is **optional** and only needed if you want photorealistic isometric basemaps, custom/mod maps rendered as images, or offline tiles without the vector pack.

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

**UI:** Admin → **Player map** → **Local map tiles** card (Generate / Stop / Resume / Start over + progress bar).

> **Frontend not updating after git pull?** Host volume `./data/app-build` can pin an old Vite build. Redeploy rebuilds the app image; entrypoint now re-syncs `public/build` when the image manifest changes. Force refresh once:
> ```bash
> rm -rf data/app-build/*
> ./deploy.sh
> # hard-refresh browser (Ctrl+Shift+R)
> ```

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
- **Admin UI** — progress bar on the Player map page (polls every 5s)

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
| Generate + pack command | `app/app/Console/Commands/GenerateMapTiles.php` |
| SQLite pack / serve store | `app/app/Services/MapTileStore.php` |
| Prefer local vs proxy config | `app/app/Services/MapConfigBuilder.php` |
| Admin page + generate button | `app/resources/js/pages/admin/player-map.tsx` |
| Tile HTTP route | `GET /admin/map-tiles/{level}/{tile}` → `PlayerMapController::tile` |
| Unit tests | `app/tests/Unit/MapTileStoreTest.php`, `MapConfigBuilderTest.php` |

Pack schema (version `1`):

- `meta(key, value)` — includes `map_info` JSON, `version`, `created_at`
- `tiles(z, x, y, format, data)` — primary key `(z, x, y)`, `format` = `webp` or `jpg`

### Related docs

- [Command reference](commands.md) — artisan examples via `docker exec` / `make exec`
- [Troubleshooting](troubleshooting.md) — map / disk issues
- [README — Map tiles](../README.md#map-tiles-admin-player-map) — short operator summary
