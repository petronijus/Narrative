/**
 * renderer/pixelDensityContext.ts — the device pixels per slide unit of the
 * canvas an object is being mounted on (renderer/imageVariant.ts), and the
 * least variant of a picture the mounting scene wants.
 *
 * Module-level like the slide number (slideNumberContext.ts) and the
 * rendering surface (colourResolver.ts `withRenderingSurface`): object
 * renderers are shared by every scene and mount from data alone, so the
 * scene that mounts — the scene graph, or present mode's slides prepared off
 * stage — says around the call which canvas the object is for. The image
 * renderer keeps the values on its node; a later change of the canvas's
 * density reaches mounted nodes through `SceneGraph.setPixelDensity`.
 *
 * The floor: present mode keeps every slide it prepared on the GPU, so a
 * picture the deck shows full-bleed on one slide and small on another is
 * best drawn from one texture — the larger — on both (presentSlides.ts); and
 * a picture a build scales up past its rest size gets `display`, in present
 * mode and in the editor (imageVariant.ts `scaledUpObjectIds`).
 *
 * Null outside any canvas (a thumbnail mount, a test): pictures are then
 * drawn from `display`, as before the canvas chose.
 */

import type { ImageObject, ImageVariant } from '@narrative/shared'

/**
 * The least variant the mounting scene wants for a picture (undefined: no
 * floor) — read when the picture chooses, so it sees the scene as it is then.
 */
export type VariantFloor = (data: ImageObject) => ImageVariant | undefined

let density: number | null = null
let floor: VariantFloor | null = null

/** Run `fn` with `d` as the mounting canvas's density, and `f` as the scene's floor. */
export function withPixelDensity<T>(
  d: number | null,
  fn: () => T,
  f: VariantFloor | null = null,
): T {
  const previous = { density, floor }
  density = d
  floor = f
  try {
    return fn()
  } finally {
    density = previous.density
    floor = previous.floor
  }
}

/** The density of the canvas mounting now, or null outside one. */
export function mountingPixelDensity(): number | null {
  return density
}

/** The mounting scene's variant floor, or null. */
export function mountingVariantFloor(): VariantFloor | null {
  return floor
}
