/**
 * state/useSlideThumbnails.ts
 *
 * React hook that produces a Map<slideId, dataUrl> of PNG thumbnails for a
 * set of slide IDs.
 *
 * Behaviour:
 * - Creates one ThumbnailRenderer on mount; destroys it on unmount.
 * - Subscribes to deck-level object changes via a SINGLE subscribeToDeckSlideEvents()
 *   observer on ctx.slides. This avoids the stale-reference bug where per-slide
 *   observers captured a Y.Array that got orphaned after a slide rebuild (e.g.
 *   Hocuspocus initial sync, moveSlide delete+recreate).
 * - Re-renders are debounced 500 ms so rapid edits do not thrash the GPU.
 * - Concurrent renderSlide() calls are automatically serialised by ThumbnailRenderer.
 * - When slideIds grows, new per-slide debouncers are added without re-creating existing ones.
 * - When slideIds shrinks, removed debouncers are cleaned up and their entries
 *   are removed from the returned Map.
 * - Slide deletion (slideId disappears from slideIds): entry removed from Map.
 *
 * Usage:
 *   const thumbnails = useSlideThumbnails(slideIds)
 *   // thumbnails.get(slideId) === 'data:image/png;base64,...' | undefined
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { subscribeToDeckSlideEvents } from '@narrative/slide-model'
import { yMapToPlainObject } from '@narrative/slide-model'
import { createThumbnailRenderer } from '../renderer/thumbnails.js'
import type { ThumbnailRenderer } from '../renderer/thumbnails.js'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { SlideObject, SlideBackground } from '@narrative/shared'
import { computeSlideNumber } from '@narrative/shared'
import { useDeckCtx } from './useDeckCtx.js'
import { useSlides } from './useSlides.js'
import type * as Y from 'yjs'

// ---------------------------------------------------------------------------
// Cheap structural compare for SlideBackground.
// Replaces JSON.stringify(prev) === JSON.stringify(next) which ran in the
// background-watch effect on every awareness/edit tick (60 slides × 2
// stringifies × ~30 Hz). Discriminated by kind so we only compare fields
// that exist for that variant.
// ---------------------------------------------------------------------------

function backgroundsEqual(a: SlideBackground, b: SlideBackground): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'color':
      return a.color === (b as typeof a).color && (a.alpha ?? 1) === ((b as typeof a).alpha ?? 1)
    case 'image': {
      const bb = b as typeof a
      return a.assetId === bb.assetId && a.fit === bb.fit && (a.dim ?? 0) === (bb.dim ?? 0)
    }
    case 'linearGradient': {
      const bb = b as typeof a
      return a.angleDeg === bb.angleDeg && stopsEqual(a.stops, bb.stops)
    }
    case 'radialGradient': {
      const bb = b as typeof a
      return (
        a.centerX === bb.centerX &&
        a.centerY === bb.centerY &&
        a.radius === bb.radius &&
        stopsEqual(a.stops, bb.stops)
      )
    }
  }
}

function stopsEqual(
  a: ReadonlyArray<{ offset: number; color: number; alpha?: number }>,
  b: ReadonlyArray<{ offset: number; color: number; alpha?: number }>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    if (ai.offset !== bi.offset || ai.color !== bi.color || (ai.alpha ?? 1) !== (bi.alpha ?? 1)) {
      return false
    }
  }
  return true
}

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
// Helper — read objects for a slide id from ctx by fresh traversal
// ---------------------------------------------------------------------------

function readSlideObjects(ctx: SlideMutationContext, slideId: string): SlideObject[] {
  for (let i = 0; i < ctx.slides.length; i++) {
    const slideMap = ctx.slides.get(i)
    if (slideMap.get('id') === slideId) {
      const objectsArr = slideMap.get('objects') as Y.Array<Y.Map<unknown>> | undefined
      if (objectsArr === undefined) return []
      const result: SlideObject[] = []
      for (let j = 0; j < objectsArr.length; j++) {
        try {
          result.push(yMapToPlainObject(objectsArr.get(j)))
        } catch {
          // skip malformed
        }
      }
      return result
    }
  }
  return []
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
  const allSlides = useSlides()
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map())

  // Stable ref to the renderer instance (async init, may be null briefly).
  const rendererRef = useRef<ThumbnailRenderer | null>(null)

  // Track latest objects per slide so debounced callback always uses fresh state.
  const latestObjectsRef = useRef<Map<string, SlideObject[]>>(new Map())

  // P3: track latest background per slide so thumbnails paint the same
  // artboard fill the editor shows. We re-render the thumbnail when the
  // background changes.
  const latestBackgroundRef = useRef<Map<string, SlideBackground | undefined>>(new Map())

  // Always-fresh snapshot of the deck slides for slide-number computation.
  // The render scheduler reads this through a ref so a useCallback with
  // empty deps doesn't capture a stale list across reorders.
  const slidesRef = useRef(allSlides)
  slidesRef.current = allSlides

  // Per-slide debounce cancellers — cancelled on cleanup or slide removal.
  const debouncersRef = useRef<
    Map<string, { debounced: (id: string) => void; cancel: () => void }>
  >(new Map())

  // Single deck-level unsubscribe (replaces per-slide unsubscribesRef).
  const deckUnsubRef = useRef<(() => void) | null>(null)

  // ---------------------------------------------------------------------------
  // Render helper — schedules a thumbnail update for one slide
  // ---------------------------------------------------------------------------

  /** Per-slide render-in-flight tracker. The renderer's internal queue
   *  serialises ALL renders globally — without coalescing, rapid edits
   *  on slide A queue several renders for A behind unrelated slide B
   *  renders, so the latest A thumbnail can take seconds to appear. We
   *  keep at most ONE in-flight render + ONE pending re-render per
   *  slide. */
  const inFlightRef = useRef<Set<string>>(new Set())
  const pendingDirtyRef = useRef<Set<string>>(new Set())

  const scheduleRender = useCallback((slideId: string): void => {
    const renderer = rendererRef.current
    if (renderer === null) {
      return
    }

    if (inFlightRef.current.has(slideId)) {
      pendingDirtyRef.current.add(slideId)
      return
    }

    const objects = latestObjectsRef.current.get(slideId) ?? []
    const background = latestBackgroundRef.current.get(slideId)
    const slideNumber = computeSlideNumber(slidesRef.current, slideId)
    inFlightRef.current.add(slideId)

    renderer
      .renderSlide(objects, background, slideNumber)
      .then((dataUrl) => {
        setThumbnails((prev) => {
          const next = new Map(prev)
          next.set(slideId, dataUrl)
          return next
        })
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('renderer has been destroyed')) {
          return
        }
        console.error('[useSlideThumbnails] renderSlide failed:', err)
      })
      .finally(() => {
        inFlightRef.current.delete(slideId)
        const wasDirty = pendingDirtyRef.current.delete(slideId)
        if (wasDirty) {
          scheduleRender(slideId)
        }
      })
  }, [])

  // ---------------------------------------------------------------------------
  // Ensure per-slide debouncer exists (idempotent)
  // ---------------------------------------------------------------------------

  const ensureDebouncer = useCallback(
    (slideId: string): void => {
      if (debouncersRef.current.has(slideId)) return
      const { debounced, cancel } = debounce((id: string) => {
        scheduleRender(id)
      }, DEBOUNCE_MS)
      debouncersRef.current.set(slideId, { debounced, cancel })
    },
    [scheduleRender],
  )

  const removeDebouncer = useCallback((slideId: string): void => {
    const db = debouncersRef.current.get(slideId)
    db?.cancel()
    debouncersRef.current.delete(slideId)
    latestObjectsRef.current.delete(slideId)
    latestBackgroundRef.current.delete(slideId)
  }, [])

  // ---------------------------------------------------------------------------
  // Deck-level subscription — mounted once, never torn down until unmount.
  // When a deck event fires, we fresh-traverse ctx.slides for each affected id.
  // ---------------------------------------------------------------------------

  // Keep a stable ref to the current tracked slide ids so the deck callback
  // (which is created once) can always read the latest set.
  const trackedSlideIdsRef = useRef<Set<string>>(new Set())

  // Keep a stable ref to deckCtx (changes are rare but possible).
  const deckCtxRef = useRef<SlideMutationContext>(deckCtx)
  useEffect(() => {
    deckCtxRef.current = deckCtx
  }, [deckCtx])

  // Mount the deck-level subscription once. We capture everything via refs.
  useEffect(() => {
    const ctx = deckCtxRef.current

    const unsub = subscribeToDeckSlideEvents(ctx, (affectedIds: Set<string>) => {
      const tracked = trackedSlideIdsRef.current
      for (const slideId of affectedIds) {
        if (!tracked.has(slideId)) continue

        // Fresh traversal — avoids stale Y.Array reference
        const objects = readSlideObjects(deckCtxRef.current, slideId)
        latestObjectsRef.current.set(slideId, objects)

        ensureDebouncer(slideId)
        const db = debouncersRef.current.get(slideId)
        db?.debounced(slideId)
      }
    })

    deckUnsubRef.current = unsub

    return () => {
      unsub()
      deckUnsubRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once on mount
  }, [])

  // ---------------------------------------------------------------------------
  // Lifecycle — create renderer on mount, destroy on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    // P12d: the thumbnail Pixi instance contends with the main editor
    // canvas for the GPU driver during cold start — when both initialise
    // in parallel, first-paint latency suffers. Defer this Application
    // by one frame so the editor's first paint runs first. The vitest
    // suite uses fake timers + microtask awaits and would otherwise hang
    // waiting for the deferred init, so we skip the defer in test mode.
    const isTest = import.meta.env.MODE === 'test'
    let startTimer = 0
    const start = (): void => {
      if (cancelled) return
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
    }
    if (isTest) {
      start()
    } else {
      startTimer = window.setTimeout(start, 0)
    }

    return () => {
      cancelled = true
      if (startTimer !== 0) window.clearTimeout(startTimer)
      rendererRef.current?.destroy()
      rendererRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once on mount
  }, [])

  // ---------------------------------------------------------------------------
  // Lifecycle — track which slide ids are active; seed initial objects.
  //
  // We do NOT re-create the Yjs subscription here (that's deck-level, above).
  // Instead we just maintain debouncers + latestObjectsRef for the current
  // slideIds set, and seed initial object reads for newly appeared slides.
  // ---------------------------------------------------------------------------

  const lastSlideIdsRef = useRef<string[]>([])

  useEffect(() => {
    const prev = lastSlideIdsRef.current
    const sameOrder = prev.length === slideIds.length && prev.every((id, i) => id === slideIds[i])

    if (sameOrder) return

    const incomingSet = new Set(slideIds)
    const prevSet = new Set(prev)

    const disappeared: string[] = []
    for (const id of prev) {
      if (!incomingSet.has(id)) disappeared.push(id)
    }
    const appeared: string[] = []
    for (const id of slideIds) {
      if (!prevSet.has(id)) appeared.push(id)
    }

    // Update the tracked set ref (used by deck callback).
    trackedSlideIdsRef.current = incomingSet

    // Clean up debouncers for slides that disappeared.
    for (const id of disappeared) {
      removeDebouncer(id)
    }

    // Seed newly appeared slides with a fresh object read + initial render.
    for (const id of appeared) {
      ensureDebouncer(id)
      const objects = readSlideObjects(deckCtx, id)
      latestObjectsRef.current.set(id, objects)
      // Schedule initial render immediately (not debounced) so thumbnails
      // appear as soon as the renderer is ready.
      scheduleRender(id)
    }

    // Prune thumbnails of slides that no longer exist.
    setThumbnails((prev) => {
      let changed = false
      const next = new Map<string, string>()
      for (const [id, url] of prev) {
        if (incomingSet.has(id)) {
          next.set(id, url)
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })

    lastSlideIdsRef.current = slideIds.slice()
  }, [slideIds, deckCtx, ensureDebouncer, removeDebouncer, scheduleRender])

  // ---------------------------------------------------------------------------
  // P3: watch slide backgrounds — re-render thumbnails when they change.
  // Reads from the `useSlides()` snapshot, which already re-runs whenever
  // any slide-level change lands (background, transition, name, …).
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const tracked = new Set(slideIds)
    for (const slide of allSlides) {
      if (!tracked.has(slide.id)) continue
      const prev = latestBackgroundRef.current.get(slide.id)
      const next = slide.background
      if (prev === next) continue
      // Cheap structural compare avoids the JSON.stringify-twice hot path.
      // Backgrounds are small discriminated unions (≤ ~7 scalar fields plus
      // an optional `stops` array on gradients) so a kind-aware field check
      // is dramatically cheaper than two stringifies, especially when the
      // hook re-runs at awareness rate (~30 Hz) on a 60-slide deck.
      if (prev !== undefined && next !== undefined && backgroundsEqual(prev, next)) {
        continue
      }
      latestBackgroundRef.current.set(slide.id, next)
      scheduleRender(slide.id)
    }
  }, [allSlides, slideIds, scheduleRender])

  // Re-render every tracked thumbnail when the deck order or skipped
  // flags change, since `computeSlideNumber` reads from that list and
  // any slide may host a `isSlideNumber` text leaf whose displayed
  // number just shifted.
  // Hoist the order/skipped fingerprint so it isn't recomputed inside the
  // dep array on every render — the previous shape did a full deck traversal
  // (60 slides ≈ 60 string concats) per parent render even when nothing
  // structural changed.
  const orderFingerprint = useMemo(
    () => allSlides.map((s) => `${s.id}:${s.skipped === true ? 'x' : '_'}`).join('|'),
    [allSlides],
  )
  useEffect(() => {
    for (const id of slideIds) scheduleRender(id)
    // Depend on a stable fingerprint string so unrelated slide-prop
    // edits (background, name) don't double-trigger here — the
    // background-watch effect above already covers those.
  }, [orderFingerprint, slideIds, scheduleRender])

  // ---------------------------------------------------------------------------
  // Cleanup all per-slide state on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      for (const slideId of [...debouncersRef.current.keys()]) {
        removeDebouncer(slideId)
      }
      trackedSlideIdsRef.current = new Set()
      // React 18 StrictMode persists refs across the mount→unmount→remount cycle.
      // Reset lastSlideIdsRef so remount re-seeds all slides.
      lastSlideIdsRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only on unmount
  }, [])

  return thumbnails
}
