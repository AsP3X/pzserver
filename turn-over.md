# Turn-over: black holes in the isometric map tiles

Written 2026-08-22 for whoever picks this up next. It covers the map-hole
investigation end to end: what the bug was, every wrong theory chased on the way
(with the evidence that killed each one), what was built, and what is left.

**Current state: fixed and live.** The map is rebuilt, verified, and serving. The
remaining work is cleanup and a few judgement calls, listed at the bottom.

Related docs:
- `where-we-left-off.md` — running task list, same story in less detail
- `docs/map-tiles.md` — operator documentation
- `docs/superpowers/plans/2026-08-20-local-map-tiles.md` — the original plan

---

## The symptom

Solid black rectangles with hard, axis-aligned edges scattered across the
isometric basemap, in the middle of otherwise fully-painted terrain. They got
worse the further you zoomed out, until at low zoom most of the map was black.

Reported at, among others, world `14355,7766`, `2447,13014`, `5951,11269`,
`10289,15122`, `13535,15170`, `16564,14219`, `12733,6032`, `17804,4576`,
`15647,4098`.

---

## THE ROOT CAUSE

`web/tools/map-tiles/conf.yaml` sets `omit_levels: 2`. Levels 21 and 22 are
therefore **rendered but never written to disk** — they exist only in a
shared-memory tile cache, and level 20 is *merged* from level 21, which is
merged from 22.

When that cache fills, the scheduler evicts to make room:

```python
# pzmap2dzi/scheduling.py:148
if self.cache_size:
    while self.cache_used > self.cache_size:
        self.release_cache(None, 'save')
```

`release_cache(key, 'save')` asks the worker to save the tile. But:

```python
# pzmap2dzi/pzdzi.py:127
if not write_all and level >= self.levels - self.skip_level:
    return 'skip'
```

For exactly the omitted levels, `save_tile` returns `'skip'` — it writes
nothing. **So evicting one of those tiles destroys it.** Its level-20 parent is
then merged with a missing quadrant, which comes out black. That black
propagates upward, diluted by a factor of four per level, which is why the
damage looked worse when zoomed out.

Measured, same map, same code, only `cache_limit_mb` differing:

| `cache_limit_mb` | `shm_size` | Peak cache | Result |
|---|---|---|---|
| `0` (unbounded, the default) | 4 GB | hit the shm wall at 3744 MB | workers died silently, render stalled at 0% CPU |
| `4096` | 8 GB | **4112 — at the ceiling** | ~13,000 tiles destroyed, holes everywhere |
| `16384` | 24 GB | **5760 — 10 GB spare** | no eviction, no holes |

The fix is simply that the cache must never fill. It is not a performance knob;
it is a correctness one.

### The gate that makes it permanent

`web/tools/map-tiles/check_cache.py` runs in `run.sh` **before anything is
packed**, and fails the run if the peak comes within 5% of the limit, naming the
two settings to raise. Absence of the report also fails.

This matters more than the setting itself, because **every other signal stayed
green through 13,000 destroyed tiles**: exit code 0, the geometry gate,
`PRAGMA quick_check`, and the pack completing normally. The damage was only ever
visible in pixels.

---

## Wrong theories, and what disproved them

Chased in order. Recorded so nobody spends the time again.

### 1. "The interrupted run left half-drawn tiles" — partly true, not the cause

A worker killed mid-render leaves a `.pending` marker beside a **complete, valid
JPEG that is only partly painted**. During an earlier stall the `.pending`
markers were deleted by hand while the `.jpg` files were kept, so the resumed
run saw finished tiles and skipped them. That really did bake one hole in
permanently.

**Disproved as the general cause:** a later clean, uninterrupted render produced
the same holes.

Still worth having fixed — `run.sh` now deletes `.pending` markers together with
their `.jpg`, so an interrupted run self-heals.

### 2. "Client and server game builds have drifted" — wrong, and a wasted user request

The render logged `missing texture [...]` and `missing tile: camping_04_16`, and
the Steam build IDs differed (client `24775755`, server `24775771`). The user was
asked to verify their game install on the strength of this.

**Disproved:** those are two *different Steam apps* — client is 108600, dedicated
server is 380870 — with independent build numbering, so the comparison was
meaningless. And the missing tile indices form a regular grid pattern
(1,2,3 / 16,17,18 / 33,34,35 …), which is what empty slots in a tilesheet look
like. `camping_04` *is* present in `Tiles2x.pack`.

**Nothing needs updating.** Ignore `missing tile:` lines; they are noise.

### 3. "The texture cache is stale/incomplete" — wrong

`data/map-tiles/texture` is reused between runs (`hash unchanged, skip`), so a
partial extraction would persist forever.

**Disproved:** a fresh extraction into an empty directory produced *exactly* the
same 39,909 textures, and `camping_04_16.png` was absent from both. Keeping the
texture cache across runs is safe and saves the extraction step.

