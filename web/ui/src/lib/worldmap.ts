/**
 * The Knox County basemap: loading the vector pack and painting it.
 *
 * The pack is a schematic of the world built from the game's own map data —
 * water, roads, railways and building footprints as flat polygons in world
 * coordinates, plus a handful of place labels. It is the same artefact the PHP
 * stack serves; only the renderer is new. That one is built on Leaflet and
 * carries a second isometric tile mode, an admin's whole player fleet and a
 * legend. None of that is wanted for showing one survivor one dot, so this
 * draws straight onto a canvas instead.
 *
 * Coordinates are the game's: one unit is one floor tile, and the world runs
 * to roughly 19,800 x 15,900. Nothing here converts to latitude and longitude.
 */

import { headBitmap } from '@/lib/player-look'

/** Where the pack is served from. Copied in at build time, not fetched cold. */
export const WORLDMAP_URL = '/map/vanilla.json'

interface Style {
  fill: string
  /**
   * Below this zoom the layer is not drawn. Every building footprint in Knox
   * County at arm's length is a grey smear, so the pack says at what point
   * each layer starts being information rather than noise.
   */
  minZ: number
  /** Paint order, low to high. */
  order: number
}

interface Label {
  /** The text, already upper-cased by the generator. */
  t: string
  x: number
  y: number
  /** Style key, so a label is tinted like the thing it names. */
  k: string
  /** Relative size. */
  s: number
}

/** One feature: a style key and a flat [x, y, x, y, …] ring. */
type Feature = [string, number[]]

/**
 * Features bucketed by cell, keyed `"column,row"` — the game's own 300-unit
 * cells, which is what makes culling cheap. Sparse: empty stretches of map
 * have no key at all.
 */
type Cells = Record<string, Feature[]>

export interface Worldmap {
  /** [minX, minY, maxX, maxY] in world units. */
  bounds: [number, number, number, number]
  bg: [number, number, number]
  styles: Record<string, Style>
  cells: Cells
  labels: Label[]
  cellSize: number
  /** Display name of the map this was built from. */
  name: string
}

interface RawWorldmap {
  bounds: [number, number, number, number]
  bg: [number, number, number]
  styles: Record<string, Style>
  cells: Cells
  labels: Label[]
  cellSize: number
  maps?: { name?: string }[]
}

let pending: Promise<Worldmap> | null = null

/**
 * Fetch the pack once per page load.
 *
 * It is about 1.6 MB of JSON, so the promise is cached rather than the parsed
 * result being re-derived: two components mounting at once must not pull it
 * twice.
 */
export function loadWorldmap(): Promise<Worldmap> {
  pending ??= fetch(WORLDMAP_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`worldmap ${response.status}`)
      }

      return response.json() as Promise<RawWorldmap>
    })
    .then((raw) => ({
      bounds: raw.bounds,
      bg: raw.bg,
      styles: raw.styles,
      cells: raw.cells,
      labels: raw.labels,
      cellSize: raw.cellSize,
      name: raw.maps?.[0]?.name ?? 'Knox County',
    }))
    .catch((error: unknown) => {
      // Let the next mount try again rather than caching the failure forever.
      pending = null

      throw error
    })

  return pending
}

export interface View {
  /** World coordinate at the centre of the canvas. */
  x: number
  y: number
  /** Device-independent pixels per world unit. */
  scale: number
}

/**
 * The pack's `minZ` thresholds are Leaflet zoom levels, where the world is one
 * pixel per unit at zoom 0 — so a zoom is the base-2 log of the scale.
 */
export function zoomOf(scale: number): number {
  return Math.log2(scale)
}

/** The scale at which the whole world just fits inside a box. */
export function fitScale(
  bounds: Worldmap['bounds'],
  width: number,
  height: number,
): number {
  const [minX, minY, maxX, maxY] = bounds

  return Math.min(width / (maxX - minX), height / (maxY - minY))
}

/** Keep the centre inside the world, so the map cannot be flung into the void. */
export function clampView(view: View, map: Worldmap): View {
  const [minX, minY, maxX, maxY] = map.bounds

  return {
    ...view,
    x: Math.min(Math.max(view.x, minX), maxX),
    y: Math.min(Math.max(view.y, minY), maxY),
  }
}

