/** Merge touching update rects so the map draws one outline and one bubble. */

export type WorldRect = { x: number; y: number; w: number; h: number }

export function parseRect(raw: number[]): WorldRect | null {
  if (raw.length < 4) {
    return null
  }
  const [x, y, w, h] = raw
  if (!(w > 0) || !(h > 0)) {
    return null
  }
  return { x, y, w, h }
}

/** Share an edge of positive length, or overlap. Corners-only do not merge. */
export function rectsAdjacent(a: WorldRect, b: WorldRect): boolean {
  const ax2 = a.x + a.w
  const ay2 = a.y + a.h
  const bx2 = b.x + b.w
  const by2 = b.y + b.h
  const xOverlap = Math.min(ax2, bx2) - Math.max(a.x, b.x)
  const yOverlap = Math.min(ay2, by2) - Math.max(a.y, b.y)
  if (xOverlap > 0 && yOverlap > 0) {
    return true
  }
  if (xOverlap === 0 && yOverlap > 0) {
    return true
  }
  if (yOverlap === 0 && xOverlap > 0) {
    return true
  }
  return false
}

export function clusterIndices(rects: WorldRect[]): number[][] {
  const parent = rects.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!
      i = parent[i]!
    }
    return i
  }
  const unite = (i: number, j: number) => {
    const a = find(i)
    const b = find(j)
    if (a !== b) {
      parent[b] = a
    }
  }
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (rectsAdjacent(rects[i]!, rects[j]!)) {
        unite(i, j)
      }
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < rects.length; i += 1) {
    const root = find(i)
    const list = groups.get(root) ?? []
    list.push(i)
    groups.set(root, list)
  }
  return [...groups.values()]
}

type Side = 'north' | 'south' | 'west' | 'east'

export type WorldEdge = { x0: number; y0: number; x1: number; y1: number }

/**
 * Outer edges of a union of axis-aligned rects. Shared interior edges are
 * dropped so adjacent cells become one construction site.
 */
export function exposedEdges(rects: WorldRect[]): WorldEdge[] {
  const edges: WorldEdge[] = []
  for (const rect of rects) {
    edges.push(
      ...edgeSegments(rect, 'north', rects),
      ...edgeSegments(rect, 'south', rects),
      ...edgeSegments(rect, 'west', rects),
      ...edgeSegments(rect, 'east', rects),
    )
  }
  return edges
}

function edgeSegments(rect: WorldRect, side: Side, all: WorldRect[]): WorldEdge[] {
  const cuts: [number, number][] = []
  for (const other of all) {
    if (other === rect) {
      continue
    }
    const cut = neighborCut(rect, other, side)
    if (cut) {
      cuts.push(cut)
    }
  }
  if (side === 'north' || side === 'south') {
    const y = side === 'north' ? rect.y : rect.y + rect.h
    return leftover(rect.x, rect.x + rect.w, cuts).map(([x0, x1]) => ({
      x0,
      y0: y,
      x1,
      y1: y,
    }))
  }
  const x = side === 'west' ? rect.x : rect.x + rect.w
  return leftover(rect.y, rect.y + rect.h, cuts).map(([y0, y1]) => ({
    x0: x,
    y0,
    x1: x,
    y1,
  }))
}

function neighborCut(rect: WorldRect, other: WorldRect, side: Side): [number, number] | null {
  if (side === 'north') {
    if (other.y + other.h !== rect.y) {
      return null
    }
    return overlap1d(rect.x, rect.x + rect.w, other.x, other.x + other.w)
  }
  if (side === 'south') {
    if (other.y !== rect.y + rect.h) {
      return null
    }
    return overlap1d(rect.x, rect.x + rect.w, other.x, other.x + other.w)
  }
  if (side === 'west') {
    if (other.x + other.w !== rect.x) {
      return null
    }
    return overlap1d(rect.y, rect.y + rect.h, other.y, other.y + other.h)
  }
  if (other.x !== rect.x + rect.w) {
    return null
  }
  return overlap1d(rect.y, rect.y + rect.h, other.y, other.y + other.h)
}

function overlap1d(a0: number, a1: number, b0: number, b1: number): [number, number] | null {
  const lo = Math.max(a0, b0)
  const hi = Math.min(a1, b1)
  if (hi - lo <= 0) {
    return null
  }
  return [lo, hi]
}

export type OverlayPiece<T> = { rect: number[]; data: T }

export function clusterPieces<T>(pieces: OverlayPiece<T>[]): OverlayPiece<T>[][] {
  const valid: { piece: OverlayPiece<T>; rect: WorldRect }[] = []
  for (const piece of pieces) {
    const rect = parseRect(piece.rect)
    if (rect) {
      valid.push({ piece, rect })
    }
  }
  return clusterIndices(valid.map((entry) => entry.rect)).map((indexes) =>
    indexes.map((i) => valid[i]!.piece),
  )
}

function leftover(start: number, end: number, cuts: [number, number][]): [number, number][] {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  let cursor = start
  for (const [lo, hi] of sorted) {
    if (lo > cursor) {
      out.push([cursor, Math.min(lo, end)])
    }
    cursor = Math.max(cursor, hi)
    if (cursor >= end) {
      break
    }
  }
  if (cursor < end) {
    out.push([cursor, end])
  }
  return out
}
