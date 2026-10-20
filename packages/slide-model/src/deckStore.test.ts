/**
 * deckStore.test.ts — the shared deck read model (performance.md → E1).
 *
 * What it must guarantee: its snapshot equals `listSlides` structurally at
 * every moment, and keeps the identity of everything a change did not touch
 * (objects, slides, the list) — the Y event path decides what is rebuilt.
 */

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import * as Y from 'yjs'
import type { RectangleObject, SlideObject, TextObject } from '@narrative/shared'
import { createSlideDoc } from './yDoc.js'
import {
  addSlide,
  getSlideAnimationsCtx,
  getSlideObjectsCtx,
  listSlides,
  moveSlide,
  removeSlide,
  setSlideName,
  updateSlideBackground,
  updateSlideTransition,
  type SlideMutationContext,
} from './slides.js'
import {
  addObject,
  LOCAL_ORIGIN,
  moveObjectsLayer,
  removeObject,
  spliceRichText,
  updateObject,
} from './mutations.js'
import { addAnimation } from './animationMutations.js'
import { setSlideNotes } from './notes.js'
import { createUndoManager } from './undo.js'
import { createDeckStore, getDeckStore, type DeckStore } from './deckStore.js'

const rect = (id: string, x = 0): RectangleObject => ({
  id,
  type: 'rectangle',
  x,
  y: 0,
  width: 100,
  height: 100,
  fill: 0,
  rotation: 0,
  opacity: 1,
})

const text = (id: string, body: string): TextObject =>
  ({
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    opacity: 1,
    fontSize: 24,
    fontWeight: 'normal',
    color: 0,
    align: 'left',
    text: body,
  }) as TextObject

interface World {
  ctx: SlideMutationContext
  store: DeckStore
  /** Runs the store's queued notification, as the next animation frame would. */
  frame: () => void
  slideA: string
  slideB: string
}

/** A new deck's empty first slide, then A with r1, r2 and a text t1, and B with r3. */
function world(): World {
  const { doc, slides } = createSlideDoc()
  const ctx: SlideMutationContext = { doc, slides }
  const slideA = addSlide(ctx).id
  const slideB = addSlide(ctx).id
  const a = getSlideObjectsCtx(ctx, slideA)!
  addObject(a, rect('r1'))
  addObject(a, rect('r2', 50))
  addObject(a, text('t1', 'hello'))
  addObject(getSlideObjectsCtx(ctx, slideB)!, rect('r3'))
  let queued: (() => void) | null = null
  const store = createDeckStore(ctx, { schedule: (cb) => (queued = cb) })
  return {
    ctx,
    store,
    slideA,
    slideB,
    frame: () => {
      const cb = queued
      queued = null
      cb?.()
    },
  }
}

const objectsOf = (w: World, slideId: string) => getSlideObjectsCtx(w.ctx, slideId)!

