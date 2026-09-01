# Hybrid isometric map (sprites in, JPEG out)

> Parked 2026-09-01. Not started. Come back here before combining the two
> isometric basemaps or deleting thumbs / high-zoom JPEG levels.

**Goal:** One isometric website map. Live sprites when zoomed in, the existing
JPEG DZI pack when zoomed out past **Z17**. Stop storing two close-up maps.

**Why:** Zoom 19 on Sprites was stretching 512px cell thumbs (~8×) with visible
cell seams. The game draws native sprites in the frustum. JPEG already covers
county zoom well. Keeping both LODs on disk is the waste.

**Related:** `docs/map-tiles.md`, `docs/map-sprites.md`,
`web/ui/src/lib/iso-sprites.ts`, `web/ui/src/lib/iso-tiles.ts`.
Live sprites at neighbourhood zoom: `dc59bb8`.

---

## Decision to make when we pick this up

Two ways to “combine.” Disk only moves if we **delete** the overlapping LOD.

| Option | What changes | Disk saved | Keep the Isometric toggle? |
|---|---|---|---|
| **A. UI only** | Sprites mode uses JPEG at ≤Z17. Drop sprite thumbs + overview. JPEG pack unchanged. | **~0.5–1 GB** | Yes. Full JPEG street map still needs z18–z20. |
| **B. One basemap** | Same UI cut. Also delete JPEG **z18–z20**. Fold Isometric + Sprites into one mode (Schematic stays). | **~24–25 GB** | No — or the toggle becomes this hybrid. |

**B is the point of this plan.** A is a small bake/disk cleanup if we still
want a pure photographed street view.

A client-only switch that leaves both packs on disk saves **nothing**.

---

## Cutoff

`levelForScale` is `22 + log2(isoScale)`.

| Zoom | `isoScale` | Role |
|---|---|---|
| 22 | 1.0 | Native sprites |
| 19 | 0.125 | Live WebGL sprites (current `LIVE_CELL_CAP`) |
| **17** | **0.03125** | **Switch to JPEG.** ~64 CSS px per 2048 JPEG tile. |
| 8 | ~1/16384 | County / whole-world JPEG |

Z17 is already past where occupancy for the whole view is cheap
(`LIVE_CELL_CAP = 48` cells). Do not invent a third LOD (sprite thumbs) for
the gap.

---

## What is on disk today

### JPEG DZI — `tiles.sqlite` on `pz-map-tiles-sqlite`

Measured (quality 85, levels 0–20, 21,726 tiles): **~24.4 GB**.

| Level | Tiles (geometric split of 21,726) | Size |
|---|---|---|
| z20 | ~16,300 | **~20 GB** (documented) |
| z19 | ~4,070 | ~3.3 GB |
| z18 | ~1,020 | ~0.8 GB |
| **z0–z17** | ~340 | **~0.3 GB** |

A full county of z21 was never in this pack (~60–80 GB, ~100 MB/cell). Hybrid
does not need it; sprites cover street zoom.

### Sprites — `sprites.sqlite` on `pz-map-sprites`

Bake facts: **4,065** cells, **25,990** unique sprites, 512px cell thumbs,
2048px county overview.

Live file was **not** `du`’d from the laptop (no SSH to the host). Split
estimated from the format:

| Table | Keep for hybrid? | Size |
|---|---|---|
| `cells.occupancy` (SPR1, 7 bytes/record) | **Yes** — this *is* the live map | ~1–3 GB |
| `atlas` (2048² PNG pages) | **Yes** | ~0.1–0.4 GB |
| `sprites` (UV + ox/oy) | **Yes** | negligible |
| `thumbs` (512×~291 PNG × 4,065) | **No** if JPEG covers ≤Z17 | **~0.4–0.8 GB** |
| `overview` (2048px stamp) | **No** | a few MB |

Pin the split on the host before deleting anything:

