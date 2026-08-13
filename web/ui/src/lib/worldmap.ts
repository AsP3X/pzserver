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

interface DrawOptions {
  /** CSS pixel size of the canvas. */
  width: number
  height: number
  /** Where to put a marker, in world coordinates. */
  marker?: { x: number; y: number } | null
  /** Colour for the marker ring. */
  markerColor?: string
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

  if (options.marker) {
    drawMarker(ctx, px(options.marker.x), py(options.marker.y), options.markerColor)
  }
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
): void {
  ctx.save()

  ctx.beginPath()
  ctx.arc(x, y, 11, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.lineWidth = 5
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(x, y, 11, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 2.5
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(x, y, 2.5, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()

  ctx.restore()
}
