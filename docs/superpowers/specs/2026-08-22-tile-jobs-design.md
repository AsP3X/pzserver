# Tile jobs: regional re-render as the primitive

The isometric pack is a 24 GB SQLite file of DZI tiles. Today a change
anywhere means hours of full render, or a cell-based `map-tiles-region` that
was bolted on after the fact. Later we will want to refresh player-built
structures and game-file patches without touching the rest of Knox County.

This sitting makes a **tile job** the only unit of work. Callers pass world
squares (cells as a helper). The planner expands those to whole DZI tiles.
The runner paints only the covering cells, replaces only those rows in the
live pack, and leaves the map up. CLI and a small admin API share that runner.

Player-building detection, workshop diffs, and an admin page are out of scope.
They later emit squares into this pipeline.

Related: `docs/map-tiles.md`, `turn-over.md`,
`docs/superpowers/specs/2026-08-20-local-map-tiles-design.md`.

## Architecture

```
squares or cells
        │
        ▼
    planner ──► dirty tiles (every packed level)
                restore tiles (merge siblings)
                render cells (covering, whole tiles)
        │
        ▼
    runner (map-tiles container)
        unpack restore tiles
        delete / omit dirty tiles
        render those cells
        pack only dirty keys (WAL, in place)
        bump generated_at
        │
        ▼
    live map  (web-api stays up; client fetches ?v=generated_at)
```

pzmap2dzi still paints **cells**. We do not change that. The planner is the
translation: callers speak game squares; the pack speaks `(z, x, y)`; the
renderer gets the cell box that fully covers those tiles.

Full-map `make map-tiles` is the same runner with an empty dirty set meaning
“everything”: no restore, no `--only`, VACUUM only on that path.

## Rules

These are correctness constraints, not style. Breaking one of them re-introduces
black rectangles, a downed site, or a silent no-op. Copy the short form into
`docs/map-tiles.md` when this ships.

### Do

1. **Speak squares (or cells as a helper).** Public contract is a game-world
   rectangle in squares — the same coords as pins. A cell is
   `x*256, y*256, 256, 256`. Both become DZI tiles internally.
2. **Expand to whole tiles before rendering.** `render_cell_range` paints only
   the cells it is handed. A tile that straddles the edge comes back
   part-drawn and part-black. `expand_to_whole_tiles` is mandatory. Measured:
   tile `20/134_59` went from 12.5% black to 62.4% when this was skipped.
3. **Dirty every packed ancestor.** A level-20 change without rebuilding
   19…0 leaves zoom-out stale or black. Dirty set is the covering tiles at
   max packed level plus every parent down to 0.
4. **Restore merge siblings, never dirty tiles.** Parents merge four children
   from disk. Missing siblings → three-quarters black. Dirty tiles must stay
   *absent* so pzmap2dzi does not skip them.
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

### Do not

1. **Do not stop `web-api` for a region.** That takes the whole site down
   (nginx resolves `web-api` at start and crash-loops). The old “stop because
   Windows locks the filename” rule applied to *renaming* the pack, which we
   no longer do.
2. **Do not rename `tiles.sqlite` while it is open.** That is the Windows
   filename reservation trap. In-place UPDATE only.
3. **Do not VACUUM a region.** VACUUM rebuilds the 24 GB file beside itself.
   It is for a full first pack only.
4. **Do not restore dirty tiles.** pzmap2dzi treats an existing `.jpg` as
   done. Restoring the hole makes the run a no-op.
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
10. **Do not detect player buildings or game patches in this sitting.** Those
    later emit squares into this pipeline. Do not invent a second render path
    for them.

## Components

### Planner

Extend `web/tools/map-tiles/cells.py` and `region.py`.

Input: world-square rects, and/or cell rects.

Output, three lists:

| File | Meaning |
|---|---|
| `dirty.txt` | `(z,x,y)` to redraw, every packed level |
| `restore.txt` | merge siblings, minus anything already dirty |
| `render_cells.txt` | cell box that fully covers dirty level-20 tiles |

`make map-tiles-region CELLS=…` stays as the cell helper. New:
`SQUARES="x,y,w,h"` (same `x,y` or `x,y,w,h` grammar, semicolon-separated).

### Runner

Same `map-tiles` compose service (`profiles: [tools]`, `shm_size: 24gb`).
`run.sh` reads `PZ_MAP_SQUARES` and/or `PZ_MAP_CELLS`.

Order: plan → unpack restore → render covering cells → cache gate →
geometry gate → pack dirty keys → checkpoint WAL → bump `generated_at`.

### Live pack

