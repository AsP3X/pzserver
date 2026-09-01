/**
 * Sprite isometric basemap. Live sprites up close; the JPEG DZI pack when
 * zoomed out past live range (and the pack exists). Cell thumbs remain the
 * fallback if JPEG is missing.
 */

import {
  ISO_DZI,
  ISO_LAYER_HEIGHT,
  drawIsoTiles,
  dziToWorld,
  jpegPackReady,
  levelForScale,
  worldToDzi,
  type IsoMapping,
} from '@/lib/iso-tiles'
import {
  attachSpriteGl,
  drawSpritesGl,
  ensureSpriteGl,
  presentSpriteGl,
  setSpriteGlOnScreen,
  spriteGlEpoch,
  uploadAtlasPage,
} from '@/lib/iso-sprites-gl'

const CELL = 256
const HALF = 64
/** Must match `thumbs.py` `cell_dzi_box` pad: HALF*16 + LAYER_HEIGHT*8. */
const THUMB_PAD = HALF * 16 + ISO_LAYER_HEIGHT * 8
const BUCKET = 16
const BUCKETS = CELL / BUCKET
/** Keep occupancy/GPU batches stable for about this many CSS pixels of pan. */
const SNAP_PAN_PX = 240
/**
 * Live WebGL at HUD zoom 17 and closer. Mid-zoom draws 512px cell thumbs on
 * top of a county underlay. The 2048 overview is never the only picture
 * while a cell is still tens of pixels on screen (that was the z15 mush).
 */
const LIVE_CELL_CAP = 128
const THUMB_DRAW_PX = 96
const THUMB_ALWAYS_PX = 200
const THUMB_DRAW_CELLS = 900
const MIN_THUMB_CSS = 40
const MAX_INFLIGHT = 20
const CELL_LIMIT = 256
const THUMB_LIMIT = 768
const SORT_CAP = 250_000
const STAMP_PREFETCH = 192
/** Below this iso scale, drop ground sprites that cover less than one CSS pixel. */
const CLUTTER_SCALE = 0.08
/** Grass-ish, so holes do not flash the old near-black fill. */
const GROUND = '#4e5c36'

export interface SpriteMeta {
  ready: boolean
  generated_at: string | null
  game_version: string | null
  pages: number | null
  sprites: number | null
  cells: number | null
  z_min: number | null
  z_max: number | null
  thumb_scale: number | null
  max_reach: number | null
  cell_size: number | null
}

export interface SpriteRecord {
  id: number
  name: string
  page: number
  x: number
  y: number
  w: number
  h: number
  ox: number
  oy: number
}

interface PackedCell {
  count: number
  lx: Uint8Array
  ly: Uint8Array
  z: Int8Array
  sprite: Uint32Array
  bucketStart: Uint32Array
  bucketCount: Uint16Array
  pages: number[]
}

interface VisibleSprite {
  wx: number
  wy: number
  z: number
  sprite: number
  dziX: number
  dziY: number
}

type AtlasSource = HTMLImageElement | ImageBitmap

const atlasImages = new Map<number, AtlasSource>()
const atlasInflight = new Set<number>()
const atlasFailed = new Set<number>()
const thumbImages = new Map<string, HTMLImageElement>()
const thumbOrder: string[] = []
const cells = new Map<string, PackedCell | 'loading' | 'empty'>()
const cellOrder: string[] = []
const queuedThumbs = new Set<string>()
const listeners = new Set<() => void>()
const visiblePool: VisibleSprite[] = []
const sortScratch: VisibleSprite[] = []
const stampedOverview = new Set<string>()

interface CollectCache {
  cx0: number
  cy0: number
  cx1: number
  cy1: number
  n: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  cutaway: number | null
  liveRevision: number
  ready: number
  skip: number
  count: number
}

let collectCache: CollectCache | null = null
let sortedCount = -1
let gpuBatchEpoch = 1
let panSnap = ''

function bumpGpuBatches() {
  gpuBatchEpoch += 1
  panSnap = ''
}

let meta: SpriteMeta | null = null
let sprites: SpriteRecord[] = []
let spriteTable: Array<SpriteRecord | undefined> = []
let loading = false
let notifyFrame = 0
let inflight = 0
const waitQueue: Array<{ key: string; urgent: boolean; run: () => void }> = []
const thumbWanted = new Set<string>()
let overview: HTMLCanvasElement | null = null
let overviewCtx: CanvasRenderingContext2D | null = null
let overviewH = 0
let overviewW = 0
let bakedOverview: HTMLImageElement | null = null
let heldLive = false
let cutawayFloor: number | null = null
let roofById = new Uint8Array(0)
let lastDrawLive = false
let atlasWarm = 0
const liveRemove = new Map<number, Set<number>>()
const liveAdd: Array<{ wx: number; wy: number; z: number; sprite: number }> = []
let liveRevision = -1
let livePoll = 0
let cameraMoving = false
let atlasGeneration = 0
let rasterFrame = 0
let rasterJob: RasterJob | null = null
let spriteLayer: SpriteLayer | null = null

interface SpriteLayer {
  canvas: HTMLCanvasElement
  centerX: number
  centerY: number
  scale: number
  width: number
  height: number
  ready: number
  atlas: number
  cutaway: number | null
}

interface RasterJob {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  mapping: IsoMapping
  width: number
  height: number
  cover: { cx: number; cy: number }[]
  rows: VisibleSprite[]
  index: number
  centerX: number
  centerY: number
  scale: number
  ready: number
  atlas: number
  cutaway: number | null
}

let thumbNotifyWait = 0

function notify() {
  if (notifyFrame) {
    return
  }
  notifyFrame = requestAnimationFrame(() => {
    notifyFrame = 0
    for (const listener of listeners) {
      listener()
    }
  })
}

function notifyThumbs() {
  if (thumbNotifyWait) {
    return
  }
  thumbNotifyWait = window.setTimeout(() => {
    thumbNotifyWait = 0
    notify()
  }, 80)
}

export function spriteMapMoving(): boolean {
  return cameraMoving
}

export function setSpriteMapMoving(moving: boolean) {
  if (cameraMoving === moving) {
    return
  }
  cameraMoving = moving
  if (moving) {
    cancelRaster()
    return
  }
  notify()
}

function cancelRaster() {
  if (rasterFrame) {
    cancelAnimationFrame(rasterFrame)
    rasterFrame = 0
  }
  rasterJob = null
}

function cameraMatches(
  layer: { centerX: number; centerY: number; scale: number; width: number; height: number },
  mapping: IsoMapping,
  width: number,
  height: number,
) {
  return (
    layer.scale === mapping.isoScale &&
    layer.width === width &&
    layer.height === height &&
    Math.abs(layer.centerX - mapping.center.x) < 0.5 &&
    Math.abs(layer.centerY - mapping.center.y) < 0.5
  )
}

