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

  // P14: do NOT memoize this. The objectsCtx wraps a Y.Array reference
  // that can be SILENTLY swapped when a remote moveSlide / sync replaces
  // a slide's Y.Map without changing its id or position. memoising on
  // [deckCtx, activeSlideId, slideOrderKey] would keep the stale Y.Array
  // reference alive — the drag handler then writes to a Y.Array no
  // longer in the doc tree, peers never receive the update, and the
  // local UI shows up-to-date data because useSlideObjectChanges
  // re-subscribes on slideOrderKey but useSlideObjects does not. Fresh
  // lookup per render is cheap (O(slides) array scan, no Y.Doc
  // mutation) and bulletproof.
  const objectsCtx = activeSlideId !== null ? getSlideObjectsCtx(deckCtx, activeSlideId) : null

  return { objects, objectsCtx, mutationCtx: objectsCtx }
}
