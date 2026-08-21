# Where we left off

Running list of open work, grouped under the main task it belongs to. Newest
main task first. Update the date when you touch it.

**Last updated:** 2026-08-21

## Orientation

| Branch | Contains | Remote |
|---|---|---|
| `main` | — | in sync |
| `rust-web-stack` | shipped work, plus the tile spec and plan | in sync at `b5de35f` |
| `map-tiles-local` | tile work in progress, plus the shop item picker | **ahead of remote**, see below |

`map-tiles-local` has drifted: on top of the tile work it also carries the shop
item picker (`f4da88e`..`0e7e936`) and a `cargo fmt` / clippy sweep (`47dea21`,
`1e12410`). Unrelated to tiles; do not be confused by them.

### Status vocabulary used below

| Mark | Meaning |
|---|---|
| `[x] DONE` | Written, tests run and green, committed. Commit hash given. |
| `[~] TEST PENDING` | Code committed, but a listed check has not been run yet. |
| `[ ] OPEN` | Not started. |

Every task records what was actually run and what it printed, so the next
session does not have to re-derive it.

Windows host has no `make`; use `.\make.ps1 <target>`. All compose commands take
the same three files:

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml
```

---

## 1. Local isometric map tiles — IN PROGRESS

Render the basemap from the server's own game files instead of pulling every
tile from `tiles.pzmap.org`, pack it into one SQLite file, serve it from our own
API. After this the map works with no internet at all.

- **Spec:** `docs/superpowers/specs/2026-08-20-local-map-tiles-design.md`
- **Plan:** `docs/superpowers/plans/2026-08-20-local-map-tiles.md` — 8 tasks,
  each with full code and exact commands
- **Branch:** `map-tiles-local`
- **Shape:** levels 8–20, ~27,000 tiles, ~15 GB, no CDN fallback at all

### Done

- [x] **DONE — Task 1: render container and geometry gate** (`9faae33`, `421a25e`)
      Image builds, config written, gate passes on a real render and rejects a
      shifted `x0`, a halved `sqr`, a missing cell rect and a half-height map.

- [x] **DONE — Task 2: pack the DZI tree into `tiles.sqlite`** (`bf34edf`)
      `pack.py` + `test_pack.py`. Written test-first; the test failed with
      `ImportError: cannot import name 'pack' from 'pack'` before the
      implementation, as the plan predicted.

      **Test: PASSED.** `cd web/tools/map-tiles && python -m pytest test_pack.py -v`
      → `2 passed in 0.06s` (host python 3.11.15, pytest 9.1.1 — no container
      needed for this one).

      **Deviation from the plan, deliberate:** the plan sorted level directories
      with `sorted(tiles_dir.iterdir(), key=lambda p: int(p.name))` and filtered
      non-directories *after* the sort. The sort key runs first, so one stray
      non-numeric entry in `layer0_files/` would crash the pack at the end of an
      hours-long render. Replaced with a `_level_dirs()` generator that filters
      to numeric directories before sorting. Same behaviour, no cliff.

      Also added `__pycache__/` to `.gitignore`. `.pytest_cache/` needs no entry
      — pytest writes a self-ignoring `.gitignore` inside it.

- [x] **DONE — Task 3: compose service and make targets** (`3259a5b`)
      `run.sh` written, `map-tiles` service added to `docker-compose.web.yml`
      behind the `tools` profile, read-only `/map-tiles` mount added to
      `web-api`, and a `map-tiles` target in both `Makefile` (plus `.PHONY` and
      the help block) and `make.ps1` (`Do-MapTiles`, the switch arm, the help
      line).

      **Checks: PASSED.** No unit test exists for this one; the plan's own
      verification commands were run instead.
      - `docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml config` → `compose OK`
      - `config --services` without the profile → 8 services, **no `map-tiles`**,
        so a normal `up` cannot start it
      - `config --profiles` → `caddy`, `tools`
      - `--profile tools config --services | grep -c map-tiles` → `1`
      - resolved `web-api` mount → `data\map-tiles → /map-tiles`, `read_only: true`

      **Not yet exercised:** the image has not been rebuilt since `run.sh` stopped
      being an empty placeholder. `make map-tiles` builds before it runs, so
      Task 8 covers it — but that means Task 8 is the first time `run.sh`
      actually executes.

      **Tidy-up while in there:** `conf.yaml` still carried a Task 1 `TODO` and a
      guessed output path (`/out/map_data/default/base/…`) directly above the
      verified one. Removed the stale pair; the verified layout stands alone.

- [x] **DONE — Task 4: Rust store module** (`6d43698`)
      `services/map_tiles.rs` — `MapTiles::open` / `.tile()` / `.meta()`, one
      mutex-guarded read-only connection read through `spawn_blocking`.
      Registered in `services/mod.rs`. Added `rusqlite 0.32 (bundled)` to
      `pz-api` (matching `pz-bridge`, so the workspace resolves one copy) and a
      new `[dev-dependencies]` block with `tempfile = "3"`.

      Written test-first: with only the test module present, `cargo test` failed
      with `E0425: cannot find type MapTiles in this scope`, as the plan said it
      would.

      **Test: PASSED.** `cd web/api && cargo test --workspace map_tiles` →
      `4 passed; 0 failed` — stored tile served, absent tile is `None` not an
      error, missing file reads as "not generated", meta reports 8–20 / 42.20.0.
      `cargo fmt --check` clean.

      **Deviation from the plan, forced:** the plan typed `tile()` as
      `anyhow::Result<…>`, but **`anyhow` is not a dependency anywhere in this
      workspace** and adding one is a dependency change nobody approved. Used
      the crate's own `ApiResult`/`ApiError::Internal` instead, which is what
      every other service here returns. The two error paths — `spawn_blocking`
      join failure and the rusqlite read — are mapped explicitly, replacing the
      plan's `.await??`. Task 5's route code needs no change for this: it
      already matches on `Ok`/`Err` and prints `%error`, and `ApiError` is
      `Display`.

- [x] **DONE — Task 5: API routes** (`9cc4d39`)
      `routes/map_tiles.rs` — `GET /api/v1/map-tiles/meta` and
      `GET /api/v1/map-tiles/{z}/{tile}`. `map_tiles_path` added to `config.rs`
      (`MAP_TILES_PATH`, default `/map-tiles/tiles.sqlite`), the store held on
      `AppState`, routes merged into the `fast` router.

      **Tests: PASSED.** `cargo test --workspace` → **176 passed, 0 failed**
      (72 pz-api — two new `parse_tile` cases — + 100 + 4).
      `cargo clippy --all-targets --all-features -- -D warnings` → clean.
      `cargo fmt --check` → clean.

      **Live check against the running stack: PASSED.** Rebuilt and restarted
      `web-api`, then:
      - `curl /api/v1/map-tiles/meta` →
        `{"generated":false,"min_level":null,"max_level":null,"game_version":null}`
      - `curl -o /dev/null -w %{http_code} /api/v1/map-tiles/20/3_4.jpg` → `404`
      - malformed names `3_4.png`, `a_b.jpg`, `3-4.jpg` → `404` each, not 500
      - start-up log → `no map tile store; iso basemap unavailable
        path=/map-tiles/tiles.sqlite`
      - `/map-tiles` is mounted in the container and `touch` inside it fails
        with `Read-only file system`

      That `generated:false` / `404` pair is the **correct** pre-render state,
      not a failure. It flips once Task 8 runs.

- [x] **DONE — Task 6: point the client at it** (`f8d327c`)
      `ISO_TILE_URL` is now the relative `/api/v1/map-tiles/{z}/{x}_{y}.jpg`,
      `ISO_TILE_HOST` deleted (`grep -rn ISO_TILE_HOST web/ui/src` → no
      matches), and CSP `img-src` is down to `'self' data:` — no external host
      anywhere in `security-headers.conf`.

      **Checks: PASSED.** `npx tsc -b` clean, `npm run lint` exit 0 (the
      warnings it prints are all pre-existing, none in the touched files),
      `npm run build` → `✓ built in 4.20s`.

      **Note:** Task 7's level clamp and `loadTileMeta` are in this same commit,
      because the plan puts both edits in `iso-tiles.ts` and they cannot be
      split across two commits without splitting the file.

- [x] **DONE — Task 7: clamp zoom to what was rendered** (`c7c133f`, plus the
      `iso-tiles.ts` half in `f8d327c`)
      `renderedMaxLevel` + `setRenderedMaxLevel()` + `loadTileMeta()` in
      `iso-tiles.ts`; `levelForScale` now clamps to it. `worldmap.tsx` reads the
      meta once on mount and shows `map.iso_not_generated` instead of
      `map.iso_unavailable` when the store has never been rendered. New key
      added to `en.json` and `de.json` in `map.` order.

      **Checks: PASSED.** Both locale JSON files parse, `npx tsc -b` clean,
      `npm run lint` exit 0, `npm run build` clean.

      **TEST PENDING — the browser console assertions.** The plan's Task 7 Step 1
      and Step 4 verify the clamp by importing the module in the dev-server page
      console (`web/ui` has no test runner and adding one is a dependency
      change). Not run: the clamp is only observable once meta returns a real
      `max_level`, which needs Task 8. Run after the render:

      ```js
      const t = await import('/src/lib/iso-tiles.ts');
      t.setRenderedMaxLevel(20);
      console.assert(t.levelForScale(1.0) === 20, 'scale 1.0 should clamp to 20');
      console.assert(t.levelForScale(0.35) === 20, 'scale 0.35 is 20 already');
      console.assert(t.levelForScale(0.001) === 11, 'zoomed out is unaffected');
      ```

      **Deviation from the plan, deliberate:** the plan did not mention
      `map.attribution_iso`, which read *"Isometric tiles from pzmap.org"* in
      both locales. That string is printed on the map itself and became false
      the moment the tiles went local, so it now reads "rendered by this
      server". Also refreshed the `ISO_BASEMAP` doc comment in `worldmap.tsx`,
      which still explained the switch in terms of a third-party host going
      away.

### Open

- [~] **Task 8 — the real render** — **partly done; the render itself has not
      been run.** This is the hours-long one. Steps 1 and 8 are complete:

      - [x] **Step 1: disk check — PASSED.** `df -h .` → `192G` available on
            `C:`, against the ~25 GB the plan asks for.
      - [x] **Step 8: documentation** (`da1f5bb`). `docs/map-tiles.md` rewritten
            from scratch around `make map-tiles`. The whole 311-line Laravel
            version was describing code deleted in `36e213d` — `artisan
            zomboid:generate-map-tiles`, `PZ_MAP_BASEMAP`, `--profile=lite|full`,
            the `pz-app` container, the proxy fallback. All gone. The rewritten
            doc documents the real flow, the schema, both routes, the
            `web-api` restart, the geometry gate, and the `MSYS_NO_PATHCONV=1`
            trap. The one surviving mention of `map.projectzomboid.com` is the
            deliberate note explaining *why* there is no CDN fallback.

      - [x] **Proving run of `run.sh` — PASSED, and it found a blocker.** Rather
            than commit hours blind, the image was built and the run taken as
            far as the geometry gate, then stopped.

            - Image builds: `pzserver-map-tiles:local`, 815 MB.
            - `deploy`, `unpack` and `render base` all execute. `map_info.json`
              landed as promised, ~10s into the render.
            - **Geometry gate: PASSED.**
              `python web/tools/map-tiles/verify.py .../map_info.json` →
              `OK: x0/y0/sqr match exactly; 579616x253944 at skip=2 is the
              expected 2318656x1019040 pyramid`. `x0=1040384`, `y0=-139296`,
              `sqr=128` and `cell_rects` all match `ISO_DZI` exactly. pzmap2dzi
              1.1.16. **So pins will land correctly** — the thing the whole gate
              exists to protect is confirmed good.

      **Still to run — this is what is left of the whole feature:**

      - [ ] **Step 2: render.** `.\make.ps1 map-tiles`. Hours. Safe to interrupt;
            re-running resumes.
      - [ ] **Step 3: check what landed.** Expect ~27,000 tiles, `min_level` 8,
            `max_level` 20.
      - [ ] **Step 4: restart `web-api`** so it opens the new file, then
            `curl /api/v1/map-tiles/meta` → expect `"generated":true`.
      - [ ] **Step 5: prove tiles serve.** z8 and z20 → `200 image/jpeg` with
            non-zero size; z22 → `404`.
      - [ ] **Step 6: prove nothing calls out.** Network panel filtered on
            `pzmap.org` while panning the map → no requests. (Already true by
            construction — CSP no longer permits that host at all.)
      - [ ] **Step 7: prove the pins line up.** Signed in, on the real map,
            against a survivor whose in-game position is known. **This is the
            check the entire geometry gate exists to protect.**
      - [ ] **Task 7's browser console assertions** (see Task 7 above) — they
            need a real `max_level` from meta, so they belong with this run.

## ⚠ THE BLOCKER: the dedicated server has no texture packs

Found by that proving run, and it would have cost a whole night otherwise.

The render printed `invalid texture_path: /pz/media/texturepacks`, then
**1009 `missing texture […]` lines covering 232 distinct textures** — every
texture it asked for. `find data/server -iname '*.pack'` returns **zero**, and so
does the same search inside `pz-game-server`.

**The spec's premise was wrong.** It says *"The game files that pyramid was
rendered from are already on the server."* They are not. The dedicated server
download ships `media/maps` (the cells) but **not** `media/texturepacks` — it
never draws anything, so it has no use for them. pzmap2dzi does. Without them
the render completes and produces a **blank, untextured map**.

**`verify.py` cannot catch this.** It reads `map_info.json`, which is geometry,
not pixels. The gate passes on a fully blank render. That is a second silent
failure of exactly the kind the plan feared, on an axis nobody checked.

### The fix, implemented and tested

pzmap2dzi's own `conf/vanilla.txt` derives the path as
`texture_path: '{pz_root}/media/texturepacks'`, so the packs have to appear
under `/pz`. Three parts:

1. **A mount** in `docker-compose.web.yml`, layering the packs onto the
   read-only server install at that exact path, via `PZ_TEXTUREPACKS_HOST`.
   Default `./data/server/media/texturepacks`, so an operator who copies the
   folder onto the server needs no override.
2. **`mkdir -p data/server/media/texturepacks`** in both `map-tiles` targets.
   Docker **cannot create a mountpoint inside a read-only bind mount** — without
   this the run dies on `read-only file system` before reaching any check.
   Verified: that is exactly how it failed first time.
3. **A fail-fast guard at the top of `run.sh`** — checks for `*.pack` before
   `deploy` and exits 1 with instructions. Turns a silent blank map into a loud
   error in under a second.

**Test: guard fires. PASSED.** With the directory empty:
`FAIL: no texture packs at /pz/media/texturepacks` → exit 1, before any render.

### What this means for deploying

The packs are ~527 MB and live in a PZ **client** install
(`…/Steam/steamapps/common/ProjectZomboid/media/texturepacks`, 26 files on this
machine). The production Linux server has no client, so someone has to either:

- **copy that folder once** into `data/server/media/texturepacks` on the server, or
- **render on a machine that has the client** and ship the resulting
  `tiles.sqlite` — which is a single file, and one of the stated reasons for
  packing it that way in the first place.

**This is a decision for the operator and it is not made yet.** For now this
dev box's `.env` points at its own client install, so `.\make.ps1 map-tiles`
works here immediately:

```
PZ_TEXTUREPACKS_HOST=C:/Program Files (x86)/Steam/steamapps/common/ProjectZomboid/media/texturepacks
```

`.env` is untracked, so that line is local to this machine only. `.env.example`
carries the default and both options.

**Test: the fix works. PASSED.** Re-run with that path mounted:
`==> textures: 24 packs found`, and **`missing texture` count 0** — against
1009 before. The render then moved on to unpacking textures
(`Processing pages: n/144`) and was stopped there, since only proof was wanted.

Commits: `30b1bc6` (mount + mkdir + guard), `a2b46c0` (docs).

## ⚠ SECOND BLOCKER, also silent: /dev/shm was 64 MB

Hit on the first real render (2026-08-21). Worth reading before touching the
render service, because it looks exactly like "slow" and is not.

**Symptom.** The render reached `Working`, wrote 23 files, and then stopped.
Not slowly — completely. 0.00% CPU across repeated samples, 140 MB resident
(the parent alone), zero file growth over 30 s, and **no error of any kind** in
the log. It sat like that for 15 minutes looking like a long render.

**Cause.** pzmap2dzi renders through a multiprocessing pool that passes
2048×2048 RGBA tiles between workers in POSIX shared memory — `/dev/shm`.
Docker defaults that to **64 MB**. One tile buffer is 16 MB, and
`worker_count: auto` spawns one worker per core: 16 cores → **256 MB of demand
against 64 MB of tmpfs**. Workers die on the allocation without raising, the
parent waits on them forever.

The only trace is a `resource_tracker: leaked shared_memory objects` warning per
dead worker — **16 warnings, 16 workers, 16 abandoned `.pending` tiles.** That
warning also fires on healthy worker exit, so on its own it means nothing.

**What ruled out the obvious suspects:**

| Suspect | Evidence against |
|---|---|
| OOM | `OOMKilled=false`, container memory unlimited, VM `dmesg` has no kill records, 140 MB of 31 GB in use |
| A crash | No traceback anywhere in the log |
| Just slow | 0.00% CPU on three consecutive samples |

**First fix, and why it was not enough:** `shm_size: 4gb` (`74539d0`). The run
restarted, hit 1479% CPU and 1.8 GB of shm, and rendered 819 tiles — then
**stalled again at exactly the same 0% CPU**, this time with the log's last line
reading `cache: 3744.00 MB` against the new 4 GB ceiling.

**The actual root cause** — found only by reading pzmap2dzi's scheduler:

`cache_limit_mb` **defaults to 0**, and `scheduling.py:148` gates eviction on
`if self.cache_size:`. **Zero is falsy, so the eviction loop never runs.** The
shared-memory tile cache — which holds rendered children so a parent can be
merged from them — grows without any limit until `/dev/shm` is exhausted.
Raising `shm_size` only moves the wall further out.

**Real fix (`d6a5287`):** `cache_limit_mb: 4096` in `conf.yaml`'s `render_conf`,
under `shm_size: 8gb`, leaving the 16 workers' in-flight 16 MB buffers room
above the cache. **`conf.yaml` is baked into the image, so this needs a
rebuild** — editing it alone changes nothing.

**Confirmed active:** the progress line now reads
`job: 1152/347597 worker: 16/16 cache: 1376.00 / 4096 MB`. That ` / 4096`
suffix is printed only when `cache_limit` is set (`scheduling.py:213`), so it is
proof the bound took effect rather than an assumption.

### How to tell this stall from slow progress

It is genuinely indistinguishable by eye — both look like a long render. The
`job: N/M` counter is the reliable signal, not the tile count: the render spends
long stretches producing nothing saveable (void areas, and levels 21–22 which are
rendered but never written), so a static `.jpg` count is normal and a static
**job counter** is not.

```bash
C=$(docker ps -q --filter "ancestor=pzserver-map-tiles:local")
docker logs "$C" 2>&1 | tr '
' '
' | grep -o "job: [0-9]*/[0-9]*.*" | tail -1
docker stats --no-stream --format '{{.CPUPerc}}' "$C"
```

Frozen counter **and** 0.00% CPU across two samples = stalled. Anything else is
just slow.

**After any stall, delete the `.pending` markers before restarting** — they are
work claims from dead workers. Completed `.jpg` and `.empty` tiles are valid and
the run resumes past them.

### While you are here: `omit_levels` is a disk saving, not a time saving

The plan reads as though dropping levels 21–22 cuts the work. It does not.
`pzdzi.py:127` is `if not write_all and level >= levels - skip_level: return
'skip'` — the deepest levels are still **rendered**, just never **written**,
because each coarser tile is built by merging its four children. So level-22
`.pending` files during a run are correct and expected, and the runtime is
full-depth regardless. `omit_levels: 2` saves roughly 185 GB of disk and zero
hours.

### The documented 15 GB looks too low — confirm and correct at the end

Measured at job 28141/347597 (8.1%): **1920 tiles, 2.7 GB** — about **1.44 MB
per tile**, against the plan's 581 KB mean. Level distribution is a clean 4×
quadtree progression, so nothing structural is wrong:

| Level | 16 | 17 | 18 | 19 | 20 |
|---|---|---|---|---|---|
| Tiles | 2 | 16 | 84 | 368 | 1450 |

Two ways to project, both landing well above the doc:

- Linear on jobs: `2.7 GB / 0.081` ≈ **33 GB**
- Plan's ~27,000 tiles at the observed 1.44 MB ≈ **39 GB**

Neither is reliable this early — the walk order is topological, not uniform — but
both say the documented **~15 GB result / ~25 GB free** is understated, probably
by 2–3×.

**Action at the end of the run:** measure the real `tiles.sqlite` and tile count,
then correct the sizing table and the free-space requirement in
`docs/map-tiles.md`. Not urgent operationally — 185 GB free here — but an
operator trusting "25 GB free" on a smaller box would run out mid-render.

### The free-space figure is worse than the raw size, because of VACUUM

`pack.py:62` ends with `con.execute("VACUUM")`. SQLite implements VACUUM by
rebuilding the entire database into a temporary copy and then replacing the
original — so at that moment the disk holds **two full copies**. On a ~26 GB
pack that is ~52 GB, and it happens *after* the loose tree has been deleted, so
it is a second, separate peak.

Rough shape of the run's disk usage:

| Phase | Peak on disk |
|---|---|
| Render | loose tree, ~26 GB |
| Pack | tree shrinking, DB growing — roughly flat at ~26–30 GB |
| **VACUUM** | **DB + temp copy, ~52 GB** |

**Observed, not predicted:** SQLite writes the rebuild as `tiles.sqlite-journal`
**directly beside the database** in `data/map-tiles/` — not in `/tmp`, which is
what an earlier version of this note guessed. So the doubled peak falls on the
**same volume the pack lives on**. An operator who sized that volume at the
documented 25 GB would survive the render and then hit the wall during VACUUM,
with the whole render already spent.

**Open question for after the run:** whether that VACUUM earns its cost at all.
The packer only ever INSERTs, in level order, with no deletes and no updates, so
there is very little fragmentation for VACUUM to reclaim. It buys a marginally
smaller file in exchange for a full 26 GB read+write and a doubled peak disk
requirement. Dropping it is probably right, but it is a change to tested code
and there was no reason to churn it mid-render — decide with the real numbers.

---

### Also fixed on the way: CRLF corruption

The Python edits used to patch files wrote CRLF on Windows, which silently broke
`run.sh` — the container failed with `env: 'bash
': No such file or directory`.
`.gitattributes` mandates `eol=lf` for `*.sh`, but a direct file write bypasses
git entirely, and Docker `COPY`s from the working tree, not from the index.

