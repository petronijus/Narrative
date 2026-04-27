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

import { useState, useEffect } from 'react'
import { subscribeToSlideObjects, getSlideObjectsCtx } from '@narrative/slide-model'
import type { ObjectsMutationContext } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'

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
  const [objects, setObjects] = useState<SlideObject[]>([])

  useEffect(() => {
    if (activeSlideId === null) {
      setObjects([])
      return
    }
    // subscribeToSlideObjects rebinds itself when the slide's Y.Map
    // identity is replaced (P14), so this useEffect only needs to
    // re-run when activeSlideId actually changes.
    const unsubscribe = subscribeToSlideObjects(deckCtx, activeSlideId, (changes) => {
      setObjects(changes.snapshot)
    })
    return () => {
      unsubscribe()
    }
  }, [deckCtx, activeSlideId])

  // Do NOT memoize: a remote moveSlide / sync swap can replace the
  // slide's Y.Map (and therefore its `objects` Y.Array) without
  // changing the id or position, so any cached reference would point
  // at a Y.Array no longer in the doc tree. Fresh lookup per render
  // is cheap (O(slides) scan, no mutation).
  const objectsCtx = activeSlideId !== null ? getSlideObjectsCtx(deckCtx, activeSlideId) : null

  return { objects, objectsCtx, mutationCtx: objectsCtx }
}
