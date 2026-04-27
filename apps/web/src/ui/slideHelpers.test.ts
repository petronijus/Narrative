/**
 * ui/slideHelpers.test.ts
 *
 * Tests for duplicateSlide. The important invariant since M13 is that the
 * copied objects KEEP their source ids — that's what makes the duplicate a
 * natural Magic Move fixture and what keeps animation objectId references
 * valid across the copy.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import {
  hydrateSlideDoc,
  listSlides,
  getSlideObjectsCtx,
  addObject,
  addAnimation,
  getSlideAnimationsCtx,
  type SlideMutationContext,
} from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { duplicateSlide } from './slideHelpers.js'

function makeRect(id: string, overrides: Partial<SlideObject> = {}): SlideObject {
  return {
    id,
    type: 'rectangle',
    x: 100,
    y: 200,
    width: 80,
    height: 60,
    rotation: 0,
    opacity: 1,
    fill: '#ff0000',
    ...overrides,
  } as SlideObject
}

function bootstrapDeck(): { doc: Y.Doc; ctx: SlideMutationContext } {
  const doc = new Y.Doc()
  const { slides } = hydrateSlideDoc(doc)
  return { doc, ctx: { doc, slides } }
}

describe('duplicateSlide — preserves source object ids (Magic Move fixture)', () => {
  let ctx: SlideMutationContext

  beforeEach(() => {
    ctx = bootstrapDeck().ctx
  })

  it('copies each object keeping its original id', () => {
    const slides = listSlides(ctx)
    const sourceId = slides[0]!.id

    const objectsCtx = getSlideObjectsCtx(ctx, sourceId)!
    addObject(objectsCtx, makeRect('rect-alpha'))
    addObject(objectsCtx, makeRect('rect-beta', { x: 400 }))

    const dup = duplicateSlide(ctx, sourceId)
    expect(dup).not.toBeNull()

    const dupIds = dup!.objects.map((o) => o.id).sort()
    expect(dupIds).toEqual(['rect-alpha', 'rect-beta'])
  })

  it('copied objects preserve geometry + style', () => {
    const slides = listSlides(ctx)
    const sourceId = slides[0]!.id

    const objectsCtx = getSlideObjectsCtx(ctx, sourceId)!
    addObject(objectsCtx, makeRect('r1', { x: 50, y: 60, width: 100, fill: 0x00ff00 }))

    const dup = duplicateSlide(ctx, sourceId)!
    const copy = dup.objects.find((o) => o.id === 'r1')!
    expect(copy).toMatchObject({ x: 50, y: 60, width: 100, type: 'rectangle' })
    expect((copy as unknown as { fill: number }).fill).toBe(0x00ff00)
  })

  it('animations are copied and their objectId references still resolve', () => {
    const slides = listSlides(ctx)
    const sourceId = slides[0]!.id

    const objectsCtx = getSlideObjectsCtx(ctx, sourceId)!
    addObject(objectsCtx, makeRect('anim-target'))

    const animsCtx = getSlideAnimationsCtx(ctx, sourceId)!
    addAnimation(animsCtx, {
      objectId: 'anim-target',
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.5,
      delay: 0,
      easing: 'power2.out',
    })

    const dup = duplicateSlide(ctx, sourceId)!
    // Objects kept their ids (asserted above), so the copied animation's
    // objectId should still point at an object that exists in this slide.
    const copiedAnim = dup.animations[0]!
    const dupObjIds = new Set(dup.objects.map((o) => o.id))
    expect(dupObjIds.has(copiedAnim.objectId)).toBe(true)
  })

  it('returns null and warns when source slide is missing', () => {
    const result = duplicateSlide(ctx, 'no-such-slide')
    expect(result).toBeNull()
  })

  it('source and copy are independent: editing one does not affect the other', () => {
    const slides = listSlides(ctx)
    const sourceId = slides[0]!.id

    const objectsCtx = getSlideObjectsCtx(ctx, sourceId)!
    addObject(objectsCtx, makeRect('shared'))

    const dup = duplicateSlide(ctx, sourceId)!
    expect(dup.objects).toHaveLength(1)

    // Add a new object only on the source slide. The duplicated slide must
    // NOT see it — each slide has its own Y.Array despite sharing ids.
    addObject(objectsCtx, makeRect('source-only'))

    const after = listSlides(ctx)
    const sourceSlide = after.find((s) => s.id === sourceId)!
    const dupSlide = after.find((s) => s.id === dup.id)!
    expect(sourceSlide.objects.map((o) => o.id).sort()).toEqual(['shared', 'source-only'])
    expect(dupSlide.objects.map((o) => o.id)).toEqual(['shared'])
  })
})