Every file that `.gitattributes` pins to LF and these edits touched has been
normalized back; `make.ps1` was left CRLF, which is what `*.ps1 eol=crlf` asks
for. `git diff` afterwards showed only the six genuinely-changed files, so
nothing else was disturbed.

**If you patch files with a script on Windows, write bytes with `
`** or you
will rebuild this bug.

---

## Tile loading was slow — measured, and it is mostly not the code

Reported after cutover: the map works but tiles take ages. Measured rather than
guessed, and the answer was not where it looked.

**Ruled out, each by measurement:**

| Suspect | Verdict |
|---|---|
| gzip on JPEGs | Not applied at all; identical timing with `Accept-Encoding: identity` |
| Audit middleware | 0 rows for map-tiles paths; `/map-tiles/meta` in the *same* router answers in **2 ms** |
| Router / nginx | `/api/health` 2 ms through the same proxy |
| Bad query plan | `SEARCH tiles USING PRIMARY KEY` — optimal |
| Tile bytes | A **404**, returning no body at all, still cost **140 ms** |

**The actual cause: the Docker Desktop bind mount.**

| Reading the same pack | MISS | HIT |
|---|---|---|
| Windows filesystem directly | 4.8 ms | 6.4 ms |
| Through the bind mount | **144.6 ms** | **181.8 ms** |