export interface MapPin {
  x: number
  y: number
  /** Used to tell the page which pin was clicked. */
  id?: string
  color?: string
  label?: string
  /** Overall body health 0–100. */
  health?: number | null
  look?: import('@/lib/player-look').PlayerLook | null
}

interface DrawOptions {
  /** CSS pixel size of the canvas. */
  width: number
  height: number
  /** Where to put a marker, in world coordinates. */
  marker?: {
    x: number
    y: number
    health?: number | null
    look?: import('@/lib/player-look').PlayerLook | null
  } | null
  /** Colour for the marker ring. */
  markerColor?: string
  /** Extra pins — used by the admin map to show everyone at once. */
  markers?: MapPin[]
  /** A destination the operator has picked, drawn as a cross. */
  destination?: { x: number; y: number } | null
  /** Which extra pin is selected, so its label stays up even when zoomed out. */
  selectedId?: string | null
  /** Painted flow areas, in world-tile cells. */
  zones?: MapZone[]
  /** In-progress rectangle while drawing a safe zone. */
  draftRect?: MapRect | null
  /** Brush ghost while painting a district, in world tiles. */
  brush?: {
    x: number
    y: number
    radius: number
    erase?: boolean
    cellSize?: number
  } | null
  /** World-square rects `[x, y, w, h]` a tile job is painting right now. */
  updating?: number[][]
}

export interface MapRect {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface MapZone {
  id?: string
  cells: { x: number; y: number }[]
  cellSize: number
  color?: string
  selected?: boolean
  /** World-tile rectangle. Preferred over cells for large no-PvP boxes. */
  rect?: MapRect
  label?: string
}

/**
 * Paint the map.
 *
 * Layers are painted in the pack's own order rather than cell by cell, so a
 * road never disappears under the building it runs past. Only cells touching
 * the viewport are visited, which is the entire reason the pack is bucketed.
 */
export function drawWorldmap(
  ctx: CanvasRenderingContext2D,
  map: Worldmap,
  view: View,
  options: DrawOptions,
): void {
  const { width, height } = options
  const zoom = zoomOf(view.scale)

  const [red, green, blue] = map.bg
  ctx.fillStyle = `rgb(${red} ${green} ${blue})`
  ctx.fillRect(0, 0, width, height)

  // World -> canvas.
  const px = (x: number) => (x - view.x) * view.scale + width / 2
  const py = (y: number) => (y - view.y) * view.scale + height / 2

  // The world rectangle currently on screen, in cell coordinates. Padded by a
  // cell in each direction: the generator files a polygon under one cell even
  // when it laps a little way into the next, so culling exactly to the
  // viewport clips roads and rivers at the edge of the screen.
  const halfW = width / 2 / view.scale
  const halfH = height / 2 / view.scale

  const firstCol = Math.floor((view.x - halfW) / map.cellSize) - 1
  const lastCol = Math.floor((view.x + halfW) / map.cellSize) + 1
  const firstRow = Math.floor((view.y - halfH) / map.cellSize) - 1
  const lastRow = Math.floor((view.y + halfH) / map.cellSize) + 1

  const visible: Feature[][] = []
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstCol; column <= lastCol; column += 1) {
      const cell = map.cells[`${column},${row}`]
      if (cell) {
        visible.push(cell)
      }
    }
  }

  const layers = Object.entries(map.styles)
    .filter(([, style]) => zoom >= style.minZ)
    .sort((left, right) => left[1].order - right[1].order)

  for (const [key, style] of layers) {
    ctx.fillStyle = style.fill
    ctx.beginPath()

    for (const cell of visible) {
      for (const [featureKey, ring] of cell) {
        if (featureKey !== key || ring.length < 6) {
          continue
        }

        ctx.moveTo(px(ring[0]!), py(ring[1]!))
        for (let index = 2; index < ring.length; index += 2) {
          ctx.lineTo(px(ring[index]!), py(ring[index + 1]!))
        }
        ctx.closePath()
      }
    }

    ctx.fill()
  }

  drawLabels(ctx, map, view, { px, py, width, height, zoom })
  drawMapOverlays(ctx, options, (x, y) => ({ x: px(x), y: py(y) }), zoom)
}

