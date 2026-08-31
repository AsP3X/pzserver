/**
 * Sprite isometric basemap. Parallel to the JPEG DZI pack.
 *
 * Same CRS as iso-tiles.ts. Atlas + occupancy + cell thumbs from
 * /api/v1/map-sprites. JPEG URLs are never used here.
 */

import { ISO_DZI, dziToWorld, worldToDzi, type IsoMapping } from '@/lib/iso-tiles'

const CELL = 256
const HALF = 64
const THUMB_PAD = HALF * 24
/** Live sprites only once a street is on screen. County/town stay on thumbs. */
const NEAR_SCALE = 0.22
/** More cells than this → one county overview blit instead of thousands of thumbs. */
const OVERVIEW_CELLS = 28
const OVERVIEW_W = 2048
const MAX_INFLIGHT = 6
const CELL_LIMIT = 48
const THUMB_LIMIT = 96

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
}

interface VisibleSprite {
  wx: number
  wy: number
  z: number
  sprite: number
}

const atlasImages = new Map<number, HTMLImageElement>()
const thumbImages = new Map<string, HTMLImageElement>()
const thumbOrder: string[] = []
const cells = new Map<string, PackedCell | 'loading' | 'empty'>()
const cellOrder: string[] = []
const queuedThumbs = new Set<string>()
const listeners = new Set<() => void>()
const visiblePool: VisibleSprite[] = []
const stampedOverview = new Set<string>()

let meta: SpriteMeta | null = null
let sprites: SpriteRecord[] = []
let spriteById = new Map<number, SpriteRecord>()
let loading = false
let notifyFrame = 0
let inflight = 0
const waitQueue: Array<() => void> = []
let overview: HTMLCanvasElement | null = null
let overviewCtx: CanvasRenderingContext2D | null = null
let overviewH = 0
let cameraMoving = false
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
}

interface RasterJob {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  mapping: IsoMapping
  width: number
  height: number
  rows: VisibleSprite[]
  index: number
  centerX: number
  centerY: number
  scale: number
  ready: number
}

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
  return meta?.ready === true && sprites.length > 0
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
    if (!next.ready) {
      return
    }
    const rows = await fetch(`/api/v1/map-sprites/sprites?v=${next.generated_at ?? ''}`).then(
      (response) => response.json() as Promise<SpriteRecord[]>,
    )
    sprites = rows
    spriteById = new Map(rows.map((row) => [row.id, row]))
  } catch {
    meta = { ready: false } as SpriteMeta
  } finally {
    loading = false
    notify()
  }
}

function enqueue(start: () => Promise<void>, urgent = false) {
  const run = () => {
    inflight += 1
    void start().finally(() => {
      inflight -= 1
      const next = waitQueue.shift()
      if (next) {
        next()
      }
    })
  }
  if (inflight < MAX_INFLIGHT) {
    run()
  } else if (urgent) {
    waitQueue.unshift(run)
  } else {
    waitQueue.push(run)
  }
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

function revision(): string {
  return meta?.generated_at ?? ''
}

function atlasPage(page: number): HTMLImageElement {
  const existing = atlasImages.get(page)
  if (existing) {
    return existing
  }
  const image = new Image()
  image.decoding = 'async'
  atlasImages.set(page, image)
  image.onload = () => {
    spriteLayer = null
    cancelRaster()
    notify()
  }
  image.src = `/api/v1/map-sprites/atlas/${page}?v=${revision()}`
  return image
}

function ensureOverview() {
  if (overview && overviewCtx) {
    return
  }
  overviewH = Math.max(1, Math.round((OVERVIEW_W * ISO_DZI.height) / ISO_DZI.width))
  overview = document.createElement('canvas')
  overview.width = OVERVIEW_W
  overview.height = overviewH
  overviewCtx = overview.getContext('2d', { alpha: true })
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
  const sx = (box.left / ISO_DZI.width) * OVERVIEW_W
  const sy = (box.top / ISO_DZI.height) * overviewH
  const sw = ((box.right - box.left) / ISO_DZI.width) * OVERVIEW_W
  const sh = ((box.bottom - box.top) / ISO_DZI.height) * overviewH
  overviewCtx.drawImage(image, sx, sy, sw, sh)
  stampedOverview.add(key)
}

function requestThumb(cx: number, cy: number, keep: boolean): HTMLImageElement | null {
  const key = `${cx}_${cy}`
  const existing = thumbImages.get(key)
  if (existing) {
    touch(thumbOrder, key, THUMB_LIMIT, (drop) => {
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
  enqueue(async () => {
    await new Promise<void>((resolve) => {
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => {
        stampOverview(cx, cy, image)
        if (keep) {
          thumbImages.set(key, image)
          touch(thumbOrder, key, THUMB_LIMIT, (drop) => {
            thumbImages.delete(drop)
            return true
          })
        }
        queuedThumbs.delete(key)
        notify()
        resolve()
      }
      image.onerror = () => {
        queuedThumbs.delete(key)
        resolve()
      }
      image.src = `/api/v1/map-sprites/thumbs/${key}?v=${revision()}`
    })
  })
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
  for (let i = 0; i < filled; i += 1) {
    lx[i] = rows[i].lx
    ly[i] = rows[i].ly
    z[i] = rows[i].z
    sprite[i] = rows[i].sprite
  }
  return { count: filled, lx, ly, z, sprite }
}

function dropCell(key: string): boolean {
  if (cells.get(key) === 'loading') {
    return false
  }
  cells.delete(key)
  return true
}

function requestCell(cx: number, cy: number) {
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
        return
      }
      cells.set(key, decodeOccupancy(await response.arrayBuffer()))
      notify()
    } catch {
      cells.set(key, 'empty')
    }
  }, true)
}