`pack.py --replace --only <dirty.txt>` UPDATEs those blobs. Enable WAL on
open. After the last batch, `PRAGMA wal_checkpoint(TRUNCATE)`. No VACUUM.
`generated_at` is always set on a region pack.

web-api mount: `${PZ_MAP_TILES_HOST}:/map-tiles` **without** `:ro`.

### Job API

Postgres table `map_tile_jobs`:

- `id` UUID
- `squares` / `cells` JSON (what was asked)
- `status` `queued` | `running` | `done` | `failed`
- `error` text, nullable
- `tiles_replaced` int, nullable
- `created_at`, `started_at`, `finished_at`

Routes (admin auth, audit on POST):

- `POST /api/v1/admin/map-tiles/rerender`  
  Body: `{ "squares": [[x,y,w,h], …] }` and/or `{ "cells": [[x,y,w,h], …] }`  
  → `202 { id, status }`
- `GET /api/v1/admin/map-tiles/jobs/{id}` → the row

Empty/malformed → `400`. Container `pz-map-tiles` already running → `409`.
Unknown id → `404`.

The API starts the one-shot container through the existing Docker socket
proxy (`CONTAINERS`+`POST` are already enabled). It does **not** use
`DockerClient`, which is wired only to the game server. Env and binds match
compose: image `pzserver-map-tiles:local`, `/pz`, texture packs, `/out`,
`shm_size`, `PZ_MAP_SQUARES` / `PZ_MAP_CELLS`.

No new admin page.

## Data flow

1. Accept squares and/or cells. Insert job `queued`. Spawn container. Return
   `202`.
2. Planner reads `map_info.json` (same `x0`/`y0`/`sqr` as `ISO_DZI`). Build
   dirty / restore / render-cells.
3. Unpack only restore keys. Dirty keys stay absent.
4. `render_cell_range` = covering cells. `dzi_cell_range` unchanged.
5. Paint. `check_cache.py`. `verify.py`.
6. Pack `--replace --only dirty`. WAL checkpoint. `generated_at = now`.
7. web-api’s next tile read is the new JPEG. Client meta `?v=` on next paint
   or reload. A few seconds of mixed old/new tiles in a viewport is accepted.
8. Container exit 0 → job `done` + `tiles_replaced`. Non-zero → `failed` +
   error. Audit already written on POST.

## Error handling

Fail before paint when: no pack, no `map_info.json`, no textures, bad input,
geometry mismatch, cache ceiling, or another job running.

Interrupted render: next start deletes `.pending` with its `.jpg`. Pack is
commit-then-unlink in batches of 500; a kill leaves a mixed dirty set; re-run
the same job.

WAL checkpoint failure: committed pages are already in the main file; log it,
do not roll back painted tiles.

Docker/proxy failure after the row exists: job `failed`, not a 500 on a later
poll. The API does not 500 because the game server is down.

## Testing

No live pzmap2dzi render in CI.

**Planner.** Square rect → covering level-20 tiles that overlap the DZI box.
Cell rect ≡ `x*256, y*256, 256, 256`. Dirty set includes ancestors 20→0.
Restore = four children minus dirty. `expand_to_whole_tiles` regression for a
straddling cell.

**Packer.** `--replace --only` updates named rows; every other blob is
byte-identical. Full pack still skip-on-conflict and VACUUMs; region path does
neither. `generated_at` written on a region pack.

**API.** Squares POST → `202` and a row. Empty/bad → `400`. Second POST while
the container is running → `409`. Unknown job → `404`. Audit on POST.

## Files

| Piece | Role |
|---|---|
| `web/tools/map-tiles/cells.py` | Square↔tile projection, expand, merge siblings |
| `web/tools/map-tiles/region.py` | Plan dirty / restore / render-cells |
| `web/tools/map-tiles/pack.py` | `--only`, WAL, no VACUUM on replace |
| `web/tools/map-tiles/unpack.py` | Restore merge inputs (already `--only`) |
| `web/tools/map-tiles/run.sh` | `PZ_MAP_SQUARES` + existing `PZ_MAP_CELLS` |
| `Makefile` / `make.ps1` | `SQUARES=` as well as `CELLS=` |
| `docker-compose.web.yml` | web-api map-tiles mount writable |
| `web/api` jobs + admin routes | `202` POST, GET status, spawn container |
| `docs/map-tiles.md` | Operator copy of the rules |

Client tile URLs already carry `?v=generated_at`. No client change required
beyond meta already exposing that field.

## Out of scope

- Detecting player-built structures or save-game diffs
- Watching workshop / vanilla map file changes
- An admin UI for jobs
- Moving the pack onto a named volume
- Dropping `omit_levels` or re-rendering 21–22 onto disk