export function onSpriteMapChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function spriteMapReady(): boolean {
  return meta?.ready === true
}

/** Inclusive lotpack z range in the catalogue. `z_max` in meta is exclusive. */
export function spriteStoreyRange(): { min: number; max: number } {
  const min = meta?.z_min ?? 0
  const exclusive = meta?.z_max
  const max = exclusive != null && exclusive > 0 ? exclusive - 1 : 7
  return { min: Math.min(0, min), max: Math.max(0, max) }
}

/** `null` draws every storey (roofs on). A number hides everything above it. */
export function spriteCutawayFloor(): number | null {
  return cutawayFloor
}

/** True when the last paint used live sprites (Inside can hide storeys). */
export function spriteMapDrawingLive(): boolean {
  return lastDrawLive
}

export function setSpriteCutawayFloor(floor: number | null): void {
  let next = floor
  if (next !== null) {
    const { min, max } = spriteStoreyRange()
    next = Math.min(max, Math.max(min, next))
  }
  if (cutawayFloor === next) {
    return
  }
  cutawayFloor = next
  collectCache = null
  sortedCount = -1
  bumpGpuBatches()
  spriteLayer = null
  cancelRaster()
  notify()
}

export async function loadSpriteMap(): Promise<void> {
  if (loading || meta) {
    return
  }
  loading = true
  try {
    const next = await fetch('/api/v1/map-sprites/meta', { cache: 'no-store' }).then(
      (response) => response.json() as Promise<SpriteMeta>,
    )
    meta = next
    loading = false
    notify()
    if (!next.ready) {
      return
    }
    const version = next.generated_at ?? ''
    const overviewImage = new Image()
    overviewImage.decoding = 'async'
    overviewImage.onload = () => {
      if (overviewImage.naturalWidth > 0) {
        bakedOverview = overviewImage
        if (overviewCtx && overview && stampedOverview.size === 0) {
          overviewCtx.imageSmoothingEnabled = true
          overviewCtx.drawImage(bakedOverview, 0, 0, overview.width, overview.height)
        }
        notify()
      }
    }
    overviewImage.onerror = () => notify()
    overviewImage.src = `/api/v1/map-sprites/overview?v=${version}`
    const [packed, roofs] = await Promise.all([
      fetch(`/api/v1/map-sprites/sprites.bin?v=${version}`),
      fetch(`/api/v1/map-sprites/roofs.bin?v=${version}`),
    ])
    if (packed.ok) {
      applySpriteTable(decodeSpriteBin(await packed.arrayBuffer()))
    } else {
      const rows = await fetch(`/api/v1/map-sprites/sprites?v=${version}`).then(
        (response) => response.json() as Promise<SpriteRecord[]>,
      )
      applySpriteTable(rows)
    }
    if (roofs.ok) {
      applyRoofIds(decodeRoofBin(await roofs.arrayBuffer()))
    }
    warmAtlas()
    startLivePoll()
    notify()
  } catch {
    meta = { ready: false } as SpriteMeta
    loading = false
    notify()
  }
}

function pumpQueue() {
  const next = waitQueue.shift()
  if (next) {
    next.run()
  }
}

function enqueue(start: () => Promise<void>, urgent = false, key = '') {
  const run = () => {
    inflight += 1
    void start().finally(() => {
      inflight -= 1
      pumpQueue()
    })
  }
  if (inflight < MAX_INFLIGHT) {
    run()
    return
  }
  const item = { key, urgent, run }
  if (urgent) {
    waitQueue.unshift(item)
  } else {
    waitQueue.push(item)
  }
}

function dropQueuedThumbsExcept(wanted: Set<string>) {
  const keep: typeof waitQueue = []
  for (const item of waitQueue) {
    if (item.key.startsWith('thumb:')) {
      const cell = item.key.slice(6)
      if (!wanted.has(cell)) {
        queuedThumbs.delete(cell)
        continue
      }
    }
    keep.push(item)
  }
  waitQueue.length = 0
  waitQueue.push(...keep)
}

function touch(
  order: string[],
  key: string,
  limit: number,
  drop: (key: string) => boolean,
) {
  const index = order.indexOf(key)
  if (index >= 0) {
    order.splice(index, 1)
  }
  order.push(key)
  while (order.length > limit) {
    const oldest = order.shift()
    if (!oldest || oldest === key) {
      continue
    }
    if (!drop(oldest)) {
      order.push(oldest)
      break
    }
  }
}

function applySpriteTable(rows: SpriteRecord[]) {
  sprites = rows
  collectCache = null
  sortedCount = -1
  bumpGpuBatches()
  const maxId = rows.reduce((max, row) => (row.id > max ? row.id : max), 0)
  spriteTable = new Array(maxId + 1)
  const namedRoofs: number[] = []
  for (const row of rows) {
    spriteTable[row.id] = row
    if (isRoofName(row.name)) {
      namedRoofs.push(row.id)
    }
  }
  if (namedRoofs.length > 0) {
    applyRoofIds(namedRoofs)
  }
}

function isRoofName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('roofs_') || lower.includes('_roofs_')
}

function applyRoofIds(ids: number[]) {
  let max = roofById.length
  for (const id of ids) {
    if (id + 1 > max) {
      max = id + 1
    }
  }
  if (max > roofById.length) {
    const next = new Uint8Array(max)
    next.set(roofById)
    roofById = next
  }
  for (const id of ids) {
    if (id >= 0 && id < roofById.length) {
      roofById[id] = 1
    }
  }
}

function decodeRoofBin(buffer: ArrayBuffer): number[] {
  if (buffer.byteLength < 4) {
    return []
  }
  const view = new DataView(buffer)
  const count = view.getUint32(0, true)
  const ids: number[] = []
  for (let i = 0; i < count; i += 1) {
    const offset = 4 + i * 4
    if (offset + 4 > view.byteLength) {
      break
    }
    ids.push(view.getUint32(offset, true))
  }
  return ids
}

function liveKey(wx: number, wy: number, z: number): number {
  return wx * 1_000_000_000 + wy * 10_000 + (z + 128)
}

