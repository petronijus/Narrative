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

export async function captureSlidePng(sceneGraph: SceneGraph): Promise<Blob> {
  const renderer = sceneGraph.getApp().renderer
  // The slide root's own space is slide space: its background and objects
  // from (0, 0) to the slide's size, whatever origin the canvas gave it.
  const canvas = renderer.extract.canvas({
    target: sceneGraph.getRoot(),
    frame: new Rectangle(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT),
    resolution: 1,
  }) as HTMLCanvasElement | OffscreenCanvas
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' })
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob !== null ? resolve(blob) : reject(new Error('the slide could not be encoded')),
      'image/png',
    )
  })
}
