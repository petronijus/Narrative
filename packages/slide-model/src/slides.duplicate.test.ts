/**
 * slides.duplicate.test.ts
 *
 * duplicateSlide copies a slide whole — rich text, tables, notes, and the
 * slide's own settings — as a clone of its Yjs structure.
 *
 * What it replaced read the source through listSlides() and re-added each
 * object. A text body in that snapshot is the source slide's live Y.Text,
 * and Yjs cannot give one type a second parent: the insert threw halfway
 * through integration, leaving the copy half-built and the document broken
 * (a canvas that would not render, thumbnails that came late).
 */

import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import type { TextObject } from '@narrative/shared'
import { addObject, LOCAL_ORIGIN } from './mutations.js'
import { addAnimation } from './animationMutations.js'
import { addTable, getTableCellYMap } from './tableMutations.js'
import { createSlideDoc } from './yDoc.js'
import {
  addSlide,
  duplicateSlide,
  getSlideAnimationsCtx,
  getSlideNotes,
  getSlideObjectsCtx,
  listSlides,
  setSlideName,
  setSlideSkipped,
  updateSlideBackground,
  updateSlideTransition,
} from './slides.js'
import type { SlideMutationContext } from './slideMutationContext.js'

function textObject(id: string, text: string): TextObject {
  return {
    id,
    type: 'text',
    x: 10,
    y: 20,
    width: 400,
    height: 80,
    rotation: 0,
    opacity: 1,
    fontSize: 32,
    fontWeight: 'normal',
    color: 0,
    align: 'left',
    text,
  } as TextObject
}

/** A slide snapshot with every Yjs value replaced by what it holds. */
function plain(value: unknown): unknown {
  if (value instanceof Y.Text) return { delta: value.toDelta() as unknown }
  if (value instanceof Y.XmlFragment) return { xml: value.toString() }
  if (value instanceof Y.AbstractType) return { yjs: value.toJSON() as unknown }
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

function slideById(ctx: SlideMutationContext, id: string): unknown {
  const slide = listSlides(ctx).find((s) => s.id === id)
  if (slide === undefined) throw new Error(`no slide ${id}`)
  const { id: _id, ...rest } = slide
  void _id
  return plain(rest)
}

function slideYMap(ctx: SlideMutationContext, id: string): Y.Map<unknown> {
  for (let i = 0; i < ctx.slides.length; i++) {
    if (ctx.slides.get(i).get('id') === id) return ctx.slides.get(i)
  }
  throw new Error(`no slide ${id}`)
}

/** A deck whose second slide carries every kind of content a slide holds. */
function richDeck() {
  const { doc, slides } = createSlideDoc()
  const ctx: SlideMutationContext = { doc, slides }
  // createSlideDoc seeds the deck's first slide.
  const before = listSlides(ctx)[0]!
  const source = addSlide(ctx)
  const after = addSlide(ctx)

  const objects = getSlideObjectsCtx(ctx, source.id)!
  addObject(objects, textObject('title', 'Hello duplicate'))
  const body = objects.objects.get(0).get('text') as Y.Text
  body.format(0, 5, { fontWeight: 700, italic: true })

  const tableId = addTable(objects, { x: 0, y: 200, width: 600, height: 200, rows: 2, cols: 2 })
  const cellText = getTableCellYMap(objects, tableId, 1, 1)!.get('text') as Y.Text
  cellText.insert(0, 'cell')
  cellText.format(0, 4, { underline: true })

  addAnimation(getSlideAnimationsCtx(ctx, source.id)!, {
    objectId: 'title',
    preset: 'fadeIn',
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: 'power2.out',
  })
  updateSlideTransition(ctx, source.id, { kind: 'fade', durationMs: 400 })
  updateSlideBackground(ctx, source.id, { kind: 'color', color: 0x123456, alpha: 1 })
  setSlideName(ctx, source.id, 'Agenda')
  setSlideSkipped(ctx, source.id, true)

  const notes = getSlideNotes(ctx, source.id)!
  const para = new Y.XmlElement('paragraph')
  const words = new Y.XmlText()
  para.insert(0, [words])
  notes.insert(0, [para])
  words.insert(0, 'Say this', { bold: true })

  return { doc, ctx, before: before.id, source: source.id, after: after.id }
}

describe('duplicateSlide', () => {
  it('copies everything the slide holds, rich text and tables included', () => {
    const { ctx, source } = richDeck()
    const copy = duplicateSlide(ctx, source)
    expect(copy).not.toBeNull()
    expect(copy!.id).not.toBe(source)
    expect(slideById(ctx, copy!.id)).toEqual(slideById(ctx, source))
  })

  it('places the copy right after its source, or where asked', () => {
    const { ctx, before, source, after } = richDeck()
    const next = duplicateSlide(ctx, source)!
    expect(listSlides(ctx).map((s) => s.id)).toEqual([before, source, next.id, after])
    const first = duplicateSlide(ctx, source, 0)!
    expect(listSlides(ctx)[0]!.id).toBe(first.id)
  })

  it('keeps object ids, so Magic Move pairs them and animations resolve', () => {
    const { ctx, source } = richDeck()
    const copy = duplicateSlide(ctx, source)!
    const ids = copy.objects.map((o) => o.id)
    expect(ids).toEqual(
      listSlides(ctx)
        .find((s) => s.id === source)!
        .objects.map((o) => o.id),
    )
    expect(ids).toContain(copy.animations[0]!.objectId)
  })

  it('gives the copy its own text: editing one leaves the other alone', () => {
    const { ctx, source } = richDeck()
    const copy = duplicateSlide(ctx, source)!
    const textOf = (id: string) =>
      (slideYMap(ctx, id).get('objects') as Y.Array<Y.Map<unknown>>).get(0).get('text') as Y.Text
    textOf(copy.id).insert(textOf(copy.id).length, ' — copy')
    expect(textOf(source).toString()).toBe('Hello duplicate')
    expect(textOf(copy.id).toString()).toBe('Hello duplicate — copy')
    getSlideNotes(ctx, source)!.delete(0, 1)
    expect(getSlideNotes(ctx, copy.id)!.length).toBe(1)
  })

  it('is one change: one transaction, one undo step', () => {
    const { doc, ctx, source } = richDeck()
    const undo = new Y.UndoManager(ctx.slides, { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    let transactions = 0
    doc.on('afterTransaction', () => (transactions += 1))
    const copy = duplicateSlide(ctx, source)!
    expect(transactions).toBe(1)
    undo.undo()
    expect(listSlides(ctx).some((s) => s.id === copy.id)).toBe(false)
    expect(listSlides(ctx)).toHaveLength(3)
  })

  it('reaches a collaborator intact', () => {
    const { doc, ctx, source } = richDeck()
    const copy = duplicateSlide(ctx, source)!
    const peer = createSlideDoc()
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(doc))
    const peerCtx: SlideMutationContext = { doc: peer.doc, slides: peer.slides }
    expect(slideById(peerCtx, copy.id)).toEqual(slideById(ctx, source))
  })

  it('returns null for a slide that does not exist', () => {
    const { ctx } = richDeck()
    expect(duplicateSlide(ctx, 'no-such-slide')).toBeNull()
    expect(listSlides(ctx)).toHaveLength(3)
  })
})