function decodeLiveBin(buffer: ArrayBuffer): { revision: number; rows: Array<{ wx: number; wy: number; z: number; remove: number; add: number }> } {
  const view = new DataView(buffer)
  if (
    view.byteLength < 12 ||
    view.getUint8(0) !== 0x4c ||
    view.getUint8(1) !== 0x49 ||
    view.getUint8(2) !== 0x56 ||
    view.getUint8(3) !== 0x45
  ) {
    return { revision: 0, rows: [] }
  }
  const revision = view.getUint32(4, true)
  const count = view.getUint32(8, true)
  const rows: Array<{ wx: number; wy: number; z: number; remove: number; add: number }> = []
  for (let i = 0; i < count; i += 1) {
    const offset = 12 + i * 14
    if (offset + 14 > view.byteLength) {
      break
    }
    rows.push({
      wx: view.getUint16(offset, true),
      wy: view.getUint16(offset + 2, true),
      z: view.getInt8(offset + 4),
      remove: view.getUint32(offset + 6, true),
      add: view.getUint32(offset + 10, true),
    })
  }
  return { revision, rows }
}

function applyLiveRows(rows: Array<{ wx: number; wy: number; z: number; remove: number; add: number }>) {
  liveRemove.clear()
  liveAdd.length = 0
  collectCache = null
  sortedCount = -1
  bumpGpuBatches()
  for (const row of rows) {
    const key = liveKey(row.wx, row.wy, row.z)
    if (row.remove) {
      let set = liveRemove.get(key)
      if (!set) {
        set = new Set()
        liveRemove.set(key, set)
      }
      set.add(row.remove)
    }
    if (row.add) {
      liveAdd.push({ wx: row.wx, wy: row.wy, z: row.z, sprite: row.add })
      const rec = spriteTable[row.add]
      if (rec) {
        atlasPage(rec.page)
      }
    }
  }
}

function startLivePoll() {
  if (livePoll) {
    return
  }
  const tick = () => {
    void fetch('/api/v1/map-sprites/live/meta', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body: { revision?: number }) => {
        const revision = Number(body.revision) || 0
        if (revision === liveRevision) {
          return
        }
        return fetch('/api/v1/map-sprites/live', { cache: 'no-store' }).then(async (response) => {
          if (!response.ok || response.status === 204) {
            liveRevision = revision
            applyLiveRows([])
            notify()
            return
          }
          const decoded = decodeLiveBin(await response.arrayBuffer())
          liveRevision = decoded.revision
          applyLiveRows(decoded.rows)
          notify()
        })
      })
      .catch(() => undefined)
  }
  tick()
  livePoll = window.setInterval(tick, 4000)
}

function warmAtlas() {
  atlasWarm = 0
  const n = spritePageCount()
  const step = () => {
    if (cameraMoving || inflight > 8) {
      if (atlasWarm < n) {
        window.setTimeout(step, 80)
      }
      return
    }
    let batch = 0
    while (atlasWarm < n && batch < 4) {
      atlasPage(atlasWarm)
      atlasWarm += 1
      batch += 1
    }
    if (atlasWarm < n) {
      window.setTimeout(step, 40)
    }
  }
  step()
}

function spritePageCount(): number {
  let pages = meta?.pages ?? 0
  for (const row of sprites) {
    if (row.page + 1 > pages) {
      pages = row.page + 1
    }
  }
  return Math.max(1, pages)
}

function decodeSpriteBin(buffer: ArrayBuffer): SpriteRecord[] {
  const view = new DataView(buffer)
  if (
    view.byteLength < 8 ||
    view.getUint8(0) !== 0x53 ||
    view.getUint8(1) !== 0x50 ||
    view.getUint8(2) !== 0x52 ||
    view.getUint8(3) !== 0x43
  ) {
    return []
  }
  const count = view.getUint32(4, true)
  const rows: SpriteRecord[] = []
  for (let i = 0; i < count; i += 1) {
    const offset = 8 + i * 14
    if (offset + 14 > view.byteLength) {
      break
    }
    const w = view.getUint16(offset + 6, true)
    const h = view.getUint16(offset + 8, true)
    if (w === 0 || h === 0) {
      continue
    }
    rows.push({
      id: i + 1,
      name: '',
      page: view.getUint16(offset, true),
      x: view.getUint16(offset + 2, true),
      y: view.getUint16(offset + 4, true),
      w,
      h,
      ox: view.getInt16(offset + 10, true),
      oy: view.getInt16(offset + 12, true),
    })
  }
  return rows
}

function revision(): string {
  return meta?.generated_at ?? ''
}

function atlasReady(image: AtlasSource): boolean {
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    return image.width > 0
  }
  const el = image as HTMLImageElement
  return el.complete && el.naturalWidth > 0
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    const url = URL.createObjectURL(blob)
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('atlas image'))
    }
    image.src = url
  })
}

async function decodeAtlasBlob(blob: Blob): Promise<AtlasSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      })
    } catch {
      try {
        return await createImageBitmap(blob)
      } catch {
        // Fall through to HTMLImageElement.
      }
    }
  }
  return blobToImage(blob)
}

function atlasPage(page: number): AtlasSource | null {
  const existing = atlasImages.get(page)
  if (existing) {
    return existing
  }
  if (page < 0 || atlasInflight.has(page) || atlasFailed.has(page)) {
    return null
  }
  atlasInflight.add(page)
  void (async () => {
    try {
      const response = await fetch(`/api/v1/map-sprites/atlas/${page}?v=${revision()}`)
      if (!response.ok) {
        atlasFailed.add(page)
        return
      }
      const source = await decodeAtlasBlob(await response.blob())
      atlasImages.set(page, source)
      uploadAtlasPage(page, source)
      atlasGeneration += 1
      bumpGpuBatches()
      notify()
    } catch {
      atlasFailed.add(page)
    } finally {
      atlasInflight.delete(page)
    }
  })()
  return null
}

function makeOverviewCanvas(widthPx: number): {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
} | null {
  const canvas = document.createElement('canvas')
  const heightPx = Math.max(1, Math.round((widthPx * ISO_DZI.height) / ISO_DZI.width))
  canvas.width = widthPx
  canvas.height = heightPx
  if (canvas.width !== widthPx || canvas.height !== heightPx) {
    return null
  }
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) {
    return null
  }
  return { canvas, ctx }
}

function ensureOverview() {
  if (overview && overviewCtx) {
    return
  }
  const made = makeOverviewCanvas(8192) ?? makeOverviewCanvas(4096) ?? makeOverviewCanvas(2048)
  if (!made) {
    return
  }
  overview = made.canvas
  overviewCtx = made.ctx
  overviewW = overview.width
  overviewH = overview.height
  overviewCtx.fillStyle = GROUND
  overviewCtx.fillRect(0, 0, overviewW, overviewH)
  if (bakedOverview && bakedOverview.naturalWidth > 0) {
    overviewCtx.imageSmoothingEnabled = true
    overviewCtx.drawImage(bakedOverview, 0, 0, overviewW, overviewH)
  }
}