export function drawMapOverlays(
  ctx: CanvasRenderingContext2D,
  options: DrawOptions,
  toScreen: (x: number, y: number) => { x: number; y: number },
  zoom: number,
): void {
  for (const rect of options.updating ?? []) {
    drawConstruction(ctx, rect, toScreen)
  }

  if (options.marker) {
    const point = toScreen(options.marker.x, options.marker.y)
    try {
      drawMarker(ctx, point.x, point.y, options.markerColor, options.marker.health, options.marker.look)
    } catch {
      drawMarker(ctx, point.x, point.y, options.markerColor, options.marker.health, null)
    }
  }

  for (const extra of options.markers ?? []) {
    const point = toScreen(extra.x, extra.y)
    const color = extra.color ?? options.markerColor ?? '#ffb000'
    try {
      drawMarker(ctx, point.x, point.y, color, extra.health, extra.look)
    } catch {
      drawMarker(ctx, point.x, point.y, color, extra.health, null)
    }
    if (extra.label && (zoom >= 0 || extra.id === options.selectedId)) {
      drawPinLabel(ctx, point.x, point.y, extra.label, color)
    }
  }

  if (options.destination) {
    const point = toScreen(options.destination.x, options.destination.y)
    drawDestination(ctx, point.x, point.y)
  }

  for (const zone of options.zones ?? []) {
    drawZone(ctx, zone, toScreen)
  }

  if (options.draftRect) {
    drawRectZone(ctx, options.draftRect, 'rgba(255, 176, 0, 0.38)', true, toScreen)
  }

  if (options.brush) {
    drawBrush(ctx, options.brush, toScreen)
  }
}

const TAPE_YELLOW = '#f5c400'
const TAPE_BLACK = '#1a1a1a'

/**
 * Hazard-tape border around a world rectangle. The same four world corners
 * become a diamond on the isometric basemap and a box on the schematic one.
 * Stripe phase marches so the overlay reads as in-progress, not a painted zone.
 */
function drawConstruction(
  ctx: CanvasRenderingContext2D,
  rect: number[],
  toScreen: (x: number, y: number) => { x: number; y: number },
): void {
  if (rect.length < 4) {
    return
  }
  const [x, y, w, h] = rect
  if (!(w > 0) || !(h > 0)) {
    return
  }
  const corners = [
    toScreen(x, y),
    toScreen(x + w, y),
    toScreen(x + w, y + h),
    toScreen(x, y + h),
  ]
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(corners[0]!.x, corners[0]!.y)
  for (let i = 1; i < corners.length; i += 1) {
    ctx.lineTo(corners[i]!.x, corners[i]!.y)
  }
  ctx.closePath()
  ctx.fillStyle = 'rgba(245, 196, 0, 0.16)'
  ctx.fill()

  const width = 7
  ctx.lineJoin = 'miter'
  ctx.miterLimit = 4
  ctx.lineWidth = width + 2
  ctx.strokeStyle = TAPE_BLACK
  ctx.stroke()

  const stripe = 12
  const phase = -((Date.now() / 28) % (stripe * 2))
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i]!
    const b = corners[(i + 1) % corners.length]!
    stripeEdge(ctx, a.x, a.y, b.x, b.y, width, stripe, phase)
  }
  ctx.restore()
}

function stripeEdge(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  stripe: number,
  phase: number,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.hypot(dx, dy)
  if (length < 1) {
    return
  }
  const ux = dx / length
  const uy = dy / length
  const px = (-uy * width) / 2
  const py = (ux * width) / 2
  let along = phase
  let yellow = true
  while (along < length) {
    const start = Math.max(0, along)
    const end = Math.min(length, along + stripe)
    if (end > start) {
      const sx = x0 + ux * start
      const sy = y0 + uy * start
      const ex = x0 + ux * end
      const ey = y0 + uy * end
      ctx.beginPath()
      ctx.moveTo(sx + px, sy + py)
      ctx.lineTo(ex + px, ey + py)
      ctx.lineTo(ex - px, ey - py)
      ctx.lineTo(sx - px, sy - py)
      ctx.closePath()
      ctx.fillStyle = yellow ? TAPE_YELLOW : TAPE_BLACK
      ctx.fill()
    }
    along += stripe
    yellow = !yellow
  }
}

