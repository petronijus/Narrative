import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createSlideDoc } from './yDoc.js'
import { getSlideNotes, listSlides, updateSlideTransition } from './slides.js'
import { clearSlideTransitionDirection, getSlideNotesText } from './slideMeta.js'
import { createUndoManager } from './undo.js'

function deck() {
  const { doc, slides } = createSlideDoc()
  return { doc, slides }
}

function para(text: string, name = 'paragraph'): Y.XmlElement {
  const el = new Y.XmlElement(name)
  const t = new Y.XmlText()
  t.insert(0, text)
  el.insert(0, [t])
  return el
}

describe('clearSlideTransitionDirection', () => {
  it('removes a push direction that updateSlideTransition cannot clear, as one undo step', () => {
    const ctx = deck()
    const id = listSlides(ctx)[0]!.id
    updateSlideTransition(ctx, id, { kind: 'push', durationMs: 400, direction: 'left' })
    const undo = createUndoManager(ctx)
    expect(clearSlideTransitionDirection(ctx, id)).toBe(true)
    expect(listSlides(ctx)[0]!.transition).toEqual({ kind: 'push', durationMs: 400 })
    expect(undo.undoStack).toHaveLength(1)
  })

  it('writes nothing when there is no direction or no slide', () => {
    const ctx = deck()
    const id = listSlides(ctx)[0]!.id
    const before = Y.encodeStateVector(ctx.doc)
    expect(clearSlideTransitionDirection(ctx, id)).toBe(false)
    expect(clearSlideTransitionDirection(ctx, 'missing')).toBe(false)
    expect(Y.encodeStateVector(ctx.doc)).toEqual(before)
  })
})

describe('getSlideNotesText', () => {
  it('reads paragraphs, headings, lists and hard breaks as plain text', () => {
    const ctx = deck()
    const notes = getSlideNotes(ctx, listSlides(ctx)[0]!.id)!
    ctx.doc.transact(() => {
      const withBreak = new Y.XmlElement('paragraph')
      const a = new Y.XmlText()
      a.insert(0, 'line one')
      const b = new Y.XmlText()
      b.insert(0, 'line two', { bold: {} })
      withBreak.insert(0, [a, new Y.XmlElement('hardBreak'), b])
      const bullets = new Y.XmlElement('bulletList')
      const item1 = new Y.XmlElement('listItem')
      item1.insert(0, [para('first')])
      const nested = new Y.XmlElement('orderedList')
      nested.setAttribute('start', 3 as unknown as string)
      const n1 = new Y.XmlElement('listItem')
      n1.insert(0, [para('three')])
      const n2 = new Y.XmlElement('listItem')
      n2.insert(0, [para('four')])
      nested.insert(0, [n1, n2])
      const item2 = new Y.XmlElement('listItem')
      item2.insert(0, [para('second'), nested])
      bullets.insert(0, [item1, item2])
      notes.insert(0, [para('Title', 'heading'), withBreak, bullets])
    })
    expect(getSlideNotesText(ctx, listSlides(ctx)[0]!.id)).toBe(
      ['Title', 'line one\nline two', '- first', '- second', '  3. three', '  4. four'].join('\n'),
    )
  })

  it('never writes: a slide without a notes fragment reads as empty, a missing slide as null', () => {
    const ctx = deck()
    const slide = ctx.slides.get(0)
    ctx.doc.transact(() => slide.delete('notes'))
    const before = Y.encodeStateVector(ctx.doc)
    expect(getSlideNotesText(ctx, listSlides(ctx)[0]!.id)).toBe('')
    expect(getSlideNotesText(ctx, 'missing')).toBeNull()
    expect(Y.encodeStateVector(ctx.doc)).toEqual(before)
  })
})
