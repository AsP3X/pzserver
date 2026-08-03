# Map tiles (admin player map)

The admin **Player map** (`/admin/players/map`) plots player markers on a basemap. The same basemap config is reused for safe zones, moderation, and the player portal map widget.

## Default: proxy tiles (no generation)

Out of the box the panel uses tiles from **map.projectzomboid.com** (configurable via `PZ_MAP_PROXY_URL` / `config/zomboid.php` → `map.proxy_*`).

- No local disk usage beyond the panel itself
- No `pzmap2dzi` run required
- Requires outbound HTTPS from the browser (or users) to the proxy host

Local generation is **optional** and only needed if you want offline basemaps, custom/mod maps, or to avoid depending on the public tile CDN.

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

**UI:** Admin → **Player map** → **Generate local tiles** (or **Regenerate tiles**).

**CLI (preferred for logs / SSH):**

```bash
# Linux
make exec CMD="php artisan zomboid:generate-map-tiles --force"

# Windows PowerShell
.\make.ps1 exec php artisan zomboid:generate-map-tiles --force
```

Generation is **not** scheduled and **not** run automatically on container start (too heavy).

#### Artisan options

| Option | Description |
|--------|-------------|
| `--force` | Delete existing pack and loose tiles, then re-render and pack |
| `--pack-only` | Pack an existing loose pyramid into `tiles.sqlite` without re-rendering |
| `--keep-loose` | Keep the multi-file pyramid after packing (not recommended) |
| `--workers=N` | Render worker processes (default: detected CPU cores) |
| `--map=` | Specific map name passed to pzmap2dzi (default: vanilla / all) |

### Migrating an existing multi-file install

If you already generated tiles **before** packing existed, you likely have a huge `layer0_files/` tree. Convert without re-rendering:

```bash
make exec CMD="php artisan zomboid:generate-map-tiles --pack-only"
```

After it finishes you should see `./data/map-tiles/tiles.sqlite` and the loose pyramid removed. Backups and deletes become normal again.

If packing is interrupted, re-run `--pack-only` (or regenerate with `--force`).

### Resource expectations

Local isometric render is demanding (pzmap2dzi’s own guidance is high RAM/disk for full maps). Preview-quality settings used by this stack (`layer_range`, `omit_levels`, WebP) reduce cost, but still plan for:

- Long runtime (tens of minutes to hours depending on CPU)
- Temporary disk spike while the loose pyramid exists **before** pack+delete
- Prefer running generate when the host is idle

Logs:

- Artisan / UI background job: `app/storage/logs/map-tiles.log`
- pzmap2dzi subprocess: `app/storage/logs/pzmap2dzi.log`

### Configuration

| Env / config | Default | Meaning |
|--------------|---------|---------|
| `PZ_MAP_TILES_PATH` | `/map-tiles` | Path **inside** the app container |
| `PZ_MAP_TILES_HOST` | `./data/map-tiles` | Host bind mount (compose) |
| `config('zomboid.map.*')` | see `app/config/zomboid.php` | Zoom defaults, proxy URL/DZI, tile size |

Detection order in `MapConfigBuilder`:

1. Local pack (`tiles.sqlite`) or legacy loose tiles → `source: local`
2. Else public proxy → `source: proxy`

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

- [Command reference](commands.md) — artisan examples via `make exec`
- [Troubleshooting](troubleshooting.md) — map / disk issues
- [README — Map tiles](../README.md#map-tiles-admin-player-map) — short operator summary
