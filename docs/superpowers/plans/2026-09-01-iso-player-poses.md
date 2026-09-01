# Iso map player figures (stand, crouch, sit)

> Parked 2026-09-01. Not started. Come back here before drawing survivors on
> the sprite map as full characters instead of head pins.

**Goal:** On the sprite isometric map, draw each online player as a Project
Zomboid-looking survivor in one of **three idle poses** — standing, crouch,
sitting — placed on the same iso square they occupy in the game.

**Why:** The pin is a ring plus a canvas-painted head. It marks *who* is there.
It does not look like a person standing on a tile. The live sprite map now
holds a street-zoom world; survivors should sit in that world the same way
furniture does.

**Related:** `web/ui/src/lib/player-look.ts`, `web/ui/src/lib/worldmap.ts`
(`drawMarker`), `game-server/mods/KnoxRelay/42/media/lua/server/KR_Look.lua`,
`KR_Beacon.lua`, `web/api/crates/pz-bridge/src/lua.rs` (`LivePlayer`),
`web/ui/src/lib/iso-sprites.ts` (placement: `worldToDzi`, `ISO_LAYER_HEIGHT`).

---

## What we already have

| Piece | Where | What it is |
|---|---|---|
| Live position | `KR_Beacon` → `Lua/players_live.json` ~30s | `x, y, z, is_dead, is_ghost, appearance` |
| Head look | `KR_Look.of` | female, skin RGB, hair name + color, beard, hat slot |
| Map pin | `drawMarker` + `paintHead` | Ring, health arc, 24px composed portrait |
| Body UI masks | `web/ui/src/lib/body-sprites.ts` | Front-view health-panel silhouettes, **not** iso |
| Worn clothes | `KR_Vitals` clothing panel | Names/condition for the character page, **not** used on the map |
| Sprite atlas | `sprites.sqlite` / lotpacks | World tiles only. No Bob/Kate. |

Build 42 survivors are **3D meshes**. The dedicated server does not ship that
art. The sprite bake (`web/tools/map-sprites/extract.py`) reads tile `.pack`
files and lotpacks — not character rigs.

Do **not** bake players into cell occupancy. They move. Occupancy is the
static (plus live door/window) world.

---

## Decision to make when we pick this up

How “actual” the figure is. This choice drives art, not Lua.

| Option | Looks like the game? | Effort | Limit |
|---|---|---|---|
| **A. Canvas body** | No. Same stylized heads, with a torso. | Small | Fine as a bigger pin, not a survivor on a square. |
| **B. Bake 3 idles from the client 3D rig** | Yes, at map scale. | Medium | Default clothes; tint skin/hair from `KR_Look`. |
| **C. Full clothing layers** | Closest. | Large | Every outfit × pose × facing — why TIS dropped 2D characters. |

**B is the point of this plan.** A is a fallback if we cannot get client
models into a bake. C is a later sitting.

Also decide facing count: **8** (reads on iso) vs **4** (half the frames).

---

## Target for v1 (option B)

- 2 bodies (male / female)
- 3 poses: `stand` | `crouch` | `sit`
- 8 facings (N, NE, E, SE, S, SW, W, NW)
- 1 default outfit
- Skin and hair tinted at draw time from existing `appearance`
- Street zoom: iso figure, painter-sorted with live sprites so walls can hide them
- Zoomed out: keep today’s pin
- Sitting on a chair vs sitting on the ground share **one** sit frame

That is on the order of **48 frames** (2 × 3 × 8), or 96 if we keep a second
outfit. One extra PNG atlas the UI loads like the tile atlas — **not** mixed
into `sprites.sqlite`.

---

## Work

### 1. Knox Relay — pose + facing

Lua change. Server **and** client must get the new Lua before we stop. Then
ask the Workshop-release question. Do not bump `modversion=` /
`KR_Bridge.VERSION` unless the answer is yes.

`KR_Beacon.export` adds, behind `pcall` like every other B42 getter:

```lua
pose = "stand" | "crouch" | "sit"
dir  = 0..7   -- iso facing
```

Probe (names may differ on this build; wrap each call):

- Crouch: `isSneaking` / sneak variable
- Sit: sit-on-ground and sit-on-furniture (one pose for v1)
- Facing: `getDirectionAngle` or forward vector, quantized to 8 iso dirs

Beacon at **30s is too slow** for pose. Use ~2–5s, or piggyback the vitals
tick (~10s) if we refuse a faster beacon.

Dead / ghost stay as they are (pin or hidden, not a posed figure).

### 2. Art — pose atlas from a client install

Not from the dedicated server. Need the PZ **client** models + idle /
crouch-idle / sit-idle clips.

Bake a small atlas (PNG pages + UV JSON): `male|female / stand|crouch|sit / dir`.
Same iso camera as the tile map (`worldToDzi`, `HALF=64`, origin at square
anchor). Record `ox, oy` the way tile sprites do.

Store next to map sprites or under `public/` — a few MB, not a new sqlite
volume unless the bake grows.

Tint: multiply skin/hair regions or keep unshaded greyscale zones. Do not
try to match every worn item in v1.

### 3. API

`LivePlayer` already has a loose `appearance` JSON blob. Add `pose` and `dir`
on the live mark (and the map pin type in `web/ui/src/lib/api.ts`). No new
service if beacon still owns `players_live.json`.

Friends / “share position” must keep working: no figure if they are not
sharing.

### 4. Map draw

Overlay **after** the live sprite pass, same CRS:

```
dzi = worldToDzi(x, y)
screen x = (dzi.x - center.x) * scale + ox * scale
screen y = (dzi.y - center.y) * scale + HALF * scale + oy * scale - z * 192 * scale
```

- Live / street zoom: draw the pose sprite (WebGL occupant or 2D blit)
- Painter key `wx+wy` then `z` so walls in front occlude the figure
- Far zoom: existing `drawMarker` head pin
- Do **not** punch the figure into occupancy or thumbs

### 5. Out of v1

- Walk cycles
- Clothing layers (vitals already lists worn items if we want this later)
- Chair depth-maps (in-game sitting *in* a seat; without it the figure will
  float on furniture — accept that or hide sit as “on ground” only)
- Baking characters into `sprites.sqlite`
- Using `BODY_SPRITES` health masks as iso bodies

---

## Files that will move

| Area | Files |
|---|---|
| Lua | `KR_Beacon.lua`, maybe `KR_Look.lua` if pose lives next to appearance |
| Bridge | `web/api/crates/pz-bridge/src/lua.rs` (`LivePlayer`) |
| API types | `web/ui/src/lib/api.ts`, admin/me map routes |
| Draw | `web/ui/src/lib/worldmap.ts` or `iso-sprites.ts` overlay |
| Art | new baker (client models) + atlas loader; not `extract.py` lotpacks |

Knox Relay version strings stay put until a **yes** on Workshop.

---

## Pickup checklist

1. Pick option **B** vs **A** (and 8 vs 4 facings).
2. Confirm B42 Lua names for sneak / sit / facing on the live server.
3. Confirm we can read client models + idle clips from a Windows client install
   (same constraint as tile texture packs).
4. Deploy Lua (server image recreate + client workshop cache) **before** the
   Workshop question.
5. Street-zoom figure + far-zoom pin. No occupancy rewrite.