function cellBox(cx: number, cy: number) {
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

function visibleCells(mapping: IsoMapping, width: number, height: number, near: boolean) {
  const corners = [
    mapping.toWorld(0, 0),
    mapping.toWorld(width, 0),
    mapping.toWorld(0, height),
    mapping.toWorld(width, height),
  ]
  const reach = near ? Math.ceil((meta?.max_reach ?? 512) / HALF) + 8 : 4
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
  const cx0 = Math.floor((minX - reach) / CELL)
  const cy0 = Math.floor((minY - reach) / CELL)
  const cx1 = Math.floor((maxX + reach) / CELL)
  const cy1 = Math.floor((maxY + reach) / CELL)
  const out: { cx: number; cy: number }[] = []
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cy = cy0; cy <= cy1; cy += 1) {
      out.push({ cx, cy })
    }
  }
  return { cover: out, minX: minX - reach, maxX: maxX + reach, minY: minY - reach, maxY: maxY + reach }
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
  if (topLeft.x > width || topLeft.y > height || topLeft.x + destW < 0 || topLeft.y + destH < 0) {
    return
  }
  ctx.drawImage(image, topLeft.x, topLeft.y, destW, destH)
}

function drawOverview(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
) {
  ensureOverview()
  if (!overview) {
    return false
  }
  const destX = (0 - mapping.center.x) * mapping.isoScale + width / 2
  const destY = (0 - mapping.center.y) * mapping.isoScale + height / 2
  const destW = ISO_DZI.width * mapping.isoScale
  const destH = ISO_DZI.height * mapping.isoScale
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(overview, destX, destY, destW, destH)
  return stampedOverview.size > 0
}

function drawThumbsOrOverview(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
  cover: { cx: number; cy: number }[],
) {
  ctx.imageSmoothingEnabled = true
  if (cover.length >= OVERVIEW_CELLS) {
    const focus = mapping.toWorld(width / 2, height / 2)
    const fx = Math.floor(focus.x / CELL)
    const fy = Math.floor(focus.y / CELL)
    cover.sort(
      (a, b) =>
        Math.abs(a.cx - fx) +
        Math.abs(a.cy - fy) -
        (Math.abs(b.cx - fx) + Math.abs(b.cy - fy)),
    )
    for (const { cx, cy } of cover) {
      requestThumb(cx, cy, false)
    }
    drawOverview(ctx, mapping, width, height)
    return
  }
  for (const { cx, cy } of cover) {
    drawThumb(ctx, mapping, cx, cy, width, height)
  }
}

