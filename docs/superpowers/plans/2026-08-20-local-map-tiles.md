# Local Isometric Map Tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the isometric basemap from the server's own game files, pack it into one SQLite file, and serve it from the API so the map never calls `tiles.pzmap.org` again.

**Architecture:** A one-off container runs `pzmap2dzi` against `data/server/media`, producing a DZI pyramid capped at level 20. A pack step walks that tree into `data/map-tiles/tiles.sqlite`, deleting files as it goes so peak disk stays near the final size. The API opens that file read-only and serves `GET /api/v1/map-tiles/{z}/{x}_{y}.jpg`. The client points at that route instead of the CDN; levels 21–22 return 404 and the existing `IsoTileCache.ancestor()` upscales.

**Tech Stack:** pzmap2dzi (Python, MIT), SQLite via `rusqlite` (already a workspace dependency in `pz-bridge`), Axum, React/TypeScript, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-20-local-map-tiles-design.md`

---

## Critical Risk: Read This First

The client hardcodes the pyramid's geometry in `web/ui/src/lib/iso-tiles.ts`:

```ts
export const ISO_DZI = {
  width: 2_318_656, height: 1_019_040,
  x0: 1_040_384, y0: -139_296,
  sqr: 128, tileSize: 2048, maxLevel: 22, minLevel: 8,
} as const
```

`worldToDzi()` uses `x0`/`y0` to place pins. If our render produces different image bounds than pzmap.org's, **every pin lands in the wrong place** while the tiles still look plausible — the worst kind of failure, because it looks like it works.

Two pzmap2dzi settings decide those bounds: `tile_align_levels` and `dzi_cell_range`. **Task 1 verifies the generated `layer0.dzi` matches `ISO_DZI` exactly and stops if it does not.** Do not proceed past Task 1 on a mismatch.

Reference values from the live pyramid, confirmed by fetching it:

```xml
<Image TileSize="2048" Overlap="0" Format="jpg">
  <Size Width="2318656" Height="1019040"/>
</Image>
```

## What Task 1 established (it has run — these are measurements, not predictions)

- **`omit_levels` does not corrupt the geometry.** It leaves `x0`, `y0` and `sqr`
  in full-resolution space and divides only `w`/`h`, recording the reduction as
  `skip`. `579616 x 4 = 2318464`, exactly an unrestricted render. The client's
  tile indices line up unchanged, because `tileSpan()` already scales by the
  level difference: `ceil(2318656/8192) = 284` columns at level 20 is exactly
  what the reduced pyramid has. **The levels 8-20 design is sound.**
- **`map_info.json` is the file that matters**, not `layer0.dzi`. It carries
  `x0`, `y0`, `sqr` and `cell_rects`; the `.dzi` carries only dimensions.
- **The gate is cheap.** `map_info.json` is written about ten seconds into a
  render, before any tiles are painted. Start the render, wait for the file,
  verify, kill it. `render_cell_range` does *not* make this cheaper — the
  pyramid still walks every level, which is why a "single cell" run was still
  going at 51 minutes.
- **Output layout:** `/out/html/map_data/base/{layer0.dzi,map_info.json,layer0_files/{z}/{x}_{y}.jpg}`.
- **Residual vs the public pyramid:** our height is 3264px short, a fraction of
  one cell, because our game files differ slightly from whatever that was
  rendered from. `cell_rects` match exactly. Costs at most one tile row at the
  bottom edge.
- **Windows:** hand-run `docker run` needs `MSYS_NO_PATHCONV=1` or the bind
  mount silently does not happen.

## Deviation from the spec

The spec says "One read-only connection, opened once and shared." `rusqlite::Connection` is `!Sync`, so it cannot literally be shared across async handlers. This plan uses a `Mutex<Connection>` read inside `tokio::task::spawn_blocking`. Same intent, correct mechanics.

## File Structure

| File | Responsibility |
|---|---|
| `web/tools/map-tiles/Dockerfile` | Create — Python + pzmap2dzi image |
| `web/tools/map-tiles/conf.yaml` | Create — pzmap2dzi settings (tile size, depth cap, layer cap) |
| `web/tools/map-tiles/pack.py` | Create — walk DZI tree into `tiles.sqlite`, deleting as it goes |
| `web/tools/map-tiles/verify.py` | Create — assert generated geometry matches `ISO_DZI` |
| `web/tools/map-tiles/run.sh` | Create — deploy → unpack → render → verify → pack |
| `web/api/crates/pz-api/src/services/map_tiles.rs` | Create — open the store, read one tile, read meta |
| `web/api/crates/pz-api/src/routes/map_tiles.rs` | Create — the two HTTP routes |
| `web/api/crates/pz-api/src/routes/mod.rs` | Modify — mount the routes |
| `web/api/crates/pz-api/src/state.rs` | Modify — hold the store |
| `web/api/crates/pz-api/src/config.rs` | Modify — tile store path |
| `web/api/crates/pz-api/Cargo.toml` | Modify — add `rusqlite` |
| `docker-compose.web.yml` | Modify — `map-tiles` service, `web-api` mount |
| `Makefile`, `make.ps1` | Modify — `map-tiles` target |
| `web/ui/src/lib/iso-tiles.ts` | Modify — local URL, level clamp |
| `web/ui/security-headers.conf` | Modify — drop the external host from CSP |
| `docs/map-tiles.md` | Modify — replace Laravel-era instructions |

---

### Task 1: Render container, and prove the geometry matches

**Files:**
- Create: `web/tools/map-tiles/Dockerfile`
- Create: `web/tools/map-tiles/conf.yaml`
- Create: `web/tools/map-tiles/verify.py`

- [ ] **Step 1: Write the verifier first — it is the gate everything else depends on**

Create `web/tools/map-tiles/verify.py`:

```python
"""Fail loudly if the render's geometry does not match what the client assumes.

web/ui/src/lib/iso-tiles.ts hardcodes ISO_DZI and derives every pin position
from it. A pyramid with different bounds still renders, but puts every survivor
in the wrong place, so this is checked before anything is built on top.
"""
import sys
import xml.etree.ElementTree as ET

