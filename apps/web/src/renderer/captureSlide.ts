/**
 * renderer/captureSlide.ts — the slide a canvas shows, as a PNG at the
 * slide's own size (1920×1080), read from the Pixi scene.
 *
 * The render page (pages/DeckRender.tsx) uses it to hand the editor an exact
 * picture of a slide without a server round trip: the same scene graph, the
 * same fonts and pictures, rendered once more into a texture at resolution 1
 * — whatever the device pixel ratio the page was painted at. Only Pixi
 * content is in it; the render page has no DOM overlays (video playback and
 * peer cursors are the editor's).
 */

import { DOMAdapter, Rectangle, type Texture } from 'pixi.js'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './constants.js'
import type { SceneGraph } from './SceneGraph.js'

/**
 * The slide as a canvas of the slide's own size (1920×1080) at resolution 1,
 * or scaled by `resolution` (a thumbnail: 200 / 1920).
 * Throws — never returns an empty picture — when the WebGL context is gone:
 * the GPU process died (on the render worker: out of memory), and every
 * pixel read from it is empty. Chrome may report the loss late, so the
 * canvas's `webglcontextlost` event is watched too (`watchContextLoss`).
 */
export function captureSlideCanvas(
  sceneGraph: SceneGraph,
  resolution = 1,
): HTMLCanvasElement | OffscreenCanvas {
  const renderer = sceneGraph.getApp().renderer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's WebGL renderer exposes `gl` untyped on the base type
  const gl = (renderer as any).gl as WebGLRenderingContext | undefined
  if (gl?.isContextLost() === true || lostCanvases.has(renderer.canvas)) {
    throw new Error('the WebGL context was lost')
  }
  // The slide root's own space is slide space: its background and objects
  // from (0, 0) to the slide's size, whatever origin the canvas gave it.
  // A scaled capture is cut to whole pixel rows: 1080 × 200/1920 = 112.5 rows
  // would leave the last one half covered, drawn as a faint grey line.
  const height =
    resolution === 1 ? SLIDE_HEIGHT : Math.floor(SLIDE_HEIGHT * resolution) / resolution
  const canvas = renderer.extract.canvas({
    target: sceneGraph.getRoot(),
    frame: new Rectangle(0, 0, SLIDE_WIDTH, height),
    resolution,
  }) as HTMLCanvasElement | OffscreenCanvas
  if (gl?.isContextLost() === true || lostCanvases.has(renderer.canvas)) {
    throw new Error('the slide came back empty (the WebGL context was lost)')
  }
  return canvas
}

/**
 * `captureSlideCanvas` without a synchronous read-back: the slide is drawn
 * into a texture now (inside `around`, for state that must hold only while it
 * is drawn), the read is queued into a pixel-pack buffer behind a fence, and
 * the pixels are fetched once the GPU has passed the fence — a poll on a
 * timer, so the main thread never waits for the GPU. The pixels and the
 * canvas are made exactly as Pixi's `extract.canvas` makes them (the same
 * `readPixels` of the texture's resolved framebuffer, put into a 2D canvas
 * as they are), so the picture is the same.
 *
 * Why: `readPixels` into client memory waits for every command queued
 * before it — the first capture after an edit waited ~290 ms on the
 * rasters and uploads the edit had queued (performance.md, Log 2026-10-19).
 * Without WebGL2 (no fences) it falls back to the synchronous read.
 */
