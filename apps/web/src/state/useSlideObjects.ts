/**
 * state/useSlideObjects.ts
 *
 * Hook for subscribing to the active slide's objects from Y.Doc.
 * Re-renders when any object on the active slide changes.
 *
 * M9 update: scoped to active slide via ActiveSlideContext.
 * If no active slide, returns empty array and null objectsCtx.
 *
 * Returns:
 * - objects: SlideObject[] — current snapshot
 * - objectsCtx: ObjectsMutationContext | null — for calling object mutations
 */

import { useState, useEffect, useMemo } from 'react'
import { subscribeToSlideObjects, getSlideObjectsCtx } from '@narrative/slide-model'
import type { ObjectsMutationContext } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'
import { useSlides } from './useSlides.js'

export interface UseSlideObjectsResult {
  objects: SlideObject[]
  /** ObjectsMutationContext scoped to the active slide. Null if no active slide. */
  objectsCtx: ObjectsMutationContext | null
  /**
   * @deprecated Use objectsCtx. Kept for backward compat with consumers expecting mutationCtx.
   * Removed in M10.
   */
  mutationCtx: ObjectsMutationContext | null
}

export function useSlideObjects(): UseSlideObjectsResult {
  const { deckCtx } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()
  const slides = useSlides()
  const [objects, setObjects] = useState<SlideObject[]>([])

  // P14: re-subscribe whenever the slide list changes structure, not
  // just when activeSlideId changes. moveSlide / cross-client slide
  // additions can replace a slide's underlying Y.Map (and therefore
  // its objects Y.Array), orphaning a subscription that was attached
  // to the old reference. Keying off `slideOrderKey` forces a fresh
  // lookup + observe each time the deck's slide structure mutates.
  const slideOrderKey = useMemo(() => slides.map((s) => s.id).join('|'), [slides])

  useEffect(() => {
    if (activeSlideId === null) {
      setObjects([])
      return
    }
    const unsubscribe = subscribeToSlideObjects(deckCtx, activeSlideId, (changes) => {
      setObjects(changes.snapshot)
    })
    return () => {
      unsubscribe()
    }
  }, [deckCtx, activeSlideId, slideOrderKey])

  // Recompute objectsCtx whenever activeSlideId or the slide order
  // changes — getSlideObjectsCtx looks up the live Y.Array each call,
  // and we need a fresh reference after any structural change so
  // bulkUpdateObjects writes to the current in-doc Y.Array.
  const objectsCtx = useMemo(
    () => (activeSlideId !== null ? getSlideObjectsCtx(deckCtx, activeSlideId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slideOrderKey covers slide structure, deckCtx is stable
    [deckCtx, activeSlideId, slideOrderKey],
  )

  return { objects, objectsCtx, mutationCtx: objectsCtx }
}