EXPECTED = {"Width": "2318656", "Height": "1019040", "TileSize": "2048", "Format": "jpg"}


def main(dzi_path: str) -> int:
    root = ET.parse(dzi_path).getroot()
    size = root.find("{http://schemas.microsoft.com/deepzoom/2008}Size")
    if size is None:
        print(f"FAIL: no <Size> in {dzi_path}", file=sys.stderr)
        return 1

    actual = {
        "Width": size.get("Width"),
        "Height": size.get("Height"),
        "TileSize": root.get("TileSize"),
        "Format": root.get("Format"),
    }

    bad = {k: (v, actual[k]) for k, v in EXPECTED.items() if actual[k] != v}
    for key, (want, got) in bad.items():
        print(f"FAIL: {key} is {got}, ISO_DZI expects {want}", file=sys.stderr)

    if bad:
        print(
            "\nThe pyramid does not match web/ui/src/lib/iso-tiles.ts.\n"
            "Pins would be misplaced. Fix conf.yaml (tile_size, tile_align_levels,\n"
            "dzi_cell_range) rather than editing ISO_DZI to match a bad render.",
            file=sys.stderr,
        )
        return 1

    print(f"OK: geometry matches ISO_DZI ({actual['Width']}x{actual['Height']}, "
          f"tile {actual['TileSize']}, {actual['Format']})")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: verify.py <path to layer0.dzi>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
```

- [ ] **Step 2: Run the verifier against the live pyramid to prove it accepts a good one**

```bash
cd web/tools/map-tiles
curl -s -H "User-Agent: Mozilla/5.0" \
  https://tiles.pzmap.org/42.20.0/base/layer0.dzi -o /tmp/reference.dzi
python verify.py /tmp/reference.dzi
```

Expected: `OK: geometry matches ISO_DZI (2318656x1019040, tile 2048, jpg)`, exit 0.

This is the only time the plan touches the network. It proves the checker works before it is used as a gate.

- [ ] **Step 3: Prove the verifier rejects a bad one**

```bash
sed 's/TileSize="2048"/TileSize="1024"/' /tmp/reference.dzi > /tmp/bad.dzi
python verify.py /tmp/bad.dzi; echo "exit=$?"
```

Expected: `FAIL: TileSize is 1024, ISO_DZI expects 2048`, `exit=1`.

`1024` is pzmap2dzi's default, so this is the exact mistake most likely to be made.

- [ ] **Step 4: Commit the verifier**

```bash
git add web/tools/map-tiles/verify.py
git commit -m "Add a geometry gate for locally rendered map tiles."
```

- [ ] **Step 5: Write the render config**

Create `web/tools/map-tiles/conf.yaml`. Only the settings that differ from
pzmap2dzi's shipped defaults, each with the reason:

```yaml
# Paths inside the container. The game install is mounted read-only; the render
# writes only to /out.
pz_root: /pz
output_root: /out
mod_root: /pz/steamapps/workshop/content/108600
custom_root: .
save_game_root: /dev/null

output_entry: default
output_route: map_data/

# B42, matching the server build.
map_conf_default: default_b42.txt
map_conf:
    - vanilla.txt
    - mod/

# Vanilla Knox County. Matches Map=Muldraugh, KY in server.ini.
base_map: default
mod_maps: []
save_games: []

render_conf:
    verbose: true
    worker_count: auto

    # 2048, NOT the shipped default of 1024. ISO_DZI.tileSize in
    # web/ui/src/lib/iso-tiles.ts is 2048 and the client's tileSpan() maths is
    # built on it. verify.py enforces this.
    tile_size: 2048

    # Only building layer 0. The client requests layer0_files exclusively, and
    # rendering the upper floors would multiply the work for tiles nothing asks
    # for. Range is half-open: [0, 1] is layer 0 alone.
    layer_range: [0, 1]

    # Discard the two deepest levels: 22 and 21. Leaves 8-20, about 27k tiles
    # and 15 GB instead of 360k and 200 GB. DEFAULT_ISO_SCALE resolves to level
    # 20, so the survivor-focus view is still native; deeper zoom upscales
    # through IsoTileCache.ancestor().
    omit_levels: 2

    # jpg for the base layer is already the default; stated so a future default
    # change cannot silently break the client's .jpg URLs.
    image_fmt_base_layer0: jpg
    image_save_options:
        jpg: {quality: 85}
```

Leave `tile_align_levels` and `dzi_cell_range` at their defaults on the first
run. They set the image bounds, and the defaults are what pzmap.org used. Step 9
is where that assumption gets tested.

- [ ] **Step 6: Write the image**

Create `web/tools/map-tiles/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

# Renders the isometric pyramid from the game files. Never part of the running
# stack: compose keeps it behind a profile and it is run on demand.
FROM python:3.12-slim

# Pillow needs libjpeg/zlib to decode the game's textures. build-essential and
# linux-libc-dev are for pynput's evdev backend, which compiles a C extension
# against linux/input.h — pzmap2dzi never touches keyboard/mouse input in
# headless deploy/unpack/render use, but pip installs the whole requirements
# file regardless. lupa (Lua bindings) also builds its bundled Lua from source
# and needs the same toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git libjpeg62-turbo zlib1g build-essential linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*

ARG PZMAP2DZI_REF=main
RUN git clone --depth 1 --branch "${PZMAP2DZI_REF}" \
        https://github.com/cff29546/pzmap2dzi.git /opt/pzmap2dzi \
    && pip install --no-cache-dir -r /opt/pzmap2dzi/requirements.txt

WORKDIR /opt/pzmap2dzi

