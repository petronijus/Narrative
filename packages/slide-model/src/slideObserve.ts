/**
 * slide-model/src/slideObserve.ts
 *
 * Observer helpers for the multi-slide deck schema (M9).
 *
 * Three APIs:
 * 1. subscribeToSlides — emits full list of slides (id + transition metadata)
 *    whenever the slides array changes (add/remove/reorder/transition update).
 * 2. subscribeToSlideObjects — incremental ObjectChangeSet for one slide.
 *    Same contract as M3 subscribeToObjectChanges, but scoped to a slide.
 * 3. subscribeToSlideAnimations — full AnimationStep[] snapshot for one slide.
 *
 * If slideId doesn't exist when subscribing, the subscribe returns an unsubscribe
 * that is a no-op and the callback is never called. The caller should re-subscribe
 * when activeSlideId changes.
 */

import * as Y from 'yjs'
import type { SlideObject, AnimationStep } from '@narrative/shared'
import type { ObjectChangeSet } from './observe.js'
import { yMapToPlainObject } from './bindings.js'
import { yMapToAnimationStep } from './animationBindings.js'
import type { SlideMutationContext } from './slides.js'

// Re-export ObjectChangeSet for consumers who only import from slideObserve
export type { ObjectChangeSet }

// ---------------------------------------------------------------------------
// Slide metadata snapshot (for subscribeToSlides)
// ---------------------------------------------------------------------------

export interface SlideSummary {
  id: string
  transition: {
    kind: string
    durationMs: number
    direction?: string
  }
}

// ---------------------------------------------------------------------------
// 1. subscribeToSlides
// ---------------------------------------------------------------------------

/**
 * Subscribe to changes in the deck's slide list.
 *
 * Emits a full SlideSummary[] (id + transition) on every change to the slides Y.Array
 * or to any slide's transition Y.Map. Does not track per-slide objects/animations —
 * use subscribeToSlideObjects / subscribeToSlideAnimations for that.
 *
 * Callback is called synchronously on subscribe with current state.
 *
 * @returns unsubscribe function
 */
export function subscribeToSlides(
  ctx: SlideMutationContext,
  callback: (slides: SlideSummary[]) => void,
): () => void {
  const getSnapshot = (): SlideSummary[] => {
    const result: SlideSummary[] = []
    for (let i = 0; i < ctx.slides.length; i++) {
      const slideMap = ctx.slides.get(i)
      const id = slideMap.get('id') as string
      const transitionMap = slideMap.get('transition') as Y.Map<unknown> | undefined
      const direction = transitionMap?.get('direction') as string | undefined
      result.push({
        id,
        transition: {
          kind: (transitionMap?.get('kind') as string) ?? 'none',
          durationMs: (transitionMap?.get('durationMs') as number) ?? 0,
          ...(direction !== undefined ? { direction } : {}),
        },
      })
    }
    return result
  }

  const observer = (): void => {
    callback(getSnapshot())
  }

  // observeDeep catches slide array changes AND nested transition map changes
  ctx.slides.observeDeep(observer)

  // Synchronous initial emission
  callback(getSnapshot())

  return (): void => {
    ctx.slides.unobserveDeep(observer)
  }
}

// ---------------------------------------------------------------------------
// 2. subscribeToSlideObjects
// ---------------------------------------------------------------------------

/**
 * Pending batch state for incremental object diff — identical contract to observe.ts.
 */
interface PendingBatch {
  addedObjects: Map<string, SlideObject>
  removedIds: Set<string>
  updatedPatches: Map<string, Partial<SlideObject>>
}

function createPendingBatch(): PendingBatch {
  return {
    addedObjects: new Map(),
    removedIds: new Set(),
    updatedPatches: new Map(),
  }
}

function isBatchEmpty(batch: PendingBatch): boolean {
  return (
    batch.addedObjects.size === 0 && batch.removedIds.size === 0 && batch.updatedPatches.size === 0
  )
}

/**
 * Subscribe to incremental object changes for one specific slide.
 *
 * Uses rAF batching — same contract as subscribeToObjectChanges from observe.ts,
 * but scoped to a specific slide's objects Y.Array.
 *
 * If slideId doesn't exist: returns a no-op unsubscribe, callback never called.
 * Re-subscribe when activeSlideId changes (React useEffect dependency).
 *
 * @returns unsubscribe function
 */
export function subscribeToSlideObjects(
  ctx: SlideMutationContext,
  slideId: string,
  callback: (changes: ObjectChangeSet) => void,
): () => void {
  const { unsubscribe } = subscribeToSlideObjectsWithFlush(ctx, slideId, callback)
  return unsubscribe
}