function cellCorners(
  cell: { x: number; y: number },
  size: number,
  toScreen: (x: number, y: number) => { x: number; y: number },
) {
  const x = cell.x * size
  const y = cell.y * size
  return [
    toScreen(x, y),
    toScreen(x + size, y),
    toScreen(x + size, y + size),
    toScreen(x, y + size),
  ]
}

function traceCell(
  ctx: CanvasRenderingContext2D,
  corners: { x: number; y: number }[],
) {
  ctx.moveTo(corners[0]!.x, corners[0]!.y)
  ctx.lineTo(corners[1]!.x, corners[1]!.y)
  ctx.lineTo(corners[2]!.x, corners[2]!.y)
  ctx.lineTo(corners[3]!.x, corners[3]!.y)
  ctx.closePath()
}

/** Magenta sits off the Knox iso palette (grass, dirt, tan roofs) so paint reads. */
export const ZONE_FILL = 'rgba(214, 48, 255, 0.52)'
export const ZONE_INK = '#ff9af5'

function drawRectZone(
  ctx: CanvasRenderingContext2D,
  rect: MapRect,
  color: string | undefined,
  selected: boolean,
  toScreen: (x: number, y: number) => { x: number; y: number },
): void {
  const west = Math.min(rect.x1, rect.x2)
  const east = Math.max(rect.x1, rect.x2)
  const north = Math.min(rect.y1, rect.y2)
  const south = Math.max(rect.y1, rect.y2)
  const corners = [
    toScreen(west, north),
    toScreen(east, north),
    toScreen(east, south),
    toScreen(west, south),
  ]
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(corners[0]!.x, corners[0]!.y)
  for (let index = 1; index < corners.length; index += 1) {
    ctx.lineTo(corners[index]!.x, corners[index]!.y)
  }
  ctx.closePath()
  ctx.fillStyle = selected ? 'rgba(255, 176, 0, 0.34)' : (color ?? ZONE_FILL)
  ctx.fill()
  ctx.strokeStyle = selected ? '#ffb000' : lightenStroke(color ?? ZONE_INK)
  ctx.lineWidth = selected ? 3 : 2
  ctx.stroke()
  ctx.restore()
}

function drawZone(
  ctx: CanvasRenderingContext2D,
  zone: MapZone,
  toScreen: (x: number, y: number) => { x: number; y: number },
): void {
  if (zone.rect) {
    drawRectZone(ctx, zone.rect, zone.color, zone.selected === true, toScreen)
    if (zone.label) {
      const mid = toScreen((zone.rect.x1 + zone.rect.x2) / 2, (zone.rect.y1 + zone.rect.y2) / 2)
      drawPinLabel(ctx, mid.x, mid.y, zone.label, zone.color ?? ZONE_INK)
    }
    return
  }
  if (zone.cells.length === 0) {
    return
  }

  const size = Math.max(1, zone.cellSize)
  const owned = new Set(zone.cells.map((cell) => `${cell.x},${cell.y}`))
  const corners = zone.cells.map((cell) => cellCorners(cell, size, toScreen))
  const span = cellScreenSpan(corners[0]!)

  ctx.save()
  ctx.beginPath()
  for (const quad of corners) {
    traceCell(ctx, quad)
  }
  ctx.fillStyle = 'rgba(18, 0, 28, 0.62)'
  ctx.fill()
  ctx.fillStyle = zone.color ?? ZONE_FILL
  ctx.fill()

  ctx.save()
  ctx.clip()
  ctx.strokeStyle = 'rgba(255, 210, 255, 0.42)'
  ctx.lineWidth = 2
  const hatch = Math.max(8, Math.min(16, span / 3))
  const bounds = hatchBounds(zone.cells, size, toScreen)
  for (let walk = bounds.min - bounds.height; walk < bounds.max + bounds.height; walk += hatch) {
    ctx.beginPath()
    ctx.moveTo(walk, bounds.top)
    ctx.lineTo(walk + bounds.height, bounds.bottom)
    ctx.stroke()
  }
  ctx.restore()

  if (span >= 10) {
    ctx.strokeStyle = 'rgba(255, 232, 255, 0.88)'
    ctx.lineWidth = span >= 22 ? 1.35 : 1
    ctx.beginPath()
    for (const quad of corners) {
      traceCell(ctx, quad)
    }
    ctx.stroke()
  }

  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = '#120016'
  ctx.lineWidth = span >= 16 ? 7 : 5
  strokeZoneEdge(ctx, zone.cells, owned, size, toScreen)
  ctx.strokeStyle = zone.color ? lightenStroke(zone.color) : ZONE_INK
  ctx.lineWidth = span >= 16 ? 3 : 2.25
  strokeZoneEdge(ctx, zone.cells, owned, size, toScreen)
  ctx.restore()
}

