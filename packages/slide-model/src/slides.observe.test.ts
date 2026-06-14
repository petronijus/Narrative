/**
 * slides.observe.test.ts
 *
 * Tests for slide-scoped observer helpers (M9):
 * subscribeToSlides, subscribeToSlideObjects, subscribeToSlideAnimations.
 */

import { describe, it, expect, vi } from 'vitest'
import { createSlideDoc } from './yDoc.js'
import {
  addSlide,
  removeSlide,
  moveSlide,
  updateSlideTransition,
  getSlideObjectsCtx,
  getSlideAnimationsCtx,
  type SlideMutationContext,
} from './slides.js'
import {
  subscribeToSlides,
  subscribeToSlideObjectsWithFlush,
  subscribeToSlideObjects,
  subscribeToSlideAnimations,
} from './slideObserve.js'
import { addObject, removeObject, updateObject, moveObjectsLayer } from './mutations.js'
import { addAnimation } from './animationMutations.js'
import { plainObjectToYMap } from './bindings.js'
import type { RectangleObject } from '@narrative/shared'

function makeCtx(): SlideMutationContext {
  const { doc, slides } = createSlideDoc()
  return { doc, slides }
}

const makeRect = (id: string): RectangleObject => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fill: 0,
  rotation: 0,
  opacity: 1,
})

// PERF-1: subscribeToSlides coalesces post-subscribe emissions onto the next
// frame. The node test env has no requestAnimationFrame, so the subscriber
// falls back to a microtask (Promise.resolve().then(flush)). Draining the
// microtask queue is enough to flush the coalesced callback deterministically.
const tick = (): Promise<void> => Promise.resolve()

// ---------------------------------------------------------------------------
// subscribeToSlides
// ---------------------------------------------------------------------------

describe('subscribeToSlides', () => {
  it('emits initial snapshot synchronously', () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)

    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0]![0]).toHaveLength(1)

    unsub()
  })

  it('emits when a slide is added', async () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()

    addSlide(ctx)
    // PERF-1: post-subscribe emit is coalesced — fires on the next tick, not sync.
    expect(cb).not.toHaveBeenCalled()
    await tick()
    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0]![0]).toHaveLength(2)

    unsub()
  })

  it('emits when a slide is removed', async () => {
    const ctx = makeCtx()
    addSlide(ctx)
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()

    const slideId = ctx.slides.get(0).get('id') as string
    removeSlide(ctx, slideId)
    await tick()
    expect(cb).toHaveBeenCalledOnce()

    unsub()
  })

  it('emits when a transition is updated', async () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()

    const slideId = ctx.slides.get(0).get('id') as string
    updateSlideTransition(ctx, slideId, { kind: 'fade', durationMs: 300 })
    await tick()
    expect(cb).toHaveBeenCalledOnce()

    unsub()
  })

  it('coalesces N synchronous mutations within one frame into a single callback', async () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()

    // Simulate a burst of transactions in one frame (e.g. a drag emitting many
    // transition/array updates). The observer fires once per transaction, but
    // the rAF/microtask coalescing must collapse them into a SINGLE callback.
    addSlide(ctx)
    addSlide(ctx)
    const slideId = ctx.slides.get(0).get('id') as string
    updateSlideTransition(ctx, slideId, { kind: 'fade', durationMs: 100 })
    updateSlideTransition(ctx, slideId, { kind: 'push', durationMs: 200, direction: 'left' })

    // Nothing emitted synchronously — all collapsed into the pending frame.
    expect(cb).not.toHaveBeenCalled()

    await tick()

    // Exactly one callback for the whole burst, carrying the final state.
    expect(cb).toHaveBeenCalledOnce()
    const summary = cb.mock.calls[0]![0] as Array<{
      id: string
      transition: { kind: string; durationMs: number; direction?: string }
    }>
    expect(summary).toHaveLength(3) // 1 initial + 2 added
    const first = summary.find((s) => s.id === slideId)!
    expect(first.transition.kind).toBe('push')
    expect(first.transition.durationMs).toBe(200)
    expect(first.transition.direction).toBe('left')

    unsub()
  })

  it('does not emit after unsubscribe', async () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()
    unsub()

    addSlide(ctx)
    await tick()
    expect(cb).not.toHaveBeenCalled()
  })

  it('cancels a pending coalesced emit when unsubscribed mid-frame', async () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()

    // Schedule a flush, then tear down before the frame fires.
    addSlide(ctx)
    unsub()
    await tick()
    // The queued flush must be a no-op after unsubscribe — no stale emit.
    expect(cb).not.toHaveBeenCalled()
  })

  it('summary includes id and transition data', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    updateSlideTransition(ctx, slideId, { kind: 'push', durationMs: 400, direction: 'left' })

    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)

    const summary = cb.mock.calls[0]![0][0]
    expect(summary.id).toBe(slideId)
    expect(summary.transition.kind).toBe('push')
    expect(summary.transition.durationMs).toBe(400)
    expect(summary.transition.direction).toBe('left')

    unsub()
  })
})

// ---------------------------------------------------------------------------
// subscribeToSlideObjects
// ---------------------------------------------------------------------------