/**
 * Variant with explicit flush — for testing and SSR.
 */
export function subscribeToSlideObjectsWithFlush(
  ctx: SlideMutationContext,
  slideId: string,
  callback: (changes: ObjectChangeSet) => void,
): { unsubscribe: () => void; flush: () => void } {
  // Find the slide
  let slideObjectsArr: Y.Array<Y.Map<unknown>> | null = null
  for (let i = 0; i < ctx.slides.length; i++) {
    const m = ctx.slides.get(i)
    if (m.get('id') === slideId) {
      slideObjectsArr = m.get('objects') as Y.Array<Y.Map<unknown>>
      break
    }
  }

  if (slideObjectsArr === null) {
    // Slide not found — no-op subscribe
    return {
      unsubscribe: () => {},
      flush: () => {},
    }
  }

  const objectsArr = slideObjectsArr

  // Internal snapshot
  const currentSnapshot = new Map<string, SlideObject>()
  for (let i = 0; i < objectsArr.length; i++) {
    const obj = yMapToPlainObject(objectsArr.get(i))
    currentSnapshot.set(obj.id, obj)
  }

  let pending: PendingBatch = createPendingBatch()
  let rafHandle = -1
  let dispatching = false
  let unsubscribed = false

  const flush = (): void => {
    if (unsubscribed || isBatchEmpty(pending)) {
      pending = createPendingBatch()
      rafHandle = -1
      return
    }
    if (dispatching) return
    dispatching = true

    const batchToProcess = pending
    pending = createPendingBatch()
    rafHandle = -1

    const netAdded: SlideObject[] = []
    const netRemoved: string[] = []
    const netUpdated: Array<{ id: string; patch: Partial<SlideObject> }> = []

    const netZeroIds = new Set<string>()
    for (const id of batchToProcess.removedIds) {
      if (batchToProcess.addedObjects.has(id)) netZeroIds.add(id)
    }

    for (const id of batchToProcess.removedIds) {
      if (netZeroIds.has(id)) {
        currentSnapshot.delete(id)
        continue
      }
      currentSnapshot.delete(id)
      netRemoved.push(id)
    }

    for (const [id, obj] of batchToProcess.addedObjects) {
      if (netZeroIds.has(id)) continue
      currentSnapshot.set(id, obj)
      netAdded.push(obj)
      batchToProcess.updatedPatches.delete(id)
    }

    for (const [id, patch] of batchToProcess.updatedPatches) {
      if (batchToProcess.removedIds.has(id)) continue
      if (netZeroIds.has(id)) continue
      const existing = currentSnapshot.get(id)
      if (existing !== undefined) {
        const updated = { ...existing, ...patch } as SlideObject
        currentSnapshot.set(id, updated)
        netUpdated.push({ id, patch })
      }
    }

    const snapshot: SlideObject[] = []
    for (let i = 0; i < objectsArr.length; i++) {
      const id = objectsArr.get(i).get('id') as string | undefined
      if (id !== undefined) {
        const obj = currentSnapshot.get(id)
        if (obj !== undefined) snapshot.push(obj)
      }
    }

    if (netAdded.length > 0 || netRemoved.length > 0 || netUpdated.length > 0) {
      callback({
        added: netAdded,
        removed: netRemoved,
        updated: netUpdated,
        snapshot,
      })
    }

    dispatching = false
  }

  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    if (unsubscribed) return

    for (const event of events) {
      if (event.target === objectsArr) {
        processArrayEvent(event as Y.YArrayEvent<Y.Map<unknown>>, pending, currentSnapshot)
      } else if (event.target instanceof Y.Map) {
        processMapEvent(event as Y.YMapEvent<unknown>, pending)
      }
    }

    if (rafHandle === -1 && !isBatchEmpty(pending)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raf = (globalThis as any).requestAnimationFrame as
        | ((cb: () => void) => number)
        | undefined
      if (raf !== undefined) {
        rafHandle = raf(flush)
      } else {
        rafHandle = 0
        Promise.resolve().then(flush)
      }
    }
  }

  objectsArr.observeDeep(observer)

  // Initial synchronous emission
  const orderedInitial: SlideObject[] = []
  for (let i = 0; i < objectsArr.length; i++) {
    const id = objectsArr.get(i).get('id') as string | undefined
    if (id !== undefined) {
      const obj = currentSnapshot.get(id)
      if (obj !== undefined) orderedInitial.push(obj)
    }
  }
  callback({ added: orderedInitial, removed: [], updated: [], snapshot: orderedInitial })

  const unsubscribe = (): void => {
    unsubscribed = true
    objectsArr.unobserveDeep(observer)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caf = (globalThis as any).cancelAnimationFrame as ((id: number) => void) | undefined
    if (rafHandle !== -1 && caf !== undefined) caf(rafHandle)
    rafHandle = -1
    pending = createPendingBatch()
  }

  return { unsubscribe, flush }
}

