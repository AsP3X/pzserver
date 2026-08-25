/**
 * Isometric DZI tiles, served by this server from its own render.
 *
 * pzmap2dzi paints Knox County once from the game files the dedicated server
 * already has, Deep Zoom slices it into 2048px JPEGs, the browser only fetches
 * the window you can see. Overlays stay in game coordinates on top.
 *
 * Tiles come from this origin, out of the pyramid `make map-tiles` renders.
 * Nothing leaves the origin, so the map works with no internet at all and does
 * not lean on a volunteer CDN that has already moved once. The geometry below
 * is the same pyramid pzmap.org served — `web/tools/map-tiles/verify.py` gates
 * the render on it matching, because a mismatch puts every pin in the wrong
 * place while the tiles still look plausible.
 *
 * Levels above the rendered maximum answer 404 by design; `IsoTileCache`
 * upscales from the deepest level actually held. See `docs/map-tiles.md`.
 */

export const ISO_TILE_URL = '/api/v1/map-tiles/{z}/{x}_{y}.jpg'

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

/**
 * Deepest level we actually ask for. 22 is native 1:1 but a full county of
 * it is ~200 GB. 21 is one step past the complete pack (0–20): sharp enough
 * at max zoom, and it can be filled region by region. Missing z21 tiles 404
 * and the painter upscales from z20.
 */
export const ISO_DETAIL_MAX = 21

/** CSS pixels per DZI pixel when focusing a survivor — about a street. */
export const DEFAULT_ISO_SCALE = 0.35

/** How long a tile may hang before it counts as a failure. */
const TILE_TIMEOUT_MS = 10_000

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

/**
 * Deepest *complete* level the local pack holds, from /api/v1/map-tiles/meta.
 *
 * The client also asks for `ISO_DETAIL_MAX` (21). Those tiles 404 until a
 * regional job writes them; `IsoTileCache` then upscales from this level.
 */
let renderedMaxLevel: number = ISO_DZI.maxLevel

export function setRenderedMaxLevel(level: number): void {
  renderedMaxLevel = Math.min(ISO_DZI.maxLevel, Math.max(ISO_DZI.minLevel, level))
}

/** Query string for tile URLs; `undefined` until meta has been read. */
let packRevision: string | undefined

export interface TileMeta {
  generated: boolean
  min_level: number | null
  max_level: number | null
  game_version: string | null
  generated_at: string | null
  /** Jobs currently painting. */
  updating?: UpdatingJob[]
}

export interface UpdatingJob {
  /** World-square rects `[x, y, w, h]`. */
  rects: number[][]
  percent: number | null
  stage: string
}

let metaRequest: Promise<TileMeta> | null = null

/** Forget the cached meta so the next `loadTileMeta` hits the network. */
export function refreshTileMeta(): Promise<TileMeta> {
  metaRequest = null
  return loadTileMeta()
}