### 4. "Cache misses mean lost tiles" — wrong, and a bad gate was built on it

The first version of `check_cache.py` failed any run with a cache miss.

**Disproved:** `merge_tile` falls back to `load_tile` on a miss, which recovers
any tile that *was* written to disk. A good render and a bad one both missed
~3.7% (96.29% vs 96.26% hit rate). The miss rate is not the signal — the **peak
against the limit** is, because reaching the ceiling is what triggers eviction.

### 5. "The map data is missing for that cell" — wrong

**Disproved:** cell `56_30` has `56_30.lotheader` (6 KB) and
`world_56_30.lotpack` (1.1 MB), comparable to cells that render perfectly.

### 6. "712 tiles are still holed after the fix" — wrong, they are the map edge

A blackness scan flagged 712 level-20 tiles as partially black.

**Disproved:** they follow `x+2, y±1` coordinate diagonals with blackness values
repeating exactly (76.6% across ten tiles), and inspecting two of them shows
clean **diagonal** boundaries — water below one, a road and grass along another.
That is the isometric map diamond, legitimately void.

**How to tell them apart:** real holes have **axis-aligned rectangular** edges;
map edges are **diagonal**. The distribution is the giveaway too — 15,410 of
16,092 level-20 tiles are under 10% black, and everything above sits on the
boundary.

---

## Other bugs found and fixed on the way

These were real, are fixed, and are unrelated to the holes.

| Bug | Symptom | Fix |
|---|---|---|
| No texture packs on the dedicated server | Every tile untextured; the geometry gate passes anyway | `PZ_TEXTUREPACKS_HOST` mount + fail-fast guard in `run.sh` (`30b1bc6`) |
| `/dev/shm` defaulted to 64 MB | 16 workers × 16 MB buffers → silent worker death, 0% CPU stall | `shm_size` (`74539d0`) |
| Packer read levels from directory names | `min_level 0, max_level 22` for a pack holding 12–20, which disabled the client's zoom clamp entirely | Derive from the tiles table (`acc7fd8`) |
| Single `Mutex<Connection>` in the API | All tile reads serialised; concurrency gave 1.0× speedup | Pool of 8 read-only connections — viewport **2.7× faster** (`87bdf47`) |
| Client tile cache evicted in-flight requests | Zoom fast and the top half of the map never loads | Evict only settled entries (`f1c6990`) |
| VACUUM after every repack | 40+ minutes to reclaim nothing after a 59-row update | Skipped when `--replace` (`53e3fc1`) |
| `tee` for the cache gate | Python block-buffers stdout, blinding live monitoring | `PYTHONUNBUFFERED=1` (`7ec6eb6`) |

---

## Traps that will bite you

**`web-api` must be stopped before packing.** It holds 8 open descriptors on
`tiles.sqlite` (the connection pool). On Windows those reserve the *filename*, so
after renaming the old pack aside, `touch tiles.sqlite` fails with
`No such file or directory` while `zzz.sqlite` works fine. The pack then dies
with `unable to open database file` — **after hours of rendering**. This
happened twice.

**Stopping `web-api` takes the whole site down, not just the map.** nginx
resolves upstreams at startup and fails hard, so if `web-ui` restarts while
`web-api` is down it crash-loops on `host not found in upstream "web-api"` and
never recovers on its own. Restart `web-ui` after bringing `web-api` back.

**The pack is safe to interrupt.** It commits in batches of 500 and only unlinks
a tile after its row is committed. A kill leaves a hot journal; opening the
database **read-write** lets SQLite roll back, after which `PRAGMA quick_check`
returns `ok`. Re-running resumes and skips stored tiles. Verified: after one kill,
15,134 packed + 6,592 loose = 21,726 exactly.

**Docker Desktop's bind mount is ~30× slower than the host filesystem** for
random I/O into the 24 GB pack: 144 ms per miss vs 4.8 ms. This is a Windows
dev-environment problem; a Linux server bind-mounts natively. `cache_size` and
`mmap_size` pragmas make no difference — the working set is far too large.

**`curl` inside a `while read` loop steals the loop's stdin** and returns `000`
for every request. Redirect with `< /dev/null`. This produced a false "tiles
aren't serving" report.

---

## What was built

All under `web/tools/map-tiles/`, **33 tests passing** (`python -m pytest`).

| File | Purpose |
|---|---|
| `check_cache.py` | **The gate.** Fails the run if the cache came within 5% of its limit |
| `audit.py` | Pyramid completeness — every tile with children must have a parent, down to level 0 |
| `verify.py` | Geometry gate (pre-existing) — `x0`/`y0`/`sqr` must match `ISO_DZI` |
| `pack.py` | Tree → SQLite. `--replace` for re-renders; skips VACUUM in that mode |
| `unpack.py` | SQLite → tree. `--only` restores just the merge inputs by key |
| `cells.py` | Cell rect ↔ tiles, same projection as the client's `worldToDzi` |
| `region.py` | Plans a regional re-render: what to redraw, what to restore |
| `set_render_range.py` | Patches `render_cell_range` (inserts it if absent) |
| `levels.py` | Reports a pack's level range |

