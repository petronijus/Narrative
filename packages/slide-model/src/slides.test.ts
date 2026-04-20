/**
 * slides.test.ts
 *
 * Tests for slide CRUD operations (M9):
 * addSlide, removeSlide, moveSlide, updateSlideTransition, listSlides,
 * getSlideObjectsCtx, getSlideAnimationsCtx.
 *
 * Invariant: deck always has at least 1 slide (never zero).
 */

import { describe, it, expect, vi } from 'vitest'
import { createSlideDoc } from './yDoc.js'
import {
  addSlide,
  removeSlide,
  moveSlide,
  updateSlideTransition,
  listSlides,
  getSlideObjectsCtx,
  getSlideAnimationsCtx,
  type SlideMutationContext,
} from './slides.js'

function makeCtx(): SlideMutationContext {
  const { doc, slides } = createSlideDoc()
  return { doc, slides }
}

// ---------------------------------------------------------------------------
// addSlide
// ---------------------------------------------------------------------------

describe('addSlide', () => {
  it('appends a slide when no index given', () => {
    const ctx = makeCtx()
    const slide = addSlide(ctx)

    // Initial doc already has 1 slide; now 2
    expect(ctx.slides.length).toBe(2)
    expect(typeof slide.id).toBe('string')
    expect(slide.id).not.toBe('')
  })

  it('returns a Slide with correct defaults', () => {
    const ctx = makeCtx()
    const slide = addSlide(ctx)

    expect(slide.objects).toEqual([])
    expect(slide.animations).toEqual([])
    expect(slide.transition.kind).toBe('none')
    expect(slide.transition.durationMs).toBe(0)
  })

  it('inserts at given index', () => {
    const ctx = makeCtx()
    const second = addSlide(ctx)
    const inserted = addSlide(ctx, 0) // insert at beginning

    expect(ctx.slides.get(0).get('id')).toBe(inserted.id)
    expect(ctx.slides.get(1).get('id')).not.toBe(second.id)
    void second
  })

  it('appends when index >= length', () => {
    const ctx = makeCtx()
    const slide = addSlide(ctx, 999)
    const lastIdx = ctx.slides.length - 1
    expect(ctx.slides.get(lastIdx).get('id')).toBe(slide.id)
  })

  it('inserted slide has id, objects, animations, transition in Y.Map', () => {
    const ctx = makeCtx()
    addSlide(ctx)
    const slideMap = ctx.slides.get(ctx.slides.length - 1)
    expect(typeof slideMap.get('id')).toBe('string')
    expect(slideMap.get('objects')).toBeDefined()
    expect(slideMap.get('animations')).toBeDefined()
    expect(slideMap.get('transition')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// removeSlide
// ---------------------------------------------------------------------------

describe('removeSlide', () => {
  it('removes a slide by id', () => {
    const ctx = makeCtx()
    const secondSlide = addSlide(ctx)

    removeSlide(ctx, secondSlide.id)
    expect(ctx.slides.length).toBe(1)
  })

  it('no-op + warn when slide not found', () => {
    const ctx = makeCtx()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    removeSlide(ctx, 'does-not-exist')
    expect(ctx.slides.length).toBe(1) // unchanged
    expect(warnSpy).toHaveBeenCalledOnce()

    warnSpy.mockRestore()
  })

  it('never drops below 1 slide — replaces last with fresh empty slide', () => {
    const ctx = makeCtx()
    const firstSlideId = ctx.slides.get(0).get('id') as string

    removeSlide(ctx, firstSlideId)

    // Still has 1 slide, but it's a different (new) one
    expect(ctx.slides.length).toBe(1)
    const newSlideId = ctx.slides.get(0).get('id') as string
    expect(newSlideId).not.toBe(firstSlideId)
  })

  it('fresh replacement slide has empty objects and animations', () => {
    const ctx = makeCtx()
    const firstSlideId = ctx.slides.get(0).get('id') as string

    removeSlide(ctx, firstSlideId)

    const replacement = ctx.slides.get(0)
    const objects = replacement.get('objects') as { length: number }
    const animations = replacement.get('animations') as { length: number }
    expect(objects.length).toBe(0)
    expect(animations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// moveSlide
// ---------------------------------------------------------------------------

describe('moveSlide', () => {
  function setup3Slides(): { ctx: SlideMutationContext; ids: string[] } {
    const ctx = makeCtx()
    const s0 = ctx.slides.get(0).get('id') as string
    const s1 = addSlide(ctx).id
    const s2 = addSlide(ctx).id
    return { ctx, ids: [s0, s1, s2] }
  }

  it('moves slide to new position', () => {
    const { ctx, ids } = setup3Slides()

    moveSlide(ctx, ids[0]!, 2)

    const order = Array.from({ length: ctx.slides.length }, (_, i) => ctx.slides.get(i).get('id'))
    expect(order[2]).toBe(ids[0]!)
  })

  it('no-op when source index === destination', () => {
    const { ctx, ids } = setup3Slides()
    const before = Array.from({ length: ctx.slides.length }, (_, i) => ctx.slides.get(i).get('id'))

    moveSlide(ctx, ids[1]!, 1)

    const after = Array.from({ length: ctx.slides.length }, (_, i) => ctx.slides.get(i).get('id'))
    expect(after).toEqual(before)
  })

  it('no-op + warn when slide not found', () => {
    const { ctx } = setup3Slides()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = Array.from({ length: ctx.slides.length }, (_, i) => ctx.slides.get(i).get('id'))

    moveSlide(ctx, 'ghost-id', 0)

    const after = Array.from({ length: ctx.slides.length }, (_, i) => ctx.slides.get(i).get('id'))
    expect(after).toEqual(before)
    warnSpy.mockRestore()
  })

  it('clamps index to [0, length-1]', () => {
    const { ctx, ids } = setup3Slides()

    moveSlide(ctx, ids[0]!, 999)

    const lastIdx = ctx.slides.length - 1
    expect(ctx.slides.get(lastIdx).get('id')).toBe(ids[0]!)
  })
})

// ---------------------------------------------------------------------------
// updateSlideTransition
// ---------------------------------------------------------------------------

describe('updateSlideTransition', () => {
  it('updates kind and durationMs', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string

    updateSlideTransition(ctx, slideId, { kind: 'fade', durationMs: 300 })

    const transition = ctx.slides.get(0).get('transition') as { get: (k: string) => unknown }
    expect(transition.get('kind')).toBe('fade')
    expect(transition.get('durationMs')).toBe(300)
  })

  it('updates only specified fields (partial patch)', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string

    updateSlideTransition(ctx, slideId, { kind: 'push', durationMs: 400, direction: 'left' })
    updateSlideTransition(ctx, slideId, { durationMs: 200 }) // partial patch

    const transition = ctx.slides.get(0).get('transition') as { get: (k: string) => unknown }
    expect(transition.get('kind')).toBe('push') // unchanged
    expect(transition.get('durationMs')).toBe(200)
    expect(transition.get('direction')).toBe('left') // unchanged
  })

  it('no-op + warn when slide not found', () => {
    const ctx = makeCtx()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    updateSlideTransition(ctx, 'ghost-id', { kind: 'fade', durationMs: 100 })

    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// listSlides
// ---------------------------------------------------------------------------

describe('listSlides', () => {
  it('returns all slides as plain objects', () => {
    const ctx = makeCtx()
    addSlide(ctx)
    addSlide(ctx)

    const slides = listSlides(ctx)
    expect(slides.length).toBe(3)
    expect(slides.every((s) => typeof s.id === 'string')).toBe(true)
  })

  it('includes transition data', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    updateSlideTransition(ctx, slideId, { kind: 'cube', durationMs: 500 })

    const slides = listSlides(ctx)
    expect(slides[0]!.transition.kind).toBe('cube')
    expect(slides[0]!.transition.durationMs).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// getSlideObjectsCtx
// ---------------------------------------------------------------------------

describe('getSlideObjectsCtx', () => {
  it('returns ObjectsMutationContext for existing slide', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string

    const objectsCtx = getSlideObjectsCtx(ctx, slideId)
    expect(objectsCtx).not.toBeNull()
    expect(objectsCtx!.doc).toBe(ctx.doc)
    expect(objectsCtx!.objects).toBeDefined()
  })

  it('returns null for non-existent slide', () => {
    const ctx = makeCtx()
    const objectsCtx = getSlideObjectsCtx(ctx, 'ghost-id')
    expect(objectsCtx).toBeNull()
  })

  it('scoped objects array is same instance as slide Y.Map objects', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string
    const objectsCtx = getSlideObjectsCtx(ctx, slideId)

    const slideObjects = ctx.slides.get(0).get('objects')
    expect(objectsCtx!.objects).toBe(slideObjects)
  })
})

// ---------------------------------------------------------------------------
// getSlideAnimationsCtx
// ---------------------------------------------------------------------------

describe('getSlideAnimationsCtx', () => {
  it('returns AnimationsMutationContext for existing slide', () => {
    const ctx = makeCtx()
    const slideId = ctx.slides.get(0).get('id') as string

    const animCtx = getSlideAnimationsCtx(ctx, slideId)
    expect(animCtx).not.toBeNull()
    expect(animCtx!.doc).toBe(ctx.doc)
    expect(animCtx!.animations).toBeDefined()
  })

  it('returns null for non-existent slide', () => {
    const ctx = makeCtx()
    expect(getSlideAnimationsCtx(ctx, 'ghost-id')).toBeNull()
  })
})
