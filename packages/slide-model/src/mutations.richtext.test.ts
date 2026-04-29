/**
 * Rich-text mutation behaviour:
 * - addObject for a text obj seeds a Y.Text from the supplied string.
 * - updateObject text patches replace the Y.Text content in place
 *   (identity preserved) so collaborators don't lose their cursors.
 * - A legacy plain-string `text` slot is promoted to Y.Text on the
 *   first text-mutating patch.
 */
import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import { addObject, updateObject } from './mutations.js'
import { createSlideDoc } from './yDoc.js'
import { addSlide, getSlideObjectsCtx } from './slides.js'
import type { SlideMutationContext } from './slideMutationContext.js'
import type { TextObject } from '@narrative/shared'

function freshTextCtx() {
  const { doc, slides } = createSlideDoc()
  const deckCtx: SlideMutationContext = { doc, slides }
  const slide = addSlide(deckCtx)
  const ctx = getSlideObjectsCtx(deckCtx, slide.id)
  if (ctx === null) throw new Error('slide ctx missing')
  return { doc, deckCtx, ctx }
}

describe('text mutations and Y.Text', () => {
  it('addObject seeds a Y.Text for a text object whose text is a string', () => {
    const { ctx } = freshTextCtx()
    addObject(ctx, {
      id: 'a',
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
      text: 'hello',
    } as TextObject)
    const stored = ctx.objects.get(0).get('text')
    expect(stored).toBeInstanceOf(Y.Text)
    expect((stored as Y.Text).toString()).toBe('hello')
  })

  it('addObject preserves a Y.Text reference passed in directly', () => {
    const { ctx } = freshTextCtx()
    const yt = new Y.Text()
    yt.insert(0, 'pre-built')
    addObject(ctx, {
      id: 'b',
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
      text: yt,
    } as TextObject)
    const stored = ctx.objects.get(0).get('text')
    expect(stored).toBe(yt)
    expect((stored as Y.Text).toString()).toBe('pre-built')
  })

  it('updateObject text patch replaces the Y.Text contents in place (identity preserved)', () => {
    const { ctx } = freshTextCtx()
    addObject(ctx, {
      id: 'c',
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
      text: 'hello',
    } as TextObject)
    const ytBefore = ctx.objects.get(0).get('text') as Y.Text
    updateObject(ctx, 'c', { text: 'world' } as Partial<TextObject>)
    const ytAfter = ctx.objects.get(0).get('text') as Y.Text
    expect(ytAfter).toBe(ytBefore)
    expect(ytAfter.toString()).toBe('world')
  })

  it('updateObject promotes a legacy plain-string text slot to Y.Text on first patch', () => {
    const { doc, ctx } = freshTextCtx()
    // Simulate a deck saved before the rich-text migration: text is
    // stored as a plain string under the Y.Map slot, no Y.Text yet.
    const yMap = new Y.Map<unknown>()
    doc.transact(() => {
      ctx.objects.push([yMap])
      yMap.set('id', 'legacy')
      yMap.set('type', 'text')
      yMap.set('text', 'old string')
      yMap.set('x', 0)
      yMap.set('y', 0)
      yMap.set('width', 100)
      yMap.set('height', 40)
      yMap.set('rotation', 0)
      yMap.set('opacity', 1)
      yMap.set('fontSize', 24)
      yMap.set('fontWeight', 'normal')
      yMap.set('color', 0)
      yMap.set('align', 'left')
    })
    updateObject(ctx, 'legacy', { text: 'new value' } as Partial<TextObject>)
    expect(yMap.get('text')).toBeInstanceOf(Y.Text)
    expect((yMap.get('text') as Y.Text).toString()).toBe('new value')
  })
})
