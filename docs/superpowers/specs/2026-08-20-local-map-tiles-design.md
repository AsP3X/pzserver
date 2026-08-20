# Local isometric map tiles

The isometric basemap fetches its tiles from `tiles.pzmap.org`. That host is a
community service standing in for the map The Indie Stone took off their own
servers on 7 August 2026, it sits behind Cloudflare, and it has already moved
once this month. Every player looking at the map is traffic someone else pays
for, and an outage there blanks our map.

The game files that pyramid was rendered from are already on the server.
`pzmap2dzi` — the same tool pzmap.org runs — turns them into the same tiles.
So: render once, keep the result, serve it ourselves, and stop calling out.

After this, the map works with no internet connection at all.

## Sizing

Measured against the live pyramid, not estimated. Level 22 was sampled at 30
grid positions spread across its 1133 × 498 grid.

| Fact | Value |
|---|---|
| Grid positions, levels 8–22 | 752,910 |
| Level 22 positions that 404 | ~53% — pzmap2dzi emits nothing for empty regions |
| Tiles that exist and are populated | 64%, averaging 890 KB |
| Tiles that exist and are sparse | 36%, averaging 24 KB |
| Mean over tiles that exist | 581 KB |

Depth is the dominant cost. Level 22 alone is 75% of the pyramid.

| Range | Real tiles | Disk |
|---|---|---|
| 8–19 | ~7,000 | ~4 GB |
| **8–20** | **~27,000** | **~15 GB** |
| 8–21 | ~98,000 | ~54 GB |
| 8–22 | ~360,000 | ~200 GB |

**Levels 8–20.** `DEFAULT_ISO_SCALE = 0.35` resolves to level 20, so the view
you get when centring on a survivor is native. Deeper zoom upscales.

## Generation

A `map-tiles` service in `docker-compose.web.yml` under a non-default profile,
so it never starts with the stack. `docker compose run --rm map-tiles`, wrapped
by a `map-tiles` target in both `Makefile` and `make.ps1`.

| Mount | Mode | Purpose |
|---|---|---|
| `data/server/media` | read-only | Map cells the render reads |
| `data/map-tiles` | read-write | Output |

```
media/maps/{Muldraugh KY, Riverside, …}
    │  pzmap2dzi, levels 8–20
    ▼
loose DZI tree ──pack──▶ tiles.sqlite
    │
  deleted as it packs
```

**The pack deletes as it walks.** Holding the whole loose tree and the finished
database at once costs ~30 GB for a 15 GB result. Inserting a tile then
unlinking its file keeps the peak near 15 GB.

**The target is resumable.** The render takes hours and a machine can be
rebooted. A re-run continues rather than starting over; pzmap2dzi is already
incremental, and the pack step skips `(z, x, y)` rows that exist.

## Store

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

`WITHOUT ROWID` because the primary key is the only lookup and a second index
would be dead weight across 27,000 rows of blob.

Grid positions with no tile have no row. Absence is the answer, not a sentinel.

`meta` holds `game_version`, `min_level`, `max_level`, `tile_size`, `width`,
`height`, `generated_at`, `tile_count`.

## Serving

```
GET /api/v1/map-tiles/{z}/{x}_{y}.jpg
```

| Case | Response |
|---|---|
| Row exists | `200`, `image/jpeg`, `Cache-Control: public, max-age=604800` |
| No row | `404`, empty body |
| No `tiles.sqlite` | `404`, empty body |

Public, like the rest of the map surface. A tile is not a secret.

`rusqlite` is already a workspace dependency — `pz-bridge` uses it — so this is
a module and a route, not a new library. One read-only connection, opened once
and shared.

Not `immutable`: the URL carries no version, so a re-render for a new game build
returns different bytes at the same path. A week of staleness after a re-render
is the accepted cost of keeping the URL simple.

`web-api` gains a read-only mount of `data/map-tiles`.

## Client

`ISO_TILE_URL` becomes the relative `/api/v1/map-tiles/{z}/{x}_{y}.jpg`.
`ISO_TILE_HOST` goes.

Levels 21 and 22 return 404. `IsoTileCache.ancestor()` already walks up the
pyramid for the nearest loaded parent and crops it to the child's rectangle, so
deep zoom goes soft rather than blank. No change needed there.

`unreachable` needs no change for deep zoom: it requires *nothing* loaded all
session, and anyone zooming past 20 has already loaded level 20 tiles, so 404s
at 21 and 22 cannot trigger a false fallback to the schematic.

An empty store is the other case, and it does trip `unreachable` — correctly,
since there is genuinely nothing to draw. Only the wording is wrong, which is
what the meta endpoint below fixes.

CSP loses its last external host:

```
img-src 'self' data:
```

## Meta endpoint

```
GET /api/v1/map-tiles/meta
→ { "generated": true, "min_level": 8, "max_level": 20, "game_version": "42.20.0" }
```

Two jobs. Clamp `levelForScale` to `max_level`, so deep zoom stops requesting
tiles that can never exist. And distinguish *not generated yet* from *not
answering* — before the first render every tile 404s, which trips `unreachable`
and shows "Isometric tiles are not answering", which would be a lie.

`{ "generated": false }` when the file is absent.

## Out of scope

- Levels 21 and 22. Upscaling covers them.
- Any fallback to `tiles.pzmap.org`. The point is to stop calling it.
- A panel page for generation. The make target is the interface for now; the
  backups job pattern is there if this later deserves a button.
- Workshop map mods. `Map=Muldraugh, KY` is vanilla Knox County. Adding a map
  mod means a re-render, and nothing here prevents that.

## Unknowns to settle in implementation

- **pzmap2dzi's flags** for capping levels and choosing output format. Confirm
  against the version installed; do not assume.
- **Render duration.** Hours on CPU, but the first run is the measurement.
- **Whether the pack is Python or Rust.** Python keeps it in the container that
  already has the tree; either is fine.