# Overwrites the shipped config, deliberately. parse_map() resolves map_conf and
# map_conf_default relative to the config file's own directory, so conf.yaml has
# to sit beside vanilla.txt, default_b42.txt and mod/ — putting it anywhere else
# makes the render fail looking for map descriptions that are not there.
COPY conf.yaml /opt/pzmap2dzi/conf/conf.yaml
COPY verify.py pack.py run.sh /tools/
RUN chmod +x /tools/run.sh

ENTRYPOINT ["/tools/run.sh"]
```

- [ ] **Step 7: Confirm the requirements file exists at that path before relying on it**

```bash
curl -sI https://raw.githubusercontent.com/cff29546/pzmap2dzi/main/requirements.txt \
  | head -1
```

Expected: `HTTP/2 200`.

If it is 404, list the repo and use whatever dependency file it does ship:

```bash
curl -s "https://api.github.com/repos/cff29546/pzmap2dzi/git/trees/main?recursive=1" \
  | python -c "import sys,json; [print(x['path']) for x in json.load(sys.stdin)['tree'] if 'require' in x['path'] or x['path'].endswith('.toml')]"
```

- [ ] **Step 8: Build the image**

```bash
docker build -t pzserver-map-tiles:local web/tools/map-tiles
```

Expected: build succeeds. `run.sh` and `pack.py` do not exist yet, so `COPY`
will fail — create empty placeholders first and fill them in Tasks 2 and 3:

```bash
touch web/tools/map-tiles/pack.py web/tools/map-tiles/run.sh
```

- [ ] **Step 9: Render one small cell range and check the geometry — THE GATE**

Full render is hours. This proves the geometry in minutes by rendering a single
cell while keeping the pyramid's bounds for the whole map.

Add temporarily to `conf.yaml` under `render_conf`:

```yaml
    # TEMPORARY, remove after the geometry check passes.
    render_cell_range[default]:
        - [35, 35]
```

`dzi_cell_range` stays `auto`, so the DZI bounds still describe the whole map —
which is exactly what is being verified — while only one cell is painted.

**`MSYS_NO_PATHCONV=1` is required on Windows.** Without it, Git Bash rewrites
the container-side `/pz` into a Windows path and the bind mount silently does
not happen: `/pz` does not exist inside the container, and the render dies with
`FileNotFoundError` on the map directory as though the game files were missing.
They are not. This affects only these hand-run commands — the compose service
in Task 3 reads its paths from YAML and is unaffected.

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(pwd)/data/server:/pz:ro" \
  -v "$(pwd)/data/map-tiles:/out" \
  --entrypoint bash pzserver-map-tiles:local -c \
  'python main.py -c conf/conf.yaml deploy \
   && python main.py -c conf/conf.yaml unpack \
   && python main.py -c conf/conf.yaml render base \
   && find /out -name "layer0.dzi" -print'
```

Then verify whatever path that `find` printed:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/data/map-tiles:/out" \
  --entrypoint python pzserver-map-tiles:local \
  /tools/verify.py /out/<path from find>/layer0.dzi
```

Expected: `OK: geometry matches ISO_DZI (2318656x1019040, tile 2048, jpg)`.

**If it fails, stop.** Record the actual Width/Height and adjust
`dzi_cell_range` — the config's own comments give the B42 default:

```yaml
    dzi_cell_range:
        - [0, 18, 45, 45]
        - [45, 3, 13, 60]
        - [58, 0, 20, 63]
```

Re-run until it passes. Do not edit `ISO_DZI` to match a bad render, and do not
continue to Task 2 without a pass.

- [ ] **Step 10: Record the real output path**

The layout is `{output_root}/{output_route}/{output_entry}/base/layer0_files/{z}/{x}_{y}.jpg`,
but confirm it from the `find` above rather than trusting this. Write the actual
path into `conf.yaml` as a comment — Tasks 2 and 3 both depend on it.

- [ ] **Step 11: Remove the temporary cell range and commit**

Delete the `render_cell_range[default]` block added in Step 9.

```bash
git add web/tools/map-tiles/
git commit -m "Add the map tile render image and its config."
```

---

### Task 2: Pack the tree into SQLite

**Files:**
- Create: `web/tools/map-tiles/pack.py` (replacing the placeholder)

- [ ] **Step 1: Write the failing test**

Create `web/tools/map-tiles/test_pack.py`:

```python
import sqlite3
from pathlib import Path

from pack import pack


def build_tree(root: Path) -> None:
    for z, x, y, body in [(8, 0, 0, b"a"), (20, 3, 4, b"bb"), (20, 5, 6, b"ccc")]:
        d = root / "base" / "layer0_files" / str(z)
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{x}_{y}.jpg").write_bytes(body)


def test_pack_moves_every_tile_and_removes_the_tree(tmp_path):
    tree, db = tmp_path / "tree", tmp_path / "tiles.sqlite"
    build_tree(tree)

    count = pack(tree / "base" / "layer0_files", db, {"game_version": "42.20.0"})

    assert count == 3
    con = sqlite3.connect(db)
    assert con.execute("SELECT data FROM tiles WHERE z=20 AND x=5 AND y=6").fetchone()[0] == b"ccc"
    assert con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0] == 3
    assert con.execute("SELECT value FROM meta WHERE key='game_version'").fetchone()[0] == "42.20.0"
    assert con.execute("SELECT value FROM meta WHERE key='min_level'").fetchone()[0] == "8"
    assert con.execute("SELECT value FROM meta WHERE key='max_level'").fetchone()[0] == "20"
    # Files are removed as they are packed, so peak disk stays near the result.
    assert list((tree / "base" / "layer0_files").rglob("*.jpg")) == []


