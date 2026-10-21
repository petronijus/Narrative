/**
 * state/useDeckStore.test.tsx — the selector hooks over the shared deck store
 * (performance.md → E1, E6): a component re-renders when what it selected
 * changed, and not when another object, slide or the speaker notes did.
 */

import { describe, it, expect } from 'vitest'
import { render, act } from '@testing-library/react'
import React from 'react'
import * as Y from 'yjs'
import {
  addObject,
  addSlide,
  applyParagraphPatch,
  createSlideDoc,
  getDeckStore,
  getSlideObjectsCtx,
  setSlideNotes,
  spliceRichText,
  updateObject,
  LOCAL_ORIGIN,
  type SlideMutationContext,
} from '@narrative/slide-model'
import type { RectangleObject, SlideObject, TextObject } from '@narrative/shared'
import { SlideDocContext, createMockSlideDocValue } from './slideDocContext.js'
import { ActiveSlideContext } from './ActiveSlideContext.js'
import { useTextRunAttrs } from '../ui/useTextRunAttrs.js'
import {
  useActiveSlideObject,
  useActiveSlideObjectFields,
  useActiveSlideObjects,
  useActiveSlideObjectsWhere,
  useSlideIdsKey,
} from './useDeckStore.js'

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
    width: 300,
    height: 40,
    rotation: 0,
    opacity: 1,
    fontSize: 24,
    fontWeight: 'normal',
    color: 0,
    align: 'left',
    text: body,
  }) as TextObject

function deck(): { ctx: SlideMutationContext; slideId: string } {
  const { doc, slides } = createSlideDoc()
  const ctx: SlideMutationContext = { doc, slides }
  const slideId = slides.get(0).get('id') as string
  const objects = getSlideObjectsCtx(ctx, slideId)!
  addObject(objects, rect('a'))
  addObject(objects, rect('b', 50))
  addObject(objects, { ...rect('c'), locked: true })
  return { ctx, slideId }
}

/** Renders `probe` under the deck's contexts; `renders` counts its renders. */
function mount<T>(ctx: SlideMutationContext, slideId: string, probe: () => T) {
  const seen: { renders: number; value: T | undefined } = { renders: 0, value: undefined }
  function Probe() {
    seen.value = probe()
    seen.renders++
    return null
  }
  render(
    <SlideDocContext value={createMockSlideDocValue({ deckCtx: ctx })}>
      <ActiveSlideContext value={{ activeSlideId: slideId, setActiveSlideId: () => {} }}>
        <Probe />
      </ActiveSlideContext>
    </SlideDocContext>,
  )
  return seen
}

/** Deliver the store's pending notification, as the next frame would. */
const frame = (ctx: SlideMutationContext): void => act(() => getDeckStore(ctx).flush())

