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
import { yMapToPlainObject } from './bindings.js'
import { yMapToAnimationStep } from './animationBindings.js'
import type { SlideMutationContext } from './slides.js'

/**
 * Incremental diff dispatched by `subscribeToSlideObjects` once per rAF tick.
 *
 * - `added`    — new objects, plain SlideObject form (already converted from Y.Map).
 * - `removed`  — ids of objects that disappeared.
 * - `updated`  — per-object patches; multiple writes within a tick are coalesced.
 * - `snapshot` — full ordered list after the diff is applied; useful for
 *   bootstrapping new subscribers without replaying the changelog.
 */
export interface ObjectChangeSet {
  added: SlideObject[]
  removed: string[]
  updated: Array<{ id: string; patch: Partial<SlideObject> }>
  snapshot: SlideObject[]
}

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
    // Defensive: a Y.Map missing the discriminator (`type`) — older bug
    // states or partial writes — must not bring the whole subscription
    // down. Log + skip the bad entry so the rest of the slide still
    // loads. yMapToPlainObject throws on missing/non-string `type`.
    try {
      const obj = yMapToPlainObject(objectsArr.get(i))
      currentSnapshot.set(obj.id, obj)
      lastEmittedOrder.push(obj.id)
    } catch (err) {
      console.warn(
        `[subscribeToSlideObjects] skipping malformed object at index ${i} on slide ${slideId}:`,
        err,
      )
    }
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
    // Drop the `netZeroIds.size > 0` guard — when netZeroIds is empty the
    // loop is a no-op anyway, and keeping the guard meant a reorder that
    // landed in the same batch as a genuine add/remove was silently
    // skipped, leaving the per-id remount data incomplete. The outer
    // `orderChanged` check at the emit site (below) already gates the
    // callback so we never fire spuriously.
    if (orderChanged) {
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
      })
      lastEmittedOrder = currentOrder
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
      } else if (event.target instanceof Y.Text) {
        // Rich-text bodies live as Y.Text inside the slide-object Y.Map.
        // A format / insert / delete on the Y.Text fires a Y.YTextEvent.
        // We surface it as a patch on the parent object so the reconciler re-renders.
        processTextEvent(event as Y.YTextEvent, objectsArr, pending)
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

    // The rebind below emits a synthetic remove-all+add-all snapshot
    // synchronously. Any pending rAF flush queued by the OLD objectsArr's
    // observer would land AFTER this synchronous emit and deliver patches
    // from the stale array on top of the fresh state — out-of-order. Cancel
    // it and drop the queued batch so the rebind is the last word.
    if (rafHandle !== -1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caf = (globalThis as any).cancelAnimationFrame as ((id: number) => void) | undefined
      if (caf !== undefined && rafHandle !== 0) caf(rafHandle)
      rafHandle = -1
    }
    pending = createPendingBatch()

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
      try {
        const obj = yMapToPlainObject(objectsArr.get(i))
        currentSnapshot.set(obj.id, obj)
        lastEmittedOrder.push(obj.id)
        fresh_ordered.push(obj)
      } catch (err) {
        console.warn(
          `[subscribeToSlideObjects] skipping malformed object during rebind at index ${i}:`,
          err,
        )
      }
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

function processTextEvent(
  event: Y.YTextEvent,
  objectsArr: Y.Array<Y.Map<unknown>>,
  pending: PendingBatch,
): void {
  // event.path is the ABSOLUTE path from the doc root to the Y.Text — it is NOT
  // relative to objectsArr. Do NOT use path indices to locate the parent Y.Map or
  // derive the field name: path[0] is the slide index and path[1] is "objects" (the
  // key in the slide Y.Map), which is wrong for both purposes.
  //
  // Instead, walk up from the event target:
  //   - event.target          = the Y.Text that was mutated
  //   - event.target.parent   = the text-object Y.Map that owns the field
  //   - _item.parentSub       = the key name of the Y.Text within its parent Y.Map
  //
  // We then confirm the parent Y.Map is actually a direct item of objectsArr
  // (guards against accidentally processing events from unrelated subtrees that
  // Yjs might route through this observer).

  const yText = event.target as Y.Text
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parentMap = (yText as any).parent as Y.Map<unknown> | null | undefined
  if (!(parentMap instanceof Y.Map)) return

  const id = parentMap.get('id')
  if (typeof id !== 'string') return

  // Retrieve the key name from Yjs internals (_item.parentSub is the map key).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key: string = ((yText as any)._item?.parentSub as string | undefined) ?? 'text'

  const patch: Record<string, unknown> = { [key]: parentMap.get(key) }
  const existing = pending.updatedPatches.get(id)
  if (existing !== undefined) {
    pending.updatedPatches.set(id, { ...existing, ...patch } as Partial<SlideObject>)
  } else {
    pending.updatedPatches.set(id, patch as Partial<SlideObject>)
  }
}

function processMapEvent(event: Y.YMapEvent<unknown>, pending: PendingBatch): void {
  const yMap = event.target as Y.Map<unknown>
  const id = yMap.get('id')

  const merge = (ownerId: string, patch: Record<string, unknown>): void => {
    if (Object.keys(patch).length === 0) return
    const existing = pending.updatedPatches.get(ownerId)
    if (existing !== undefined) {
      pending.updatedPatches.set(ownerId, { ...existing, ...patch } as Partial<SlideObject>)
    } else {
      pending.updatedPatches.set(ownerId, patch as Partial<SlideObject>)
    }
  }

  if (typeof id === 'string') {
    // Direct change on the slide-object Y.Map.
    const patch: Record<string, unknown> = {}
    for (const [key] of event.keys) {
      if (key === 'id' || key === 'type') continue
      // Value may itself be a Y.Type (e.g. fresh `overrides` Y.Map). Convert
      // to plain JSON so the renderer's applyPatch path always sees the
      // same shape regardless of the Yjs storage choice.
      const v = yMap.get(key)
      patch[key] = v instanceof Y.AbstractType ? (v as Y.AbstractType<unknown>).toJSON() : v
    }
    merge(id, patch)
    return
  }

  // Nested change — e.g. write into instance.overrides.leaves[leafId]. The
  // event.target Y.Map has no `id`. Walk up the parent chain to find the
  // id-bearing slide-object Y.Map, then re-emit the top-level field that
  // owns the changed subtree as a plain-JSON patch. Without this, the
  // renderer's applyPatch never sees `'overrides' in patch` and the
  // canvas stays stale until reload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyType = Y.AbstractType<any>
  const getParent = (t: AnyType): AnyType | null => {
    const p = (t as unknown as { parent: unknown }).parent
    return p instanceof Y.AbstractType ? (p as AnyType) : null
  }

  let cur: AnyType = yMap as unknown as AnyType
  for (let depth = 0; depth < 12; depth++) {
    const parent = getParent(cur)
    if (parent === null) return
    if (parent instanceof Y.Map) {
      const candidateId = parent.get('id')
      if (typeof candidateId === 'string') {
        for (const [k, v] of parent.entries()) {
          if (v === cur) {
            if (k !== 'id' && k !== 'type') {
              const plain =
                v instanceof Y.AbstractType ? (v as Y.AbstractType<unknown>).toJSON() : v
              merge(candidateId, { [k]: plain })
            }
            return
          }
        }
        return
      }
    }
    cur = parent
  }
}