```bash
docker run --rm -v pz-map-sprites:/s -v pz-map-tiles-sqlite:/t nouchka/sqlite3 \
  sh -c 'ls -lh /s/sprites.sqlite /t/tiles.sqlite; sqlite3 /s/sprites.sqlite "
    SELECT name, ROUND(SUM(LENGTH(data))/1e6, 1) AS mb FROM (
      SELECT \"atlas\" name, data FROM atlas
      UNION ALL SELECT \"thumbs\", data FROM thumbs
      UNION ALL SELECT \"overview\", data FROM overview
    ) GROUP BY 1;
    SELECT \"occupancy\", ROUND(SUM(LENGTH(occupancy))/1e6, 1) FROM cells;"
  sqlite3 /t/tiles.sqlite "
    SELECT z, COUNT(*), ROUND(SUM(LENGTH(data))/1e6, 1) AS mb
    FROM tiles GROUP BY z ORDER BY z;"'
```

---

## Target disk (option B)

| Keep | Size |
|---|---|
| JPEG z0–z17 | ~0.3 GB |
| Sprite occupancy + atlas | ~1–3.5 GB |
| **Total** | **~2–5 GB** |

vs ~26–28 GB today. **Save ~24–25 GB.**

Cannot drop occupancy or atlas. Thumbs existed only because county zoom could
not draw every sprite; JPEG already does that job.

---

## Implementation sketch (when we do it)

Do not start from thumbs. Switch the **live** path first, then delete data.

1. **Measure** the two SQLite files on the host (command above). Write the
   real MB into this file, replacing the estimates.
2. **UI:** In `iso-sprite` mode, if `levelForScale(isoScale) <= 17`, call
   `drawIsoTiles` instead of `drawIsoSprites`. Keep Schematic. Decide whether
   the Isometric toggle remains (blocks deleting z18–z20) or becomes this
   hybrid.
3. **Prefetch:** Below the cut, do not fetch occupancy, atlas, or thumbs.
   Above the cut, do not fetch JPEG z18+ if we are about to drop those rows.
4. **Bake:** Skip `thumbs` + `overview` in `extract.py`. Occupancy still
   written per cell. Resume fingerprint (`BAKE_VERSION`) must bump so an old
   work file with thumbs is not reused as “done.”
5. **API:** Stop serving `/map-sprites/thumbs/` and `/overview` once nothing
   reads them. Optional: `DELETE FROM thumbs; DELETE FROM overview; VACUUM`
   on the live sprites DB (VACUUM copies the file; do it when disk has room).
6. **JPEG pack:** Only after the Isometric toggle is gone or hybrid. Delete
   `tiles` rows with `z >= 18` (or rebuild `make map-tiles` with a deeper
   omit). Client `ISO_DETAIL_MAX` / `renderedMaxLevel` must then be 17 for
   this mode so it does not request missing z18–z20. Do **not** VACUUM the
   24 GB file beside itself without ~25 GB free; a targeted rebuild may be
   cleaner than `DELETE` + `VACUUM`.
7. **Confirm:** Street zoom is live sprites (no cell diamonds). Zoom out past
   17 is JPEG, no hitch, pins still on `ISO_DZI` CRS. Hard-refresh after
   deploy.

Knox Relay is unrelated. Do not bump `modversion=` / `KR_Bridge.VERSION`.

---

## Open questions

- Keep a separate photographed **Isometric** mode? If yes, option A only.
- Cut at 17 vs 16 vs 18 — 17 matches the math; confirm in the browser.
- Rebuild JPEG capped at 17, or `DELETE z>=18` on the live pack?

---

## Status

- [x] Storage analysis (2026-09-01)
- [ ] Measure live `sprites.sqlite` / per-level `tiles.sqlite` on the host
- [ ] Choose A vs B (Isometric toggle)
- [ ] Implement UI cut
- [ ] Stop baking thumbs/overview
- [ ] Drop JPEG z18+ (B only)