describe('deck store selector hooks', () => {
  it('useActiveSlideObject re-renders for its object only', () => {
    const { ctx, slideId } = deck()
    const seen = mount(ctx, slideId, () => useActiveSlideObject('a'))
    const before = seen.renders
    const a = seen.value
    expect(a?.x).toBe(0)

    updateObject(getSlideObjectsCtx(ctx, slideId)!, 'b', { x: 99 })
    frame(ctx)
    expect(seen.renders).toBe(before)
    expect(seen.value).toBe(a)

    updateObject(getSlideObjectsCtx(ctx, slideId)!, 'a', { x: 7 })
    frame(ctx)
    expect(seen.renders).toBe(before + 1)
    expect(seen.value?.x).toBe(7)
  })

  it('useActiveSlideObjects follows every object; notes changes render nothing', () => {
    const { ctx, slideId } = deck()
    const seen = mount(ctx, slideId, () => useActiveSlideObjects())
    expect(seen.value?.map((o) => o.id)).toEqual(['a', 'b', 'c'])
    const before = seen.renders
    setSlideNotes(ctx, slideId, [{ type: 'paragraph', content: [{ text: 'hello' }] }])
    frame(ctx)
    expect(seen.renders).toBe(before)

    updateObject(getSlideObjectsCtx(ctx, slideId)!, 'b', { x: 1 })
    frame(ctx)
    expect(seen.renders).toBe(before + 1)
  })

  it('useActiveSlideObjectsWhere re-renders only when its subset changes', () => {
    const { ctx, slideId } = deck()
    const locked = (o: SlideObject): boolean => o.locked === true
    const seen = mount(ctx, slideId, () => useActiveSlideObjectsWhere(locked))
    expect(seen.value?.map((o) => o.id)).toEqual(['c'])
    const before = seen.renders
    updateObject(getSlideObjectsCtx(ctx, slideId)!, 'a', { x: 5 })
    frame(ctx)
    expect(seen.renders).toBe(before)
    updateObject(getSlideObjectsCtx(ctx, slideId)!, 'a', { locked: true })
    frame(ctx)
    expect(seen.value?.map((o) => o.id)).toEqual(['a', 'c'])
  })

  it('useSlideIdsKey changes with the slide list, not with edits inside slides', () => {
    const { ctx, slideId } = deck()
    const seen = mount(ctx, slideId, () => useSlideIdsKey())
    const before = seen.renders
    updateObject(getSlideObjectsCtx(ctx, slideId)!, 'a', { x: 3 })
    frame(ctx)
    expect(seen.renders).toBe(before)
    const added = addSlide(ctx)
    frame(ctx)
    expect(seen.value).toBe(`${slideId}\n${added.id}`)
  })

  it('useActiveSlideObjectFields skips a change inside the text, not a field write', () => {
    const { ctx, slideId } = deck()
    addObject(getSlideObjectsCtx(ctx, slideId)!, text('t', 'hello'))
    const seen = mount(ctx, slideId, () => useActiveSlideObjectFields('t'))
    const before = seen.renders
    const first = seen.value as TextObject
    const yText = first.text as Y.Text
    expect(yText).toBeInstanceOf(Y.Text)

    // Typing and a paragraph format: the store rebuilt the object, the
    // fields are the same — no render, and the Y.Text held is the live one.
    spliceRichText(ctx.doc, yText, 5, 0, ' world', LOCAL_ORIGIN)
    ctx.doc.transact(() => applyParagraphPatch(yText, 0, yText.length, { list: 'bullet' }))
    frame(ctx)
    expect(getDeckStore(ctx).getObject(slideId, 't')).not.toBe(first)
    expect(seen.renders).toBe(before)
    // (the paragraph patch terminates the paragraph with its separator)
    expect((seen.value as TextObject).text.toString()).toMatch(/^hello world/)

    // A field write is a change.
    updateObject(getSlideObjectsCtx(ctx, slideId)!, 't', { opacity: 0.5 })
    frame(ctx)
    expect(seen.renders).toBe(before + 1)
    expect(seen.value?.opacity).toBe(0.5)
  })

  it('useTextRunAttrs re-renders when the paragraphs change, not on typing', () => {
    const { ctx, slideId } = deck()
    addObject(getSlideObjectsCtx(ctx, slideId)!, text('t', 'hello'))
    const obj = getDeckStore(ctx).getObject(slideId, 't') as TextObject
    const yText = obj.text as Y.Text
    const seen = mount(ctx, slideId, () => useTextRunAttrs(obj))
    const before = seen.renders
    expect(seen.value?.paraAttrs).toEqual({})
    expect(seen.value?.selAttrs).toBeNull()

    spliceRichText(ctx.doc, yText, 5, 0, ' world', LOCAL_ORIGIN)
    frame(ctx)
    expect(seen.renders).toBe(before)

    ctx.doc.transact(() => applyParagraphPatch(yText, 0, yText.length, { list: 'bullet' }))
    frame(ctx)
    expect(seen.renders).toBe(before + 1)
    expect(seen.value?.paraAttrs.list).toBe('bullet')
  })
})