describe('subscribeToSlideObjects', () => {
  it('emits initial snapshot synchronously', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    const objectsCtx = getSlideObjectsCtx(ctx, slideId)!

    // Pre-add an object before subscribing
    addObject(objectsCtx, makeRect('r1'))

    const cb = vi.fn()
    const unsub = subscribeToSlideObjects(ctx, slideId, cb)

    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0]![0].snapshot).toHaveLength(1)

    unsub()
  })

  it('returns no-op subscribe when slideId not found', () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlideObjects(ctx, 'ghost-id', cb)

    expect(cb).not.toHaveBeenCalled()
    unsub() // should not throw
  })

  it('emits added objects via flush', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    const objectsCtx = getSlideObjectsCtx(ctx, slideId)!

    const cb = vi.fn()
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slideId, cb)
    cb.mockClear()

    addObject(objectsCtx, makeRect('r1'))
    flush()

    expect(cb).toHaveBeenCalledOnce()
    const changes = cb.mock.calls[0]![0]
    expect(changes.added).toHaveLength(1)
    expect(changes.added[0]!.id).toBe('r1')

    unsubscribe()
  })

  it('emits removed objects via flush', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    const objectsCtx = getSlideObjectsCtx(ctx, slideId)!

    addObject(objectsCtx, makeRect('r1'))

    const cb = vi.fn()
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slideId, cb)
    cb.mockClear()

    removeObject(objectsCtx, 'r1')
    flush()

    expect(cb).toHaveBeenCalledOnce()
    const changes = cb.mock.calls[0]![0]
    expect(changes.removed).toContain('r1')

    unsubscribe()
  })

  it('emits updated patches via flush', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    const objectsCtx = getSlideObjectsCtx(ctx, slideId)!

    addObject(objectsCtx, makeRect('r1'))

    const cb = vi.fn()
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slideId, cb)
    cb.mockClear()

    updateObject(objectsCtx, 'r1', { x: 99 })
    flush()

    expect(cb).toHaveBeenCalledOnce()
    const changes = cb.mock.calls[0]![0]
    expect(changes.updated).toHaveLength(1)
    expect(changes.updated[0]!.patch).toMatchObject({ x: 99 })

    unsubscribe()
  })

  it('does not emit after unsubscribe', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    const objectsCtx = getSlideObjectsCtx(ctx, slideId)!

    const cb = vi.fn()
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slideId, cb)
    cb.mockClear()
    unsubscribe()

    addObject(objectsCtx, makeRect('r1'))
    flush()
    expect(cb).not.toHaveBeenCalled()
  })

  it('reorder via moveObjectsLayer back keeps the moved id in snapshot', () => {
    // P12 regression: when moveObjectsLayer expresses a move as
    // delete+insert of the same id (netZero), the rebuilt snapshot
    // must still contain the moved object so the SceneGraph can
    // setChildIndex it. Previously the netZero pass dropped the id
    // from currentSnapshot, leaving snapshot=[A] for what should be
    // [B, A] — Pixi never repositioned B and the visual order stayed
    // stale until a page refresh.
    const ctx = makeCtx()
    const slide1Id = ctx.slides.get(0).get('id') as string
    const slideCtx = getSlideObjectsCtx(ctx, slide1Id)!
    addObject(slideCtx, makeRect('A'))
    addObject(slideCtx, makeRect('B'))

    const cb = vi.fn()
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slide1Id, cb)
    cb.mockClear()

    // "Send to back" on B → applyReorderMinimal does delete+insert of B.
    moveObjectsLayer(slideCtx, ['B'], 'back')
    flush()

    expect(cb).toHaveBeenCalledTimes(1)
    const change = cb.mock.calls[0]![0] as {
      added: ReadonlyArray<{ id: string }>
      removed: ReadonlyArray<string>
      snapshot: ReadonlyArray<{ id: string }>
    }
    expect(change.snapshot.map((o) => o.id)).toEqual(['B', 'A'])
    // The reorder branch re-emits the moved id as remove + add so the
    // reconciler tears down + re-mounts into the correct order.
    expect(change.removed).toContain('B')
    expect(change.added.map((o) => o.id)).toContain('B')
    unsubscribe()
  })

  it('is scoped to the specific slide — not emitting for other slides', () => {
    const ctx = makeCtx()
    const slide1Id = ctx.slides.get(0).get('id') as string
    const slide2 = addSlide(ctx)
    const slide2Ctx = getSlideObjectsCtx(ctx, slide2.id)!

    const cb = vi.fn()
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slide1Id, cb)
    cb.mockClear()

    // Add object to slide 2 (not slide 1)
    addObject(slide2Ctx, makeRect('r2'))
    flush()

    expect(cb).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('rebind cancels pending batch — no stale flush after slide-Y.Map swap', () => {
    // Regression: when the active slide's Y.Map is replaced (moveSlide,
    // Hocuspocus initial sync swapping a locally hydrated stub for the
    // remote one), the slidesObserver synchronously emits a remove-all+
    // add-all snapshot. Any pending rAF flush queued by the OLD objectsArr
    // observer would land AFTER that synchronous emit and deliver patches
    // from the stale array — out-of-order. The rebind branch now cancels
    // the pending rAF + clears the batch so the rebind is the last word.
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    const objectsCtx = getSlideObjectsCtx(ctx, slideId)!
    addObject(objectsCtx, makeRect('A'))

    const cb = vi.fn()
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slideId, cb)
    cb.mockClear()

    // 1) Mutate the OLD array — pushes an update into the pending batch.
    updateObject(objectsCtx, 'A', { x: 99 })

    // 2) Replace the slide Y.Map at the same index BEFORE flush is called.
    //    This is the moveSlide / Hocuspocus-rebind shape: same id, fresh
    //    Y.Map identity. The slidesObserver should detect the swap, cancel
    //    the queued flush, and emit a single rebind snapshot reflecting
    //    the FRESH array's state — never the stale {x:99} patch.
    //
    //    We mimic moveSlide's delete + clone-insert internally because
    //    moveSlide itself early-returns when from === to. .clone() yields
    //    a fresh Y.Map identity with the same id so the slidesObserver
    //    sees a different `objectsArr` reference and triggers rebind.
    ctx.doc.transact(() => {
      const original = ctx.slides.get(0)
      const cloned = original.clone()
      ctx.slides.delete(0, 1)
      ctx.slides.insert(0, [cloned])
    })

    // 3) flush() is a no-op: the pending batch was already cleared during
    //    the rebind. The cb has only the rebind emit.
    flush()

    // Last call must be the rebind. The cloned Y.Map deep-clones every
    // field, so 'A' (with x=99 already committed pre-clone) survives in
    // the fresh objects array. What MUST NOT leak through is a stale
    // `updated` patch entry from the pre-rebind pending batch.
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1]
    expect(lastCall).toBeDefined()
    const change = lastCall![0] as {
      added: ReadonlyArray<{ id: string }>
      removed: ReadonlyArray<string>
      updated: ReadonlyArray<{ id: string; patch: object }>
      snapshot: ReadonlyArray<{ id: string }>
    }
    // Critical: rebind has no carry-over stale patches from before the swap.
    expect(change.updated).toEqual([])
    // The rebind emits the synthetic remove-all + add-all so consumers
    // tear down the old subtree and re-mount the fresh one.
    expect(change.added.map((o) => o.id)).toEqual(['A'])
    expect(change.removed).toEqual(['A'])

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// subscribeToSlideAnimations
// ---------------------------------------------------------------------------

describe('subscribeToSlideAnimations', () => {
  it('emits initial snapshot synchronously (empty)', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string

    const cb = vi.fn()
    const unsub = subscribeToSlideAnimations(ctx, slideId, cb)

    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0]![0]).toEqual([])

    unsub()
  })

  it('emits when animation is added', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    const animCtx = getSlideAnimationsCtx(ctx, slideId)!

    const cb = vi.fn()
    const unsub = subscribeToSlideAnimations(ctx, slideId, cb)
    cb.mockClear()

    addAnimation(animCtx, {
      objectId: 'obj-1',
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.5,
      delay: 0,
      easing: 'power2.out',
    })

    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0]![0]).toHaveLength(1)

    unsub()
  })

  it('returns no-op subscribe when slideId not found', () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlideAnimations(ctx, 'ghost-id', cb)

    expect(cb).not.toHaveBeenCalled()
    unsub()
  })

  it('keeps firing after the slide Y.Map is replaced by moveSlide (rebind)', () => {
    // Regression: moveSlide deletes + reinserts the slide's Y.Map at the
    // same id, so an observer bound to the old animations Y.Array goes
    // stale. The subscription must rebind to the fresh array and keep
    // delivering edits — otherwise the animations panel silently desyncs.
    const ctx = makeCtx()
    addSlide(ctx) // second slide so there's something to reorder past
    const slideId = ctx.slides.get(0).get('id') as string

    const cb = vi.fn()
    const unsub = subscribeToSlideAnimations(ctx, slideId, cb)
    cb.mockClear()

    // Replace the tracked slide's Y.Map (move it to the end and back).
    moveSlide(ctx, slideId, 1)
    cb.mockClear()

    // An edit on the SAME slide id, now backed by a fresh Y.Map/Y.Array,
    // must still reach the subscriber.
    const animCtx = getSlideAnimationsCtx(ctx, slideId)!
    addAnimation(animCtx, {
      objectId: 'obj-1',
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.5,
      delay: 0,
      easing: 'power2.out',
    })

    expect(cb).toHaveBeenCalled()
    expect(cb.mock.calls.at(-1)![0]).toHaveLength(1)

    unsub()
  })

  it('does not emit after unsubscribe', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    const animCtx = getSlideAnimationsCtx(ctx, slideId)!

    const cb = vi.fn()
    const unsub = subscribeToSlideAnimations(ctx, slideId, cb)
    cb.mockClear()
    unsub()

    addAnimation(animCtx, {
      objectId: 'obj-1',
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.5,
      delay: 0,
      easing: 'power2.out',
    })

    expect(cb).not.toHaveBeenCalled()
  })
})

// Suppress unused import warning
void plainObjectToYMap
