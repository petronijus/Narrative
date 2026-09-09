/**
 * slide-model/src/undo.text.test.ts
 *
 * The UndoManager is built with `trackedOrigins: new Set([LOCAL_ORIGIN])`, so
 * an origin-less transaction is invisible to it. Every mutation in
 * `mutations.ts` passes LOCAL_ORIGIN — but the text-editing overlay called
 * `spliceRichText` without one, so nothing the user typed reached the undo
 * stack: moving a text box was undoable, writing the sentence inside it was
 * not. Reported 2026-09-09 as "undo suddenly doesn't work".
 *
 * These tests pin the contract at the level where it is decided — the origin
 * argument — rather than through the editor UI, so they stay meaningful even
 * when the overlay is rewritten.
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { LOCAL_ORIGIN, spliceRichText, addObject } from './mutations.js'
import { createSlideDoc } from './yDoc.js'
import { addSlide, getSlideObjectsCtx, type SlideMutationContext } from './slides.js'
import { createUndoManager } from './undo.js'
import type { TextObject } from '@narrative/shared'

function makeDeckWithText(): {
  doc: Y.Doc
  undoManager: Y.UndoManager
  yText: Y.Text
} {
  const { doc, slides } = createSlideDoc()
  const ctx: SlideMutationContext = { doc, slides }
  const slide = addSlide(ctx)
  const objectsCtx = getSlideObjectsCtx(ctx, slide.id)
  if (objectsCtx === null) throw new Error('slide objects ctx missing')

  const text = new Y.Text()
  text.insert(0, 'Hello')
  const obj = {
    id: 'text-1',
    type: 'text',
    x: 0,
    y: 0,
    width: 400,
    height: 100,
    rotation: 0,
    opacity: 1,
    text,
  } as unknown as TextObject
  addObject(objectsCtx, obj)

  // Build the manager only after the seed content exists, so the initial
  // insert isn't itself on the stack.
  const undoManager = createUndoManager(ctx)
  return { doc, undoManager, yText: text }
}

describe('undo of text edits', () => {
  it('undoes a splice made with LOCAL_ORIGIN', () => {
    const { doc, undoManager, yText } = makeDeckWithText()

    spliceRichText(doc, yText, 5, 0, ' world', LOCAL_ORIGIN)
    expect(yText.toString()).toBe('Hello world')
    expect(undoManager.canUndo()).toBe(true)

    undoManager.undo()
    expect(yText.toString()).toBe('Hello')
  })

  it('leaves an origin-less splice off the undo stack', () => {
    // This is the bug, pinned: without an origin the edit is applied but the
    // manager never sees it, so the user's Mod+Z does nothing (or worse, undoes
    // some older object-level change instead).
    const { doc, undoManager, yText } = makeDeckWithText()

    spliceRichText(doc, yText, 5, 0, ' world')
    expect(yText.toString()).toBe('Hello world')
    expect(undoManager.canUndo()).toBe(false)
  })

  it('redoes what it undid', () => {
    const { doc, undoManager, yText } = makeDeckWithText()

    spliceRichText(doc, yText, 5, 0, ' world', LOCAL_ORIGIN)
    undoManager.undo()
    expect(yText.toString()).toBe('Hello')

    undoManager.redo()
    expect(yText.toString()).toBe('Hello world')
  })

  it('undoes a structural transaction carrying LOCAL_ORIGIN', () => {
    // The Enter / Tab path in the editor mutates Y.Text inside its own
    // `doc.transact(…, LOCAL_ORIGIN)` rather than through spliceRichText.
    const { doc, undoManager, yText } = makeDeckWithText()

    doc.transact(() => {
      yText.insert(5, ' second')
    }, LOCAL_ORIGIN)
    expect(yText.toString()).toBe('Hello second')

    undoManager.undo()
    expect(yText.toString()).toBe('Hello')
  })
})
