/**
 * state/useSlideObjects.ts
 *
 * The active slide's objects (via ActiveSlideContext), read from the deck's
 * shared store (state/useDeckStore.ts, performance.md → E1). Re-renders when
 * any object on the active slide changes; an object that did not change keeps
 * its identity. A component that shows one object should use
 * `useActiveSlideObject(id)` instead, which re-renders only for that object.
 *
 * Returns:
 * - objects: SlideObject[] — current snapshot (empty when there is no active slide)
 * - objectsCtx: ObjectsMutationContext | null — the active slide's objects Y.Array
 */

import { getSlideObjectsCtx } from '@narrative/slide-model'
import type { ObjectsMutationContext } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'
import { useCallback } from 'react'
import {
  useActiveSlideObject,
  useActiveSlideObjects,
  useDeckSelector,
  useDeckStore,
} from './useDeckStore.js'

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
  const objects = useActiveSlideObjects()

  // Do NOT memoize: a remote moveSlide / sync swap can replace the
  // slide's Y.Map (and therefore its `objects` Y.Array) without
  // changing the id or position, so any cached reference would point
  // at a Y.Array no longer in the doc tree. Fresh lookup per render
  // is cheap (O(slides) scan, no mutation).
  const objectsCtx = activeSlideId !== null ? getSlideObjectsCtx(deckCtx, activeSlideId) : null

  return { objects, objectsCtx, mutationCtx: objectsCtx }
}

/**
 * The active slide's objects Y.Array for a writer that needs it, without
 * subscribing to the objects (looked up fresh on every render: a slide's
 * Y.Map can be replaced under the same id).
 */
export function useActiveObjectsCtx(): ObjectsMutationContext | null {
  const { deckCtx } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()
  return activeSlideId !== null ? getSlideObjectsCtx(deckCtx, activeSlideId) : null
}

/** One object of the active slide by id: re-renders only when that object changes. */
export function useSlideObject(objectId: string | null): SlideObject | undefined {
  return useActiveSlideObject(objectId)
}

/**
 * A value derived from the active slide's objects (z-order): re-renders only
 * when the derived value changes (`isEqual`, identity by default) — a panel
 * that lists names does not re-render while an object is dragged.
 */
export function useSlideObjectsSelector<T>(
  select: (objects: SlideObject[]) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const { activeSlideId } = useActiveSlide()
  return useDeckSelector(
    (store) =>
      select(
        activeSlideId === null
          ? NO_OBJECTS
          : (store.getSlide(activeSlideId)?.objects ?? NO_OBJECTS),
      ),
    isEqual,
  )
}

/** The active slide's objects as the document has them now — for handlers, no subscription. */
export function useSlideObjectsNow(): () => SlideObject[] {
  const store = useDeckStore()
  const { activeSlideId } = useActiveSlide()
  return useCallback(
    () =>
      activeSlideId === null ? NO_OBJECTS : (store.getSlide(activeSlideId)?.objects ?? NO_OBJECTS),
    [store, activeSlideId],
  )
}

const NO_OBJECTS: SlideObject[] = []
