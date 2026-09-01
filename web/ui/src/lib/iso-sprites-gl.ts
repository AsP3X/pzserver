/**
 * GPU sprite pass. The game does this in OpenGL: one atlas in VRAM, only the
 * squares in the frustum, painter's order for alpha. Canvas 2D cannot.
 */

import { ISO_LAYER_HEIGHT, worldToDzi, type IsoMapping } from '@/lib/iso-tiles'

const HALF = 64
const PAGE = 2048
const MAX_INSTANCES = 48_000

const VERT = `#version 300 es
in vec2 a_unit;
in vec4 a_dest;
in vec4 a_uv;
in float a_page;
uniform vec2 u_res;
out vec2 v_uv;
out float v_page;
void main() {
  vec2 pos = a_dest.xy + a_unit * a_dest.zw;
  vec2 clip = (pos / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv.xy + a_unit * a_uv.zw;
  v_page = a_page;
}
`

const FRAG = `#version 300 es
precision mediump float;
precision mediump sampler2DArray;
in vec2 v_uv;
in float v_page;
uniform sampler2DArray u_tex;
out vec4 out_color;
void main() {
  out_color = texture(u_tex, vec3(v_uv, v_page));
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
  tex: WebGLTexture
  pages: number
  uploaded: boolean[]
  uRes: WebGLUniformLocation
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

function init(pageCount: number): GlState | null {
  if (failed) {
    return null
  }
  if (state && state.pages >= pageCount) {
    return state
  }
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
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
  gl.bindAttribLocation(program, 3, 'a_page')
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
  const tex = gl.createTexture()
  if (!vao || !unitBuf || !instanceBuf || !tex) {
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

  const pages = Math.max(1, pageCount)
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex)
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, PAGE, PAGE, pages)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)

  gl.useProgram(program)
  gl.uniform1i(uTex, 0)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  state = {
    canvas,
    gl,
    program,
    vao,
    instanceBuf,
    instanceData: new Float32Array(MAX_INSTANCES * 9),
    tex,
    pages,
    uploaded: Array.from({ length: pages }, () => false),
    uRes,
  }
  return state
}

export function uploadAtlasPage(page: number, image: HTMLImageElement): void {
  if (!image.complete || image.naturalWidth === 0) {
    return
  }
  const gls = state
  if (!gls || page < 0 || page >= gls.pages || gls.uploaded[page]) {
    return
  }
  const { gl, tex } = gls
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex)
  gl.texSubImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    0,
    0,
    page,
    image.naturalWidth,
    image.naturalHeight,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    image,
  )
  gls.uploaded[page] = true
}

export function drawSpritesGl(
  target: CanvasRenderingContext2D,
  mapping: IsoMapping,
  width: number,
  height: number,
  rows: GlOccupant[],
  count: number,
  sprites: Array<GlSprite | undefined>,
  pageCount: number,
): boolean {
  const gls = init(Math.max(1, pageCount))
  if (!gls || count === 0) {
    return false
  }
  const { canvas, gl, program, vao, instanceBuf, instanceData, tex, uRes, uploaded } = gls
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  gl.viewport(0, 0, w, h)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  const scale = mapping.isoScale
  const cx = mapping.center.x
  const cy = mapping.center.y
  let written = 0
  const invPage = 1 / PAGE
  for (let i = 0; i < count && written < MAX_INSTANCES; i += 1) {
    const occupant = rows[i]
    const sprite = sprites[occupant.sprite]
    if (!sprite || sprite.w <= 0 || !uploaded[sprite.page]) {
      continue
    }
    const destW = sprite.w * scale
    const destH = sprite.h * scale
    if (destW < 0.75 || destH < 0.75) {
      continue
    }
    const dzi = worldToDzi(occupant.wx, occupant.wy)
    const dx = (dzi.x - cx) * scale + width / 2 + sprite.ox * scale
    const dy =
      (dzi.y - cy) * scale + height / 2 + HALF * scale + sprite.oy * scale - occupant.z * ISO_LAYER_HEIGHT * scale
    if (dx > width || dy > height || dx + destW < 0 || dy + destH < 0) {
      continue
    }
    const base = written * 9
    instanceData[base] = dx
    instanceData[base + 1] = dy
    instanceData[base + 2] = destW
    instanceData[base + 3] = destH
    instanceData[base + 4] = sprite.x * invPage
    instanceData[base + 5] = sprite.y * invPage
    instanceData[base + 6] = sprite.w * invPage
    instanceData[base + 7] = sprite.h * invPage
    instanceData[base + 8] = sprite.page
    written += 1
  }
  if (written === 0) {
    return false
  }

  gl.useProgram(program)
  gl.uniform2f(uRes, width, height)
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf)
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, instanceData.subarray(0, written * 9))
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex)
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, written)

  target.drawImage(canvas, 0, 0, width, height)
  return true
}