### Regional re-render — works, and is the answer for future map updates

```bash
make map-tiles-region CELLS="34,30,4,4"     # x, y, w, h in map cells
.\make.ps1 map-tiles-region 34,30,4,4
```

Minutes rather than hours. Uses pzmap2dzi's `render_cell_range`, which renders a
subset while leaving `dzi_cell_range` — and therefore the pyramid geometry and
every tile index the client computes — untouched.

**Critical detail:** the requested cells are **widened to cover whole tiles**
before rendering. `render_cell_range` paints only the cells it is handed, so a
tile straddling the edge of the request comes back part-drawn and part-black. An
early version fixed one hole and cut a bigger one — tile `20/134_59` went from
12.5% black to 62.4%. See `expand_to_whole_tiles` in `cells.py`.

**Stop `web-api` first** (see traps above).

---

## Verifying a render — do not trust the exit code

In order:

```bash
# 1. the cache gate (run.sh does this automatically, before packing)
python web/tools/map-tiles/check_cache.py <render.log> 16384
#    -> "cache peaked at N MB of 16384 MB - nothing evicted"

# 2. pyramid completeness
python web/tools/map-tiles/audit.py data/map-tiles/tiles.sqlite
#    -> "pyramid is complete: every tile with children has a parent"

# 3. pixels, not bytes — decode a known tile and count black
#    reference: 20/178_69 and the eight others listed at the top

# 4. the API is serving the NEW pack
#    compare served bytes against both packs; pick a tile that DIFFERS
#    between them, or the test proves nothing
```

Step 4's caveat is real: the first attempt at it used tile `20/178_69`, which was
byte-identical in both packs because it had been hand-patched earlier. It
"passed" for the wrong reason.

---

## Current state (2026-08-22)

| | |
|---|---|
| Pack | `data/map-tiles/tiles.sqlite`, 24.40 GB, **21,726 tiles, levels 0–20** |
| Audit | `pyramid is complete` |
| Integrity | `ok` |
| The nine reported holes | **all 0.0% black** |
| Serving | levels 0–20 all `200` with matching bytes; 21 → `404` |
| Cache peak | 5760 MB of 16384 — nothing evicted |
| Rollback | `data/map-tiles/tiles.sqlite.old`, 24.39 GB, **still present** |
| Branch | `map-tiles-local`, 45 commits ahead of origin, **unpushed, unmerged** |

Browsers need a hard reload (Ctrl+Shift+R) — tiles carry
`Cache-Control: public, max-age=604800`.

---

## What is left

1. **User confirmation of the visual result**, then `rm data/map-tiles/tiles.sqlite.old`
   to reclaim 24 GB. Not deleted yet on purpose.

2. **`docs/map-tiles.md` sizing table is wrong.** It says levels 8–20, ~27,000
   tiles, ~15 GB result, ~25 GB free needed. Actual: **levels 0–20, 21,726 tiles,
   24.4 GB**, and VACUUM writes its rebuild *beside* the database, so peak free
   space needed is closer to **50 GB**. The doc also predates
   `PZ_TEXTUREPACKS_HOST`, `shm_size`, `cache_limit_mb`, `check_cache.py`,
   `audit.py` and the regional re-render.

3. **Consider dropping VACUUM from the full-pack path.** It takes over an hour on
   24 GB and doubles peak disk, to reclaim almost nothing — the packer only ever
   INSERTs in key order. Already skipped for `--replace`.

4. **Automate the `web-api` stop/start around packing**, or document it
   prominently. It has caused two multi-hour failures.

5. **Client zoom clamp only bounds the maximum.** `levelForScale` clamps to
   `renderedMaxLevel` from meta but the minimum is still `ISO_DZI.minLevel` (8).
   Harmless now that the pack starts at level 0, but a pack with a higher
   `min_level` would blank on zoom-out with no ancestor to fall back to.

6. **Branch is 45 commits ahead and unpushed**, and carries unrelated work (shop
   item picker, a `cargo fmt`/clippy sweep). Merge strategy undecided.

---

## If holes come back

1. Check the render log for `cache max used:` against `cache_limit_mb` in
   `conf.yaml`. Within 5% means eviction ran and tiles were destroyed. Raise
   `cache_limit_mb` **and** `shm_size` above it, then re-render.
2. Run `audit.py`. Missing parents mean the merge did not finish.
3. Decode the suspect tile and look at it. Axis-aligned rectangular black is a
   hole; diagonal black is the map edge and is correct.
4. To repair a specific area without a full render, use
   `make map-tiles-region CELLS="x,y,w,h"` — with `web-api` stopped.