~30x, and it matches the API's numbers exactly. Every tile read is random I/O
into a 24 GB file across Docker Desktop's filesystem translation layer. **This
is a Windows dev-environment problem; a Linux server bind-mounts natively and
does not pay it.**

`PRAGMA cache_size` and `mmap_size` were tried and made **no difference**
(~2050 ms for 9 tiles in every configuration) — the working set is far too
large to cache.

### What was fixed: the store serialised every read

Concurrency *does* help through the bind mount — 9 tiles go 2107 ms serial to
623 ms parallel, **3.4x**. The API was getting none of it: measured speedup
**1.0x**, because `MapTiles` held one `Mutex<Connection>` and every read queued
behind it.

Replaced with a round-robin pool of 8 read-only connections (no new dependency,
just `Vec<Mutex<Connection>>` + an `AtomicUsize`). A concurrency test now guards
it — note that every other test in that file passes with a single connection,
since serialisation is invisible to one-at-a-time assertions.

### Second bug: zooming fast left half the map permanently blank

Reported with a screenshot: zoom quickly and the top half of the viewport goes
black and never fills in.

**Cause:** `IsoTileCache.touch()` evicted by age **regardless of status**, so a
burst of requests pushed still-loading entries out of the cache. Eviction does
not cancel the request — the image still arrives, `settle()` finds
`entries.get(key)` gone, and **throws the bytes away**. The next frame requests
the same tile, which is evicted again. It never converges.