def test_pack_resumes_without_duplicating(tmp_path):
    tree, db = tmp_path / "tree", tmp_path / "tiles.sqlite"
    build_tree(tree)
    pack(tree / "base" / "layer0_files", db, {})

    build_tree(tree)  # a re-run after an interrupted render
    count = pack(tree / "base" / "layer0_files", db, {})

    con = sqlite3.connect(db)
    assert con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0] == 3
    assert count == 0
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd web/tools/map-tiles && python -m pytest test_pack.py -v
```

Expected: FAIL, `ModuleNotFoundError` or `ImportError: cannot import name 'pack'`.

- [ ] **Step 3: Write the packer**

Replace `web/tools/map-tiles/pack.py`:

```python
"""Fold a DZI tile tree into one SQLite file.

Deletes each tile as it is stored. Holding the loose tree and the finished
database at the same time costs roughly double the final size, and the final
size is about 15 GB.
"""
import sqlite3
import sys
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS tiles (
    z INTEGER NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (z, x, y)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def pack(tiles_dir: Path, db_path: Path, meta: dict) -> int:
    """Store every tile under `tiles_dir`. Returns how many were newly added."""
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)

    added = 0
    levels = []
    for level_dir in sorted(tiles_dir.iterdir(), key=lambda p: int(p.name)):
        if not level_dir.is_dir():
            continue
        z = int(level_dir.name)
        levels.append(z)

        batch = []
        for tile in level_dir.glob("*.jpg"):
            x, _, y = tile.stem.partition("_")
            batch.append((z, int(x), int(y), tile.read_bytes(), tile))

            if len(batch) >= 500:
                added += _flush(con, batch)
                batch.clear()

        added += _flush(con, batch)
        print(f"level {z}: packed, {added} tiles so far", flush=True)

    if levels:
        meta = dict(meta)
        meta.setdefault("min_level", str(min(levels)))
        meta.setdefault("max_level", str(max(levels)))
    meta["tile_count"] = str(con.execute("SELECT COUNT(*) FROM tiles").fetchone()[0])

    con.executemany(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        list(meta.items()),
    )
    con.commit()
    con.execute("VACUUM")
    con.close()
    return added


def _flush(con, batch) -> int:
    """Insert a batch, then unlink the files that are now safely stored."""
    if not batch:
        return 0

    rows = [(z, x, y, blob) for z, x, y, blob, _ in batch]
    before = con.total_changes
    con.executemany(
        "INSERT INTO tiles (z, x, y, data) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(z, x, y) DO NOTHING",
        rows,
    )
    con.commit()

    for *_, path in batch:
        path.unlink(missing_ok=True)

    return con.total_changes - before


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: pack.py <layer0_files dir> <tiles.sqlite> [k=v ...]", file=sys.stderr)
        raise SystemExit(2)

    extra = dict(pair.split("=", 1) for pair in sys.argv[3:])
    n = pack(Path(sys.argv[1]), Path(sys.argv[2]), extra)
    print(f"packed {n} new tiles into {sys.argv[2]}")
```

- [ ] **Step 4: Run the tests**

```bash
cd web/tools/map-tiles && python -m pytest test_pack.py -v
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/tools/map-tiles/pack.py web/tools/map-tiles/test_pack.py
git commit -m "Pack the rendered tile tree into a single SQLite file."
```

---

### Task 3: The run script and the make targets

**Files:**
- Create: `web/tools/map-tiles/run.sh` (replacing the placeholder)
- Modify: `docker-compose.web.yml`
- Modify: `Makefile`, `make.ps1`

- [ ] **Step 1: Write the run script**

Replace `web/tools/map-tiles/run.sh`:

```bash
#!/usr/bin/env bash
# Render, verify, pack. Re-running resumes: pzmap2dzi skips work it has already
# done, and the packer skips tiles already stored.
set -euo pipefail

CONF=conf/conf.yaml
OUT=/out
TREE="$OUT/html/map_data/base"   # verified layout; there is no `default` segment

cd /opt/pzmap2dzi

echo "==> deploy"
python main.py -c "$CONF" deploy

echo "==> unpack"
python main.py -c "$CONF" unpack

echo "==> render base (hours; ctrl-c is safe, re-run resumes)"
python main.py -c "$CONF" render base

echo "==> verify geometry"
python /tools/verify.py "$TREE/map_info.json"

echo "==> pack"
python /tools/pack.py "$TREE/layer0_files" "$OUT/tiles.sqlite" \
    "game_version=${PZ_GAME_VERSION:-42.20.0}" \
    "tile_size=2048" \
    "width=2318656" \
    "height=1019040" \
    "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "==> done"
ls -lh "$OUT/tiles.sqlite"
```

If Task 1 Step 10 recorded a different tree path, use that instead of `$TREE`.

- [ ] **Step 2: Add the compose service**

In `docker-compose.web.yml`, alongside the other services:

```yaml
  # One-off tile render. `profiles` keeps it out of `up`; it is run on demand
  # through `make map-tiles` and exits when finished.
  map-tiles:
    image: ${PZ_MAP_TILES_IMAGE:-pzserver-map-tiles:local}
    build:
      context: ./web/tools/map-tiles
      dockerfile: Dockerfile
    pull_policy: build
    container_name: pz-map-tiles
    profiles: ["tools"]
    volumes:
      # The game install, for the map cells and textures. Read-only: rendering
      # must never be able to damage the server's own files.
      - ${PZ_SERVER_HOST:-./data/server}:/pz:ro
      - ${PZ_MAP_TILES_HOST:-./data/map-tiles}:/out
    environment:
      PZ_GAME_VERSION: ${PZ_GAME_VERSION:-42.20.0}
```

- [ ] **Step 3: Mount the store into web-api**

In `docker-compose.web.yml`, in the `web-api` service's `volumes:` list, after
the `/backups` entry:

```yaml
      # The packed isometric pyramid. Read-only: the API only ever reads it,
      # and `make map-tiles` is what writes it.
      - ${PZ_MAP_TILES_HOST:-./data/map-tiles}:/map-tiles:ro
