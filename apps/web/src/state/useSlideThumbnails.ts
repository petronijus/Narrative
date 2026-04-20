/**
 * state/useSlideThumbnails.ts
 *
 * React hook that produces a Map<slideId, dataUrl> of PNG thumbnails for a
 * set of slide IDs.
 *
 * Behaviour:
 * - Creates one ThumbnailRenderer on mount; destroys it on unmount.
 * - Subscribes to each slide's object changes via subscribeToSlideObjects().
 * - Re-renders are debounced 500 ms so rapid edits do not thrash the GPU.
 * - Concurrent renderSlide() calls are automatically serialised by ThumbnailRenderer.
 * - When slideIds grows, new subscriptions are added without re-creating existing ones.
 * - When slideIds shrinks, removed subscriptions are cleaned up and their entries
 *   are removed from the returned Map.
 * - Slide deletion (slideId disappears from slideIds): entry removed from Map.
 *
 * Usage:
 *   const thumbnails = useSlideThumbnails(slideIds)
 *   // thumbnails.get(slideId) === 'data:image/png;base64,...' | undefined
 *
 * Limitation:
 * - createThumbnailRenderer() is async. Thumbnails start generating after the
 *   renderer is ready (usually < 1 rAF after mount). Until then the Map is empty.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { subscribeToSlideObjects } from '@narrative/slide-model'
import { createThumbnailRenderer } from '../renderer/thumbnails.js'
import type { ThumbnailRenderer } from '../renderer/thumbnails.js'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { useDeckCtx } from './useDeckCtx.js'

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

/**
 * Returns a debounced version of fn that delays invocation by delayMs.
 * Each call resets the timer. The returned cancel() clears any pending call.
 */
function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  delayMs: number,
): { debounced: (...args: T) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null

  const debounced = (...args: T): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, delayMs)
  }

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return { debounced, cancel }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Debounce interval in ms — applied per slide independently. */
const DEBOUNCE_MS = 500

/**
 * For a set of slide IDs, returns a Map<slideId, dataUrl> of current thumbnails.
 * Re-renders the thumbnail for a slide when that slide's objects change (debounced 500 ms).
 *
 * @param slideIds Ordered list of slide IDs to track.
 * @returns Map<string, string> — entries for slides that have been rendered at least once.
 */
export function useSlideThumbnails(slideIds: string[]): Map<string, string> {
  const deckCtx = useDeckCtx()
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map())

  // Stable ref to the renderer instance (async init, may be null briefly).
  const rendererRef = useRef<ThumbnailRenderer | null>(null)

  // Track latest objects per slide so debounced callback always uses fresh state.
  const latestObjectsRef = useRef<Map<string, SlideObject[]>>(new Map())

  // Per-slide debounce cancellers — cancelled on cleanup or slide removal.
  const debouncersRef = useRef<
    Map<string, { debounced: (id: string) => void; cancel: () => void }>
  >(new Map())

  // Per-slide Yjs unsubscribe functions.
  const unsubscribesRef = useRef<Map<string, () => void>>(new Map())

  // ---------------------------------------------------------------------------
  // Render helper — schedules a thumbnail update for one slide
  // ---------------------------------------------------------------------------

  const scheduleRender = useCallback((slideId: string): void => {
    const renderer = rendererRef.current
    if (renderer === null) return

    const objects = latestObjectsRef.current.get(slideId) ?? []

    renderer
      .renderSlide(objects)
      .then((dataUrl) => {
        setThumbnails((prev) => {
          const next = new Map(prev)
          next.set(slideId, dataUrl)
          return next
        })
      })
      .catch((err: unknown) => {
        // Renderer destroyed between schedule and resolve — ignore.
        if (err instanceof Error && err.message.includes('renderer has been destroyed')) {
          return
        }
        console.error('[useSlideThumbnails] renderSlide failed:', err)
      })
  }, [])

  // ---------------------------------------------------------------------------
  // Subscribe / unsubscribe helpers
  // ---------------------------------------------------------------------------

  const subscribeSlide = useCallback(
    (slideId: string, ctx: SlideMutationContext): void => {
      if (unsubscribesRef.current.has(slideId)) return // already subscribed

      // Create a debouncer for this slide.
      const { debounced, cancel } = debounce((id: string) => {
        scheduleRender(id)
      }, DEBOUNCE_MS)

      debouncersRef.current.set(slideId, { debounced, cancel })

      const unsubscribe = subscribeToSlideObjects(ctx, slideId, (changes) => {
        // Always track latest objects snapshot.
        latestObjectsRef.current.set(slideId, changes.snapshot)
        // Debounce the actual GPU render.
        debounced(slideId)
      })

      unsubscribesRef.current.set(slideId, unsubscribe)
    },
    [scheduleRender],
  )

  const unsubscribeSlide = useCallback((slideId: string): void => {
    const unsub = unsubscribesRef.current.get(slideId)
    unsub?.()
    unsubscribesRef.current.delete(slideId)

    const db = debouncersRef.current.get(slideId)
    db?.cancel()
    debouncersRef.current.delete(slideId)

    latestObjectsRef.current.delete(slideId)
  }, [])

  // ---------------------------------------------------------------------------
  // Lifecycle — create renderer on mount, destroy on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    createThumbnailRenderer({ width: 200, resolution: 1 })
      .then((renderer) => {
        if (cancelled) {
          renderer.destroy()
          return
        }
        rendererRef.current = renderer

        // Trigger initial renders for all currently tracked slides.
        for (const slideId of latestObjectsRef.current.keys()) {
          scheduleRender(slideId)
        }
      })
      .catch((err: unknown) => {
        console.error('[useSlideThumbnails] createThumbnailRenderer failed:', err)
      })

    return () => {
      cancelled = true
      rendererRef.current?.destroy()
      rendererRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once on mount
  }, [])

  // ---------------------------------------------------------------------------
  // Lifecycle — subscribe/unsubscribe when slideIds list changes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const incoming = new Set(slideIds)
    const current = new Set(unsubscribesRef.current.keys())

    // Subscribe to new slides.
    for (const slideId of incoming) {
      if (!current.has(slideId)) {
        subscribeSlide(slideId, deckCtx)
      }
    }

    // Unsubscribe from removed slides and remove their thumbnails.
    for (const slideId of current) {
      if (!incoming.has(slideId)) {
        unsubscribeSlide(slideId)
        setThumbnails((prev) => {
          if (!prev.has(slideId)) return prev
          const next = new Map(prev)
          next.delete(slideId)
          return next
        })
      }
    }
  }, [slideIds, deckCtx, subscribeSlide, unsubscribeSlide])

  // ---------------------------------------------------------------------------
  // Cleanup all subscriptions on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      for (const slideId of [...unsubscribesRef.current.keys()]) {
        unsubscribeSlide(slideId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only on unmount
  }, [])

  return thumbnails
}
