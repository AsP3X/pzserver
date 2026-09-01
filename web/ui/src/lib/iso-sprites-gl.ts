/**
 * GPU sprite pass. The game does this in OpenGL: one atlas page in VRAM at a
 * time, only the squares in the frustum, alpha test + depth so batching by
 * page does not break painter's order.
 *
 * A TEXTURE_2D_ARRAY of every 2048 page is hundreds of MB and often fails to
 * allocate; then this pass draws nothing and the 2D path upscales 512px cell
 * thumbs. Per-page 2D textures upload only what the view has asked for.
 */

import { ISO_LAYER_HEIGHT, worldToDzi, type IsoMapping } from '@/lib/iso-tiles'

const HALF = 64
const PAGE = 2048
const MAX_INSTANCES = 32_768

const VERT = `#version 300 es
in vec2 a_unit;
in vec4 a_dest;
in vec4 a_uv;
in float a_depth;
uniform vec2 u_res;
out vec2 v_uv;
void main() {
  vec2 pos = a_dest.xy + a_unit * a_dest.zw;
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
}

interface GlState {
  canvas: HTMLCanvasElement
  gl: WebGL2RenderingContext
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  instanceBuf: WebGLBuffer
  instanceData: Float32Array
  textures: Map<number, WebGLTexture>
  uploaded: boolean[]
  uRes: WebGLUniformLocation
}

let state: GlState | null = null
let failed = false
const pageBuckets: number[][] = []

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
  gl.bindAttribLocation(program, 1, 'a_dest')
  gl.bindAttribLocation(program, 2, 'a_uv')
  gl.bindAttribLocation(program, 3, 'a_depth')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    failed = true
    return null
  }
  const uRes = gl.getUniformLocation(program, 'u_res')
  const uTex = gl.getUniformLocation(program, 'u_tex')
  if (!uRes || !uTex) {
    failed = true
    return null
  }

  const vao = gl.createVertexArray()
  const unitBuf = gl.createBuffer()
  const instanceBuf = gl.createBuffer()
  if (!vao || !unitBuf || !instanceBuf) {
    failed = true
    return null
  }
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, unitBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  const stride = 36
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf)
  gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES * stride, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0)
  gl.vertexAttribDivisor(1, 1)
  gl.enableVertexAttribArray(2)
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16)
  gl.vertexAttribDivisor(2, 1)
  gl.enableVertexAttribArray(3)
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32)
  gl.vertexAttribDivisor(3, 1)

  gl.useProgram(program)
  gl.uniform1i(uTex, 0)
  gl.disable(gl.BLEND)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LESS)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

  state = {
    canvas,
    gl,
    program,
    vao,
    instanceBuf,
    instanceData: new Float32Array(MAX_INSTANCES * 9),
    textures: new Map(),
    uploaded: [],
    uRes,
  }
  return state
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
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gls.textures.set(page, tex)
  return tex
}

export function uploadAtlasPage(page: number, image: HTMLImageElement): void {
  if (!image.complete || image.naturalWidth === 0 || page < 0) {
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

function bucketPage(page: number): number[] {
  while (pageBuckets.length <= page) {
    pageBuckets.push([])
  }
  const bucket = pageBuckets[page]
  bucket.length = 0
  return bucket
}

function clipDepth(occupant: GlOccupant, index: number, count: number, ordered: boolean): number {
  if (ordered) {
    return 1 - (2 * (index + 1)) / (count + 1)
  }
  const key = occupant.wx + occupant.wy + occupant.z * 0.5
  const ndc = 1 - (2 * key) / 50_000
  if (ndc < -1) {
    return -1
  }
  if (ndc > 1) {
    return 1
  }
  return ndc
}

function drawPage(
  gls: GlState,
  page: number,
  indices: number[],
  rows: GlOccupant[],
  sprites: Array<GlSprite | undefined>,
  mapping: IsoMapping,
  width: number,
  height: number,
  dpr: number,
  count: number,
  ordered: boolean,
): number {
  const tex = gls.textures.get(page)
  if (!tex || !gls.uploaded[page] || indices.length === 0) {
    return 0
  }
  const { gl, instanceBuf, instanceData } = gls
  const scale = mapping.isoScale
  const cx = mapping.center.x
  const cy = mapping.center.y
  const invPage = 1 / PAGE
  let drawn = 0

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)

  let cursor = 0
  while (cursor < indices.length) {
    let written = 0
    while (cursor < indices.length && written < MAX_INSTANCES) {
      const index = indices[cursor]
      cursor += 1
      const occupant = rows[index]
      const sprite = sprites[occupant.sprite]
      if (!sprite || sprite.w <= 0 || sprite.h <= 0) {
        continue
      }
      const destW = sprite.w * scale
      const destH = sprite.h * scale
      const dzi = worldToDzi(occupant.wx, occupant.wy)
      const dx = (dzi.x - cx) * scale + width / 2 + sprite.ox * scale
      const dy =
        (dzi.y - cy) * scale +
        height / 2 +
        HALF * scale +
        sprite.oy * scale -
        occupant.z * ISO_LAYER_HEIGHT * scale
      if (dx > width || dy > height || dx + destW < 0 || dy + destH < 0) {
        continue
      }
      const base = written * 9
      instanceData[base] = dx * dpr
      instanceData[base + 1] = dy * dpr
      instanceData[base + 2] = destW * dpr
      instanceData[base + 3] = destH * dpr
      instanceData[base + 4] = sprite.x * invPage
      instanceData[base + 5] = sprite.y * invPage
      instanceData[base + 6] = sprite.w * invPage
      instanceData[base + 7] = sprite.h * invPage
      instanceData[base + 8] = clipDepth(occupant, index, count, ordered)
      written += 1
    }
    if (written === 0) {
      continue
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instanceData.subarray(0, written * 9))
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, written)
    drawn += written
  }
  return drawn
}

export function drawSpritesGl(
  target: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
  rows: GlOccupant[],
  count: number,
  sprites: Array<GlSprite | undefined>,
  _pageCount: number,
  ordered = true,
): boolean {
  const gls = ensureSpriteGl()
  if (!gls || count === 0) {
    return false
  }
  const { canvas, gl, program, vao, uRes } = gls
  const dpr = Math.max(1, target.getTransform().a || 1)
  const w = Math.max(1, Math.round(width * dpr))
  const h = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  gl.viewport(0, 0, w, h)
  gl.clearColor(0, 0, 0, 0)
  gl.clearDepth(1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

  for (let p = 0; p < pageBuckets.length; p += 1) {
    pageBuckets[p].length = 0
  }
  const usedPages: number[] = []
  for (let i = 0; i < count; i += 1) {
    const sprite = sprites[rows[i].sprite]
    if (!sprite || !gls.uploaded[sprite.page]) {
      continue
    }
    let bucket = pageBuckets[sprite.page]
    if (!bucket) {
      bucket = bucketPage(sprite.page)
    }
    if (bucket.length === 0) {
      usedPages.push(sprite.page)
    }
    bucket.push(i)
  }

  gl.useProgram(program)
  gl.uniform2f(uRes, w, h)
  gl.bindVertexArray(vao)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LESS)
  gl.disable(gl.BLEND)

  let drawn = 0
  for (const page of usedPages) {
    drawn += drawPage(
      gls,
      page,
      pageBuckets[page],
      rows,
      sprites,
      mapping,
      width,
      height,
      dpr,
      count,
      ordered,
    )
    pageBuckets[page].length = 0
  }
  if (drawn === 0) {
    return false
  }

  const smoothing = target.imageSmoothingEnabled
  target.imageSmoothingEnabled = false
  target.drawImage(canvas, 0, 0, width, height)
  target.imageSmoothingEnabled = smoothing
  return true
}