```

- [ ] **Step 4: Add the Makefile target**

In `Makefile`, next to `rebuild-game`:

```makefile
# Renders the isometric basemap from the game files into data/map-tiles.
# Takes hours and about 15 GB. Safe to interrupt; re-run to resume.
map-tiles:
	$(COMPOSE) --profile tools build map-tiles
	$(COMPOSE) --profile tools run --rm map-tiles
```

Add to the help block near line 204:

```makefile
	@echo "  make map-tiles         Render the isometric basemap locally (hours, ~15 GB)"
```

- [ ] **Step 5: Add the same target to make.ps1**

Beside `Do-RebuildGame` (around line 293):

```powershell
function Do-MapTiles {
    Write-Host "Rendering the isometric basemap from the game files (hours, ~15 GB)..." -ForegroundColor Cyan
    Invoke-Compose @("--profile", "tools", "build", "map-tiles")
    Invoke-Compose @("--profile", "tools", "run", "--rm", "map-tiles")
}
```

In the `switch ($Command)` block (around line 697), beside `"rebuild-game"`:

```powershell
    "map-tiles"      { Do-MapTiles }
```

And in the help block (around line 660), after the `rebuild-game` line:

```powershell
    Write-Host "    .\make.ps1 map-tiles        Render the isometric basemap locally (hours, ~15 GB)"
```

- [ ] **Step 6: Verify the compose files still parse**

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml config >/dev/null && echo "compose OK"
```

Expected: `compose OK`.

- [ ] **Step 7: Verify the service is not started by a normal up**

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml config --services | grep -c map-tiles
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml config --profiles
```

Expected: the service exists, and `tools` is listed as a profile — so `up`
without `--profile tools` leaves it alone.

- [ ] **Step 8: Commit**

```bash
git add web/tools/map-tiles/run.sh docker-compose.web.yml Makefile make.ps1
git commit -m "Wire the tile render up as an on-demand compose service."
```

---

### Task 4: The store module

**Files:**
- Create: `web/api/crates/pz-api/src/services/map_tiles.rs`
- Modify: `web/api/crates/pz-api/src/services/mod.rs`
- Modify: `web/api/crates/pz-api/Cargo.toml`

- [ ] **Step 1: Add the dependency**

In `web/api/crates/pz-api/Cargo.toml`, alongside the other dependencies:

```toml
rusqlite = { version = "0.32", features = ["bundled"] }
```

Same version and features as `pz-bridge` already uses, so the workspace resolves
one copy.

- [ ] **Step 2: Write the failing test**

Create `web/api/crates/pz-api/src/services/map_tiles.rs` with only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(dir: &std::path::Path, tiles: &[(i64, i64, i64, &[u8])]) -> MapTiles {
        let path = dir.join("tiles.sqlite");
        let con = rusqlite::Connection::open(&path).unwrap();
        con.execute_batch(
            "CREATE TABLE tiles (z INTEGER, x INTEGER, y INTEGER, data BLOB NOT NULL,
                 PRIMARY KEY (z, x, y)) WITHOUT ROWID;
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta VALUES ('min_level','8'),('max_level','20'),
                 ('game_version','42.20.0');",
        )
        .unwrap();
        for (z, x, y, body) in tiles {
            con.execute(
                "INSERT INTO tiles (z, x, y, data) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![z, x, y, body],
            )
            .unwrap();
        }
        drop(con);
        MapTiles::open(&path)
    }

    #[tokio::test]
    async fn serves_a_stored_tile() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with(dir.path(), &[(20, 3, 4, b"jpegbytes")]);

        assert_eq!(store.tile(20, 3, 4).await.unwrap(), Some(b"jpegbytes".to_vec()));
    }

    #[tokio::test]
    async fn absent_tile_is_none_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with(dir.path(), &[(20, 3, 4, b"x")]);

        // Level 22 was never rendered, and 53% of grid positions never existed.
        assert_eq!(store.tile(22, 0, 0).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_missing_file_is_not_generated_rather_than_a_failure() {
        let store = MapTiles::open(std::path::Path::new("/nonexistent/tiles.sqlite"));

        assert!(!store.meta().generated);
        assert_eq!(store.tile(20, 3, 4).await.unwrap(), None);
    }

    #[tokio::test]
    async fn meta_reports_the_rendered_range() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with(dir.path(), &[]);

        let meta = store.meta();
        assert!(meta.generated);
        assert_eq!(meta.min_level, Some(8));
        assert_eq!(meta.max_level, Some(20));
        assert_eq!(meta.game_version.as_deref(), Some("42.20.0"));
    }
}
```

Add `tempfile = "3"` to `[dev-dependencies]` in `web/api/crates/pz-api/Cargo.toml`
if it is not already there.

- [ ] **Step 3: Run to confirm it fails**

```bash
cd web/api && cargo test --workspace map_tiles
```

Expected: FAIL — `cannot find type MapTiles in this scope`.

- [ ] **Step 4: Write the store**

Prepend to `web/api/crates/pz-api/src/services/map_tiles.rs`:

