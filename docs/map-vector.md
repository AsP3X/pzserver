# Vector basemap (default)

Admin and portal maps use a **vector basemap** by default: geometry baked from vanilla Project Zomboid `worldmap.xml`, drawn in the browser with Canvas. No `pzmap2dzi` run and no tile CDN are required for normal use.

This matches the *schematic* in-game world map (water, roads, buildings, town labels) — not photorealistic isometric tiles.

## Why vector

| | Vector (default) | Local isometric tiles | Proxy tiles |
|--|------------------|----------------------|-------------|
| Storage | ~1.5 MB `map.json` | large `tiles.sqlite` | none |
| Generation | one offline bake when the game map changes | hours of disk-heavy render | none |
| Look | vanilla paper map | isometric world art | isometric CDN |
| Offline | yes | yes | no |

## Asset location

```
app/public/map-vector/vanilla/map.json
```

Served as `/map-vector/vanilla/map.json`. Format version `1`:

- **cells** — features keyed by `"cellX,cellY"` (300-square cells), absolute world-square rings
- **styles** — fill colors + min zoom (vanilla palette from `ISMapDefinitions.lua`)
- **labels** — towns / water from `worldmap-annotations.lua` + `MapLabel.json`
- **bounds** — `[minX, minY, maxX, maxY]`

The browser loads this once (HTTP cache), then paints only cells intersecting the viewport.

## Rebuild after a game map update (or map mod change)

The bake command reads **`Map=`** from `server.ini` (semicolon-separated) and merges each folder’s `worldmap.xml` from:

1. Dedicated server `media/maps/{MapFolder}/`
2. Workshop downloads: `steamapps/workshop/content/108600/*/mods/**/media/maps/{MapFolder}/` (incl. `42/` and `common/`)
3. Optional extra roots (`PZ_MAP_EXTRA_MEDIA_ROOTS`)

**Overlap rule:** same as PZ — earlier `Map=` entries win (mod maps are normally prepended; vanilla last).

Stack must already be up (`make up` / `docker compose up -d`) when using Docker. The app container needs the game install mount (`/pz-server`) so Workshop + media are visible.

**Docker (preferred on the server):**

```bash
# Preview what will be merged (Map= + resolved paths)
docker exec -it pz-app php artisan zomboid:build-worldmap-vector --list-only

# Full rebuild into public/map-vector/vanilla/map.json (vanilla + Map= mod packs)
docker exec -it pz-app php artisan zomboid:build-worldmap-vector

# Also pick up workshop maps that have worldmap.xml but are not on Map=
docker exec -it pz-app php artisan zomboid:build-worldmap-vector --scan-workshop

# Single file only (skip Map= discovery)
docker exec -it pz-app php artisan zomboid:build-worldmap-vector \
  --xml="/pz-server/media/maps/Muldraugh, KY/worldmap.xml" \
  --output=public/map-vector/vanilla/map.json
```

Equivalent via Compose service name:

```bash
docker compose exec app php artisan zomboid:build-worldmap-vector --list-only
docker compose exec app php artisan zomboid:build-worldmap-vector
docker compose exec app php artisan zomboid:build-worldmap-vector \
  --xml="/pz-server/media/maps/Muldraugh, KY/worldmap.xml"
```

Make wrapper:

```bash
make exec CMD="php artisan zomboid:build-worldmap-vector --list-only"
make exec CMD="php artisan zomboid:build-worldmap-vector"
```

**Host PHP** (dev machine with project deps + game install; no container required):

```bash
php artisan zomboid:build-worldmap-vector \
  --server-path=/path/to/dedicated-server \
  --ini=/path/to/Zomboid/Server/ZomboidServer.ini
```

When only `--xml` is set, discovery is skipped. Without `--xml`, sources come from `Map=` + game/Workshop paths (with fallback single vanilla discover).

After adding/removing **map mods**, re-run the bake and hard-refresh the browser so the new pack is used. Commit the regenerated `map.json` if you want deploys to ship that exact merge without baking on the server.

## Configuration

| Env / config | Default | Meaning |
|--------------|---------|---------|
| `PZ_MAP_BASEMAP` | `auto` | `auto` = vector → local tiles → proxy; or force `vector` / `local` / `proxy` |
| `PZ_MAP_VECTOR_URL` | `/map-vector/vanilla/map.json` | Browser URL for the pack |
| `PZ_MAP_VECTOR_PATH` | (public path) | Filesystem path; if set, **only** that file is used |
| `PZ_MAP_VECTOR_MIN_ZOOM` | `-4` | Leaflet world-square zoom (1 unit = 1 px at zoom 0) |
| `PZ_MAP_VECTOR_MAX_ZOOM` | `4` | |
| `PZ_MAP_VECTOR_DEFAULT_ZOOM` | `-1.5` | City-scale default |
| `PZ_WORLDMAP_XML` | — | Optional path for the bake command |

## Rendering notes

- **CRS:** world squares via `CRS.Simple` with `scale = 2^zoom` (not DZI isometric).
- **Coordinates:** markers / safe zones stay `x, y` world squares (`lat = -y`, `lng = x`).
- **Performance:** cell-index culling + single canvas + rAF redraw; DPR capped at 2.
- **Accuracy:** absolute coords = `cell * 300 + local` from vanilla XML; colors match TIS layer fills.

## Optional isometric tiles

Still available for a photorealistic basemap: see [map-tiles.md](map-tiles.md). Force with:

```bash
PZ_MAP_BASEMAP=local   # after generating tiles.sqlite
# or
PZ_MAP_BASEMAP=proxy   # map.projectzomboid.com
```

## Implementation

| Piece | Location |
|-------|----------|
| Bake service | `app/Services/WorldMapVectorBuilder.php` |
| Map= / Workshop discovery | `app/Services/WorldMapSourceLocator.php` |
| Artisan command | `zomboid:build-worldmap-vector` (`--list-only`, `--scan-workshop`, `--xml`) |
| Config selection | `app/Services/MapConfigBuilder.php` |
| Canvas layer | `resources/js/lib/worldmap-vector-layer.ts` |
| Map component | `resources/js/components/pz-map.tsx` |
| Tests | `tests/Unit/WorldMapVectorBuilderTest.php`, `WorldMapSourceLocatorTest.php`, `MapConfigBuilderTest.php` |
