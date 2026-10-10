/**
 * pages/renderSlide.ts — which slide the render page shows (pages/DeckRender.tsx).
 */

import type { Slide } from '@narrative/shared'

/** `?slide=` as a slide id, or as a 0-based index when it is all digits; the first slide without it. */
export function resolveRenderSlide(
  slides: readonly Slide[],
  param: string | null,
): { slide: Slide; index: number } | null {
  if (slides.length === 0) return null
  if (param === null || param === '') return { slide: slides[0]!, index: 0 }
  const byId = slides.findIndex((s) => s.id === param)
  if (byId >= 0) return { slide: slides[byId]!, index: byId }
  if (/^\d+$/.test(param)) {
    const index = Number(param)
    return index < slides.length ? { slide: slides[index]!, index } : null
  }
  return null
}
