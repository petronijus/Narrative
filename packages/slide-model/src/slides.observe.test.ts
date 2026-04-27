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

  it('emits when a slide is added', () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()

    addSlide(ctx)
    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0]![0]).toHaveLength(2)

    unsub()
  })

  it('emits when a slide is removed', () => {
    const ctx = makeCtx()
    addSlide(ctx)
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()

    const slideId = ctx.slides.get(0).get('id') as string
    removeSlide(ctx, slideId)
    expect(cb).toHaveBeenCalledOnce()

    unsub()
  })

  it('emits when a transition is updated', () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()

    const slideId = ctx.slides.get(0).get('id') as string
    updateSlideTransition(ctx, slideId, { kind: 'fade', durationMs: 300 })
    expect(cb).toHaveBeenCalledOnce()

    unsub()
  })

  it('does not emit after unsubscribe', () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToSlides(ctx, cb)
    cb.mockClear()
    unsub()

    addSlide(ctx)
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
