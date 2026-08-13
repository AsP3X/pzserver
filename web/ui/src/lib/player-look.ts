/**
 * Paint a survivor's head from the compact look the mod exports.
 *
 * This is not the game's 3D mesh — the dedicated server has none of that
 * art. It is a small composed portrait (skin, hair family, beard, hat) that
 * still reads as *this* person at map-pin size.
 */

export interface PlayerLook {
  female?: boolean
  skin?: number[] | null
  hair?: string | null
  hair_color?: number[] | null
  beard?: string | null
  beard_color?: number[] | null
  hat?: string | null
}

type HairKind = 'bald' | 'buzz' | 'short' | 'messy' | 'bob' | 'long' | 'pony' | 'bun' | 'mohawk'

const DEFAULT_SKIN: [number, number, number] = [0.78, 0.58, 0.46]
const DEFAULT_HAIR: [number, number, number] = [0.18, 0.12, 0.08]

function triplet(value: number[] | null | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!value || value.length < 3) {
    return fallback
  }
  return [value[0] ?? fallback[0], value[1] ?? fallback[1], value[2] ?? fallback[2]]
}

function fill(color: [number, number, number], shade = 1): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255 * shade)))
  return `rgb(${channel(color[0])} ${channel(color[1])} ${channel(color[2])})`
}

export function hairKind(name: string | null | undefined): HairKind {
  const text = (name ?? '').toLowerCase()
  if (!text || text === 'null' || text.includes('bald') || text === 'none') {
    return 'bald'
  }
  if (text.includes('mohawk') || text.includes('liberty') || text.includes('spike')) {
    return 'mohawk'
  }
  if (text.includes('pony') || text.includes('braid') || text.includes('pigtail')) {
    return 'pony'
  }
  if (text.includes('bun') || text.includes('granny') || text.includes('updo')) {
    return 'bun'
  }
  if (text.includes('bob') || text.includes('rachel') || text.includes('overeye') || text.includes('hat')) {
    return 'bob'
  }
  if (text.includes('long') || text.includes('flow') || text.includes('kate') || text.includes('curly')) {
    return 'long'
  }
  if (text.includes('buzz') || text.includes('crew') || text.includes('picard') || text.includes('donny') || text.includes('fade')) {
    return 'buzz'
  }
  if (text.includes('mess') || text.includes('fabian') || text.includes('wild')) {
    return 'messy'
  }
  return 'short'
}

function hasBeard(name: string | null | undefined): boolean {
  const text = (name ?? '').toLowerCase()
  return Boolean(text) && text !== 'null' && text !== 'none' && !text.includes('none')
}