function stampOverview(cx: number, cy: number, image: HTMLImageElement) {
  const key = `${cx}_${cy}`
  if (stampedOverview.has(key) || image.naturalWidth === 0) {
    return
  }
  ensureOverview()
  if (!overviewCtx || !overview) {
    return
  }
  const box = cellBox(cx, cy)
  const sx = (box.left / ISO_DZI.width) * overviewW
  const sy = (box.top / ISO_DZI.height) * overviewH
  const sw = ((box.right - box.left) / ISO_DZI.width) * overviewW
  const sh = ((box.bottom - box.top) / ISO_DZI.height) * overviewH
  overviewCtx.imageSmoothingEnabled = true
  overviewCtx.drawImage(image, sx, sy, sw, sh)
  stampedOverview.add(key)
}

function requestThumb(cx: number, cy: number, keep: boolean): HTMLImageElement | null {
  const key = `${cx}_${cy}`
  if (keep) {
    thumbWanted.add(key)
  }
  const existing = thumbImages.get(key)
  if (existing) {
    touch(thumbOrder, key, THUMB_LIMIT, (drop) => {
      if (thumbWanted.has(drop)) {
        return false
      }
      thumbImages.delete(drop)
      return true
    })
    return existing
  }
  if (!keep && stampedOverview.has(key)) {
    return null
  }
  if (queuedThumbs.has(key)) {
    return null
  }
  queuedThumbs.add(key)
  enqueue(
    async () => {
      await new Promise<void>((resolve) => {
        const image = new Image()
        image.decoding = 'async'
        image.onload = () => {
          stampOverview(cx, cy, image)
          if (keep || thumbWanted.has(key)) {
            thumbImages.set(key, image)
            touch(thumbOrder, key, THUMB_LIMIT, (drop) => {
              if (thumbWanted.has(drop)) {
                return false
              }
              thumbImages.delete(drop)
              return true
            })
            notify()
          } else {
            notifyThumbs()
          }
          queuedThumbs.delete(key)
          resolve()
        }
        image.onerror = () => {
          queuedThumbs.delete(key)
          resolve()
        }
        image.src = `/api/v1/map-sprites/thumbs/${key}?v=${revision()}`
      })
    },
    keep,
    `thumb:${key}`,
  )
  return null
}

function decodeOccupancy(buffer: ArrayBuffer): PackedCell | 'empty' {
  const view = new DataView(buffer)
  if (view.byteLength < 8) {
    return 'empty'
  }
  if (
    view.getUint8(0) !== 0x53 ||
    view.getUint8(1) !== 0x50 ||
    view.getUint8(2) !== 0x52 ||
    view.getUint8(3) !== 0x31
  ) {
    return 'empty'
  }
  const count = view.getUint32(4, true)
  if (count <= 0) {
    return 'empty'
  }
  const rows = new Array<{ lx: number; ly: number; z: number; sprite: number }>(count)
  let offset = 8
  let filled = 0
  for (let i = 0; i < count; i += 1) {
    if (offset + 7 > view.byteLength) {
      break
    }
    rows[filled] = {
      lx: view.getUint8(offset),
      ly: view.getUint8(offset + 1),
      z: view.getInt8(offset + 2),
      sprite: view.getUint32(offset + 3, true),
    }
    filled += 1
    offset += 7
  }
  rows.length = filled
  rows.sort((left, right) => left.lx + left.ly - (right.lx + right.ly) || left.z - right.z)
  const lx = new Uint8Array(filled)
  const ly = new Uint8Array(filled)
  const z = new Int8Array(filled)
  const sprite = new Uint32Array(filled)
  const bucketCount = new Uint16Array(BUCKETS * BUCKETS)
  for (let i = 0; i < filled; i += 1) {
    lx[i] = rows[i].lx
    ly[i] = rows[i].ly
    z[i] = rows[i].z
    sprite[i] = rows[i].sprite
    bucketCount[(lx[i] >> 4) * BUCKETS + (ly[i] >> 4)] += 1
  }
  const bucketStart = new Uint32Array(BUCKETS * BUCKETS)
  let cursor = 0
  for (let b = 0; b < bucketStart.length; b += 1) {
    bucketStart[b] = cursor
    cursor += bucketCount[b]
  }
  const heads = bucketStart.slice()
  const olx = new Uint8Array(filled)
  const oly = new Uint8Array(filled)
  const oz = new Int8Array(filled)
  const osprite = new Uint32Array(filled)
  const pageSeen = new Set<number>()
  for (let i = 0; i < filled; i += 1) {
    const b = (lx[i] >> 4) * BUCKETS + (ly[i] >> 4)
    const at = heads[b]
    heads[b] = at + 1
    olx[at] = lx[i]
    oly[at] = ly[i]
    oz[at] = z[i]
    osprite[at] = sprite[i]
    const rec = spriteTable[sprite[i]]
    if (rec) {
      pageSeen.add(rec.page)
    }
  }
  return {
    count: filled,
    lx: olx,
    ly: oly,
    z: oz,
    sprite: osprite,
    bucketStart,
    bucketCount,
    pages: [...pageSeen],
  }
}

function prefetchAtlas(cell: PackedCell) {
  if (cell.pages.length > 0) {
    for (const page of cell.pages) {
      atlasPage(page)
    }
    return
  }
  if (sprites.length === 0) {
    return
  }
  const seen = new Set<number>()
  const { count, sprite } = cell
  for (let i = 0; i < count; i += 1) {
    const rec = spriteTable[sprite[i]]
    if (!rec || seen.has(rec.page)) {
      continue
    }
    seen.add(rec.page)
    atlasPage(rec.page)
  }
}

function typicalThumbDest(mapping: IsoMapping): number {
  const box = cellBox(0, 0)
  return (box.right - box.left) * mapping.isoScale
}

function shouldDrawThumbs(mapping: IsoMapping, coverLen: number): boolean {
  const destW = typicalThumbDest(mapping)
  if (destW >= THUMB_ALWAYS_PX) {
    return true
  }
  return destW >= THUMB_DRAW_PX && coverLen <= THUMB_DRAW_CELLS
}

function chooseLive(mapping: IsoMapping, coverLen: number): boolean {
  const zoom = levelForScale(mapping.isoScale)
  const wantLive = cutawayFloor !== null || zoom >= 17
  const enter = wantLive && coverLen <= LIVE_CELL_CAP
  const hold = heldLive && wantLive && coverLen <= LIVE_CELL_CAP + 32
  heldLive = enter || hold
  return heldLive
}

