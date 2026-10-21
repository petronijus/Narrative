/**
 * renderer/imageVariant.ts — which size variant an image object is drawn
 * from (docs/plans/performance.md → L3; the variants: @narrative/shared
 * imageVariants.ts).
 *
 * A picture is drawn from the smallest variant that still has a texel for
 * every pixel of the canvas's backing store it covers: its drawn size (the
 * sprite `applyFit` lays out — under `cover` larger than the frame, cropped by
 * the frame mask) times the canvas's density. The density is the renderer's
 * resolution, device pixels per slide unit of the backing store: in the
 * editor devicePixelRatio × max(1, zoom), capped by the canvas's 25-Mpx
 * pixel budget (Canvas.tsx; the browser then scales the backing store to the
 * screen — a capped backing store has fewer pixels than the screen, and the
 * picture is drawn for the backing store it lands in), in present mode
 * devicePixelRatio (the slide is drawn at 1920 × 1080 slide units and scaled
 * to the screen by CSS), on the render page 1. Measuring against the backing
 * store rather than the screen is the strict reading of "nothing looks
 * softer": the GPU never enlarges the smaller variant, so what reaches the
 * screen is what the larger one gave.
 *
 * `variant` on the object pins `thumb` or `original`; `display` (what new
 * objects are created with) and no value leave the choice to the canvas.
 *
 * At rest. A build that scales a picture up on its way in (`zoomIn` from 2×,
 * `popIn`'s and any back / elastic easing's overshoot) and a Magic Move
 * (a matched picture morphs from the outgoing slide's size) draw it larger
 * than its rest size for a while: such pictures get `display`, the variant
 * they had before there was a choice (`scaledUpObjectIds`, `morphingSlides`).
 */

import type { AnimationStep, ImageObject, Slide } from '@narrative/shared'
import { screenImageVariant, type ImageVariant } from '@narrative/shared'

/** The source's pixel size as far as it is known (the asset row's, or the loaded texture's aspect). */
export interface SourceSize {
  width: number | null
  height: number | null
}

/** The picture's drawn long side in slide units: the sprite applyFit lays out inside the imageRect. */
export function drawnLongSide(
  data: ImageObject,
  source: { width: number; height: number },
): number {
  const box = data.imageRect ?? { width: data.width, height: data.height }
  const sx = box.width / source.width
  const sy = box.height / source.height
  const scale = (data.fit ?? 'cover') === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)
  return Math.max(source.width, source.height) * Math.abs(scale)
}

/** The variant `data` pins, or null when the canvas chooses. */
export function pinnedVariant(data: Pick<ImageObject, 'variant'>): ImageVariant | null {
  return data.variant === 'thumb' || data.variant === 'original' ? data.variant : null
}

/**
 * The variant `data` is drawn from on a canvas of `density` (null: not known
 * — the render context did not say, so `display` as before there was a choice).
 */
export function imageObjectVariant(
  data: ImageObject,
  source: SourceSize | null,
  density: number | null,
): ImageVariant {
  const pinned = pinnedVariant(data)
  if (pinned !== null) return pinned
  if (density === null || !(density > 0)) return 'display'
  const w = source?.width ?? null
  const h = source?.height ?? null
  if (w === null || h === null || !(w > 0) || !(h > 0)) return 'display'
  return screenImageVariant({
    drawnLongSide: drawnLongSide(data, { width: w, height: h }),
    density,
    sourceLongSide: Math.max(w, h),
  })
}

/** Easings that overshoot their end value (GSAP): a scale-in under them passes 1. */
const OVERSHOOT = /back|elastic/i

/** Whether `step` draws its object larger than at rest at some point. */
export function scalesUp(step: Pick<AnimationStep, 'preset' | 'easing'>): boolean {
  switch (step.preset) {
    case 'zoomIn': // from `fromScale` (default 2) down to 1
    case 'popIn': // back.out(1.7) by default
      return true
    case 'scaleIn':
    case 'bounceIn':
      return OVERSHOOT.test(step.easing ?? '')
    default:
      return false
  }
}

/** The objects of `slide` a build scales up past their rest size. */
export function scaledUpObjectIds(slide: Pick<Slide, 'animations'>): Set<string> {
  const ids = new Set<string>()
  for (const step of slide.animations ?? []) if (scalesUp(step)) ids.add(step.objectId)
  return ids
}

/**
 * Indices of the slides whose pictures a Magic Move may draw larger than at
 * rest: a slide entered with one (its matched objects start at the outgoing
 * slide's size), and the slide before it (stepping back plays it reversed).
 */
export function morphingSlides(slides: ReadonlyArray<Pick<Slide, 'transition'>>): Set<number> {
  const out = new Set<number>()
  slides.forEach((s, i) => {
    if (s.transition?.kind !== 'magic') return
    out.add(i)
    if (i > 0) out.add(i - 1)
  })
  return out
}