export function paintHead(
  ctx: CanvasRenderingContext2D,
  look: PlayerLook | null | undefined,
  size: number,
): void {
  const female = look?.female ?? false
  const skin = triplet(look?.skin, DEFAULT_SKIN)
  const hairColor = triplet(look?.hair_color, DEFAULT_HAIR)
  const beardColor = triplet(look?.beard_color, hairColor)
  const kind = hairKind(look?.hair) === 'bald' && female ? 'bob' : hairKind(look?.hair)
  const beard = hasBeard(look?.beard)
  const hat = look?.hat ?? null

  ctx.clearRect(0, 0, size, size)
  ctx.save()
  ctx.scale(size / 32, size / 32)

  ctx.beginPath()
  ctx.arc(16, 16, 15.2, 0, Math.PI * 2)
  ctx.clip()

  ctx.fillStyle = '#1a1c16'
  ctx.fillRect(0, 0, 32, 32)

  if (kind === 'long' || kind === 'pony' || kind === 'bob') {
    ctx.fillStyle = fill(hairColor, 0.85)
    ctx.beginPath()
    ctx.ellipse(16, 22, kind === 'pony' ? 9 : 11, 12, 0, 0, Math.PI * 2)
    ctx.fill()
    if (kind === 'pony') {
      ctx.beginPath()
      ctx.ellipse(25, 24, 3.2, 7, 0.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  ctx.fillStyle = fill(skin, 0.88)
  ctx.beginPath()
  ctx.ellipse(16, 24, 4.2, 3.2, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = fill(skin)
  ctx.beginPath()
  ctx.ellipse(16, 15.5, female ? 8.2 : 8.6, female ? 10 : 10.4, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = fill(skin, 0.9)
  ctx.beginPath()
  ctx.ellipse(8.2, 16.5, 1.8, 2.4, 0, 0, Math.PI * 2)
  ctx.ellipse(23.8, 16.5, 1.8, 2.4, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#1c1714'
  ctx.beginPath()
  ctx.ellipse(12.6, 15.4, 1.15, 1.35, 0, 0, Math.PI * 2)
  ctx.ellipse(19.4, 15.4, 1.15, 1.35, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#f2efe6'
  ctx.beginPath()
  ctx.arc(12.9, 15.1, 0.35, 0, Math.PI * 2)
  ctx.arc(19.7, 15.1, 0.35, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = fill(skin, 0.75)
  ctx.lineWidth = 0.7
  ctx.beginPath()
  ctx.moveTo(16, 16.2)
  ctx.lineTo(15.4, 18.4)
  ctx.lineTo(16.6, 18.4)
  ctx.stroke()

  if (beard) {
    ctx.fillStyle = fill(beardColor, 0.9)
    ctx.beginPath()
    ctx.ellipse(16, 22.4, 5.2, 3.4, 0, 0, Math.PI)
    ctx.fill()
  }

  ctx.fillStyle = fill(hairColor)
  if (kind === 'buzz') {
    ctx.beginPath()
    ctx.ellipse(16, 11.2, 8.2, 5.2, 0, Math.PI, 0)
    ctx.fill()
  } else if (kind === 'short' || kind === 'messy') {
    ctx.beginPath()
    ctx.ellipse(16, 10.4, 8.6, 6.2, 0, Math.PI, Math.PI * 2)
    ctx.fill()
    if (kind === 'messy') {
      ctx.beginPath()
      ctx.moveTo(9, 10)
      ctx.lineTo(11, 6.5)
      ctx.lineTo(13, 10)
      ctx.moveTo(18, 9.5)
      ctx.lineTo(20.5, 6)
      ctx.lineTo(22, 10)
      ctx.fill()
    }
  } else if (kind === 'bob' || kind === 'long' || kind === 'pony' || kind === 'bun') {
    ctx.beginPath()
    ctx.ellipse(16, 10.6, 8.8, 6.4, 0, Math.PI, Math.PI * 2)
    ctx.fill()
    if (kind === 'bun') {
      ctx.beginPath()
      ctx.arc(16, 6.2, 3.1, 0, Math.PI * 2)
      ctx.fill()
    }
  } else if (kind === 'mohawk') {
    ctx.beginPath()
    ctx.moveTo(14, 14)
    ctx.lineTo(16, 4.5)
    ctx.lineTo(18, 14)
    ctx.closePath()
    ctx.fill()
  }

  if (hat) {
    const brim = hat.toLowerCase().includes('helmet') || hat.toLowerCase().includes('hard')
    ctx.fillStyle = brim ? '#4a4f44' : '#3d2a1c'
    ctx.beginPath()
    ctx.ellipse(16, 10.2, 9.4, 4.2, 0, Math.PI, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = brim ? '#5b6154' : '#5a3d28'
    ctx.beginPath()
    ctx.ellipse(16, 11.4, 11.2, 2.1, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

const cache = new Map<string, HTMLCanvasElement>()

export function headBitmap(look: PlayerLook | null | undefined, size: number): HTMLCanvasElement {
  const key = `${size}:${JSON.stringify(look ?? null)}`
  const hit = cache.get(key)
  if (hit) {
    return hit
  }

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    paintHead(ctx, look, size)
  }
  cache.set(key, canvas)
  if (cache.size > 80) {
    const first = cache.keys().next().value
    if (first) {
      cache.delete(first)
    }
  }
  return canvas
}
