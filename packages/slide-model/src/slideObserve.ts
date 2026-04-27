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
import { LOCAL_ORIGIN } from './mutations.js'

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

  // P12g: guard against double-unsubscribe. Yjs silently ignores an
  // `unobserveDeep` of an already-removed handler, but a stale closure
  // calling unsubscribe twice in quick succession is a sign of a deps
  // bug — defensive flag here avoids debugging surprise later.
  let unsubscribed = false
  return (): void => {
    if (unsubscribed) return
    unsubscribed = true
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
  /** P14: ids touched by a non-local-origin Yjs transaction in this batch. */
  remoteOriginIds: Set<string>
}

function createPendingBatch(): PendingBatch {
  return {
    addedObjects: new Map(),
    removedIds: new Set(),
    updatedPatches: new Map(),
    remoteOriginIds: new Set(),
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
 *
 * P14: rebinds the inner observer when the slide's Y.Map identity is
 * replaced under us. moveSlide / Hocuspocus sync of an empty-then-
 * remote-arrives slide replaces the Y.Map (delete + insert at the same
 * index, same id). If the inner observer were attached to the OLD Y.Map's
 * `objects` Y.Array, it would never see updates on the NEW one. We
 * watch ctx.slides for any change and re-resolve the target Y.Map by
 * id; if its identity differs from the one we're observing, we
 * unobserve the old Y.Array and observe the new one.
 */
export function subscribeToSlideObjectsWithFlush(
  ctx: SlideMutationContext,
  slideId: string,
  callback: (changes: ObjectChangeSet) => void,
): { unsubscribe: () => void; flush: () => void } {
  function resolveObjectsArr(): Y.Array<Y.Map<unknown>> | null {
    for (let i = 0; i < ctx.slides.length; i++) {
      const m = ctx.slides.get(i)
      if (m.get('id') === slideId) {
        return m.get('objects') as Y.Array<Y.Map<unknown>>
      }
    }
    return null
  }

  let slideObjectsArr: Y.Array<Y.Map<unknown>> | null = resolveObjectsArr()

  if (slideObjectsArr === null) {
    // Slide not found — no-op subscribe
    return {
      unsubscribe: () => {},
      flush: () => {},
    }
  }

  let objectsArr = slideObjectsArr

  // Internal snapshot
  const currentSnapshot = new Map<string, SlideObject>()
  // Last emitted order — needed to detect layer-order reorders that Yjs
  // expresses as delete-all + push-all (a net-zero set of ids but a new
  // sequence). Without this, the Pixi reconciler and React consumers
  // see no event and the UI stays stale until refresh.
  let lastEmittedOrder: string[] = []
  for (let i = 0; i < objectsArr.length; i++) {
    const obj = yMapToPlainObject(objectsArr.get(i))
    currentSnapshot.set(obj.id, obj)
    lastEmittedOrder.push(obj.id)
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
      if (netZeroIds.has(id)) {
        // Pure reorder via applyReorderMinimal expresses itself as
        // delete + insert of the same id within one tick. The remove
        // pass above cleared this id from currentSnapshot; restore it
        // from the freshly inserted Y.Map so the rebuilt `snapshot`
        // below still contains the moved object. Otherwise the
        // SceneGraph reconciler would receive an incomplete snapshot
        // and skip the setChildIndex call, leaving the visual order
        // stale until a full reload.
        currentSnapshot.set(id, obj)
        continue
      }
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
    const currentOrder: string[] = []
    for (let i = 0; i < objectsArr.length; i++) {
      const id = objectsArr.get(i).get('id') as string | undefined
      if (id !== undefined) {
        const obj = currentSnapshot.get(id)
        if (obj !== undefined) {
          snapshot.push(obj)
          currentOrder.push(id)
        }
      }
    }

    // P6: detect a pure reorder (delete-all + push-all inside one tick).
    // The net-zero pass suppressed added/removed for the shared ids, but
    // the Y.Array sequence has changed and the Pixi reconciler needs to
    // rebuild in the new z-order. We push every affected id into both
    // netRemoved + netAdded so the reconciler tears down + re-mounts
    // into the correct order, and so React consumers re-render.
    let orderChanged = currentOrder.length !== lastEmittedOrder.length
    for (let i = 0; !orderChanged && i < currentOrder.length; i++) {
      if (currentOrder[i] !== lastEmittedOrder[i]) orderChanged = true
    }
    if (orderChanged && netZeroIds.size > 0) {
      for (const id of netZeroIds) {
        netRemoved.push(id)
        const obj = batchToProcess.addedObjects.get(id)
        if (obj !== undefined) netAdded.push(obj)
      }
    }

    if (netAdded.length > 0 || netRemoved.length > 0 || netUpdated.length > 0 || orderChanged) {
      callback({
        added: netAdded,
        removed: netRemoved,
        updated: netUpdated,
        snapshot,
        remoteOriginIds: batchToProcess.remoteOriginIds,
      })
      lastEmittedOrder = currentOrder
    }

    dispatching = false
  }

  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    if (unsubscribed) return
    // P14-DIAG: temporary instrumentation. Remove once the user's
    // multi-window slide-2 drag bug is pinned. Logs every observer
    // fire on the slide-objects Y.Array so we can see whether peer
    // events even reach the subscriber.

    console.debug(
      '[slideObserve] fire',
      JSON.stringify({
        slideId,
        events: events.length,
        origin:
          events[0]?.transaction.origin === LOCAL_ORIGIN
            ? 'local'
            : String(
                events[0]?.transaction.origin?.constructor?.name ?? events[0]?.transaction.origin,
              ),
      }),
    )
    for (const event of events) {
      const isRemote = event.transaction.origin !== LOCAL_ORIGIN
      if (event.target === objectsArr) {
        processArrayEvent(event as Y.YArrayEvent<Y.Map<unknown>>, pending, currentSnapshot)
        if (isRemote) {
          // Tag every id this array-event touched. Yjs YArrayEvent
          // doesn't expose per-id keys directly, but the change set
          // we just appended to `pending` does.
          for (const id of pending.addedObjects.keys()) pending.remoteOriginIds.add(id)
          for (const id of pending.removedIds) pending.remoteOriginIds.add(id)
        }
      } else if (event.target instanceof Y.Map) {
        processMapEvent(event as Y.YMapEvent<unknown>, pending)
        if (isRemote) {
          // Map events fire on the per-object Y.Map. The id lives on
          // the map itself.
          const id = (event.target as Y.Map<unknown>).get('id') as string | undefined
          if (id !== undefined) pending.remoteOriginIds.add(id)
        }
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

  // P14: watch the deck's slides Y.Array for Y.Map replacement of the
  // active slide. If a sibling slide is added/removed/reordered the
  // target Y.Map keeps its identity, so we don't rebind. But if the
  // target slide's Y.Map is replaced (delete + insert at same id —
  // happens on moveSlide and on Hocuspocus sync that swaps a locally
  // hydrated empty Y.Map for the remote one), we need to detach the
  // old observer and attach to the new objects Y.Array. Otherwise the
  // subscriber stops seeing peer events for "the same slide" and the
  // editor silently desyncs.
  const slidesObserver = (): void => {
    if (unsubscribed) return
    const fresh = resolveObjectsArr()
    if (fresh === null || fresh === objectsArr) return
    // Identity of the target slide's objects Y.Array changed.
    objectsArr.unobserveDeep(observer)
    objectsArr = fresh
    objectsArr.observeDeep(observer)
    // Resync internal snapshot from the fresh array. Emit a
    // remove-all-then-add-all change set so consumers see the swap.
    const oldIds = [...currentSnapshot.keys()]
    currentSnapshot.clear()
    lastEmittedOrder = []
    const fresh_ordered: SlideObject[] = []
    for (let i = 0; i < objectsArr.length; i++) {
      const obj = yMapToPlainObject(objectsArr.get(i))
      currentSnapshot.set(obj.id, obj)
      lastEmittedOrder.push(obj.id)
      fresh_ordered.push(obj)
    }
    callback({
      added: fresh_ordered,
      removed: oldIds,
      updated: [],
      snapshot: fresh_ordered,
    })
  }
  ctx.slides.observe(slidesObserver)

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
    ctx.slides.unobserve(slidesObserver)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caf = (globalThis as any).cancelAnimationFrame as ((id: number) => void) | undefined
    if (rafHandle !== -1 && caf !== undefined) caf(rafHandle)
    rafHandle = -1
    pending = createPendingBatch()
  }

  return { unsubscribe, flush }
}

// ---------------------------------------------------------------------------
// 2b. subscribeToDeckSlideEvents — single deck-level observer
// ---------------------------------------------------------------------------

/**
 * Subscribe to ALL object/slide changes at the deck level with a single
 * `ctx.slides.observeDeep` observer.
 *
 * Instead of one per-slide observer (which captures a stale Y.Array reference
 * after a slide rebuild), this attaches a single observer to the root slides
 * array and derives which slide ids were affected by walking each event's
 * target up to the immediate child of `ctx.slides`.
 *
 * Callback fires once per rAF tick with the Set of affected slide ids.
 * When the slides array itself changes (add/remove/reorder), the callback
 * receives ALL current slide ids so thumbnails can reseed.
 *
 * @returns unsubscribe function
 */
export function subscribeToDeckSlideEvents(
  ctx: SlideMutationContext,
  callback: (affectedSlideIds: Set<string>) => void,
): () => void {
  let rafHandle = -1
  let unsubscribed = false
  let pendingIds: Set<string> = new Set()

  const flush = (): void => {
    rafHandle = -1
    if (unsubscribed || pendingIds.size === 0) {
      pendingIds = new Set()
      return
    }
    const ids = pendingIds
    pendingIds = new Set()
    callback(ids)
  }

  const scheduleFlush = (): void => {
    if (rafHandle !== -1) return
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

  const getAllCurrentIds = (): string[] => {
    const ids: string[] = []
    for (let i = 0; i < ctx.slides.length; i++) {
      const id = ctx.slides.get(i).get('id') as string | undefined
      if (typeof id === 'string') ids.push(id)
    }
    return ids
  }

  /**
   * Walk `node` up the Yjs parent chain until we find the Y.Map that is a
   * direct child of `ctx.slides`. Returns that map's 'id', or null if the
   * target is outside the slides array or is the array itself.
   */
  const resolveSlideId = (target: Y.AbstractType<unknown>): string | null => {
    if (target === ctx.slides) return null // the array itself — handled separately

    let node: Y.AbstractType<unknown> | null = target
    while (node !== null) {
      if ((node as unknown as { parent: unknown }).parent === ctx.slides) {
        // node is a direct child of ctx.slides — it's the slide Y.Map
        const slideMap = node as Y.Map<unknown>
        const id = slideMap.get('id')
        return typeof id === 'string' ? id : null
      }

      node = (node as unknown as { parent: Y.AbstractType<unknown> | null }).parent ?? null
    }
    return null
  }

  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    if (unsubscribed) return

    let arrayChanged = false
    for (const event of events) {
      if (event.target === ctx.slides) {
        arrayChanged = true
      } else {
        const id = resolveSlideId(event.target)
        if (id !== null) pendingIds.add(id)
      }
    }

    if (arrayChanged) {
      // Slides added/removed/reordered — emit all current ids
      for (const id of getAllCurrentIds()) pendingIds.add(id)
    }

    if (pendingIds.size > 0) {
      scheduleFlush()
    }
  }

  ctx.slides.observeDeep(observer)

  return (): void => {
    unsubscribed = true
    ctx.slides.unobserveDeep(observer)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caf = (globalThis as any).cancelAnimationFrame as ((id: number) => void) | undefined
    if (rafHandle !== -1 && caf !== undefined) caf(rafHandle)
    rafHandle = -1
    pendingIds = new Set()
  }
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
