/**
 * state/useSlides.ts
 *
 * Hook for subscribing to the full slide list (M9).
 * Returns Slide[] full snapshot — re-renders when slides change.
 *
 * For lightweight metadata only (id + transition), use SlideSummary from subscribeToSlides.
 * This hook provides full Slide[] including objects and animations.
 *
 * Note: For large decks, prefer subscribeToSlides (SlideSummary[]) in the slide panel UI
 * and only subscribe to per-slide objects/animations for the active slide.
 */

import { useState, useEffect } from 'react'
import { listSlides, subscribeToSlides } from '@narrative/slide-model'
import type { Slide } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'

/**
 * Returns the full Slide[] snapshot.
 * Re-renders on any slide structure change (add/remove/reorder/transition update).
 *
 * Does NOT re-render on object/animation changes within slides — those are
 * tracked separately by useSlideObjects and useAnimations for the active slide.
 */
export function useSlides(): Slide[] {
  const { deckCtx } = useSlideDoc()
  const [slides, setSlides] = useState<Slide[]>(() => listSlides(deckCtx))

  useEffect(() => {
    // subscribeToSlides gives lightweight SlideSummary — but we need full Slide[]
    // for this hook. Use subscribeToSlides to detect changes, then call listSlides.
    const unsubscribe = subscribeToSlides(deckCtx, () => {
      setSlides(listSlides(deckCtx))
    })
    return unsubscribe
  }, [deckCtx])

  return slides
}