function thumbOnScreen(
  mapping: IsoMapping,
  cx: number,
  cy: number,
  width: number,
  height: number,
): boolean {
  const box = cellBox(cx, cy)
  const destW = (box.right - box.left) * mapping.isoScale
  const destH = (box.bottom - box.top) * mapping.isoScale
  if (destW < MIN_THUMB_CSS && destH < MIN_THUMB_CSS) {
    return false
  }
  const topLeft = dziToScreen(mapping, box.left, box.top)
  return topLeft.x < width && topLeft.y < height && topLeft.x + destW > 0 && topLeft.y + destH > 0
}

function prefetchView(
  cover: { cx: number; cy: number }[],
  live: boolean,
  mapping: IsoMapping,
  width: number,
  height: number,
) {
  if (live) {
    thumbWanted.clear()
    if (cover.length === 0) {
      return
    }
    let cx0 = cover[0].cx
    let cy0 = cover[0].cy
    let cx1 = cx0
    let cy1 = cy0
    for (const { cx, cy } of cover) {
      requestCell(cx, cy, true)
      if (cx < cx0) {
        cx0 = cx
      }
      if (cy < cy0) {
        cy0 = cy
      }
      if (cx > cx1) {
        cx1 = cx
      }
      if (cy > cy1) {
        cy1 = cy
      }
      const occupants = cells.get(`${cx}_${cy}`)
      if (!occupants || occupants === 'loading') {
        thumbWanted.add(`${cx}_${cy}`)
      }
    }
    if (!cameraMoving) {
      for (let cx = cx0 - 1; cx <= cx1 + 1; cx += 1) {
        for (let cy = cy0 - 1; cy <= cy1 + 1; cy += 1) {
          if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) {
            continue
          }
          requestCell(cx, cy, false)
        }
      }
      dropQueuedThumbsExcept(thumbWanted)
    }
    if (cutawayFloor === null && !cameraMoving) {
      for (const key of thumbWanted) {
        const split = key.indexOf('_')
        requestThumb(Number(key.slice(0, split)), Number(key.slice(split + 1)), true)
      }
    }
    return
  }
  const drawThumbs = shouldDrawThumbs(mapping, cover.length)
  const visible = cover.filter(({ cx, cy }) => thumbOnScreen(mapping, cx, cy, width, height))
  const centerX = mapping.center.x
  const centerY = mapping.center.y
  visible.sort((left, right) => {
    const a = cellBox(left.cx, left.cy)
    const b = cellBox(right.cx, right.cy)
    const da = a.left + a.right - 2 * centerX
    const db = a.top + a.bottom - 2 * centerY
    const ea = b.left + b.right - 2 * centerX
    const eb = b.top + b.bottom - 2 * centerY
    return da * da + db * db - (ea * ea + eb * eb)
  })
  const fetch = drawThumbs ? visible : visible.slice(0, STAMP_PREFETCH)
  thumbWanted.clear()
  for (const { cx, cy } of fetch) {
    thumbWanted.add(`${cx}_${cy}`)
  }
  if (!cameraMoving) {
    dropQueuedThumbsExcept(thumbWanted)
  }
  for (const { cx, cy } of fetch) {
    requestThumb(cx, cy, drawThumbs)
  }
}

function dropCell(key: string): boolean {
  if (cells.get(key) === 'loading') {
    return false
  }
  cells.delete(key)
  collectCache = null
  sortedCount = -1
  bumpGpuBatches()
  return true
}

function requestCell(cx: number, cy: number, urgent = true) {
  const key = `${cx}_${cy}`
  if (cells.has(key)) {
    touch(cellOrder, key, CELL_LIMIT, dropCell)
    return
  }
  cells.set(key, 'loading')
  touch(cellOrder, key, CELL_LIMIT, dropCell)
  enqueue(async () => {
    try {
      const response = await fetch(`/api/v1/map-sprites/cells/${key}?v=${revision()}`)
      if (!response.ok) {
        cells.set(key, 'empty')
        notify()
        return
      }
      const packed = decodeOccupancy(await response.arrayBuffer())
      cells.set(key, packed)
      if (packed !== 'empty') {
        prefetchAtlas(packed)
      }
      notify()
    } catch {
      cells.set(key, 'empty')
      notify()
    }
  }, urgent, `cell:${key}`)
}

const cellBoxCache = new Map<string, ReturnType<typeof computeCellBox>>()

function computeCellBox(cx: number, cy: number) {
  const x0 = cx * CELL
  const y0 = cy * CELL
  const corners = [
    worldToDzi(x0, y0),
    worldToDzi(x0 + CELL, y0),
    worldToDzi(x0, y0 + CELL),
    worldToDzi(x0 + CELL, y0 + CELL),
  ]
  let left = corners[0].x
  let right = corners[0].x
  let top = corners[0].y
  let bottom = corners[0].y
  for (let i = 1; i < 4; i += 1) {
    const point = corners[i]
    if (point.x < left) {
      left = point.x
    }
    if (point.x > right) {
      right = point.x
    }
    if (point.y < top) {
      top = point.y
    }
    if (point.y > bottom) {
      bottom = point.y
    }
  }
  return {
    left: left - THUMB_PAD,
    top: top - THUMB_PAD,
    right: right + THUMB_PAD,
    bottom: bottom + THUMB_PAD,
  }
}

function cellBox(cx: number, cy: number) {
  const key = `${cx}_${cy}`
  const cached = cellBoxCache.get(key)
  if (cached) {
    return cached
  }
  const box = computeCellBox(cx, cy)
  cellBoxCache.set(key, box)
  return box
}

function drawClipped(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  destX: number,
  destY: number,
  destW: number,
  destH: number,
  viewW: number,
  viewH: number,
  srcW: number,
  srcH: number,
  srcX = 0,
  srcY = 0,
) {
  const x0 = destX > 0 ? destX : 0
  const y0 = destY > 0 ? destY : 0
  const x1 = destX + destW < viewW ? destX + destW : viewW
  const y1 = destY + destH < viewH ? destY + destH : viewH
  if (x1 <= x0 || y1 <= y0 || destW <= 0 || destH <= 0 || srcW <= 0 || srcH <= 0) {
    return
  }
  const sx = srcX + ((x0 - destX) / destW) * srcW
  const sy = srcY + ((y0 - destY) / destH) * srcH
  const sw = ((x1 - x0) / destW) * srcW
  const sh = ((y1 - y0) / destH) * srcH
  if (sw < 0.5 || sh < 0.5) {
    return
  }
  ctx.drawImage(image, sx, sy, sw, sh, x0, y0, x1 - x0, y1 - y0)
}