/** Read once, then again via `refreshTileMeta` while a job is running. */
export function loadTileMeta(): Promise<TileMeta> {
  metaRequest ??= fetch(`/api/v1/map-tiles/meta?t=${Date.now()}`, { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
    .then((meta: TileMeta) => {
      if (meta.max_level !== null) {
        setRenderedMaxLevel(meta.max_level)
      }
      setPackRevision(meta.generated_at ?? meta.game_version ?? '')
      return meta
    })
    .catch(() => {
      metaRequest = null
      setPackRevision('')
      return {
        generated: false,
        min_level: null,
        max_level: null,
        game_version: null,
        generated_at: null,
        updating: [],
      }
    })

  return metaRequest
}

/** DZI level whose native resolution is nearest the current screen scale. */
export function levelForScale(isoScale: number): number {
  const raw = ISO_DZI.maxLevel + Math.log2(isoScale)
  const cap = Math.min(ISO_DETAIL_MAX, Math.max(renderedMaxLevel, ISO_DETAIL_MAX))
  return Math.min(cap, Math.max(ISO_DZI.minLevel, Math.round(raw)))
}

export function tileUrl(z: number, x: number, y: number): string {
  const url = ISO_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
  if (packRevision) {
    return `${url}?v=${encodeURIComponent(packRevision)}`
  }
  return url
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
 * Tiles that cover the current canvas.
 *
 * `padTiles` (default 1) adds a one-tile ring so a small pan does not flash
 * empty while the next ring loads. Pass 0 for the pixels actually on screen,
 * which the painter requests first so the pad does not steal HTTP slots.
 */
export function visibleTiles(
  center: IsoPoint,
  isoScale: number,
  width: number,
  height: number,
  padTiles = 1,
): IsoTile[] {
  const level = levelForScale(isoScale)
  const span = tileSpan(level)
  const { cols, rows } = tilesOnLevel(level)
  const pad = span * padTiles

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

  /**
   * Session totals, deliberately not reset by eviction: they are a verdict on
   * the source, not on the tiles currently held.
   */
  private requested = 0
  private loaded = 0
  private failed = 0

  constructor(limit = 80) {
    this.limit = limit
  }

  /**
   * The tile source is not answering.
   *
   * A tile that 404s or is blocked fires `onerror` and nothing else, so
   * without this the canvas simply stays the empty-tile colour and the player
   * is left staring at a black rectangle wondering what broke.
   *
   * The test is "every tile we asked for came back a failure", not a fixed
   * count: zoomed out to the whole county the pyramid is one tile wide, so the
   * window asks for two and no threshold above that could ever trip. Requiring
   * nothing to have loaded all session keeps a single flaky tile from
   * condemning a source that is plainly working.
   */
  get unreachable(): boolean {
    return this.loaded === 0 && this.failed > 0 && this.failed >= this.requested
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

    if (this.order.length <= this.limit) {
      return
    }

    /**
     * Evict the oldest *settled* entries, and never an in-flight one.
     *
     * Dropping a request that is still loading does not cancel it. The image
     * still arrives, `settle` finds its entry gone and discards the bytes, the
     * next frame asks for the same tile again, and it is evicted again. The
     * view never converges — which looked like "zoom too fast and half the map
     * stops loading", and it was the top half, because `visibleIsoTiles` emits
     * rows top-down so the top rows are requested first and evicted first.
     *
     * In-flight entries are self-limiting: the browser caps concurrent
     * requests per origin, and they hold no decoded bitmap yet, so sparing
     * them costs far less memory than a ready tile does.
     */
    let over = this.order.length - this.limit
    const keep: string[] = []
    for (const candidate of this.order) {
      if (over > 0 && this.entries.get(candidate)?.status !== 'loading') {
        this.entries.delete(candidate)
        over -= 1
      } else {
        keep.push(candidate)
      }
    }
    this.order.length = 0
    this.order.push(...keep)
  }

  invalidate(): void {
    this.entries.clear()
    this.order.length = 0
    this.notify()
  }

  get(tile: IsoTile): HTMLImageElement | null {
    const entry = this.entries.get(this.key(tile))
    return entry?.status === 'ready' ? entry.image : null
  }

  request(tile: IsoTile, priority: 'high' | 'low' | 'auto' = 'auto') {
    if (packRevision === undefined) {
      return
    }

    const key = this.key(tile)
    if (this.entries.has(key)) {
      this.touch(key)
      return
    }

    const image = new Image()
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
    image.fetchPriority = priority
    this.entries.set(key, { status: 'loading', image })
    this.touch(key)
    this.requested += 1

    let settled = false
    /**
     * One outcome per request, whichever arrives first.
     *
     * A host that hangs rather than refusing is the nastiest case: no
     * `onerror`, so without the timer the verdict never lands and the player
     * watches an empty canvas for as long as the browser is willing to wait.
     */
    const settle = (ok: boolean) => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(timer)

      if (ok) {
        this.loaded += 1
      } else {
        this.failed += 1
      }

      // Only write back if this is still the entry we started: eviction may
      // have dropped it and a later request may already own the key.
      if (this.entries.get(key)?.status === 'loading') {
        this.entries.set(key, ok ? { status: 'ready', image } : { status: 'missing' })
      }

      // Sparse z21: a 404 is "not painted yet", not "the basemap is down".
      // Walk to the parent so the painter has something sharper than the
      // z-6 preview until that cell's detail job lands.
      if (!ok && tile.z > ISO_DZI.minLevel) {
        this.request(
          { z: tile.z - 1, x: tile.x >> 1, y: tile.y >> 1 },
          'high',
        )
      }

      // Notify on failure as well as success, or nothing ever re-reads
      // `unreachable` and the fallback never fires.
      this.notify()
    }

    const timer = window.setTimeout(() => settle(false), TILE_TIMEOUT_MS)
    image.onload = () => settle(true)
    image.onerror = () => settle(false)
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

export function setPackRevision(rev: string): void {
  if (packRevision === rev) {
    return
  }
  packRevision = rev
  isoTiles.invalidate()
}

/** Unique covering tiles at `level` for a set of finer tiles. */
function coveringAt(tiles: IsoTile[], level: number): IsoTile[] {
  const seen = new Set<string>()
  const out: IsoTile[] = []
  for (const tile of tiles) {
    const drop = Math.max(0, tile.z - level)
    const parent: IsoTile = {
      z: tile.z - drop,
      x: tile.x >> drop,
      y: tile.y >> drop,
    }
    const key = `${parent.z}/${parent.x}_${parent.y}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(parent)
  }
  return out
}

/** Paint the visible window. Requests missing tiles as a side effect. */
export function drawIsoTiles(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
): void {
  ctx.fillStyle = '#1c1a14'
  ctx.fillRect(0, 0, width, height)

  const viewport = visibleTiles(mapping.center, mapping.isoScale, width, height, 0)
  const padded = visibleTiles(mapping.center, mapping.isoScale, width, height, 1)

  // Coarser ancestors first: one ~300 KB z14 JPEG covers a street-level
  // viewport and paints immediately, then the 1 MB natives replace it.
  // HTTP/1.1 only opens ~6 connections per origin, so pad tiles go last
  // and with low priority so they cannot starve the pixels on screen.
  const previewLevel = viewport[0]
    ? Math.max(ISO_DZI.minLevel, viewport[0].z - 6)
    : ISO_DZI.minLevel
  for (const tile of coveringAt(viewport, previewLevel)) {
    isoTiles.request(tile, 'high')
  }
  // When asking for sparse z21, pull the complete z20 covering first so a
  // missing detail tile still paints native street resolution, not the
  // county-wide preview.
  if (viewport[0] && viewport[0].z > renderedMaxLevel) {
    for (const tile of coveringAt(viewport, renderedMaxLevel)) {
      isoTiles.request(tile, 'high')
    }
  }
  for (const tile of viewport) {
    isoTiles.request(tile)
  }
  for (const tile of padded) {
    isoTiles.request(tile, 'low')
  }

  for (const tile of padded) {
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
      // pzmap2dzi crops edge tiles smaller than tileSize. Stretching that
      // JPEG to the full DZI rectangle turns trees into a shifted stamp.
      const nw = ready.naturalWidth || ready.width
      const nh = ready.naturalHeight || ready.height
      if (nw > 0 && nh > 0 && (nw < ISO_DZI.tileSize || nh < ISO_DZI.tileSize)) {
        ctx.drawImage(
          ready,
          destX,
          destY,
          destW * (nw / ISO_DZI.tileSize),
          destH * (nh / ISO_DZI.tileSize),
        )
      } else {
        ctx.drawImage(ready, destX, destY, destW, destH)
      }
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
}
