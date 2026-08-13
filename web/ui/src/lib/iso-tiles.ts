/**
 * Official isometric DZI tiles from map.projectzomboid.com.
 *
 * Same pyramid the public map serves: pzmap2dzi paints Knox County once,
 * Deep Zoom slices it into 2048px JPEGs, the browser only fetches the
 * window you can see. Overlays stay in game coordinates on top.
 *
 * Numbers match the old panel's `proxy_dzi` so a pin at (x, y) lands on
 * the same roof as it does on map.projectzomboid.com.
 */

export const ISO_TILE_HOST = 'https://map.projectzomboid.com'
/** Current default on map.projectzomboid.com (Build 42.20). */
export const ISO_TILE_URL =
  'https://map.projectzomboid.com/maps/42.20.0/base/layer0_files/{z}/{x}_{y}.jpg'

export const ISO_DZI = {
  width: 2_318_656,
  height: 1_019_040,
  x0: 1_040_384,
  y0: -139_296,
  sqr: 128,
  tileSize: 2048,
  maxLevel: 22,
  minLevel: 8,
} as const

/** CSS pixels per DZI pixel when focusing a survivor — about a street. */
export const DEFAULT_ISO_SCALE = 0.35

/** Whole-county floor / close-up ceiling. */
export const MIN_ISO_SCALE = 2 ** (ISO_DZI.minLevel - ISO_DZI.maxLevel)
export const MAX_ISO_SCALE = 1

const HALF = ISO_DZI.sqr / 2
const QUARTER = ISO_DZI.sqr / 4

export type IsoPoint = { x: number; y: number }

/** Game square → full-resolution DZI pixel. Matches the official viewer's iso CRS. */
export function worldToDzi(x: number, y: number): IsoPoint {
  return {
    x: (x - y) * HALF + ISO_DZI.x0,
    y: (x + y) * QUARTER + ISO_DZI.y0,
  }
}

/** Full-resolution DZI pixel → game square. */
export function dziToWorld(px: number, py: number): IsoPoint {
  const a = (px - ISO_DZI.x0) / HALF
  const b = (py - ISO_DZI.y0) / QUARTER
  return {
    x: (a + b) / 2,
    y: (b - a) / 2,
  }
}

export function isoScaleForView(
  scale: number,
  width: number,
  height: number,
): number {
  const next = Math.min(MAX_ISO_SCALE, Math.max(MIN_ISO_SCALE, scale))
  if (!Number.isFinite(next) || next <= 0) {
    return fitIsoScale(width, height)
  }
  return next
}

/** Zoom that just fits the vanilla world diamond in the box. */
export function fitIsoScale(width: number, height: number): number {
  const corners = [
    worldToDzi(0, 0),
    worldToDzi(19_800, 0),
    worldToDzi(0, 15_900),
    worldToDzi(19_800, 15_900),
  ]
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  const dziW = Math.max(...xs) - Math.min(...xs)
  const dziH = Math.max(...ys) - Math.min(...ys)
  return Math.min(width / dziW, height / dziH) * 0.92
}

/** DZI level whose native resolution is nearest the current screen scale. */
export function levelForScale(isoScale: number): number {
  const raw = ISO_DZI.maxLevel + Math.log2(isoScale)
  return Math.min(ISO_DZI.maxLevel, Math.max(ISO_DZI.minLevel, Math.round(raw)))
}

export function tileUrl(z: number, x: number, y: number): string {
  return ISO_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

/** How many full-res DZI pixels one tile covers at this level. */
export function tileSpan(level: number): number {
  return ISO_DZI.tileSize * 2 ** (ISO_DZI.maxLevel - level)
}

export function tilesOnLevel(level: number): { cols: number; rows: number } {
  const span = tileSpan(level)
  return {
    cols: Math.ceil(ISO_DZI.width / span),
    rows: Math.ceil(ISO_DZI.height / span),
  }
}

/**
 * Full-res DZI rectangle a tile actually covers.
 *
 * Edge tiles (and every tile once the span is larger than the image) are
 * smaller than `tileSpan`. Drawing them as a full square stretches the
 * isometric diamond into a flat rectangle — the "one more zoom-out and
 * it looks top-down" glitch.
 */
export function tileBounds(tile: IsoTile): { x: number; y: number; w: number; h: number } {
  const span = tileSpan(tile.z)
  const x = tile.x * span
  const y = tile.y * span
  return {
    x,
    y,
    w: Math.max(0, Math.min(span, ISO_DZI.width - x)),
    h: Math.max(0, Math.min(span, ISO_DZI.height - y)),
  }
}

/** Smallest scale that still keeps the isometric image filling the box. */
export function minIsoScaleForViewport(width: number, height: number): number {
  if (width <= 0 || height <= 0) {
    return MIN_ISO_SCALE
  }
  return Math.max(MIN_ISO_SCALE, Math.min(width / ISO_DZI.width, height / ISO_DZI.height))
}

export interface IsoTile {
  z: number
  x: number
  y: number
}

/**
 * Tiles that cover the current canvas, plus a one-tile pad so a small pan
 * does not flash empty while the next ring loads.
 */
export function visibleTiles(
  center: IsoPoint,
  isoScale: number,
  width: number,
  height: number,
): IsoTile[] {
  const level = levelForScale(isoScale)
  const span = tileSpan(level)
  const { cols, rows } = tilesOnLevel(level)
  const pad = span

  const left = center.x - width / 2 / isoScale - pad
  const right = center.x + width / 2 / isoScale + pad
  const top = center.y - height / 2 / isoScale - pad
  const bottom = center.y + height / 2 / isoScale + pad

  const x0 = Math.max(0, Math.floor(left / span))
  const x1 = Math.min(cols - 1, Math.floor(right / span))
  const y0 = Math.max(0, Math.floor(top / span))
  const y1 = Math.min(rows - 1, Math.floor(bottom / span))

  const tiles: IsoTile[] = []
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      tiles.push({ z: level, x, y })
    }
  }
  return tiles
}