describe('deck store', () => {
  it('starts equal to listSlides', () => {
    const w = world()
    expect(w.store.getSlides()).toEqual(listSlides(w.ctx))
    expect(w.store.getSlide(w.slideB)?.objects.map((o) => o.id)).toEqual(['r3'])
    expect(w.store.getObject(w.slideA, 'r2')?.x).toBe(50)
    expect(w.store.getObject(w.slideA, 'nope')).toBeUndefined()
    expect(w.store.getSlide('nope')).toBeUndefined()
  })

  it('an object property change rebuilds that object only', () => {
    const w = world()
    const before = w.store.getSlides()
    const [first0, a0, b0] = before
    const r1 = w.store.getObject(w.slideA, 'r1')
    const t1 = w.store.getObject(w.slideA, 't1')
    updateObject(objectsOf(w, w.slideA), 'r2', { x: 99 })
    const after = w.store.getSlides()
    expect(after).toEqual(listSlides(w.ctx))
    expect(after).not.toBe(before)
    expect(after[0]).toBe(first0) // the other slides are untouched
    expect(after[1]).not.toBe(a0)
    expect(after[2]).toBe(b0)
    expect(w.store.getObject(w.slideA, 'r2')?.x).toBe(99)
    expect(w.store.getObject(w.slideA, 'r1')).toBe(r1)
    expect(w.store.getObject(w.slideA, 't1')).toBe(t1)
    expect(after[1]!.animations).toBe(a0!.animations)
    expect(after[1]!.transition).toBe(a0!.transition)
  })

  it('a Y.Text edit deep inside an object rebuilds that object', () => {
    const w = world()
    const t1 = w.store.getObject(w.slideA, 't1')!
    const r1 = w.store.getObject(w.slideA, 'r1')
    const yText = (t1 as unknown as { text: Y.Text }).text
    expect(yText).toBeInstanceOf(Y.Text)
    spliceRichText(w.ctx.doc, yText, 5, 0, ' world', LOCAL_ORIGIN)
    const next = w.store.getObject(w.slideA, 't1')!
    expect(next).not.toBe(t1)
    expect((next as unknown as { text: Y.Text }).text.toString()).toBe('hello world')
    expect(w.store.getObject(w.slideA, 'r1')).toBe(r1)
    expect(w.store.getSlides()).toEqual(listSlides(w.ctx))
  })

  it('inserting, removing and reordering objects keeps the untouched snapshots', () => {
    const w = world()
    const r1 = w.store.getObject(w.slideA, 'r1')
    const t1 = w.store.getObject(w.slideA, 't1')
    addObject(objectsOf(w, w.slideA), rect('r4'))
    expect(w.store.getObject(w.slideA, 'r1')).toBe(r1)
    removeObject(objectsOf(w, w.slideA), 'r2')
    expect(w.store.getObject(w.slideA, 't1')).toBe(t1)
    // A layer move re-inserts Y.Maps (clones, with new Y.Texts): those
    // objects get new snapshots, equal in content.
    moveObjectsLayer(objectsOf(w, w.slideA), ['r1'], 'front')
    expect(w.store.getSlides()).toEqual(listSlides(w.ctx))
    expect(w.store.getSlide(w.slideA)!.objects.map((o) => o.id)).toEqual(['t1', 'r4', 'r1'])
  })

  it('slide metadata, animations and slide-list changes', () => {
    const w = world()
    const a0 = w.store.getSlide(w.slideA)!
    updateSlideTransition(w.ctx, w.slideA, { kind: 'fade', durationMs: 300 })
    const a1 = w.store.getSlide(w.slideA)!
    expect(a1).not.toBe(a0)
    expect(a1.transition.kind).toBe('fade')
    expect(a1.objects).toBe(a0.objects)

    updateSlideBackground(w.ctx, w.slideA, { kind: 'color', color: 0xff0000, alpha: 1 })
    setSlideName(w.ctx, w.slideA, 'Intro')
    const a2 = w.store.getSlide(w.slideA)!
    expect(a2.name).toBe('Intro')
    expect(a2.background).toEqual({ kind: 'color', color: 0xff0000, alpha: 1 })
    expect(a2.objects).toBe(a0.objects)

    addAnimation(getSlideAnimationsCtx(w.ctx, w.slideA)!, {
      objectId: 'r1',
      preset: 'fadeIn',
      trigger: 'onClick',
      duration: 400,
      delay: 0,
      easing: 'easeOut',
    } as never)
    const a3 = w.store.getSlide(w.slideA)!
    expect(a3.animations).toHaveLength(1)
    expect(w.store.getSlides()).toEqual(listSlides(w.ctx))
    expect(a3.objects).toBe(a0.objects)
    expect(a3.background).toBe(a2.background)

    const b = w.store.getSlide(w.slideB)!
    addSlide(w.ctx, 0)
    expect(w.store.getSlides()).toHaveLength(4)
    expect(w.store.getSlide(w.slideB)).toBe(b) // a sibling added: B's Y.Map is the same
    moveSlide(w.ctx, w.slideB, 0)
    // moveSlide clones the slide's Y.Map: a new snapshot, equal content.
    expect(w.store.getSlide(w.slideB)).not.toBe(b)
    expect(w.store.getSlide(w.slideB)).toEqual(b)
    removeSlide(w.ctx, w.slideA)
    expect(w.store.getSlide(w.slideA)).toBeUndefined()
    expect(w.store.getSlides()).toEqual(listSlides(w.ctx))
  })

  it('a change nothing shows (speaker notes, a same-value write) publishes nothing', () => {
    const w = world()
    const listener = vi.fn()
    w.store.subscribe(listener)
    w.frame()
    listener.mockClear()
    const before = w.store.getSlides()
    setSlideNotes(w.ctx, w.slideA, [{ type: 'paragraph', content: [{ text: 'say this' }] }])
    updateSlideTransition(w.ctx, w.slideB, { kind: 'none' }) // already 'none'
    w.frame()
    expect(w.store.getSlides()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('tells subscribers once per frame, however many transactions', () => {
    const w = world()
    const listener = vi.fn()
    w.store.subscribe(listener)
    w.frame()
    listener.mockClear()
    for (let i = 0; i < 10; i++) updateObject(objectsOf(w, w.slideA), 'r1', { x: i })
    expect(listener).not.toHaveBeenCalled()
    w.frame()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(w.store.getObject(w.slideA, 'r1')?.x).toBe(9)
    // A read before the frame already saw the change: the frame still tells.
    updateObject(objectsOf(w, w.slideA), 'r1', { x: 42 })
    expect(w.store.getObject(w.slideA, 'r1')?.x).toBe(42)
    w.frame()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('follows undo and redo', () => {
    const w = world()
    const undo = createUndoManager(w.ctx)
    const r1 = w.store.getObject(w.slideA, 'r1')
    updateObject(objectsOf(w, w.slideA), 'r2', { x: 7 })
    undo.stopCapturing()
    expect(w.store.getObject(w.slideA, 'r2')?.x).toBe(7)
    undo.undo()
    expect(w.store.getObject(w.slideA, 'r2')?.x).toBe(50)
    expect(w.store.getObject(w.slideA, 'r1')).toBe(r1)
    undo.redo()
    expect(w.store.getObject(w.slideA, 'r2')?.x).toBe(7)
    expect(w.store.getSlides()).toEqual(listSlides(w.ctx))
  })

  it('follows remote updates', () => {
    const w = world()
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(w.ctx.doc))
    const peerCtx: SlideMutationContext = {
      doc: peer,
      slides: peer.getArray<Y.Map<unknown>>('slides'),
    }
    const b = w.store.getSlide(w.slideB)
    const r1 = w.store.getObject(w.slideA, 'r1')
    const sv = Y.encodeStateVector(peer)
    updateObject(getSlideObjectsCtx(peerCtx, w.slideA)!, 'r2', { y: 123 })
    addObject(getSlideObjectsCtx(peerCtx, w.slideA)!, rect('peer'))
    Y.applyUpdate(w.ctx.doc, Y.encodeStateAsUpdate(peer, sv), 'remote')
    expect(w.store.getObject(w.slideA, 'r2')?.y).toBe(123)
    expect(w.store.getObject(w.slideA, 'peer')).toBeDefined()
    expect(w.store.getObject(w.slideA, 'r1')).toBe(r1)
    expect(w.store.getSlide(w.slideB)).toBe(b)
    expect(w.store.getSlides()).toEqual(listSlides(w.ctx))
  })

  it('skips a malformed object as listSlides does', () => {
    const w = world()
    w.ctx.doc.transact(() => {
      objectsOf(w, w.slideA).objects.push([new Y.Map<unknown>([['id', 'broken']])])
    })
    expect(w.store.getSlides()).toEqual(listSlides(w.ctx))
    expect(w.store.getObject(w.slideA, 'broken')).toBeUndefined()
  })

  it('getDeckStore shares one store per document', () => {
    const { doc, slides } = createSlideDoc()
    const s1 = getDeckStore({ doc, slides })
    expect(getDeckStore({ doc, slides })).toBe(s1)
    const other = createSlideDoc()
    expect(getDeckStore(other)).not.toBe(s1)
  })

  it('stays equal to listSlides under random edits, and shares what they did not touch', () => {
    type Op =
      | { k: 'move'; slide: number; obj: number; x: number }
      | { k: 'add'; slide: number }
      | { k: 'remove'; slide: number; obj: number }
      | { k: 'type'; slide: number; at: number }
      | { k: 'front'; slide: number; obj: number }
      | { k: 'addSlide' }
      | { k: 'moveSlide'; slide: number; to: number }
      | { k: 'transition'; slide: number }
      | { k: 'notes'; slide: number }
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        k: fc.constant('move' as const),
        slide: fc.nat(3),
        obj: fc.nat(5),
        x: fc.integer({ min: -50, max: 50 }),
      }),
      fc.record({ k: fc.constant('add' as const), slide: fc.nat(3) }),
      fc.record({ k: fc.constant('remove' as const), slide: fc.nat(3), obj: fc.nat(5) }),
      fc.record({ k: fc.constant('type' as const), slide: fc.nat(3), at: fc.nat(10) }),
      fc.record({ k: fc.constant('front' as const), slide: fc.nat(3), obj: fc.nat(5) }),
      fc.constant({ k: 'addSlide' as const }),
      fc.record({ k: fc.constant('moveSlide' as const), slide: fc.nat(3), to: fc.nat(3) }),
      fc.record({ k: fc.constant('transition' as const), slide: fc.nat(3) }),
      fc.record({ k: fc.constant('notes' as const), slide: fc.nat(3) }),
    )
    let n = 0
    fc.assert(
      fc.property(
        fc.array(fc.array(op, { minLength: 1, maxLength: 4 }), { maxLength: 25 }),
        (frames) => {
          const w = world()
          const undo = createUndoManager(w.ctx)
          for (const ops of frames) {
            const prevSlides = w.store.getSlides()
            const prevObjects = new Map<string, SlideObject>(
              prevSlides.flatMap((s) => s.objects.map((o) => [`${s.id}/${o.id}`, o] as const)),
            )
            const touched = new Set<string>()
            for (const o of ops) {
              const slides = listSlides(w.ctx)
              const slide = slides[('slide' in o ? o.slide : 0) % slides.length]!
              const objs = getSlideObjectsCtx(w.ctx, slide.id)!
              const target =
                slide.objects[('obj' in o ? o.obj : 0) % Math.max(1, slide.objects.length)]
              switch (o.k) {
                case 'move':
                  if (target === undefined) break
                  updateObject(objs, target.id, { x: o.x })
                  touched.add(`${slide.id}/${target.id}`)
                  break
                case 'add':
                  addObject(objs, n % 2 === 0 ? rect(`o${n}`) : text(`o${n}`, 'abc'))
                  n++
                  break
                case 'remove':
                  if (target === undefined) break
                  removeObject(objs, target.id)
                  break
                case 'type': {
                  const t = slide.objects.find((x) => x.type === 'text') as unknown as
                    { id: string; text: Y.Text } | undefined
                  if (t === undefined || !(t.text instanceof Y.Text)) break
                  spliceRichText(
                    w.ctx.doc,
                    t.text,
                    Math.min(o.at, t.text.length),
                    0,
                    'x',
                    LOCAL_ORIGIN,
                  )
                  touched.add(`${slide.id}/${t.id}`)
                  break
                }
                case 'front':
                  if (target === undefined) break
                  moveObjectsLayer(objs, [target.id], 'front')
                  // A layer move re-inserts Y.Maps of the slide (clones): new snapshots.
                  for (const x of slide.objects) touched.add(`${slide.id}/${x.id}`)
                  break
                case 'addSlide':
                  addSlide(w.ctx)
                  break
                case 'moveSlide':
                  moveSlide(w.ctx, slide.id, o.to)
                  for (const x of slide.objects) touched.add(`${slide.id}/${x.id}`)
                  break
                case 'transition':
                  updateSlideTransition(w.ctx, slide.id, { durationMs: 100 + n++ })
                  break
                case 'notes':
                  setSlideNotes(w.ctx, slide.id, [{ type: 'paragraph', content: [{ text: 'n' }] }])
                  break
              }
            }
            if (ops.length % 3 === 0 && undo.canUndo()) undo.undo()
            undo.stopCapturing()
            w.frame()
            const now = w.store.getSlides()
            expect(now).toEqual(listSlides(w.ctx))
            if (ops.length % 3 === 0) continue // an undo may touch anything
            for (const s of now)
              for (const o of s.objects) {
                const key = `${s.id}/${o.id}`
                const before = prevObjects.get(key)
                if (before !== undefined && !touched.has(key)) expect(o).toBe(before)
              }
          }
        },
      ),
      { numRuns: 60 },
    )
  })
})
