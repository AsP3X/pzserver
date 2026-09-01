/**
 * GPU sprite pass. The game does this in OpenGL: one atlas page in VRAM at a
 * time, only the squares in the frustum, alpha test + depth so batching by
 * page does not break painter's order.
 *
 * A TEXTURE_2D_ARRAY of every 2048 page is hundreds of MB and often fails to
 * allocate; then this pass draws nothing and the 2D path upscales 512px cell
 * thumbs. Per-page 2D textures upload only what the view has asked for.
 */

import { ISO_LAYER_HEIGHT, type IsoMapping } from '@/lib/iso-tiles'

const PAGE = 2048
const FLOATS = 12
const STRIDE = FLOATS * 4

const VERT = `#version 300 es
in vec2 a_unit;
in vec2 a_dzi;
in vec2 a_origin;
in vec2 a_size;
in float a_z;
in vec4 a_uv;
in float a_depth;
uniform vec2 u_res;
uniform vec2 u_center;
uniform vec2 u_view;
uniform float u_scale;
uniform float u_dpr;
uniform float u_layer;
out vec2 v_uv;
void main() {
  vec2 raw = a_size * u_scale * u_dpr;
  if (raw.x < 0.5 && raw.y < 0.5) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    v_uv = a_uv.xy;
    return;
  }
  vec2 css = (a_dzi - u_center) * u_scale + u_view * 0.5
    + vec2(a_origin.x, 64.0 + a_origin.y - a_z * u_layer) * u_scale;
  // 1px dest grow closes floor diamonds when minifying. At HUD 20+ it
  // stretches quads so the last column samples the 1px atlas pad — roofs
  // fray. Exact dest once a sprite pixel is half a device pixel or larger.
  float close = step(0.5, u_scale * u_dpr);
  vec2 dest = mix(css * u_dpr - vec2(0.5), css * u_dpr, close);
  vec2 dim = mix(raw + vec2(1.0), max(raw, vec2(1.0)), close);
  vec2 pos = dest + a_unit * dim;
  vec2 clip = (pos / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, a_depth, 1.0);
  v_uv = a_uv.xy + a_unit * a_uv.zw;
}
`

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 out_color;
void main() {
  vec4 color = texture(u_tex, v_uv);
  if (color.a < 0.5) {
    discard;
  }
  out_color = color;
}
`

export interface GlSprite {
  page: number
  x: number
  y: number
  w: number
  h: number
  ox: number
  oy: number
}

export interface GlOccupant {
  wx: number
  wy: number
  z: number
  sprite: number
  dziX: number
  dziY: number
}

interface PageBatch {
  buf: WebGLBuffer
  data: Float32Array
  capacity: number
  count: number
}

interface GlState {
  canvas: HTMLCanvasElement
  gl: WebGL2RenderingContext
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  textures: Map<number, WebGLTexture>
  uploaded: boolean[]
  batches: Map<number, PageBatch>
  batchPages: number[]
  epoch: number
  uRes: WebGLUniformLocation
  uCenter: WebGLUniformLocation
  uView: WebGLUniformLocation
  uScale: WebGLUniformLocation
  uDpr: WebGLUniformLocation
  uLayer: WebGLUniformLocation
}

let state: GlState | null = null
let failed = false

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) {
    return null
  }
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export function ensureSpriteGl(): GlState | null {
  if (failed) {
    return null
  }
  if (state) {
    return state
  }
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: true,
    stencil: false,
  })
  if (!gl) {
    failed = true
    return null
  }
  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  if (!vs || !fs) {
    failed = true
    return null
  }
  const program = gl.createProgram()
  if (!program) {
    failed = true
    return null
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'a_unit')
  gl.bindAttribLocation(program, 1, 'a_dzi')
  gl.bindAttribLocation(program, 2, 'a_origin')
  gl.bindAttribLocation(program, 3, 'a_size')
  gl.bindAttribLocation(program, 4, 'a_z')
  gl.bindAttribLocation(program, 5, 'a_uv')
  gl.bindAttribLocation(program, 6, 'a_depth')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    failed = true
    return null
  }
  const uRes = gl.getUniformLocation(program, 'u_res')
  const uTex = gl.getUniformLocation(program, 'u_tex')
  const uCenter = gl.getUniformLocation(program, 'u_center')
  const uView = gl.getUniformLocation(program, 'u_view')
  const uScale = gl.getUniformLocation(program, 'u_scale')
  const uDpr = gl.getUniformLocation(program, 'u_dpr')
  const uLayer = gl.getUniformLocation(program, 'u_layer')
  if (!uRes || !uTex || !uCenter || !uView || !uScale || !uDpr || !uLayer) {
    failed = true
    return null
  }

  const vao = gl.createVertexArray()
  const unitBuf = gl.createBuffer()
  if (!vao || !unitBuf) {
    failed = true
    return null
  }
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, unitBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  for (let loc = 1; loc <= 6; loc += 1) {
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribDivisor(loc, 1)
  }

  gl.useProgram(program)
  gl.uniform1i(uTex, 0)
  gl.disable(gl.BLEND)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

  state = {
    canvas,
    gl,
    program,
    vao,
    textures: new Map(),
    uploaded: [],
    batches: new Map(),
    batchPages: [],
    epoch: -1,
    uRes,
    uCenter,
    uView,
    uScale,
    uDpr,
    uLayer,
  }
  return state
}

const GROUND_RGB: [number, number, number] = [0x4e / 255, 0x5c / 255, 0x36 / 255]

export function attachSpriteGl(host: HTMLElement, behind: HTMLElement): void {
  const gls = ensureSpriteGl()
  if (!gls) {
    return
  }
  const el = gls.canvas
  el.className = 'pointer-events-none absolute left-0 top-0 z-0 block'
  el.style.imageRendering = 'pixelated'
  el.style.background = '#4e5c36'
  if (el.parentNode !== host) {
    el.style.visibility = 'hidden'
    host.insertBefore(el, behind)
  }
}

export function setSpriteGlOnScreen(on: boolean): void {
  if (!state) {
    return
  }
  state.canvas.style.visibility = on ? 'visible' : 'hidden'
}

export function spriteGlEpoch(): number {
  return state?.epoch ?? -1
}

function sizeGl(gls: GlState, width: number, height: number, dpr: number): { w: number; h: number } {
  const w = Math.max(1, Math.round(width * dpr))
  const h = Math.max(1, Math.round(height * dpr))
  const el = gls.canvas
  if (el.width !== w || el.height !== h) {
    el.width = w
    el.height = h
  }
  el.style.width = `${width}px`
  el.style.height = `${height}px`
  return { w, h }
}

function paintBatches(gls: GlState, mapping: IsoMapping, width: number, height: number, dpr: number): number {
  const { w, h } = sizeGl(gls, width, height, dpr)
  const { gl, program, vao } = gls
  gl.viewport(0, 0, w, h)
  gl.clearColor(GROUND_RGB[0], GROUND_RGB[1], GROUND_RGB[2], 1)
  gl.clearDepth(1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  gl.useProgram(program)
  gl.uniform2f(gls.uRes, w, h)
  gl.uniform2f(gls.uCenter, mapping.center.x, mapping.center.y)
  gl.uniform2f(gls.uView, width, height)
  gl.uniform1f(gls.uScale, mapping.isoScale)
  gl.uniform1f(gls.uDpr, dpr)
  gl.uniform1f(gls.uLayer, ISO_LAYER_HEIGHT)
  gl.bindVertexArray(vao)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  gl.disable(gl.BLEND)
  let drawn = 0
  for (const page of gls.batchPages) {
    const batch = gls.batches.get(page)
    const tex = gls.textures.get(page)
    if (!batch || !tex || !gls.uploaded[page] || batch.count === 0) {
      continue
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    bindInstanceAttribs(gl, batch.buf)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count)
    drawn += batch.count
  }
  return drawn
}

export function presentSpriteGl(
  mapping: IsoMapping,
  width: number,
  height: number,
  dpr: number,
): boolean {
  const gls = state
  if (!gls || gls.epoch < 0 || gls.batchPages.length === 0) {
    return false
  }
  const drawn = paintBatches(gls, mapping, width, height, Math.max(1, dpr))
  if (drawn === 0) {
    return false
  }
  setSpriteGlOnScreen(true)
  return true
}

function textureForPage(gls: GlState, page: number): WebGLTexture | null {
  const existing = gls.textures.get(page)
  if (existing) {
    return existing
  }
  const tex = gls.gl.createTexture()
  if (!tex) {
    return null
  }
  const { gl } = gls
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gls.textures.set(page, tex)
  return tex
}

export function uploadAtlasPage(page: number, image: TexImageSource): void {
  if (page < 0) {
    return
  }
  if (image instanceof HTMLImageElement && (!image.complete || image.naturalWidth === 0)) {
    return
  }
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap && image.width === 0) {
    return
  }
  const gls = ensureSpriteGl()
  if (!gls || gls.uploaded[page]) {
    return
  }
  const tex = textureForPage(gls, page)
  if (!tex) {
    return
  }
  const { gl } = gls
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
  gls.uploaded[page] = true
}

function bindInstanceAttribs(gl: WebGL2RenderingContext, buf: WebGLBuffer): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 0)
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 8)
  gl.vertexAttribPointer(3, 2, gl.FLOAT, false, STRIDE, 16)
  gl.vertexAttribPointer(4, 1, gl.FLOAT, false, STRIDE, 24)
  gl.vertexAttribPointer(5, 4, gl.FLOAT, false, STRIDE, 28)
  gl.vertexAttribPointer(6, 1, gl.FLOAT, false, STRIDE, 44)
}

function pageBatch(gls: GlState, page: number, count: number): PageBatch | null {
  let batch = gls.batches.get(page)
  if (!batch) {
    const buf = gls.gl.createBuffer()
    if (!buf) {
      return null
    }
    batch = { buf, data: new Float32Array(count * FLOATS), capacity: count, count: 0 }
    gls.batches.set(page, batch)
  } else if (count > batch.capacity) {
    batch.data = new Float32Array(count * FLOATS)
    batch.capacity = count
  }
  batch.count = count
  return batch
}

/** Slots per iso square so adjacent floors (and the 1px dest overlap) never share a depth. */
const SQUARE_SLOTS = 2048

function clipDepth(
  occupant: GlOccupant,
  sprite: GlSprite | undefined,
  index: number,
  count: number,
  ordered: boolean,
  minDiag: number,
  span: number,
): number {
  const tie = occupant.sprite & 255
  if (ordered && count > 0) {
    // Unique per occupant. A sprite-id nudge smaller than one sort step so
    // coplanar roof pieces on the same square never share a depth sample.
    const step = 1 / (count + 1)
    const t = (index + 1) * step + ((tie + 1) / 256) * step
    return 1 - 2 * Math.min(1, t)
  }
  const diag = occupant.wx + occupant.wy - minDiag
  const storey = Math.min(31, Math.max(0, occupant.z + 8))
  const tall = sprite ? Math.min(63, sprite.h >> 2) : 0
  const key = diag * SQUARE_SLOTS + storey * 64 + (tall ^ tie)
  const ndc = 1 - (2 * key) / Math.max(1, (span + 1) * SQUARE_SLOTS)
  if (ndc < -1) {
    return -1
  }
  if (ndc > 1) {
    return 1
  }
  return ndc
}

function rebuildBatches(
  gls: GlState,
  rows: GlOccupant[],
  count: number,
  sprites: Array<GlSprite | undefined>,
  ordered: boolean,
): number {
  const { gl, uploaded } = gls
  const counts = new Map<number, number>()
  let minDiag = rows[0].wx + rows[0].wy
  let maxDiag = minDiag
  for (let i = 0; i < count; i += 1) {
    const occupant = rows[i]
    const diag = occupant.wx + occupant.wy
    if (diag < minDiag) {
      minDiag = diag
    }
    if (diag > maxDiag) {
      maxDiag = diag
    }
    const sprite = sprites[occupant.sprite]
    if (!sprite || sprite.w <= 0 || sprite.h <= 0 || !uploaded[sprite.page]) {
      continue
    }
    counts.set(sprite.page, (counts.get(sprite.page) ?? 0) + 1)
  }
  const span = Math.max(0, maxDiag - minDiag)
  gls.batchPages.length = 0
  const cursors = new Map<number, number>()
  for (const [page, n] of counts) {
    const batch = pageBatch(gls, page, n)
    if (!batch) {
      continue
    }
    cursors.set(page, 0)
    gls.batchPages.push(page)
  }
  const invPage = 1 / PAGE
  for (let i = 0; i < count; i += 1) {
    const occupant = rows[i]
    const sprite = sprites[occupant.sprite]
    if (!sprite || sprite.w <= 0 || sprite.h <= 0 || !uploaded[sprite.page]) {
      continue
    }
    const batch = gls.batches.get(sprite.page)
    const written = cursors.get(sprite.page)
    if (!batch || written === undefined) {
      continue
    }
    const base = written * FLOATS
    const data = batch.data
    data[base] = occupant.dziX
    data[base + 1] = occupant.dziY
    data[base + 2] = sprite.ox
    data[base + 3] = sprite.oy
    data[base + 4] = sprite.w
    data[base + 5] = sprite.h
    data[base + 6] = occupant.z
    data[base + 7] = sprite.x * invPage
    data[base + 8] = sprite.y * invPage
    data[base + 9] = sprite.w * invPage
    data[base + 10] = sprite.h * invPage
    data[base + 11] = clipDepth(occupant, sprite, i, count, ordered, minDiag, span)
    cursors.set(sprite.page, written + 1)
  }
  let drawn = 0
  for (const page of gls.batchPages) {
    const batch = gls.batches.get(page)
    if (!batch || batch.count === 0) {
      continue
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.buf)
    gl.bufferData(gl.ARRAY_BUFFER, batch.data.subarray(0, batch.count * FLOATS), gl.DYNAMIC_DRAW)
    drawn += batch.count
  }
  return drawn
}

export function drawSpritesGl(
  target: CanvasRenderingContext2D | null,
  mapping: IsoMapping,
  width: number,
  height: number,
  rows: GlOccupant[],
  count: number,
  sprites: Array<GlSprite | undefined>,
  _pageCount: number,
  ordered = true,
  epoch = 0,
  dpr = 1,
  blit = true,
): boolean {
  const gls = ensureSpriteGl()
  if (!gls || count === 0) {
    return false
  }
  const pixelRatio = Math.max(1, dpr)
  if (gls.epoch !== epoch) {
    const packed = rebuildBatches(gls, rows, count, sprites, ordered)
    gls.epoch = packed > 0 ? epoch : -1
  }
  const drawn = paintBatches(gls, mapping, width, height, pixelRatio)
  if (drawn === 0) {
    return false
  }
  if (blit && target) {
    setSpriteGlOnScreen(false)
    const smoothing = target.imageSmoothingEnabled
    target.imageSmoothingEnabled = false
    target.drawImage(gls.canvas, 0, 0, width, height)
    target.imageSmoothingEnabled = smoothing
  } else {
    setSpriteGlOnScreen(true)
  }
  return true
}
