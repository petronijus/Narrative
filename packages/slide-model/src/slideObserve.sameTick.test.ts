/**
 * slide-model/src/slideObserve.sameTick.test.ts
 *
 * An object inserted and then written to within one tick must reach the
 * subscriber as it is at flush time. The batch used to keep the object as
 * read when the insert event fired and drop the later patch on the grounds
 * that "the add carries everything" — so a font size set right after the
 * insert (a test API call, an import followed by a fix-up, any two mutations
 * between two frames) never reached the renderer until the next unrelated
 * write to that object. Found 2026-09-21 when a pixel-level e2e spec saw the
 * text still at its default size one run in five.
 */

import { describe, it, expect } from 'vitest'
import { subscribeToSlideObjectsWithFlush, type ObjectChangeSet } from './slideObserve.js'
import { createSlideDoc } from './yDoc.js'
import { addSlide, getSlideObjectsCtx, type SlideMutationContext } from './slides.js'
import { addObject, updateObject, removeObject } from './mutations.js'
import type { SlideObject, TextObject } from '@narrative/shared'

function text(id: string): TextObject {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 300,
    height: 100,
    rotation: 0,
    opacity: 1,
    text: 'Sell',
    fontSize: 32,
    fontWeight: 400,
    color: 0,
    align: 'left',
  } as unknown as TextObject
}

function makeCtx(): SlideMutationContext {
  const { doc, slides } = createSlideDoc()
  return { doc, slides }
}

describe('an insert and a write to the same object in one tick', () => {
  it('reports the object with the write applied', () => {
    const ctx = makeCtx()
    const slide = addSlide(ctx)
    const objects = getSlideObjectsCtx(ctx, slide.id)!
    const emitted: ObjectChangeSet[] = []
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slide.id, (c) => {
      emitted.push(c)
    })

    addObject(objects, text('t1'))
    updateObject<TextObject>(objects, 't1', { fontSize: 160, lineHeight: 1.5 })
    flush()

    const last = emitted.at(-1)!
    expect(last.added.map((o) => o.id)).toEqual(['t1'])
    const added = last.added[0] as unknown as SlideObject & { fontSize: number; lineHeight: number }
    expect(added.fontSize).toBe(160)
    expect(added.lineHeight).toBe(1.5)
    // One add, not an add and a patch: the consumer mounts once, complete.
    expect(last.updated).toEqual([])
    const snap = last.snapshot[0] as unknown as { fontSize: number }
    expect(snap.fontSize).toBe(160)
    unsubscribe()
  })

  it('a later tick still sees the merged object as its base', () => {
    const ctx = makeCtx()
    const slide = addSlide(ctx)
    const objects = getSlideObjectsCtx(ctx, slide.id)!
    const emitted: ObjectChangeSet[] = []
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slide.id, (c) => {
      emitted.push(c)
    })

    addObject(objects, text('t1'))
    updateObject<TextObject>(objects, 't1', { fontSize: 160 })
    flush()
    updateObject<TextObject>(objects, 't1', { x: 40 })
    flush()

    const last = emitted.at(-1)!
    expect(last.updated).toEqual([{ id: 't1', patch: { x: 40 } }])
    const snap = last.snapshot[0] as unknown as { fontSize: number; x: number }
    expect(snap).toMatchObject({ fontSize: 160, x: 40 })
    unsubscribe()
  })

  it('an object inserted, written to and removed in one tick is nothing', () => {
    const ctx = makeCtx()
    const slide = addSlide(ctx)
    const objects = getSlideObjectsCtx(ctx, slide.id)!
    const emitted: ObjectChangeSet[] = []
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slide.id, (c) => {
      emitted.push(c)
    })
    const before = emitted.length

    addObject(objects, text('t1'))
    updateObject<TextObject>(objects, 't1', { fontSize: 160 })
    removeObject(objects, 't1')
    flush()

    for (const c of emitted.slice(before)) {
      expect(c.added).toEqual([])
      expect(c.updated).toEqual([])
      expect(c.snapshot).toEqual([])
    }
    unsubscribe()
  })
})
