# Vector basemap (default)

> **Currently unavailable.** This was a Laravel feature of the `app` container,
> parked in `c318e99`. The Rust API that replaced it has no map routes, so the
> `artisan` commands here have nothing to run in. Kept as the reference for what
> the feature did and how the baked artefacts are laid out.

Admin and portal maps use a **vector basemap** by default: geometry baked from vanilla Project Zomboid `worldmap.xml`, drawn in the browser with Canvas. No `pzmap2dzi` run and no tile CDN are required for normal use.

This matches the *schematic* in-game world map (water, roads, buildings, town labels) — not photorealistic isometric tiles.

For a **game-like 3D isometric** basemap (live CDN + optional local generate), use the Player map **Map view** toggle — see [map-tiles.md](map-tiles.md).

## Why vector

| | Vector (default) | 3D isometric (CDN) | Local isometric pack |
|--|------------------|--------------------|----------------------|
| Storage | ~1.5–1.6 MB `map.json` | none on server | large `tiles.sqlite` |
| Generation | one offline bake when the game map changes | none | hours of disk-heavy render (`--profile=lite` recommended) |
| Look | vanilla paper map | game-like isometric | game-like isometric (offline / modded) |
| Offline | yes | no | yes |
| Live on site | yes | yes (immediate) | after generate + pack |

## Asset location

| Path | Role |
|------|------|
| `storage/app/map-vector/vanilla/map.json` | **Runtime bake** (Admin UI / artisan default) — writable by `www-data` |
| `public/map-vector/vanilla/map.json` | Packaged seed only (read fallback). Runtime bakes do **not** overwrite this (prevents tiny test maps from replacing Knox Country). |

Served by Laravel at **`/map-vector/data`** (not a static nginx file), so bakes are never stuck behind a host-owned bind mount.

Format version `1`:

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

# Full rebuild into storage/app/map-vector/vanilla/map.json (vanilla + Map= mod packs)
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

### Admin UI

**Admin → Player map → Basemap setup** (button in the page header, opens a side panel):

- Lists resolved `Map=` packs (origin + found/missing)
- Optional **Also include workshop maps not listed on Map=**
- **Rebuild vector basemap** runs the same bake as the artisan command (`POST /admin/players/map/bake-vector`)
- Writes `public/map-vector/vanilla/map.json` (or `PZ_MAP_VECTOR_PATH`) and records audit action `map.vector_bake`

Pack resolution globs the Workshop tree, so `vectorSources` / `vectorAsset` / `vectorBakeResult` are `Inertia::optional()` props: they are fetched when the panel is first opened, never by the page's 5-second poll.

## Configuration

| Env / config | Default | Meaning |
|--------------|---------|---------|
| `PZ_MAP_BASEMAP` | `auto` | `auto` = vector → local tiles → proxy; or force `vector` / `local` / `proxy` |
| `PZ_MAP_VECTOR_URL` | `/map-vector/vanilla/map.json` | Browser URL for the pack |
| `PZ_MAP_VECTOR_PATH` | (public path) | Filesystem path; if set, **only** that file is used |
| `PZ_MAP_VECTOR_MIN_ZOOM` | `-4` | Leaflet world-square zoom (1 unit = 1 px at zoom 0) |
| `PZ_MAP_VECTOR_MAX_ZOOM` | `4` | |
| `PZ_MAP_VECTOR_DEFAULT_ZOOM` | `-1.25` | Town-scale default (Muldraugh center) |
| `PZ_WORLDMAP_XML` | — | Optional path for the bake command |

## Rendering notes

- **CRS:** world squares via `CRS.Simple` with `scale = 2^zoom` (not DZI isometric).
- **Coordinates:** markers / safe zones stay `x, y` world squares (`lat = -y`, `lng = x`).
- **Performance:** cell-index culling + single canvas + rAF redraw; DPR capped at 2. Vertices are projected with a per-frame affine transform (probed from the CRS, not `latLngToLayerPoint`, which rounds), so a pan allocates nothing per point.
- **Accuracy:** absolute coords = `cell * 300 + local` from vanilla XML; colors match TIS layer fills.
- **Labels:** drawn most-important-first with a collision pass — a label that would land on one already placed is dropped rather than overprinted.
- **UI polish:** collapsible map key, Map= pack chips, live X/Y cursor, fit Home/World/Players, measure tool, dark paper mode, fullscreen, layer toggles, `#x/y/zoom` in the URL, right-click menu.
- **Forest:** when `worldmap-forest.xml` sits beside `worldmap.xml`, bake one soft green rect per forest cell (dense overview without 100k polygons).

## 3D isometric (optional)

Admin → Player map → **Map view** → **3D isometric**:

- **Live CDN first** (`map.projectzomboid.com`) so the map never waits on generation
- **Optional local pack** via Advanced → Isometric tiles (`--profile=lite` default, or `full`)
- Full detail: [map-tiles.md](map-tiles.md)

Server-wide force (skips vector default for `MapConfigBuilder::build()` only; UI toggle still works via `mapModes`):

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
| Activity heat layer | `resources/js/lib/activity-heat-layer.ts` |
| Map component | `resources/js/components/pz-map.tsx` |
| Tests | `tests/Unit/WorldMapVectorBuilderTest.php`, `WorldMapSourceLocatorTest.php`, `MapConfigBuilderTest.php` |

## Overlays

Beyond the basemap, `PzMap` can draw: player markers (faded by how stale an offline position is), safe zones and safehouse claims, located `game_events`, vehicles from the Lua mod's `vehicles.json`, and an activity density heatmap. Each is switchable from the **Layers** button; the admin map adds a time window (1 / 7 / 30 days) for the heatmap, which is an `Inertia::optional()` prop fetched only once the heatmap is switched on.

Right-clicking the map copies the square under the cursor, and — with a player selected from the list below the map — teleports them there via `POST /admin/players/{name}/teleport` (RCON, audit action `player.teleport`).
