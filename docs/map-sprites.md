# Sprite isometric map (parallel to the JPEG pack)

The website still has the photographed DZI pack (`docs/map-tiles.md`). This
document is the **other** isometric path: native texture-pack sprites, placed
by lotpacks, drawn only for squares on screen — the way the game draws.

The JPEG pack is untouched. URLs, `tiles.sqlite`, and `make map-tiles*` stay.

## Modes

| Toggle | Source |
|--------|--------|
| Schematic | vector JSON |
| Isometric | JPEG DZI pack |
| Sprites | atlas + occupancy + cell thumbs |

Sprite mode appears once `GET /api/v1/map-sprites/meta` says `ready: true`.

## Bake

Needs the **same texture packs** as `make map-tiles`. The dedicated server
download has `media/maps` (cells) but **not** `media/texturepacks`. Copy them
from a Project Zomboid **client** once:

```bash
# On the machine that has Steam (client install):
#   Windows:  .../Steam/steamapps/common/Project Zomboid/media/texturepacks
#   Linux:    ~/.steam/steam/steamapps/common/ProjectZomboid/media/texturepacks

# Example: copy the *.pack files onto the game server host
scp -r "/path/to/texturepacks/"*.pack \
  user@gameserver:/home/corespace/docker/gameserver/pzserver/data/server/media/texturepacks/

# On the game server
ls data/server/media/texturepacks/*.pack   # should list ~20+ files
make map-sprites
```

If the packs already live next to a client on that host, set in `.env`:

```
PZ_TEXTUREPACKS_HOST=/path/to/ProjectZomboid/media/texturepacks
```

Writes `sprites.sqlite` on the `pz-map-sprites` volume (`/sprites` in the
renderer, `/map-sprites` in web-api). Does not write `tiles.sqlite`. After a
successful bake, recreate `web-api` so it opens the new file, then use
**Sprites** on the map.

## API

All under `/api/v1/map-sprites/`. Public, like tiles.

- `GET /meta` — `ready`, z range, page count
- `GET /sprites` — UV + offset catalogue
- `GET /atlas/{page}` — PNG sheet
- `GET /cells/{cx}_{cy}` — occupancy blob
- `GET /thumbs/{cx}_{cy}` — far-zoom cell stamp

## Quality

Street zoom blits native sprites, all lotpack z stacked. County zoom draws
cell thumbnails baked from those same sprites, not the paper map.