export interface IsoMapping {
  toScreen(x: number, y: number): IsoPoint
  toWorld(sx: number, sy: number): IsoPoint
  isoScale: number
  center: IsoPoint
}

export function isoMapping(
  worldX: number,
  worldY: number,
  isoScale: number,
  width: number,
  height: number,
): IsoMapping {
  const center = worldToDzi(worldX, worldY)
  return {
    isoScale,
    center,
    toScreen(x, y) {
      const point = worldToDzi(x, y)
      return {
        x: (point.x - center.x) * isoScale + width / 2,
        y: (point.y - center.y) * isoScale + height / 2,
      }
    },
    toWorld(sx, sy) {
      return dziToWorld(
        center.x + (sx - width / 2) / isoScale,
        center.y + (sy - height / 2) / isoScale,
      )
    },
  }
}

type TileState =
  | { status: 'loading'; image: HTMLImageElement }
  | { status: 'ready'; image: HTMLImageElement }
  | { status: 'missing' }

/**
 * In-memory JPEG cache. The browser HTTP cache still holds the bytes;
 * this just keeps decoded bitmaps so a pan back does not decode again.
 */
export class IsoTileCache {
  private readonly entries = new Map<string, TileState>()
  private readonly order: string[] = []
  private readonly listeners = new Set<() => void>()
  private readonly limit: number

  constructor(limit = 80) {
    this.limit = limit
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private key(tile: IsoTile): string {
    return `${tile.z}/${tile.x}_${tile.y}`
  }

  private touch(key: string) {
    const index = this.order.indexOf(key)
    if (index >= 0) {
      this.order.splice(index, 1)
    }
    this.order.push(key)
    while (this.order.length > this.limit) {
      const oldest = this.order.shift()
      if (oldest) {
        this.entries.delete(oldest)
      }
    }
  }

  get(tile: IsoTile): HTMLImageElement | null {
    const entry = this.entries.get(this.key(tile))
    return entry?.status === 'ready' ? entry.image : null
  }

  request(tile: IsoTile) {
    const key = this.key(tile)
    if (this.entries.has(key)) {
      this.touch(key)
      return
    }

    const image = new Image()
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
    this.entries.set(key, { status: 'loading', image })
    this.touch(key)

    image.onload = () => {
      const current = this.entries.get(key)
      if (current?.status === 'loading') {
        this.entries.set(key, { status: 'ready', image })
        this.notify()
      }
    }
    image.onerror = () => {
      this.entries.set(key, { status: 'missing' })
    }
    image.src = tileUrl(tile.z, tile.x, tile.y)
  }

  /**
   * Walk up the pyramid until a loaded ancestor covers this tile, then
   * crop it to the child's real DZI rectangle.
   *
   * DZI edge tiles are remainders, not halves — a last-column child can be
   * ~10% of the parent. Splitting 50/50 painted a squashed second copy of
   * the county on the right (Louisville as a vertical strip).
   */
  ancestor(tile: IsoTile): { image: HTMLImageElement; sx: number; sy: number; sw: number; sh: number } | null {
    const child = tileBounds(tile)
    if (child.w <= 0 || child.h <= 0) {
      return null
    }

    let z = tile.z
    let x = tile.x
    let y = tile.y

    while (z > ISO_DZI.minLevel) {
      z -= 1
      x = Math.floor(x / 2)
      y = Math.floor(y / 2)
      const image = this.get({ z, x, y })
      if (!image) {
        continue
      }

      const parent = tileBounds({ z, x, y })
      if (parent.w <= 0 || parent.h <= 0) {
        return null
      }

      return {
        image,
        sx: ((child.x - parent.x) / parent.w) * image.width,
        sy: ((child.y - parent.y) / parent.h) * image.height,
        sw: (child.w / parent.w) * image.width,
        sh: (child.h / parent.h) * image.height,
      }
    }

    return null
  }
}

export const isoTiles = new IsoTileCache()

/** Paint the visible window. Requests missing tiles as a side effect. */
export function drawIsoTiles(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
): void {
  ctx.fillStyle = '#1c1a14'
  ctx.fillRect(0, 0, width, height)

  const tiles = visibleTiles(mapping.center, mapping.isoScale, width, height)

  for (const tile of tiles) {
    isoTiles.request(tile)
    const bounds = tileBounds(tile)
    if (bounds.w <= 0 || bounds.h <= 0) {
      continue
    }
    const destX = (bounds.x - mapping.center.x) * mapping.isoScale + width / 2
    const destY = (bounds.y - mapping.center.y) * mapping.isoScale + height / 2
    const destW = bounds.w * mapping.isoScale
    const destH = bounds.h * mapping.isoScale

    const ready = isoTiles.get(tile)
    if (ready) {
      ctx.drawImage(ready, destX, destY, destW, destH)
      continue
    }

    const parent = isoTiles.ancestor(tile)
    if (parent) {
      ctx.drawImage(
        parent.image,
        parent.sx,
        parent.sy,
        parent.sw,
        parent.sh,
        destX,
        destY,
        destW,
        destH,
      )
    }
  }

  // Coarser parent of the whole window, so the first frame is not black.
  if (tiles[0] && tiles[0].z > ISO_DZI.minLevel) {
    isoTiles.request({
      z: tiles[0].z - 1,
      x: Math.floor(tiles[0].x / 2),
      y: Math.floor(tiles[0].y / 2),
    })
  }
}
