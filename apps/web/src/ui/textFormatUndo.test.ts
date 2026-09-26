/**
 * ui/textFormatUndo.test.ts
 *
 * Undo attribution of the Inspector's text-format and list gestures.
 *
 * The editor's Y.UndoManager tracks only LOCAL_ORIGIN, and a nested
 * `doc.transact` keeps the OUTERMOST origin. Two ways that went wrong:
 *   - `Y.Text.format` calls from the Inspector ran bare (their own
 *     origin-less transaction): the run strip fell out of undo history
 *     while the box-wide patch next to it landed on it, so Mod+Z restored
 *     the box value and left the runs stripped;
 *   - `textListOps` wrapped its paragraph edits in an origin-less outer
 *     transaction, taking the whole list edit out of undo history.
 *
 * `captureTimeout = 0` stops the manager from merging separate
 * transactions by time, so "one stack item" really means "one
 * transaction" here.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addObject,
  addSlide,
  createSlideDoc,
  createUndoManager,
  getSlideObjectsCtx,
  listSlides,
  readParagraphAttrsForRange,
  updateObject,
  type ObjectsMutationContext,
  type SlideMutationContext,
} from '@narrative/slide-model'
import type { SlideObjectPatch, TextObject } from '@narrative/shared'
import { clearAllInlineRunAttrs, transactTextAction } from './textEditSelection.js'
import { setListKind } from './textListOps.js'

interface Fixture {
  undoManager: Y.UndoManager
  objectsCtx: ObjectsMutationContext
  read: () => TextObject
  patch: (p: SlideObjectPatch<TextObject>) => void
}

function makeDeck(seed: Partial<TextObject>, seedText: (t: Y.Text) => void): Fixture {
  const { doc, slides } = createSlideDoc()
  const ctx: SlideMutationContext = { doc, slides }
  const slide = addSlide(ctx)
  const objectsCtx = getSlideObjectsCtx(ctx, slide.id)
  if (objectsCtx === null) throw new Error('slide objects ctx missing')
  const text = new Y.Text()
  addObject(objectsCtx, {
    id: 'text-1',
    type: 'text',
    x: 0,
    y: 0,
    width: 400,
    height: 100,
    rotation: 0,
    opacity: 1,
    fontSize: 32,
    fontWeight: 400,
    color: 0,
    align: 'left',
    text,
    ...seed,
  } as unknown as TextObject)
  const read = (): TextObject => {
    const s = listSlides(ctx).find((x) => x.id === slide.id)
    const o = s?.objects.find((x) => x.id === 'text-1')
    if (o === undefined) throw new Error('text object missing')
    return o as TextObject
  }
  const live = read().text
  if (!(live instanceof Y.Text)) throw new Error('expected a live Y.Text')
  doc.transact(() => seedText(live))
  // Built after the seed so the fixture itself is not on the stack.
  const undoManager = createUndoManager(ctx)
  undoManager.captureTimeout = 0
  const patch = (p: SlideObjectPatch<TextObject>): void => updateObject(objectsCtx, 'text-1', p)
  return { undoManager, objectsCtx, read, patch }
}

function runWeights(t: Y.Text): Array<unknown> {
  return (t.toDelta() as Array<{ attributes?: Record<string, unknown> }>).map(
    (op) => op.attributes?.['fontWeight'],
  )
}

describe('Inspector format gestures', () => {
  it('strip + box patch are one undo step that restores both', () => {
    const { undoManager, read, patch } = makeDeck({}, (t) => {
      t.insert(0, 'Hello world')
      t.format(0, 5, { fontWeight: 700 })
    })
    const obj = read()

    transactTextAction(obj, () => {
      clearAllInlineRunAttrs(obj.text, ['fontWeight'])
      patch({ fontWeight: 300 } as SlideObjectPatch<TextObject>)
    })
    expect(read().fontWeight).toBe(300)
    expect(runWeights(read().text as Y.Text)).toEqual([undefined])
    expect(undoManager.undoStack).toHaveLength(1)

    undoManager.undo()
    expect(read().fontWeight).toBe(400)
    expect(runWeights(read().text as Y.Text)).toEqual([700, undefined])
  })

  it('a bare helper call is still undoable on its own', () => {
    const { undoManager, read } = makeDeck({}, (t) => {
      t.insert(0, 'Hello')
      t.format(0, 5, { fontWeight: 700 })
    })

    clearAllInlineRunAttrs(read().text, ['fontWeight'])
    expect(runWeights(read().text as Y.Text)).toEqual([undefined])
    expect(undoManager.canUndo()).toBe(true)

    undoManager.undo()
    expect(runWeights(read().text as Y.Text)).toEqual([700])
  })
})

describe('list gestures', () => {
  it('legacy migration + list change are one undo step', () => {
    const { undoManager, read, patch } = makeDeck(
      { listStyle: 'bullet' } as Partial<TextObject>,
      (t) => t.insert(0, 'one\ntwo'),
    )

    setListKind(read(), 'number', patch)
    const yText = read().text as Y.Text
    expect(read().listStyle).toBeUndefined()
    expect(readParagraphAttrsForRange(yText, 0, yText.length).list).toBe('number')
    expect(undoManager.undoStack).toHaveLength(1)

    undoManager.undo()
    expect(read().listStyle).toBe('bullet')
    expect(readParagraphAttrsForRange(yText, 0, yText.length).list).toBeUndefined()
  })
})