function worldWindow(mapping: IsoMapping, width: number, height: number, live: boolean) {
  const corners = [
    mapping.toWorld(0, 0),
    mapping.toWorld(width, 0),
    mapping.toWorld(0, height),
    mapping.toWorld(width, height),
  ]
  const reach = live ? Math.min(40, Math.ceil((meta?.max_reach ?? 512) / HALF) + 4) : 4
  let minX = corners[0].x
  let maxX = corners[0].x
  let minY = corners[0].y
  let maxY = corners[0].y
  for (let i = 1; i < 4; i += 1) {
    const point = corners[i]
    if (point.x < minX) {
      minX = point.x
    }
    if (point.x > maxX) {
      maxX = point.x
    }
    if (point.y < minY) {
      minY = point.y
    }
    if (point.y > maxY) {
      maxY = point.y
    }
  }
  return {
    minX: minX - reach,
    maxX: maxX + reach,
    minY: minY - reach,
    maxY: maxY + reach,
  }
}

function viewSnapKey(mapping: IsoMapping, width: number, height: number): string {
  const step = snapStep(mapping.isoScale)
  const win = worldWindow(mapping, width, height, true)
  return [
    snapWorld(win.minX, false, step),
    snapWorld(win.maxX, true, step),
    snapWorld(win.minY, false, step),
    snapWorld(win.maxY, true, step),
    step,
    cutawayFloor ?? '',
    liveRevision,
  ].join(':')
}

export function attachSpriteGlLayer(host: HTMLElement, behind: HTMLElement): void {
  attachSpriteGl(host, behind)
}

export function hideSpriteGlLayer(): void {
  setSpriteGlOnScreen(false)
}

export function panLiveSprites(
  mapping: IsoMapping,
  width: number,
  height: number,
  dpr: number,
): boolean {
  if (!cameraMoving || !lastDrawLive || spriteTable.length <= 1) {
    return false
  }
  const zoom = levelForScale(mapping.isoScale)
  if (cutawayFloor === null && zoom < 17) {
    return false
  }
  if (spriteGlEpoch() !== gpuBatchEpoch) {
    return false
  }
  if (viewSnapKey(mapping, width, height) !== panSnap) {
    return false
  }
  return presentSpriteGl(mapping, width, height, dpr)
}

function visibleCells(mapping: IsoMapping, width: number, height: number, live: boolean) {
  const { minX, maxX, minY, maxY } = worldWindow(mapping, width, height, live)
  const cx0 = Math.floor(minX / CELL)
  const cy0 = Math.floor(minY / CELL)
  const cx1 = Math.floor(maxX / CELL)
  const cy1 = Math.floor(maxY / CELL)
  const out: { cx: number; cy: number }[] = []
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cy = cy0; cy <= cy1; cy += 1) {
      out.push({ cx, cy })
    }
  }
  return { cover: out, minX, maxX, minY, maxY }
}

function dziToScreen(mapping: IsoMapping, px: number, py: number) {
  const world = dziToWorld(px, py)
  return mapping.toScreen(world.x, world.y)
}

function drawThumb(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  cx: number,
  cy: number,
  width: number,
  height: number,
) {
  const image = requestThumb(cx, cy, true)
  if (!image || !image.complete || image.naturalWidth === 0) {
    return
  }
  const box = cellBox(cx, cy)
  const topLeft = dziToScreen(mapping, box.left, box.top)
  const destW = (box.right - box.left) * mapping.isoScale
  const destH = (box.bottom - box.top) * mapping.isoScale
  ctx.imageSmoothingEnabled = destW < image.naturalWidth
  drawClipped(
    ctx,
    image,
    topLeft.x,
    topLeft.y,
    destW + 0.75,
    destH + 0.75,
    width,
    height,
    image.naturalWidth,
    image.naturalHeight,
  )
}

function drawOverview(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
) {
  const destX = (0 - mapping.center.x) * mapping.isoScale + width / 2
  const destY = (0 - mapping.center.y) * mapping.isoScale + height / 2
  const destW = ISO_DZI.width * mapping.isoScale
  const destH = ISO_DZI.height * mapping.isoScale
  ensureOverview()
  ctx.imageSmoothingEnabled = true
  if (overview && (stampedOverview.size > 0 || bakedOverview)) {
    drawClipped(ctx, overview, destX, destY, destW, destH, width, height, overview.width, overview.height)
    return true
  }
  if (bakedOverview && bakedOverview.naturalWidth > 0) {
    drawClipped(
      ctx,
      bakedOverview,
      destX,
      destY,
      destW,
      destH,
      width,
      height,
      bakedOverview.naturalWidth,
      bakedOverview.naturalHeight,
    )
    return true
  }
  return false
}

function drawThumbsOrOverview(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
  cover: { cx: number; cy: number }[],
) {
  drawOverview(ctx, mapping, width, height)
  if (!shouldDrawThumbs(mapping, cover.length)) {
    return
  }
  for (const { cx, cy } of cover) {
    if (!thumbOnScreen(mapping, cx, cy, width, height)) {
      continue
    }
    drawThumb(ctx, mapping, cx, cy, width, height)
  }
  ctx.imageSmoothingEnabled = false
}

function blitSprite(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  occupant: VisibleSprite,
  width: number,
  height: number,
) {
  const sprite = spriteTable[occupant.sprite]
  if (!sprite) {
    return
  }
  const page = atlasPage(sprite.page)
  if (!page || !atlasReady(page)) {
    return
  }
  const scale = mapping.isoScale
  if (occupant.z <= 0 && sprite.h <= 48 && scale < 0.75) {
    return
  }
  const destW = sprite.w * scale
  const destH = sprite.h * scale
  if (destW < 1.2 || destH < 1.2) {
    return
  }
  const dx = (occupant.dziX - mapping.center.x) * scale + width / 2 + sprite.ox * scale
  const dy =
    (occupant.dziY - mapping.center.y) * scale +
    height / 2 +
    HALF * scale +
    sprite.oy * scale -
    occupant.z * ISO_LAYER_HEIGHT * scale
  drawClipped(
    ctx,
    page,
    dx,
    dy,
    destW,
    destH,
    width,
    height,
    sprite.w,
    sprite.h,
    sprite.x,
    sprite.y,
  )
}

function readyCells(cover: { cx: number; cy: number }[]): number {
  let ready = 0
  for (const { cx, cy } of cover) {
    const occupants = cells.get(`${cx}_${cy}`)
    if (occupants && occupants !== 'loading') {
      ready += 1
    }
  }
  return ready
}

function skipClutterKey(scale: number): number {
  if (scale >= CLUTTER_SCALE) {
    return 0
  }
  return Math.round(1 / Math.max(scale, 1e-6))
}

function isSubpixelGround(spriteId: number, z: number, scale: number): boolean {
  if (z > 0 || scale >= CLUTTER_SCALE) {
    return false
  }
  const rec = spriteTable[spriteId]
  if (!rec) {
    return false
  }
  return rec.w * scale < 1 && rec.h * scale < 1
}