// ---------------------------------------------------------------------------
// 3. subscribeToSlideAnimations
// ---------------------------------------------------------------------------

/**
 * Subscribe to animation changes for one specific slide.
 *
 * Full snapshot pattern — same contract as subscribeToAnimations from animationObserve.ts,
 * but scoped to a specific slide's animations Y.Array.
 *
 * If slideId doesn't exist: returns a no-op unsubscribe, callback never called.
 *
 * @returns unsubscribe function
 */
export function subscribeToSlideAnimations(
  ctx: SlideMutationContext,
  slideId: string,
  callback: (animations: AnimationStep[]) => void,
): () => void {
  // Find the slide
  let slideAnimationsArr: Y.Array<Y.Map<unknown>> | null = null
  for (let i = 0; i < ctx.slides.length; i++) {
    const m = ctx.slides.get(i)
    if (m.get('id') === slideId) {
      slideAnimationsArr = m.get('animations') as Y.Array<Y.Map<unknown>>
      break
    }
  }

  if (slideAnimationsArr === null) {
    return () => {}
  }

  const animationsArr = slideAnimationsArr

  const getSnapshot = (): AnimationStep[] => {
    const result: AnimationStep[] = []
    for (let i = 0; i < animationsArr.length; i++) {
      try {
        result.push(yMapToAnimationStep(animationsArr.get(i)))
      } catch {
        // Malformed — skip
      }
    }
    return result
  }

  const observer = (): void => {
    callback(getSnapshot())
  }

  animationsArr.observeDeep(observer)
  callback(getSnapshot())

  return (): void => {
    animationsArr.unobserveDeep(observer)
  }
}

// ---------------------------------------------------------------------------
// Internal delta processors (same logic as observe.ts)
// ---------------------------------------------------------------------------

function processArrayEvent(
  event: Y.YArrayEvent<Y.Map<unknown>>,
  pending: PendingBatch,
  currentSnapshot: Map<string, SlideObject>,
): void {
  const added = event.changes.added
  for (const item of added) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (item as any).content as { type?: unknown } | undefined
    if (content && content.type instanceof Y.Map) {
      const yMap = content.type as Y.Map<unknown>
      try {
        const obj = yMapToPlainObject(yMap)
        pending.addedObjects.set(obj.id, obj)
      } catch {
        // skip
      }
    }
  }

  const deleted = event.changes.deleted
  for (const item of deleted) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (item as any).content as { type?: unknown } | undefined
    if (content && content.type instanceof Y.Map) {
      const yMap = content.type as Y.Map<unknown>
      const id = readIdFromDeletedYMap(yMap)
      if (typeof id === 'string') {
        pending.removedIds.add(id)
      }
    }
  }

  void currentSnapshot
}

function readIdFromDeletedYMap(yMap: Y.Map<unknown>): string | undefined {
  try {
    const id = yMap.get('id')
    if (typeof id === 'string') return id
  } catch {
    // ignore
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internalMap = (yMap as any)._map as Map<string, { content: { arr: unknown[] } }> | undefined
  if (internalMap !== undefined) {
    const idItem = internalMap.get('id')
    if (idItem !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = (idItem as any).content?.arr as unknown[] | undefined
      if (Array.isArray(arr) && arr.length > 0) {
        const val = arr[arr.length - 1]
        if (typeof val === 'string') return val
      }
    }
  }
  return undefined
}

function processMapEvent(event: Y.YMapEvent<unknown>, pending: PendingBatch): void {
  const yMap = event.target as Y.Map<unknown>
  const id = yMap.get('id')
  if (typeof id !== 'string') return

  const changedKeys = event.keys
  const patch: Record<string, unknown> = {}
  for (const [key] of changedKeys) {
    if (key === 'id' || key === 'type') continue
    patch[key] = yMap.get(key)
  }
  if (Object.keys(patch).length === 0) return

  const existing = pending.updatedPatches.get(id)
  if (existing !== undefined) {
    pending.updatedPatches.set(id, { ...existing, ...patch } as Partial<SlideObject>)
  } else {
    pending.updatedPatches.set(id, patch as Partial<SlideObject>)
  }
}
