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

import { Rectangle } from 'pixi.js'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './constants.js'
import type { SceneGraph } from './SceneGraph.js'

/**
 * The slide as a canvas of the slide's own size (1920×1080), at resolution 1.
 * Throws — never returns an empty picture — when the WebGL context is gone:
 * the GPU process died (on the render worker: out of memory), and every
 * pixel read from it is empty. Chrome may report the loss late, so the
 * canvas's `webglcontextlost` event is watched too (`watchContextLoss`).
 */
export function captureSlideCanvas(sceneGraph: SceneGraph): HTMLCanvasElement | OffscreenCanvas {
  const renderer = sceneGraph.getApp().renderer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's WebGL renderer exposes `gl` untyped on the base type
  const gl = (renderer as any).gl as WebGLRenderingContext | undefined
  if (gl?.isContextLost() === true || lostCanvases.has(renderer.canvas)) {
    throw new Error('the WebGL context was lost')
  }
  // The slide root's own space is slide space: its background and objects
  // from (0, 0) to the slide's size, whatever origin the canvas gave it.
  const canvas = renderer.extract.canvas({
    target: sceneGraph.getRoot(),
    frame: new Rectangle(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT),
    resolution: 1,
  }) as HTMLCanvasElement | OffscreenCanvas
  if (gl?.isContextLost() === true || lostCanvases.has(renderer.canvas)) {
    throw new Error('the slide came back empty (the WebGL context was lost)')
  }
  return canvas
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