export async function captureSlideCanvasAsync(
  sceneGraph: SceneGraph,
  resolution = 1,
  around: <T>(draw: () => T) => T = (draw) => draw(),
): Promise<HTMLCanvasElement | OffscreenCanvas> {
  const renderer = sceneGraph.getApp().renderer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's WebGL renderer exposes `gl` untyped on the base type
  const gl = (renderer as any).gl as WebGLRenderingContext | WebGL2RenderingContext | undefined
  const lost = (): boolean => gl?.isContextLost() === true || lostCanvases.has(renderer.canvas)
  if (lost()) throw new Error('the WebGL context was lost')
  if (
    gl === undefined ||
    typeof WebGL2RenderingContext === 'undefined' ||
    !(gl instanceof WebGL2RenderingContext)
  )
    return around(() => captureSlideCanvas(sceneGraph, resolution))
  const height =
    resolution === 1 ? SLIDE_HEIGHT : Math.floor(SLIDE_HEIGHT * resolution) / resolution
  const texture = around(() =>
    renderer.textureGenerator.generateTexture({
      target: sceneGraph.getRoot(),
      frame: new Rectangle(0, 0, SLIDE_WIDTH, height),
      resolution,
    }),
  )
  let pbo: WebGLBuffer | null = null
  let sync: WebGLSync | null = null
  try {
    // As GlTextureSystem.getPixels reads it.
    const res = texture.source.resolution
    const frame = texture.frame
    const width = Math.max(Math.round(frame.width * res), 1)
    const rows = Math.max(Math.round(frame.height * res), 1)
    const bytes = 4 * width * rows
    // Pixi's GL systems are reached through their untyped internals here (as in getPixels).
    const rt = renderer.renderTarget as unknown as {
      getRenderTarget(t: Texture): unknown
      getGpuRenderTarget(r: unknown): { resolveTargetFramebuffer: WebGLFramebuffer | null }
      adaptor: { bindFramebuffer(fb: WebGLFramebuffer | null): void }
    }
    const glTarget = rt.getGpuRenderTarget(rt.getRenderTarget(texture))
    rt.adaptor.bindFramebuffer(glTarget.resolveTargetFramebuffer)
    pbo = gl.createBuffer()
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ)
    gl.readPixels(
      Math.round(frame.x * res),
      Math.round(frame.y * res),
      width,
      rows,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      0,
    )
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
    if (sync === null) throw new Error('no fence for the slide read-back')
    await waitForFence(gl, sync, lost)
    if (lost()) throw new Error('the slide came back empty (the WebGL context was lost)')
    const pixels = new Uint8Array(bytes)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    // As GlTextureSystem.generateCanvas makes it.
    const canvas = DOMAdapter.get().createCanvas(width, rows) as HTMLCanvasElement | OffscreenCanvas
    canvas.width = width
    canvas.height = rows
    const ctx = canvas.getContext('2d') as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (ctx !== null) {
      const image = ctx.createImageData(width, rows)
      image.data.set(pixels)
      ctx.putImageData(image, 0, 0)
    }
    return canvas
  } finally {
    if (!gl.isContextLost()) {
      if (sync !== null) gl.deleteSync(sync)
      if (pbo !== null) gl.deleteBuffer(pbo)
    }
    texture.destroy(true)
  }
}

/** How long a read-back may take before it is given up on (a GPU that hangs). */
const FENCE_TIMEOUT_MS = 10_000

/** Resolves once the GPU has passed `sync`, polled on a timer (never waits on the main thread). */
function waitForFence(
  gl: WebGL2RenderingContext,
  sync: WebGLSync,
  lost: () => boolean,
): Promise<void> {
  const end = performance.now() + FENCE_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (lost()) return reject(new Error('the WebGL context was lost'))
      const status = gl.clientWaitSync(sync, 0, 0)
      if (status === gl.WAIT_FAILED) return reject(new Error('the slide read-back failed'))
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return resolve()
      if (performance.now() > end) return reject(new Error('the slide read-back timed out'))
      setTimeout(poll, 4)
    }
    poll()
  })
}

/** Canvases whose WebGL context was lost: nothing captured from them is trusted again. */
const lostCanvases = new WeakSet<object>()

/** Remember when the scene's WebGL context is lost (the render page calls it once). */
export function watchContextLoss(sceneGraph: SceneGraph): () => void {
  const canvas = sceneGraph.getApp().renderer.canvas as HTMLCanvasElement
  const onLost = (): void => {
    lostCanvases.add(canvas)
  }
  canvas.addEventListener('webglcontextlost', onLost)
  return () => canvas.removeEventListener('webglcontextlost', onLost)
}

/** A canvas as a PNG. */
export function canvasToPng(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' })
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob !== null ? resolve(blob) : reject(new Error('the picture could not be encoded')),
      'image/png',
    )
  })
}

export async function captureSlidePng(sceneGraph: SceneGraph): Promise<Blob> {
  return canvasToPng(captureSlideCanvas(sceneGraph))
}
