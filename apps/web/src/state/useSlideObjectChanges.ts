/**
 * state/useSlideObjectChanges.ts
 *
 * Hook for consuming incremental object changes from Y.Doc.
 * Intended for the renderer (surgical updates) — not for UI components.
 *
 * For UI components wanting a plain objects snapshot, use useSlideObjects().
 * For the renderer (surgical apply), use this hook with ObjectChangeSet callback.
 *
 * M9 update: scoped to active slide via ActiveSlideContext.
 * Re-subscribes when activeSlideId changes.
 */

import { useEffect, useRef } from 'react'
import { subscribeToSlideObjects } from '@narrative/slide-model'
import type { ObjectChangeSet } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'
import { useSlideIdsKey } from './useDeckStore.js'

/**
 * Which slide a change set belongs to, and what it is:
 *   - `initial`: the slide's objects as they are now, emitted once when the
 *     slide becomes active (all of them `added`);
 *   - `change`: an edit of the active slide's objects since;
 *   - `leave`: every object of the slide that stopped being active, removed
 *     (emitted before the next slide's `initial`).
 * A consumer that swaps whole slide scenes itself (present mode,
 * renderer/presentSlides.ts) uses it to tell a removal of a slide it no
 * longer holds, and a first emission of a slide it holds already, from the
 * changes it must apply.
 */
export interface SlideObjectChangeInfo {
  slideId: string
  kind: 'initial' | 'change' | 'leave'
}

/**
 * Subscribe to incremental changes with per-frame batching.
 *
 * Callback is stored in a ref — does not cause re-subscribe on every re-render.
 * Re-subscribes only when deckCtx or activeSlideId changes.
 *
 * Initial call: callback is called synchronously in useEffect setup
 * with initial state { added: <all existing>, removed: [], updated: [], snapshot: [...] }.
 *
 * If there is no active slide, callback is never called.
 *
 * @param callback Function called on each batched change set
 */
export function useSlideObjectChanges(
  callback: (changes: ObjectChangeSet, info: SlideObjectChangeInfo) => void,
): void {
  const { deckCtx } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()

  // Callback in ref — avoid re-subscribe on every re-render
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  // Track the last snapshot of objects shown to the consumer so that when the
  // active slide changes we can emit a synthetic "remove all previous" change
  // set before subscribing to the new slide. Without this the SceneGraph would
  // retain objects from the previous slide and stack new ones on top.
  const lastSnapshotRef = useRef<SlideObject[]>([])
  /** The slide `lastSnapshotRef` belongs to. */
  const lastSlideRef = useRef<string | null>(null)

  // Slide order fingerprint — moveSlide() recreates the slide Y.Map (Yjs has no
  // in-place reorder) which orphans the observer attached to the old objects
  // Y.Array. When the ordered slide list changes we MUST re-subscribe to the
  // fresh Y.Map for activeSlideId. Transition/object edits don't change this
  // fingerprint so we don't re-subscribe on every edit — and, being a string
  // selected from the deck store, an edit does not even re-render the caller.
  const slideOrderKey = useSlideIdsKey()

  useEffect(() => {
    if (activeSlideId === null) return

    // If switching slides (or remounting after reorder), first tell the consumer
    // to remove everything from the previously shown slide. The next subscribe()
    // will emit the new slide's objects via the initial synchronous emission.
    if (lastSnapshotRef.current.length > 0) {
      const prevIds = lastSnapshotRef.current.map((o) => o.id)
      callbackRef.current(
        { added: [], removed: prevIds, updated: [], snapshot: [] },
        { slideId: lastSlideRef.current ?? activeSlideId, kind: 'leave' },
      )
      lastSnapshotRef.current = []
    }

    // The first emission is the slide's objects as they are (synchronous
    // inside subscribe, or once the slide arrives: subscribeToSlideObjects).
    let first = true
    lastSlideRef.current = activeSlideId
    const unsubscribe = subscribeToSlideObjects(deckCtx, activeSlideId, (changes) => {
      lastSnapshotRef.current = changes.snapshot
      const kind = first ? 'initial' : 'change'
      first = false
      callbackRef.current(changes, { slideId: activeSlideId, kind })
    })
    return unsubscribe
  }, [deckCtx, activeSlideId, slideOrderKey])
}