function blitSprite(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  occupant: VisibleSprite,
  width: number,
  height: number,
) {
  const sprite = spriteById.get(occupant.sprite)
  if (!sprite) {
    return
  }
  const page = atlasPage(sprite.page)
  if (!page.complete || page.naturalWidth === 0) {
    return
  }
  const scale = mapping.isoScale
  const destW = sprite.w * scale
  const destH = sprite.h * scale
  if (destW < 0.75 || destH < 0.75) {
    return
  }
  const top = mapping.toScreen(occupant.wx, occupant.wy)
  const dx = top.x + sprite.ox * scale
  const dy = top.y + HALF * scale + sprite.oy * scale
  const margin = (meta?.max_reach ?? 512) * scale + 8
  if (dx > width + margin || dy > height + margin || dx + destW < -margin || dy + destH < -margin) {
    return
  }
  ctx.drawImage(page, sprite.x, sprite.y, sprite.w, sprite.h, dx, dy, destW, destH)
}

function collectVisible(
  cover: { cx: number; cy: number }[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): number {
  let visibleCount = 0
  for (const { cx, cy } of cover) {
    requestCell(cx, cy)
    const occupants = cells.get(`${cx}_${cy}`)
    if (!occupants || occupants === 'loading' || occupants === 'empty') {
      continue
    }
    const originX = cx * CELL
    const originY = cy * CELL
    const { count, lx, ly, z, sprite } = occupants
    for (let i = 0; i < count; i += 1) {
      const wx = originX + lx[i]
      const wy = originY + ly[i]
      if (wx < minX || wx > maxX || wy < minY || wy > maxY) {
        continue
      }
      const row = visiblePool[visibleCount]
      if (row) {
        row.wx = wx
        row.wy = wy
        row.z = z[i]
        row.sprite = sprite[i]
      } else {
        visiblePool.push({ wx, wy, z: z[i], sprite: sprite[i] })
      }
      visibleCount += 1
    }
  }
  return visibleCount
}

function pumpRaster() {
  rasterFrame = 0
  const job = rasterJob
  if (!job || cameraMoving) {
    return
  }
  const started = performance.now()
  if (job.index === 0) {
    job.ctx.fillStyle = '#141611'
    job.ctx.fillRect(0, 0, job.width, job.height)
    job.ctx.imageSmoothingEnabled = job.scale < 0.85
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
  }
  rasterJob = null
  notify()
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
  if (rasterJob && cameraMatches(rasterJob, mapping, width, height) && rasterJob.ready === ready) {
    return
  }
  cancelRaster()
  const visibleCount = collectVisible(cover, minX, maxX, minY, maxY)
  if (visibleCount === 0) {
    return
  }
  const rows: VisibleSprite[] = []
  for (let i = 0; i < visibleCount; i += 1) {
    const src = visiblePool[i]
    rows.push({ wx: src.wx, wy: src.wy, z: src.z, sprite: src.sprite })
  }
  rows.sort((left, right) => left.wx + left.wy - (right.wx + right.wy) || left.z - right.z)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) {
    return
  }
  rasterJob = {
    canvas,
    ctx,
    mapping,
    width,
    height,
    rows,
    index: 0,
    centerX: mapping.center.x,
    centerY: mapping.center.y,
    scale: mapping.isoScale,
    ready,
  }
  rasterFrame = requestAnimationFrame(pumpRaster)
}

export function drawIsoSprites(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
): void {
  ctx.fillStyle = '#141611'
  ctx.fillRect(0, 0, width, height)

  if (!spriteMapReady()) {
    void loadSpriteMap()
    return
  }

  const near = mapping.isoScale >= NEAR_SCALE && !cameraMoving
  const { cover, minX, maxX, minY, maxY } = visibleCells(mapping, width, height, near)

  if (!near) {
    cancelRaster()
    drawThumbsOrOverview(ctx, mapping, width, height, cover)
    return
  }

  const ready = readyCells(cover)
  if (
    spriteLayer &&
    cameraMatches(spriteLayer, mapping, width, height) &&
    spriteLayer.ready >= ready
  ) {
    ctx.drawImage(spriteLayer.canvas, 0, 0)
    return
  }

  drawThumbsOrOverview(ctx, mapping, width, height, cover)
  startRaster(mapping, width, height, cover, minX, maxX, minY, maxY)
}