```rust
//! Read access to the packed isometric tile pyramid.
//!
//! `make map-tiles` renders and packs `tiles.sqlite`; this only ever reads it.
//! A missing file is a normal state — it means nobody has run the render yet —
//! so every read answers `None` rather than failing.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

/// What the client needs to know about the pyramid it is drawing.
#[derive(Clone, Debug, Serialize)]
pub struct TileMeta {
    pub generated: bool,
    pub min_level: Option<i64>,
    pub max_level: Option<i64>,
    pub game_version: Option<String>,
}

impl TileMeta {
    fn absent() -> Self {
        Self { generated: false, min_level: None, max_level: None, game_version: None }
    }
}

/// `rusqlite::Connection` is `!Sync`, so it cannot be shared across handlers
/// directly. One mutex-guarded connection, read from the blocking pool, is
/// enough: a tile read is a single indexed blob fetch and the browser caches
/// aggressively on top.
#[derive(Clone)]
pub struct MapTiles {
    inner: Option<Arc<Inner>>,
    meta: TileMeta,
}

struct Inner {
    con: Mutex<Connection>,
}

impl MapTiles {
    /// Opens the store read-only. Never fails: an unusable file is reported as
    /// "not generated", which is exactly how the client should treat it.
    pub fn open(path: &Path) -> Self {
        let con = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        );

        let Ok(con) = con else {
            tracing::info!(path = %path.display(), "no map tile store; iso basemap unavailable");
            return Self { inner: None, meta: TileMeta::absent() };
        };

        let meta = read_meta(&con).unwrap_or_else(TileMeta::absent);
        tracing::info!(
            path = %path.display(),
            min = ?meta.min_level,
            max = ?meta.max_level,
            "map tile store opened",
        );

        Self { inner: Some(Arc::new(Inner { con: Mutex::new(con) })), meta }
    }

    pub fn meta(&self) -> TileMeta {
        self.meta.clone()
    }

    /// One tile, or `None` when it was never rendered.
    pub async fn tile(&self, z: i64, x: i64, y: i64) -> anyhow::Result<Option<Vec<u8>>> {
        let Some(inner) = self.inner.clone() else {
            return Ok(None);
        };

        let blob = tokio::task::spawn_blocking(move || {
            let con = inner.con.lock().expect("map tile store mutex poisoned");
            con.query_row(
                "SELECT data FROM tiles WHERE z = ?1 AND x = ?2 AND y = ?3",
                rusqlite::params![z, x, y],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
        })
        .await??;

        Ok(blob)
    }
}

fn read_meta(con: &Connection) -> rusqlite::Result<TileMeta> {
    let get = |key: &str| -> rusqlite::Result<Option<String>> {
        con.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
    };

    Ok(TileMeta {
        generated: true,
        min_level: get("min_level")?.and_then(|v| v.parse().ok()),
        max_level: get("max_level")?.and_then(|v| v.parse().ok()),
        game_version: get("game_version")?,
    })
}
```

Register it in `web/api/crates/pz-api/src/services/mod.rs` alongside the others:

```rust
pub mod map_tiles;
```

- [ ] **Step 5: Run the tests**

```bash
cd web/api && cargo test --workspace map_tiles
```

Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add web/api/crates/pz-api/src/services/map_tiles.rs \
        web/api/crates/pz-api/src/services/mod.rs \
        web/api/crates/pz-api/Cargo.toml web/api/Cargo.lock
git commit -m "Read packed map tiles from SQLite."
```

---

### Task 5: The routes

**Files:**
- Create: `web/api/crates/pz-api/src/routes/map_tiles.rs`
- Modify: `web/api/crates/pz-api/src/routes/mod.rs`
- Modify: `web/api/crates/pz-api/src/state.rs`
- Modify: `web/api/crates/pz-api/src/config.rs`

- [ ] **Step 1: Add the path to config**

In `web/api/crates/pz-api/src/config.rs`, add a field beside the existing path
settings, following how they are read:

```rust
    /// Packed isometric tile pyramid. `/map-tiles` in the container; the host
    /// side is PZ_MAP_TILES_HOST.
    pub map_tiles_path: PathBuf,
```

and in the loader:

```rust
            map_tiles_path: PathBuf::from(string("MAP_TILES_PATH", "/map-tiles/tiles.sqlite")),
```

This mirrors `backup_path`, which is loaded the same way.

- [ ] **Step 2: Hold the store in state**

In `web/api/crates/pz-api/src/state.rs`, add to `AppState`:

```rust
    /// Packed isometric basemap. Absent until `make map-tiles` has run.
    pub map_tiles: crate::services::map_tiles::MapTiles,
```

and in `AppState::new`, before constructing the struct:

```rust
        let map_tiles = crate::services::map_tiles::MapTiles::open(&config.map_tiles_path);
```

- [ ] **Step 3: Write the routes**

Create `web/api/crates/pz-api/src/routes/map_tiles.rs`:

```rust
//! The isometric basemap's tiles, served from the local pack.
//!
//! Public, like the rest of the map surface: a tile is not a secret. Anything
//! not in the store is a 404, which the client turns into an upscale of the
//! nearest level it does hold.

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use crate::services::map_tiles::TileMeta;
use crate::state::AppState;

/// A week. Not `immutable`: the URL carries no version, so a re-render for a
/// new game build returns different bytes at the same path.
const TILE_CACHE: &str = "public, max-age=604800";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/map-tiles/meta", get(meta))
        .route("/map-tiles/{z}/{tile}", get(tile))
}

async fn meta(State(state): State<AppState>) -> Json<TileMeta> {
    Json(state.map_tiles.meta())
}

