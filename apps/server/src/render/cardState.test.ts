/**
 * render/cardState.test.ts — the hash of what a deck's card shows, on real
 * slide-model documents (text bodies and table cells are live Y.Text): the
 * same for every copy of the document, changed by an edit to the first
 * slide — a text edit, a formatting-only edit, a deletion — and by nothing
 * on another slide.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { TextObject } from '@narrative/shared'
import {
  addObjects,
  addSlide,
  addTable,
  createSlideDoc,
  getSlideObjectsCtx,
  listSlides,
  removeObject,
} from '@narrative/slide-model'
import { cardSourceOf } from './cardState.js'

const text = (id: string, body: string): TextObject => ({
  id,
  type: 'text',
  x: 0,
  y: 0,
  width: 400,
  height: 80,
  text: body,
  fontSize: 40,
  fontWeight: 400,
  color: 0x000000,
  align: 'left',
  rotation: 0,
  opacity: 1,
})

/** Slide 1: a title and a 2×2 table; slide 2: a caption. */
function deck() {
  const handles = createSlideDoc()
  const [first] = listSlides(handles)
  const objects = getSlideObjectsCtx(handles, first!.id)!
  addObjects(objects, [text('title', 'Hello')])
  addTable(objects, { x: 0, y: 300, width: 600, height: 200, rows: 2, cols: 2 })
  const second = addSlide(handles)
  addObjects(getSlideObjectsCtx(handles, second.id)!, [text('caption', 'Second')])
  return { handles, objects, second }
}

const copyOf = (doc: Y.Doc): Y.Doc => {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

const titleText = (doc: Y.Doc): Y.Text =>
  (doc.getArray<Y.Map<unknown>>('slides').get(0).get('objects') as Y.Array<Y.Map<unknown>>)
    .get(0)
    .get('text') as Y.Text

describe('cardSourceOf', () => {
  it('hashes a first slide with text and a table, the same for every copy of the document', () => {
    const { handles } = deck()
    const source = cardSourceOf(handles.doc)
    expect(source).toMatch(/^[\w-]{43}$/)
    expect(cardSourceOf(copyOf(handles.doc))).toBe(source)
  })

  it('changes with a text edit, a formatting-only edit and a deletion on the first slide', () => {
    const { handles, objects } = deck()
    const seen = new Set([cardSourceOf(handles.doc)])
    titleText(handles.doc).insert(5, ', world')
    seen.add(cardSourceOf(handles.doc))
    titleText(handles.doc).format(0, 5, { fontWeight: 700 })
    seen.add(cardSourceOf(handles.doc))
    removeObject(objects, 'title')
    seen.add(cardSourceOf(handles.doc))
    expect(seen.size).toBe(4)
  })

  it('is not changed by another slide, and is null for a deck without slides', () => {
    const { handles, second } = deck()
    const source = cardSourceOf(handles.doc)
    removeObject(getSlideObjectsCtx(handles, second.id)!, 'caption')
    expect(cardSourceOf(handles.doc)).toBe(source)
    expect(cardSourceOf(new Y.Doc())).toBeNull()
  })
})
