/**
 * Sprite isometric basemap. Parallel to the JPEG DZI pack.
 *
 * Same CRS as iso-tiles.ts. Atlas + occupancy + cell thumbs from
 * /api/v1/map-sprites. JPEG URLs are never used here.
 */

import { dziToWorld, worldToDzi, type IsoMapping } from '@/lib/iso-tiles'

const CELL = 256
const HALF = 64
const THUMB_PAD = HALF * 24
const NEAR_SCALE = 0.1

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

interface Occupant {
  lx: number
  ly: number
  z: number
  sprite: number
}

const atlasImages = new Map<number, HTMLImageElement>()
const thumbImages = new Map<string, HTMLImageElement>()
const cells = new Map<string, Occupant[] | 'missing'>()
const listeners = new Set<() => void>()
let meta: SpriteMeta | null = null
let sprites: SpriteRecord[] = []
let spriteById = new Map<number, SpriteRecord>()
let loading = false

function notify() {
  for (const listener of listeners) {
    listener()
  }
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

function want(image: HTMLImageElement, url: string) {
  if (image.dataset.src === url) {
    return
  }
  image.dataset.src = url
  image.onload = () => notify()
  image.src = url
}

function atlasPage(page: number): HTMLImageElement {
  const existing = atlasImages.get(page)
  if (existing) {
    return existing
  }
  const image = new Image()
  atlasImages.set(page, image)
  want(image, `/api/v1/map-sprites/atlas/${page}?v=${meta?.generated_at ?? ''}`)
  return image
}

function thumbImage(cx: number, cy: number): HTMLImageElement {
  const key = `${cx}_${cy}`
  const existing = thumbImages.get(key)
  if (existing) {
    return existing
  }
  const image = new Image()
  thumbImages.set(key, image)
  want(image, `/api/v1/map-sprites/thumbs/${key}?v=${meta?.generated_at ?? ''}`)
  return image
}

function decodeOccupancy(buffer: ArrayBuffer): Occupant[] {
  const view = new DataView(buffer)
  if (view.byteLength < 8) {
    return []
  }
  if (
    view.getUint8(0) !== 0x53 ||
    view.getUint8(1) !== 0x50 ||
    view.getUint8(2) !== 0x52 ||
    view.getUint8(3) !== 0x31
  ) {
    return []
  }
  const count = view.getUint32(4, true)
  const rows: Occupant[] = []
  let offset = 8
  for (let i = 0; i < count; i += 1) {
    if (offset + 7 > view.byteLength) {
      break
    }
    rows.push({
      lx: view.getUint8(offset),
      ly: view.getUint8(offset + 1),
      z: view.getInt8(offset + 2),
      sprite: view.getUint32(offset + 3, true),
    })
    offset += 7
  }
  return rows
}

function requestCell(cx: number, cy: number) {
  const key = `${cx}_${cy}`
  if (cells.has(key)) {
    return
  }
  cells.set(key, 'missing')
  void fetch(`/api/v1/map-sprites/cells/${key}?v=${meta?.generated_at ?? ''}`).then(
    async (response) => {
      if (!response.ok) {
        return
      }
      cells.set(key, decodeOccupancy(await response.arrayBuffer()))
      notify()
    },
  )
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
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  return {
    left: Math.min(...xs) - THUMB_PAD,
    top: Math.min(...ys) - THUMB_PAD,
    right: Math.max(...xs) + THUMB_PAD,
    bottom: Math.max(...ys) + THUMB_PAD,
  }
}

function visibleCells(mapping: IsoMapping, width: number, height: number) {
  const corners = [
    mapping.toWorld(0, 0),
    mapping.toWorld(width, 0),
    mapping.toWorld(0, height),
    mapping.toWorld(width, height),
  ]
  const reach = (meta?.max_reach ?? 800) / HALF
  const minX = Math.min(...corners.map((point) => point.x)) - reach
  const maxX = Math.max(...corners.map((point) => point.x)) + reach
  const minY = Math.min(...corners.map((point) => point.y)) - reach
  const maxY = Math.max(...corners.map((point) => point.y)) + reach
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
  return out
}

function dziToScreen(mapping: IsoMapping, px: number, py: number) {
  const world = dziToWorld(px, py)
  return mapping.toScreen(world.x, world.y)
}

export function drawIsoSprites(
  ctx: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
): void {
  if (!spriteMapReady()) {
    void loadSpriteMap()
    ctx.fillStyle = '#141611'
    ctx.fillRect(0, 0, width, height)
    return
  }

  const near = mapping.isoScale >= NEAR_SCALE
  const cover = visibleCells(mapping, width, height)

  if (!near) {
    for (const { cx, cy } of cover) {
      const image = thumbImage(cx, cy)
      if (!image.complete || image.naturalWidth === 0) {
        continue
      }
      const box = cellBox(cx, cy)
      const topLeft = dziToScreen(mapping, box.left, box.top)
      const destW = (box.right - box.left) * mapping.isoScale
      const destH = (box.bottom - box.top) * mapping.isoScale
      ctx.drawImage(image, topLeft.x, topLeft.y, destW, destH)
    }
    return
  }

  const scale = mapping.isoScale
  const drawn: Occupant[] = []
  for (const { cx, cy } of cover) {
    requestCell(cx, cy)
    const occupants = cells.get(`${cx}_${cy}`)
    if (!occupants || occupants === 'missing') {
      const image = thumbImage(cx, cy)
      if (image.complete && image.naturalWidth > 0) {
        const box = cellBox(cx, cy)
        const topLeft = dziToScreen(mapping, box.left, box.top)
        ctx.drawImage(
          image,
          topLeft.x,
          topLeft.y,
          (box.right - box.left) * scale,
          (box.bottom - box.top) * scale,
        )
      }
      continue
    }
    for (const occupant of occupants) {
      drawn.push({
        lx: cx * CELL + occupant.lx,
        ly: cy * CELL + occupant.ly,
        z: occupant.z,
        sprite: occupant.sprite,
      })
    }
  }

  drawn.sort((left, right) => left.lx + left.ly - (right.lx + right.ly) || left.z - right.z)

  for (const occupant of drawn) {
    const sprite = spriteById.get(occupant.sprite)
    if (!sprite) {
      continue
    }
    const page = atlasPage(sprite.page)
    if (!page.complete || page.naturalWidth === 0) {
      continue
    }
    const top = mapping.toScreen(occupant.lx, occupant.ly)
    const dx = top.x + sprite.ox * scale
    const dy = top.y + HALF * scale + sprite.oy * scale
    ctx.drawImage(
      page,
      sprite.x,
      sprite.y,
      sprite.w,
      sprite.h,
      dx,
      dy,
      sprite.w * scale,
      sprite.h * scale,
    )
  }
}