async fn tile(
    State(state): State<AppState>,
    Path((z, tile)): Path<(i64, String)>,
) -> Response {
    let Some((x, y)) = parse_tile(&tile) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    match state.map_tiles.tile(z, x, y).await {
        Ok(Some(bytes)) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, TILE_CACHE),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(%error, z, x, y, "map tile read failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// `"3_4.jpg"` -> `(3, 4)`. Anything else is a 404, not a 400: a malformed tile
/// name is a URL that does not name a tile.
fn parse_tile(name: &str) -> Option<(i64, i64)> {
    let stem = name.strip_suffix(".jpg")?;
    let (x, y) = stem.split_once('_')?;
    Some((x.parse().ok()?, y.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::parse_tile;

    #[test]
    fn parses_a_tile_name() {
        assert_eq!(parse_tile("3_4.jpg"), Some((3, 4)));
        assert_eq!(parse_tile("1133_498.jpg"), Some((1133, 498)));
    }

    #[test]
    fn rejects_anything_that_is_not_one() {
        for bad in ["3_4.png", "3_4", "3-4.jpg", "_4.jpg", "a_b.jpg", "../x.jpg"] {
            assert_eq!(parse_tile(bad), None, "{bad} should not parse");
        }
    }
}
```

- [ ] **Step 4: Mount them**

In `web/api/crates/pz-api/src/routes/mod.rs`, add the module beside the others:

```rust
mod map_tiles;
```

and merge into the `fast` router, after `me::routes()`:

```rust
        .merge(map_tiles::routes())
```

- [ ] **Step 5: Run the tests and build**

```bash
cd web/api && cargo test --workspace && cargo clippy --all-targets --all-features -- -D warnings
```

Expected: all tests PASS, clippy clean.

- [ ] **Step 6: Commit**

```bash
git add web/api/crates/pz-api/src/routes/map_tiles.rs \
        web/api/crates/pz-api/src/routes/mod.rs \
        web/api/crates/pz-api/src/state.rs \
        web/api/crates/pz-api/src/config.rs
git commit -m "Serve packed map tiles from the API."
```

- [ ] **Step 7: Verify against the running stack**

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml build web-api
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml up -d web-api
curl -s http://127.0.0.1:8100/api/v1/map-tiles/meta
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8100/api/v1/map-tiles/20/3_4.jpg
```

Expected before any render: `{"generated":false,...}` and `404`. That is the
correct state, not a failure.

---

### Task 6: Point the client at the local route

**Files:**
- Modify: `web/ui/src/lib/iso-tiles.ts`
- Modify: `web/ui/security-headers.conf`

- [ ] **Step 1: Repoint the URL**

In `web/ui/src/lib/iso-tiles.ts`, replace the host constants:

```ts
/**
 * Tiles come from this server, out of the pyramid `make map-tiles` renders from
 * the game's own files. Nothing leaves the origin, so the map works offline and
 * does not lean on a volunteer CDN that has already moved once.
 *
 * Levels above the rendered maximum answer 404 by design; `IsoTileCache`
 * upscales from the deepest level actually held.
 */
export const ISO_TILE_URL = '/api/v1/map-tiles/{z}/{x}_{y}.jpg'
```

Delete `ISO_TILE_HOST`. Confirm nothing else imports it:

```bash
grep -rn "ISO_TILE_HOST" web/ui/src
```

Expected: no matches.

- [ ] **Step 2: Drop the external host from CSP**

In `web/ui/security-headers.conf`, change `img-src` and remove the paragraph
about `tiles.pzmap.org`, replacing it with:

```
# img-src needs no external host: map tiles are served from /api/v1/map-tiles
# out of the locally rendered pack. See docs/map-tiles.md.
```

The directive becomes:

```
img-src 'self' data:;
```

- [ ] **Step 3: Typecheck, lint, build**

```bash
cd web/ui && npx tsc -b && npm run lint && npm run build
```

Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add web/ui/src/lib/iso-tiles.ts web/ui/security-headers.conf
git commit -m "Draw the isometric basemap from this server's own tiles."
```

---

### Task 7: Clamp zoom to what was actually rendered

**Files:**
- Modify: `web/ui/src/lib/iso-tiles.ts`

Without this, every deep zoom fires 404s for levels that can never exist. The
cache records each miss so it is bounded, but it is still a pointless request
per tile per session, and the "not generated" case shows a misleading message.

- [ ] **Step 1: Write the failing test**

There is no test runner in `web/ui` and adding one is a dependency change, so
verify in the browser as the existing map work did. Start the dev server:

The dev server is already defined as `web-ui` on port 5174 in
`.claude/launch.json`. Start it through the preview tooling rather than a bare
`npm run dev`, then open the page. Vite serves TypeScript modules directly, so
the console is exercising the real module.

Then in the page console:

```js
const t = await import('/src/lib/iso-tiles.ts');
t.setRenderedMaxLevel(20);
console.assert(t.levelForScale(1.0) === 20, 'scale 1.0 should clamp to 20');
console.assert(t.levelForScale(0.35) === 20, 'scale 0.35 is 20 already');
console.assert(t.levelForScale(0.001) === 11, 'zoomed out is unaffected');
```

Expected before the change: the first assertion fails, `levelForScale(1.0)` is 22.

- [ ] **Step 2: Implement the clamp**

In `web/ui/src/lib/iso-tiles.ts`, add beside the other module state:

```ts
/**
 * Deepest level the local pack actually holds, from /api/v1/map-tiles/meta.
 *
 * The render stops short of the pyramid's true bottom to save disk, so asking
 * for a level past this can only ever 404. Defaults to the DZI maximum so the
 * module behaves correctly before meta has been read.
 */
let renderedMaxLevel: number = ISO_DZI.maxLevel

export function setRenderedMaxLevel(level: number): void {
  renderedMaxLevel = Math.min(ISO_DZI.maxLevel, Math.max(ISO_DZI.minLevel, level))
}
```

and change `levelForScale` to respect it:

```ts
export function levelForScale(isoScale: number): number {
  const raw = ISO_DZI.maxLevel + Math.log2(isoScale)
  return Math.min(renderedMaxLevel, Math.max(ISO_DZI.minLevel, Math.round(raw)))
}
```

- [ ] **Step 3: Fetch the meta once and apply it**

In `web/ui/src/lib/iso-tiles.ts`:

```ts
export interface TileMeta {
  generated: boolean
  min_level: number | null
  max_level: number | null
  game_version: string | null
}

let metaRequest: Promise<TileMeta> | null = null

/** Read once per page; the answer only changes when someone re-renders. */
export function loadTileMeta(): Promise<TileMeta> {
  metaRequest ??= fetch('/api/v1/map-tiles/meta')
    .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
    .then((meta: TileMeta) => {
      if (meta.max_level !== null) {
        setRenderedMaxLevel(meta.max_level)
      }
      return meta
    })
    .catch(() => {
      metaRequest = null
      return { generated: false, min_level: null, max_level: null, game_version: null }
    })

  return metaRequest
}
```

- [ ] **Step 4: Re-run the console checks**

Expected: all three assertions pass.

- [ ] **Step 5: Say "not generated" instead of "not answering"**

In `web/ui/src/components/ui/worldmap.tsx`, call `loadTileMeta()` in the mount
effect and hold the result. Where `map.iso_unavailable` is rendered, use a
second key when `generated` is false:

```tsx
{isoFellBack ? (
  <p className="text-hazard">
    {tileMeta && !tileMeta.generated ? t('map.iso_not_generated') : t('map.iso_unavailable')}
  </p>
) : null}
```

Add to `web/ui/src/i18n/en.json`, in `map.` key order:

```json
  "map.iso_not_generated": "Isometric tiles have not been generated on this server yet — showing the schematic basemap.",
```

and to `web/ui/src/i18n/de.json`:

```json
  "map.iso_not_generated": "Für diesen Server wurden noch keine isometrischen Kacheln erzeugt — es wird die schematische Grundkarte angezeigt.",
```

- [ ] **Step 6: Typecheck, lint, build**

```bash
cd web/ui && npx tsc -b && npm run lint && npm run build
```

Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add web/ui/src/lib/iso-tiles.ts web/ui/src/components/ui/worldmap.tsx \
        web/ui/src/i18n/en.json web/ui/src/i18n/de.json
git commit -m "Ask only for tile levels this server actually rendered."
```

---

### Task 8: Run the real render and verify end to end

This is the long one. Everything before it is fast; this is hours.

- [ ] **Step 1: Check there is room**

```bash
df -h .
```

Expected: at least 25 GB free — ~15 GB for the result plus headroom for the tree
ahead of the packer catching up.

- [ ] **Step 2: Render**

```bash
make map-tiles          # or .\make.ps1 map-tiles on Windows
```

Expected: level-by-level progress, then `packed N new tiles`, then a listing of
`tiles.sqlite`. Interrupting is safe; re-running resumes.

- [ ] **Step 3: Check what landed**

```bash
ls -lh data/map-tiles/tiles.sqlite
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml \
  --profile tools run --rm --entrypoint python map-tiles -c \
  "import sqlite3;c=sqlite3.connect('/out/tiles.sqlite');\
print(c.execute('SELECT COUNT(*) FROM tiles').fetchone()[0],'tiles');\
print(dict(c.execute('SELECT key,value FROM meta')))"
```

Expected: roughly 27,000 tiles, `min_level` 8, `max_level` 20.

- [ ] **Step 4: Restart the API so it opens the new file**

```bash
docker compose -f docker-compose.yml -f docker-compose.amd64.yml -f docker-compose.web.yml restart web-api
curl -s http://127.0.0.1:8100/api/v1/map-tiles/meta
```

Expected: `{"generated":true,"min_level":8,"max_level":20,"game_version":"42.20.0"}`.

The store is opened at start-up, so a render on a running stack needs this
restart. Note it in the docs.

- [ ] **Step 5: Prove tiles serve**

```bash
curl -s -o /dev/null -w "z8   %{http_code} %{content_type} %{size_download}\n" \
  http://127.0.0.1:8100/api/v1/map-tiles/8/0_0.jpg
curl -s -o /dev/null -w "z20  %{http_code} %{content_type} %{size_download}\n" \
  http://127.0.0.1:8100/api/v1/map-tiles/20/139_61.jpg
curl -s -o /dev/null -w "z22  %{http_code}\n" \
  http://127.0.0.1:8100/api/v1/map-tiles/22/558_244.jpg
```

Expected: the first two `200 image/jpeg` with non-zero sizes, the third `404`.

- [ ] **Step 6: Prove nothing calls out any more**

Open the panel, sign in, go to the player map, switch to Isometric, and pan and
zoom. In the browser's network panel, filter on `pzmap.org`.

Expected: no requests. Every tile comes from `/api/v1/map-tiles/`.

- [ ] **Step 7: Prove the pins still line up — the geometry gate, in the real UI**

Pick a survivor whose in-game position you know, or use the map's click-to-read
coordinate. Confirm the pin sits on the same building it does on pzmap.org at
the same coordinates.

This is the check Task 1 was protecting. If pins are offset, the render's bounds
differ from `ISO_DZI` and the pyramid must be re-rendered with a corrected
`dzi_cell_range` — not papered over by editing `ISO_DZI`.

- [ ] **Step 8: Update the documentation**

Rewrite the generation sections of `docs/map-tiles.md` around `make map-tiles`,
and delete the Laravel-era `PZ_MAP_BASEMAP` and `zomboid:generate-map-tiles`
material, which describes code that no longer exists. Note the `web-api`
restart from Step 4 and the disk requirement from Step 1.

- [ ] **Step 9: Commit**

```bash
git add docs/map-tiles.md
git commit -m "Document rendering the basemap from the server's own game files."
```

`data/map-tiles/` is host data and must not be committed. Confirm it is ignored:

```bash
git status --short data/map-tiles
```

Expected: no output.

---

## Notes for whoever runs this

- **Tasks 1–7 are quick. Task 8 is hours.** Do not start Task 8 until 1–7 are
  committed and green, because a failed geometry check means re-rendering.
- **The geometry gate in Task 1 Step 9 is not optional.** Skipping it risks
  discovering after a multi-hour render that every pin is in the wrong place.
- **Nothing here is reversible-by-accident.** The render only writes to
  `data/map-tiles`, and the game install is mounted read-only.
- **If pzmap2dzi's interface has moved on**, its config is the contract: read
  `conf/conf.yaml` in the cloned repo and reconcile, rather than guessing at
  flags. `main.py` takes only `-c/--conf`, a command, and remaining arguments.
