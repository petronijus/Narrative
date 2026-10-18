/**
 * renderer/liveThumbnail.ts — the thumbnail of the slide the editor is showing,
 * read from the editor's own canvas.
 *
 * The sidebar thumbnail used to be built in a Pixi application of its own: every
 * object of the slide mounted again, every text measured and rasterised again,
 * every picture decoded again — 100–500 ms of main-thread time (224–404
 * objects) after each edit, which landed when the user paused or carried on.
 * For the slide being edited all of it is already on the editor's canvas, text
 * rasters and picture textures included: this draws that scene once more, into
 * a texture the size of the thumbnail, and reads it back (~1 ms).
 *
 * Only a settled scene is trusted: the objects of the slide are all there (and
 * nothing else), no load is in flight, no text raster is pending. Otherwise
 * `null`, and the caller renders the slide the slow way.
 */

import { perfCount } from '@narrative/shared'
import { SLIDE_WIDTH } from './constants.js'
import { captureSlideCanvas } from './captureSlide.js'
import { getDefaultRenderScheduler } from './RenderScheduler.js'
import { settleScene } from './settleScene.js'
import type { SceneGraph } from './SceneGraph.js'

/** How long to wait for the scene to finish loading before giving up on it. */
const SETTLE_TIMEOUT_MS = 1500

/**
 * The thumbnail of the slide on the editor's canvas as a PNG data URL, `width`
 * pixels wide; `null` when the canvas does not show exactly `expectedIds` (a
 * slide switch in progress, a load that does not end).
 */
export async function captureLiveThumbnail(
  scene: SceneGraph,
  expectedIds: readonly string[],
  width: number,
): Promise<string | null> {
  const settled = await settleScene(scene, {
    expectedIds: () => expectedIds,
    renderNow: () => getDefaultRenderScheduler()?.renderNow(),
    timeoutMs: SETTLE_TIMEOUT_MS,
  })
  if (!settled.settled) {
    perfCount('thumb.live.unsettled')
    return null
  }

  // The canvas may still hold the previous slide's extra objects (settle only
  // asks for the expected ones to be present).
  const mounted = scene.getMountedIds()
  if (mounted.length !== expectedIds.length) return null
  const have = new Set(mounted)
  if (!expectedIds.every((id) => have.has(id))) return null

  perfCount('thumb.live')
  const canvas = scene.withTextUnfaded(() => captureSlideCanvas(scene, width / SLIDE_WIDTH))
  return 'toDataURL' in canvas ? canvas.toDataURL('image/png') : null
}