**Why the top half specifically:** `visibleIsoTiles` emits rows top-down, so the
top rows are requested first and are therefore first out of the LRU.

**Why "zoom too fast" and not always:** a single viewport is only ~12–20 tiles,
comfortably under the limit of 80. Zooming through several levels quickly
stacks a fresh set per level plus `ancestor()` parents, and blows past 80.

**Fix (`f1c6990`):** evict only *settled* entries. In-flight ones are
self-limiting — the browser caps concurrent requests per origin — and they hold
no decoded bitmap yet, so sparing them costs far less memory than keeping a
ready tile. The limit was deliberately **not** raised: a 2048² tile is ~16 MB
decoded, so 80 is already ~1.3 GB worst case and raising it trades one bug for
an out-of-memory one.

**Verified against the real module** through the Vite dev server (`web/ui` has no
test runner, so this was the plan's own suggested approach):

| State, with limit 4 | Entries |
|---|---|
| 12 requests all in flight | **12** — none dropped |
| after all settle | 12 |
| after the next touch | **4** — eviction resumes, still bounded |

The second row is the one that matters: without it this fix would be an
unbounded cache, i.e. a memory leak instead of a blank map.

## The pack is incomplete — two separate defects

Found after cutover, by chasing a black rectangle the user spotted at world
`10206, 9281`.

### Defect A: a hole baked into the tile

That coordinate maps to tile `20/134_59`. It **is** in the pack (689 KB), it
serves byte-identically to what is stored, and it is a valid JPEG — it simply
has a solid black rectangle painted into it. Extracted and looked at directly.
Not a retrieval problem.

**Cause, and it was mine.** When run #2 stalled I deleted the `.pending` markers
but kept the `.jpg` files, on the stated reasoning that "completed .jpg and
.empty tiles are valid". They are not. A worker killed mid-render leaves a
**complete, valid JPEG that is only partly painted**, and the `.pending` marker
is the only record of that. Deleting it made the half-drawn tile look finished,
so the resumed run skipped it.

A scan for rectangular black regions found **413 tiles**, though many of the
100%-black ones sit on the map-diamond diagonal (`z19 45_0, 47_1, 49_2 …`,
x+2/y+1) and are legitimately void. The true count of holes-in-painted-terrain
is lower and was not pinned down.

### Defect B: the upward merge never finished

Worse, and unrelated to A. A parent must exist wherever any of its four
children do:

| Parent level | Expected | Present | Missing |
|---|---|---|---|
| 19 | 4107 | 4084 | 23 |
| 18 | 1071 | 1052 | 19 |
| 17 | 293 | 277 | 16 |
| 16 | 89 | 77 | 12 |
| 15 | 25 | 20 | 5 |
| 14 | 10 | 7 | 3 |
| 13 | 3 | 1 | 2 |

It cascades: by level 13 only 1 tile of 3 survives, and **levels 8–11 do not
exist at all**. The render exited 0 at `job: 347351/347597` — 246 short — and
packed anyway.

**This is why zooming out blanks the map.** The client's `MIN_ISO_SCALE` allows
level 8, the pack starts at 12, and `ancestor()` falls back by walking *toward*
the missing shallow levels, so there is nothing to fall back on either.

**Not yet fixed.** The cheap repair is re-merging existing children into the
missing parents — no game data needed, minutes not hours — rather than
re-rendering. Not built.

## Regional re-render — built, NOT yet proven working

Asked for so the map can be updated as the world changes on the server, rather
than paying hours for a few cells.

```bash
make map-tiles-region CELLS="34,30,4,4"     # x, y, w, h in map cells
.\make.ps1 map-tiles-region 34,30,4,4
```

`render_cell_range` is the primitive: it renders a subset while leaving
`dzi_cell_range` — and therefore the pyramid geometry and every tile index the
client computes — untouched. `verify.py` still gates on it.

Three supporting pieces (`0451835`, 16 tests):

- **`unpack.py`** — restores tiles from the pack, because the packer deletes the
  loose tree and parents merge from four children; a region rendered without its
  neighbours on disk yields parents three-quarters black. Restores **only the
  merge inputs**: one cell needs 28 tiles back, not 21,480.
- **`cells.py`** — cell rect → covering tiles, same projection as the client's
  `worldToDzi`. Targets are deliberately **not** restored; the hole is what tells
  pzmap2dzi to redraw.
- **`pack.py --replace`** — the default `DO NOTHING` keeps a first pack
  resumable but would silently discard every re-rendered tile.

`run.sh` now also deletes `.pending` markers **together with their half-drawn
`.jpg`**, which is exactly the trap that caused Defect A.

### Status: the first live run did not update the pack

Planning worked — `region 39,36: 29 tiles to redraw, 28 to restore` — and the
merge inputs were restored. Then nothing: `generated_at` unchanged, tile
`20/134_59` byte-identical, 23 loose tiles stranded in the tree. It failed
between restore and pack, and the `--rm` container took its logs with it.

**Next step: re-run with output captured** and find where it stops. Do not
assume the feature works until a tile actually changes in the pack.

## Clean re-render, started 2026-08-21 ~18:35

Chosen after the regional tool proved out but the pack turned out to be damaged
in too many places to patch: **74 missing parent tiles across levels 14–19**,
plus several hundred tiles with black rectangles painted into them. Repairing
regionally would have drawn merge inputs from the same damaged pack.

**The old pack is kept** as `data/map-tiles/tiles.sqlite.old` (24 GB) rather
than deleted — it still serves a partly-working map, and a four-hour window
with nothing at all is worse. Roll back by renaming it over `tiles.sqlite` and
restarting `web-api`. Delete it once the new pack is verified.

The `data/map-tiles/texture` cache was deliberately kept; the run reports
`hash unchanged, skip` and saves the extraction step.

### Every blocker this hit is now fixed

| Was | Fix |
|---|---|
| No texture packs → blank render | `PZ_TEXTUREPACKS_HOST` mount + fail-fast guard in `run.sh` |
| `/dev/shm` 64 MB → silent worker death | `shm_size: 8gb` |
| Unbounded tile cache → same stall at any ceiling | `cache_limit_mb: 4096` |
| `.pending` deleted, half-drawn `.jpg` kept → permanent holes | `run.sh` deletes both together |
| VACUUM after every repack | skipped when `--replace` |
| Exit 0 proved nothing | `audit.py` |

### Verify before believing it

```bash
python web/tools/map-tiles/audit.py data/map-tiles/tiles.sqlite
```

Expect `pyramid is complete`. **Do not** trust the exit code alone — every
defect this map shipped with came from a run that exited 0, opened fine, served
fine, and passed `PRAGMA quick_check`.

Then: restart `web-api` so it opens the new pack, and check a known tile's
pixels rather than its byte count. `20/134_59` is the reference — it should be
0.0% black.

### Still on the table, not done

- **Move the pack to a Docker named volume.** Lives inside the VM's ext4 rather
  than the translation layer, so it should recover most of the 30x on Windows.
  Costs moving 24 GB and changes deployment topology. **Biggest remaining win
  on this machine, and pointless on the Linux server.**
- **Smaller tiles.** Level 20 averages **1215 KB** at quality 85, so a viewport
  of nine is ~11 MB. Quality ~70 would roughly halve that. Needs a re-render or
  a re-encode pass over 21,480 blobs.

---

### Decisions settled

- [x] **Inline, not subagents, for Tasks 2–7.** Settled 2026-08-21: this
      session runs with subagent dispatch switched off, so the tasks are done
      inline against the plan's own tests. Cheaper, and every task still has to
      pass the checks the plan specifies before it is called done.

### Things already learned the hard way — do not rediscover

All are written up in the plan's "What Task 1 established" section:

- `MSYS_NO_PATHCONV=1` is required on any hand-run `docker run` from Git Bash,
  or the bind mount silently does not happen and it looks like the game files
  are missing.
- `conf.yaml` must overwrite pzmap2dzi's own `conf/conf.yaml`. It resolves map
  descriptions relative to the config file's directory.
- `omit_levels` does **not** corrupt geometry. It divides `w`/`h`, leaves
  `x0`/`y0`/`sqr` alone, and records the reduction as `skip`. Client tile
  indices line up unchanged.
- `render_cell_range` does **not** make a test render cheap — the pyramid still
  walks every level. Gate on `map_info.json`, which lands ~10s in.
- Output is `/out/html/map_data/base/…`. There is no `default` path segment.

---

## 2. Map documentation still describes deleted features

Written before the Laravel app was removed in `36e213d`, and never updated.
Anyone following these chases commands and settings that do not exist.

- [x] `docs/map-tiles.md` — **done** (`da1f5bb`, `a2b46c0`)
- [ ] `docs/map-vector.md`
- [ ] `docs/commands.md`
- [ ] `docs/troubleshooting.md`
- [ ] `README.md` (map sections)

What is wrong in them:

- `PZ_MAP_BASEMAP` — grepped across the whole Rust stack, zero hits.
- `zomboid:generate-map-tiles`, `tiles.sqlite` serving, pzmap2dzi in the app
  image — all Laravel-era, all gone.
- Every one of them still names `map.projectzomboid.com`, which The Indie Stone
  took down on 7 Aug 2026.

Best done **after** task 1 lands, so the docs can describe the real
`make map-tiles` flow in one pass rather than being rewritten twice.

---

## 3. Fold the branches back together

- [ ] Merge `map-tiles-local` into `rust-web-stack` once tiles are working.
- [ ] Decide whether `rust-web-stack` merges to `main`, and when. It has been
      the working branch for the whole Rust migration and `main` is well behind.

---

## Recently closed — no action needed

Kept briefly so nobody re-opens them.

- **Isometric basemap repointed** to `tiles.pzmap.org` after the old host went
  away, with automatic fallback to the schematic if tiles stop arriving
  (`4acc32f`). Live locally and on `pz.corespace.de`.
- **Security headers actually reach the browser.** They were being silently
  dropped on every HTML and asset response by nginx's `add_header` inheritance
  rule. Fixing it turned CSP on for the first time, which immediately blocked
  Vite's inlined `data:` fonts — also fixed. Verified live on both.
- **Sidebar double-highlight** on Player map, caused by prefix matching on
  nested routes, now resolved by longest match (`ce65e57`). Live on both.
- **`pz-game-server`** finished its SteamCMD verification and is healthy.