function cellScreenSpan(corners: { x: number; y: number }[]): number {
  return Math.hypot(corners[0]!.x - corners[2]!.x, corners[0]!.y - corners[2]!.y)
}

function lightenStroke(color: string): string {
  return color.startsWith('rgba') ? '#ffe27a' : color
}

function hatchBounds(
  cells: { x: number; y: number }[],
  size: number,
  toScreen: (x: number, y: number) => { x: number; y: number },
) {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const cell of cells) {
    for (const corner of cellCorners(cell, size, toScreen)) {
      left = Math.min(left, corner.x)
      top = Math.min(top, corner.y)
      right = Math.max(right, corner.x)
      bottom = Math.max(bottom, corner.y)
    }
  }
  return { min: left, max: right, top, bottom, height: bottom - top }
}

function strokeZoneEdge(
  ctx: CanvasRenderingContext2D,
  cells: { x: number; y: number }[],
  owned: Set<string>,
  size: number,
  toScreen: (x: number, y: number) => { x: number; y: number },
) {
  ctx.beginPath()
  for (const cell of cells) {
    const corners = cellCorners(cell, size, toScreen)
    const edges: [number, number, number, number][] = [
      [0, 1, 0, -1],
      [1, 2, 1, 0],
      [2, 3, 0, 1],
      [3, 0, -1, 0],
    ]
    for (const [from, to, dx, dy] of edges) {
      if (owned.has(`${cell.x + dx},${cell.y + dy}`)) {
        continue
      }
      ctx.moveTo(corners[from]!.x, corners[from]!.y)
      ctx.lineTo(corners[to]!.x, corners[to]!.y)
    }
  }
  ctx.stroke()
}

function drawBrush(
  ctx: CanvasRenderingContext2D,
  brush: { x: number; y: number; radius: number; erase?: boolean; cellSize?: number },
  toScreen: (x: number, y: number) => { x: number; y: number },
) {
  const size = Math.max(1, brush.cellSize ?? 16)
  const cells = cellsUnderBrush(brush.x, brush.y, brush.radius, size)
  ctx.save()
  ctx.beginPath()
  for (const cell of cells) {
    traceCell(ctx, cellCorners(cell, size, toScreen))
  }
  ctx.fillStyle = brush.erase ? 'rgba(196, 69, 54, 0.28)' : 'rgba(214, 48, 255, 0.28)'
  ctx.fill()
  ctx.strokeStyle = brush.erase ? '#ff8a7a' : '#ffe0ff'
  ctx.lineWidth = 2
  ctx.setLineDash([5, 4])
  ctx.stroke()
  ctx.restore()
}

function cellsUnderBrush(
  worldX: number,
  worldY: number,
  radius: number,
  size: number,
): { x: number; y: number }[] {
  const originX = Math.floor(worldX / size)
  const originY = Math.floor(worldY / size)
  const reach = Math.max(0, Math.round(radius / size))
  const out: { x: number; y: number }[] = []
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dy = -reach; dy <= reach; dy += 1) {
      if (dx * dx + dy * dy <= reach * reach) {
        out.push({ x: originX + dx, y: originY + dy })
      }
    }
  }
  return out
}

export interface WorldMapping {
  toScreen(x: number, y: number): { x: number; y: number }
  toWorld(sx: number, sy: number): { x: number; y: number }
}

export function vectorMapping(view: View, width: number, height: number): WorldMapping {
  return {
    toScreen(x, y) {
      return worldToScreen(view, width, height, x, y)
    },
    toWorld(sx, sy) {
      return screenToWorld(view, width, height, sx, sy)
    },
  }
}

/** World coordinate under a point on the canvas. */
export function screenToWorld(
  view: View,
  width: number,
  height: number,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return {
    x: view.x + (screenX - width / 2) / view.scale,
    y: view.y + (screenY - height / 2) / view.scale,
  }
}