function writeVisible(
  count: number,
  wx: number,
  wy: number,
  z: number,
  sprite: number,
): number {
  const dzi = worldToDzi(wx, wy)
  const row = visiblePool[count]
  if (row) {
    row.wx = wx
    row.wy = wy
    row.z = z
    row.sprite = sprite
    row.dziX = dzi.x
    row.dziY = dzi.y
  } else {
    visiblePool.push({ wx, wy, z, sprite, dziX: dzi.x, dziY: dzi.y })
  }
  return count + 1
}

function takeVisible(count: number, ordered: boolean): VisibleSprite[] {
  if (!ordered) {
    return visiblePool
  }
  if (sortedCount === count && sortScratch.length === count) {
    return sortScratch
  }
  for (let i = 0; i < count; i += 1) {
    sortScratch[i] = visiblePool[i]
  }
  sortScratch.length = count
  sortScratch.sort((left, right) => left.wx + left.wy - (right.wx + right.wy) || left.z - right.z)
  sortedCount = count
  bumpGpuBatches()
  return sortScratch
}

function snapStep(scale: number): number {
  const squares = Math.ceil(SNAP_PAN_PX / (Math.max(scale, 1e-6) * HALF))
  let step = BUCKET
  while (step < squares && step < CELL) {
    step *= 2
  }
  return step
}

function snapWorld(value: number, ceil: boolean, step: number): number {
  if (ceil) {
    return Math.ceil(value / step) * step
  }
  return Math.floor(value / step) * step
}

