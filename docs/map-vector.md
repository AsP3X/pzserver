# Vector basemap (default)

Admin and player maps use a **vector basemap** by default: a schematic of Knox
County (water, roads, buildings, town labels) painted in the browser on a
canvas. No `pzmap2dzi` run and no tile CDN are required.

This is the paper-style in-game world map, not photorealistic isometric tiles.

For a **game-like 3D isometric** basemap, see [map-tiles.md](map-tiles.md).
For **live sprites** (occupancy, doors, roofs), see [map-sprites.md](map-sprites.md).

## Why vector

| | Vector (default) | Local isometric pack | Sprite isometric |
|--|------------------|----------------------|------------------|
| Storage | ~1.6 MB `vanilla.json` shipped with the UI | large `tiles.sqlite` | `sprites.sqlite` + live overlay |
| Generation | none — pack is in the UI build | hours (`make map-tiles`) | `make map-sprites` |
| Look | vanilla paper map | game-like JPEG tiles | game-like sprites |
| Offline | yes | yes | yes |

There is **no CDN fallback** and no PHP/`artisan` bake.

## Asset location

| Path | Role |
|------|------|
| `web/ui/public/map/vanilla.json` | Schematic pack, copied into the UI image |
| Browser URL `/map/vanilla.json` | What `web/ui/src/lib/worldmap.ts` fetches (`WORLDMAP_URL`) |

The pack is about 1.6 MB of JSON. The UI loads it once per page and paints only
cells that intersect the viewport.

Format:

- **cells** — features keyed by `"column,row"`, rings in world squares
- **styles** — fill colors + minimum zoom
- **labels** — towns / water
- **bounds** — `[minX, minY, maxX, maxY]`
- **cellSize** — game cell size in squares

## Updating the pack

There is no live bake command on this stack. The schematic is the vanilla Knox
County pack checked into git.

- **Vanilla / B42 map update:** replace `web/ui/public/map/vanilla.json` and
  rebuild `web-ui`.
- **Custom `Map=` / map mods:** the isometric and sprite maps read the live
  dedicated-server files. Use `make map-tiles` / `make map-sprites` rather than
  editing the schematic pack.

## Overlays

The map component (`web/ui/src/components/ui/worldmap.tsx`) can also draw
player pins, safe zones, and the isometric/sprite layers. Mode is stored in
browser `localStorage` as `pz-map-view-mode`.

Right-clicking copies the square under the cursor. With a player selected, staff
can teleport them there (RCON, audit-logged).