/** Canvas pixel for a world coordinate. */
export function worldToScreen(
  view: View,
  width: number,
  height: number,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: (x - view.x) * view.scale + width / 2,
    y: (y - view.y) * view.scale + height / 2,
  }
}

const HIT_RADIUS = 20

/**
 * Nearest pin under a canvas point, or null if nothing is close enough.
 *
 * Distance is in CSS pixels, not world units, so a cluster stays clickable
 * at every zoom instead of only when you are already on top of it.
 */
export function hitTestPins(
  mapping: WorldMapping,
  pins: MapPin[],
  screenX: number,
  screenY: number,
): MapPin | null {
  let best: MapPin | null = null
  let bestDistance = HIT_RADIUS

  for (const pin of pins) {
    const point = mapping.toScreen(pin.x, pin.y)
    const distance = Math.hypot(point.x - screenX, point.y - screenY)
    if (distance <= bestDistance) {
      best = pin
      bestDistance = distance
    }
  }

  return best
}

interface Projection {
  px: (x: number) => number
  py: (y: number) => number
  width: number
  height: number
  zoom: number
}

/**
 * Place names, once there is room for them.
 *
 * Held back below zoom -3: the pack has sixty-six labels and at a full-world
 * view they land on top of each other and read as a single smear.
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  map: Worldmap,
  view: View,
  { px, py, width, height, zoom }: Projection,
): void {
  if (zoom < -3) {
    return
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (const label of map.labels) {
    const x = px(label.x)
    const y = py(label.y)

    if (x < -80 || x > width + 80 || y < -20 || y > height + 20) {
      continue
    }

    const size = Math.max(9, Math.min(20, 11 * label.s * Math.max(1, view.scale * 40)))

    ctx.font = `600 ${size}px "Inter Variable", system-ui, sans-serif`
    // A halo rather than a shadow: the labels sit over water, roads and roofs
    // in turn, and only an outline stays legible across all three.
    ctx.lineWidth = Math.max(2, size / 5)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)'
    ctx.lineJoin = 'round'
    ctx.strokeText(label.t, x, y)
    ctx.fillStyle = map.styles[label.k]?.fill ?? '#333'
    ctx.fillText(label.t, x, y)
  }
}

/**
 * The "you are here" pin.
 *
 * Drawn as a ring with a gap-free outline rather than a filled blob: the map
 * underneath is what the player is trying to read, and a solid marker hides
 * the one building they are standing in.
 */
function drawMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color = '#ffb000',
  health?: number | null,
  look?: import('@/lib/player-look').PlayerLook | null,
): void {
  ctx.save()

  if (health !== undefined && health !== null && Number.isFinite(health)) {
    const fraction = Math.max(0, Math.min(1, health / 100))
    const tone = fraction >= 0.67 ? '#8bb04a' : fraction >= 0.34 ? '#ffb000' : '#c44536'

    ctx.beginPath()
    ctx.arc(x, y, 18, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.lineWidth = 3.5
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(x, y, 18, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2)
    ctx.strokeStyle = tone
    ctx.lineWidth = 3
    ctx.stroke()
  }

  ctx.beginPath()
  ctx.arc(x, y, 13, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.lineWidth = 4
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(x, y, 13, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, 11.5, 0, Math.PI * 2)
  ctx.clip()
  const portrait = headBitmap(look, 24)
  ctx.drawImage(portrait, x - 12, y - 12, 24, 24)
  ctx.restore()

  ctx.restore()
}

function drawPinLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
): void {
  ctx.save()
  ctx.font = '600 11px "Inter Variable", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(10, 12, 10, 0.75)'
  ctx.lineJoin = 'round'
  ctx.strokeText(text, x + 14, y)
  ctx.fillStyle = color
  ctx.fillText(text, x + 14, y)
  ctx.restore()
}

/**
 * A destination is a cross, not another ring, so it cannot be mistaken for
 * a survivor standing there.
 */
function drawDestination(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save()
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.moveTo(x - 10, y)
  ctx.lineTo(x + 10, y)
  ctx.moveTo(x, y - 10)
  ctx.lineTo(x, y + 10)
  ctx.stroke()
  ctx.strokeStyle = '#e8e4d4'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x, y, 9, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}