function collectVisible(
  cover: { cx: number; cy: number }[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  scale: number,
): number {
  const ready = readyCells(cover)
  const skip = skipClutterKey(scale)
  const step = snapStep(scale)
  const snapMinX = snapWorld(minX, false, step)
  const snapMaxX = snapWorld(maxX, true, step)
  const snapMinY = snapWorld(minY, false, step)
  const snapMaxY = snapWorld(maxY, true, step)
  const cx0 = cover[0]?.cx ?? 0
  const cy0 = cover[0]?.cy ?? 0
  const cx1 = cover[cover.length - 1]?.cx ?? -1
  const cy1 = cover[cover.length - 1]?.cy ?? -1
  if (
    collectCache &&
    collectCache.n === cover.length &&
    collectCache.cx0 === cx0 &&
    collectCache.cy0 === cy0 &&
    collectCache.cx1 === cx1 &&
    collectCache.cy1 === cy1 &&
    collectCache.minX === snapMinX &&
    collectCache.maxX === snapMaxX &&
    collectCache.minY === snapMinY &&
    collectCache.maxY === snapMaxY &&
    collectCache.cutaway === cutawayFloor &&
    collectCache.liveRevision === liveRevision &&
    collectCache.ready === ready &&
    collectCache.skip === skip
  ) {
    return collectCache.count
  }
  sortedCount = -1
  bumpGpuBatches()
  let visibleCount = 0
  for (const { cx, cy } of cover) {
    requestCell(cx, cy)
    const occupants = cells.get(`${cx}_${cy}`)
    if (!occupants || occupants === 'loading' || occupants === 'empty') {
      continue
    }
    const originX = cx * CELL
    const originY = cy * CELL
    const { lx, ly, z, sprite, bucketStart, bucketCount } = occupants
    const lx0 = Math.max(0, Math.floor(snapMinX - originX))
    const lx1 = Math.min(CELL - 1, Math.ceil(snapMaxX - originX))
    const ly0 = Math.max(0, Math.floor(snapMinY - originY))
    const ly1 = Math.min(CELL - 1, Math.ceil(snapMaxY - originY))
    if (lx1 < lx0 || ly1 < ly0) {
      continue
    }
    const bx0 = lx0 >> 4
    const bx1 = lx1 >> 4
    const by0 = ly0 >> 4
    const by1 = ly1 >> 4
    for (let bx = bx0; bx <= bx1; bx += 1) {
      for (let by = by0; by <= by1; by += 1) {
        const bucket = bx * BUCKETS + by
        const start = bucketStart[bucket]
        const end = start + bucketCount[bucket]
        for (let i = start; i < end; i += 1) {
          const wx = originX + lx[i]
          const wy = originY + ly[i]
          if (wx < snapMinX || wx > snapMaxX || wy < snapMinY || wy > snapMaxY) {
            continue
          }
          if (cutawayFloor !== null && (z[i] > cutawayFloor || roofById[sprite[i]])) {
            continue
          }
          const gone = liveRemove.get(liveKey(wx, wy, z[i]))
          if (gone && gone.has(sprite[i])) {
            continue
          }
          if (isSubpixelGround(sprite[i], z[i], scale)) {
            continue
          }
          visibleCount = writeVisible(visibleCount, wx, wy, z[i], sprite[i])
        }
      }
    }
  }
  for (const patch of liveAdd) {
    if (patch.wx < snapMinX || patch.wx > snapMaxX || patch.wy < snapMinY || patch.wy > snapMaxY) {
      continue
    }
    if (cutawayFloor !== null && (patch.z > cutawayFloor || roofById[patch.sprite])) {
      continue
    }
    if (isSubpixelGround(patch.sprite, patch.z, scale)) {
      continue
    }
    visibleCount = writeVisible(visibleCount, patch.wx, patch.wy, patch.z, patch.sprite)
  }
  collectCache = {
    cx0,
    cy0,
    cx1,
    cy1,
    n: cover.length,
    minX: snapMinX,
    maxX: snapMaxX,
    minY: snapMinY,
    maxY: snapMaxY,
    cutaway: cutawayFloor,
    liveRevision,
    ready,
    skip,
    count: visibleCount,
  }
  return visibleCount
}

function pumpRaster() {
  rasterFrame = 0
  const job = rasterJob
  if (!job) {
    return
  }
  if (cameraMoving) {
    rasterFrame = requestAnimationFrame(pumpRaster)
    return
  }
  const started = performance.now()
  if (job.index === 0) {
    job.ctx.fillStyle = GROUND
    job.ctx.fillRect(0, 0, job.width, job.height)
    job.ctx.imageSmoothingEnabled = true
    drawOverview(job.ctx, job.mapping, job.width, job.height)
    job.ctx.imageSmoothingEnabled = false
  }
  while (job.index < job.rows.length && performance.now() - started < 6) {
    blitSprite(job.ctx, job.mapping, job.rows[job.index], job.width, job.height)
    job.index += 1
  }
  if (job.index < job.rows.length) {
    rasterFrame = requestAnimationFrame(pumpRaster)
    return
  }
  spriteLayer = {
    canvas: job.canvas,
    centerX: job.centerX,
    centerY: job.centerY,
    scale: job.scale,
    width: job.width,
    height: job.height,
    ready: job.ready,
    atlas: job.atlas,
    cutaway: job.cutaway,
  }
  rasterJob = null
  notify()
}

function startRaster(
  mapping: IsoMapping,
  width: number,
  height: number,
  cover: { cx: number; cy: number }[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
) {
  const ready = readyCells(cover)
  if (
    rasterJob &&
    cameraMatches(rasterJob, mapping, width, height) &&
    rasterJob.ready === ready &&
    rasterJob.atlas === atlasGeneration &&
    rasterJob.cutaway === cutawayFloor
  ) {
    return
  }
  cancelRaster()
  const visibleCount = collectVisible(cover, minX, maxX, minY, maxY, mapping.isoScale)
  if (visibleCount === 0) {
    return
  }
  const rows: VisibleSprite[] = []
  for (let i = 0; i < visibleCount; i += 1) {
    const src = visiblePool[i]
    rows.push({
      wx: src.wx,
      wy: src.wy,
      z: src.z,
      sprite: src.sprite,
      dziX: src.dziX,
      dziY: src.dziY,
    })
  }
  rows.sort((left, right) => left.wx + left.wy - (right.wx + right.wy) || left.z - right.z)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!ctx) {
    return
  }
  rasterJob = {
    canvas,
    ctx,
    mapping,
    width,
    height,
    cover,
    rows,
    index: 0,
    centerX: mapping.center.x,
    centerY: mapping.center.y,
    scale: mapping.isoScale,
    ready,
    atlas: atlasGeneration,
    cutaway: cutawayFloor,
  }
  rasterFrame = requestAnimationFrame(pumpRaster)
}

function blitCachedLayer(
  ctx: CanvasRenderingContext2D,
  layer: SpriteLayer,
  mapping: IsoMapping,
  width: number,
  height: number,
): boolean {
  const destW = layer.width * (mapping.isoScale / layer.scale)
  const destH = layer.height * (mapping.isoScale / layer.scale)
  const destX = (layer.centerX - mapping.center.x) * mapping.isoScale + width / 2 - destW / 2
  const destY = (layer.centerY - mapping.center.y) * mapping.isoScale + height / 2 - destH / 2
  if (destW < 2 || destH < 2) {
    return false
  }
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(layer.canvas, destX, destY, destW, destH)
  return destX <= 2 && destY <= 2 && destX + destW >= width - 2 && destY + destH >= height - 2
}

function layerNeedsRefresh(
  layer: SpriteLayer,
  mapping: IsoMapping,
  cover: { cx: number; cy: number }[],
): boolean {
  if (layer.atlas !== atlasGeneration || layer.cutaway !== cutawayFloor) {
    return true
  }
  if (layer.ready < readyCells(cover)) {
    return true
  }
  const ratio = mapping.isoScale / layer.scale
  if (ratio < 0.9 || ratio > 1.12) {
    return true
  }
  const dx = (layer.centerX - mapping.center.x) * mapping.isoScale
  const dy = (layer.centerY - mapping.center.y) * mapping.isoScale
  return Math.abs(dx) > 28 || Math.abs(dy) > 28
}

function drawLiveUnderlay(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
  cover: { cx: number; cy: number }[],
) {
  drawThumbsOrOverview(ctx, mapping, width, height, cover)
}

function drawMissingCellThumbs(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
  cover: { cx: number; cy: number }[],
) {
  for (const { cx, cy } of cover) {
    const occupants = cells.get(`${cx}_${cy}`)
    if (occupants && occupants !== 'loading') {
      continue
    }
    if (!thumbOnScreen(mapping, cx, cy, width, height)) {
      continue
    }
    drawThumb(ctx, mapping, cx, cy, width, height)
  }
  ctx.imageSmoothingEnabled = false
}

export function drawIsoSprites(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
): void {
  lastDrawLive = false
  setSpriteGlOnScreen(false)
  ctx.fillStyle = GROUND
  ctx.fillRect(0, 0, width, height)

  if (!meta?.ready) {
    void loadSpriteMap()
    return
  }

  const tight = visibleCells(mapping, width, height, false)
  const live = chooseLive(mapping, tight.cover.length)
  const { cover, minX, maxX, minY, maxY } = live
    ? visibleCells(mapping, width, height, true)
    : tight
  prefetchView(cover, live, mapping, width, height)

  if (live && spriteTable.length > 1) {
    ensureSpriteGl()
    atlasImages.forEach((image, page) => {
      if (atlasReady(image)) {
        uploadAtlasPage(page, image)
      }
    })
    if (
      cutawayFloor === null &&
      !cameraMoving &&
      readyCells(cover) < cover.length
    ) {
      drawMissingCellThumbs(ctx, mapping, width, height, cover)
    }
    const visibleCount = collectVisible(cover, minX, maxX, minY, maxY, mapping.isoScale)
    if (visibleCount > 0) {
      const ordered = visibleCount <= SORT_CAP
      const drawn = takeVisible(visibleCount, ordered)
      const dpr = Math.max(1, ctx.getTransform().a || 1)
      const painted = drawSpritesGl(
        ctx,
        mapping,
        width,
        height,
        drawn,
        visibleCount,
        spriteTable,
        spritePageCount(),
        ordered,
        gpuBatchEpoch,
        dpr,
        !cameraMoving,
      )
      if (painted) {
        lastDrawLive = true
        panSnap = viewSnapKey(mapping, width, height)
        return
      }
    }

    const haveLayer =
      spriteLayer &&
      spriteLayer.width === width &&
      spriteLayer.height === height &&
      spriteLayer.cutaway === cutawayFloor
        ? spriteLayer
        : null
    if (haveLayer) {
      blitCachedLayer(ctx, haveLayer, mapping, width, height)
      if (!cameraMoving && sprites.length > 0 && layerNeedsRefresh(haveLayer, mapping, cover)) {
        startRaster(mapping, width, height, cover, minX, maxX, minY, maxY)
      }
      return
    }

    if (cutawayFloor === null && jpegPackReady()) {
      drawIsoTiles(ctx, mapping, width, height)
    } else if (cutawayFloor === null) {
      drawLiveUnderlay(ctx, mapping, width, height, cover)
    }
    if (!cameraMoving && sprites.length > 0 && !ensureSpriteGl()) {
      startRaster(mapping, width, height, cover, minX, maxX, minY, maxY)
    }
    return
  }

  if (jpegPackReady()) {
    drawIsoTiles(ctx, mapping, width, height)
    return
  }

  drawThumbsOrOverview(ctx, mapping, width, height, cover)
}
