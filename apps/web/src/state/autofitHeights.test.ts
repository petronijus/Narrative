// @vitest-environment node
/**
 * state/autofitHeights.test.ts — when the editor writes a growing box's
 * height back: after the person's own change, at once (so it joins that
 * undo step), once; never after an undo, a peer's or an agent's change.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { LOCAL_ORIGIN, agentOrigin, createUndoManager } from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'
import { watchAutofitHeights } from './autofitHeights'

/** A deck with one slide `s1` holding text box `t1` (stored height 100). */
function deck(grows = true) {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  const text = new Y.Text('One line')
  const box = new Y.Map<unknown>()
  doc.transact(() => {
    const slide = new Y.Map<unknown>()
    const objects = new Y.Array<Y.Map<unknown>>()
    slide.set('id', 's1')
    slide.set('objects', objects)
    slides.push([slide])
    box.set('id', 't1')
    box.set('type', 'text')
    box.set('height', 100)
    box.set('text', text)
    if (grows) box.set('autofit', 'grow-down')
    objects.push([box])
  })
  return { doc, slides, box, text }
}

/** Lines of 50 px: the drawn height follows the text's length. */
const measure = (data: TextObject): number =>
  Math.ceil((data.text instanceof Y.Text ? data.text.length : 1) / 20) * 50

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

function watch(d: ReturnType<typeof deck>) {
  const writes: Array<[string, string, number]> = []
  const stop = watchAutofitHeights(d.doc, {
    measure,
    // As the command would: the person's change, in their origin.
    write: (slide, object, height) => {
      writes.push([slide, object, height])
      d.doc.transact(() => d.box.set('height', height), LOCAL_ORIGIN)
    },
  })
  return { writes, stop }
}

describe('watchAutofitHeights', () => {
  it("writes the measured height after the person's change, once", async () => {
    const d = deck()
    const w = watch(d)
    d.doc.transact(() => d.text.insert(8, ' and more text that wraps twice over'), LOCAL_ORIGIN)
    await flush()
    expect(w.writes).toEqual([['s1', 't1', 150]])
    expect(d.box.get('height')).toBe(150)
  })

  it('joins the change in one undo step, and writes nothing after the undo', async () => {
    const d = deck()
    const undo = createUndoManager({ doc: d.doc, slides: d.slides })
    const w = watch(d)
    d.doc.transact(() => d.text.insert(8, ' and more text that wraps twice over'), LOCAL_ORIGIN)
    await flush()
    expect(undo.undoStack).toHaveLength(1)
    undo.undo()
    await flush()
    expect(d.text.toString()).toBe('One line')
    expect(d.box.get('height')).toBe(100)
    expect(w.writes).toHaveLength(1)
    // Redo is still there: nothing local was written after the undo.
    expect(undo.redoStack).toHaveLength(1)
  })

  it("leaves a peer's and an agent's change to be drawn, not written", async () => {
    const d = deck()
    const w = watch(d)
    d.doc.transact(() => d.text.insert(8, ' from a peer, long enough to wrap'), 'provider')
    d.doc.transact(() => d.text.insert(0, 'An agent wrote this too. '), agentOrigin('run-1'))
    await flush()
    expect(w.writes).toEqual([])
  })

  it('measures nothing for a change that cannot move the laid-out height', async () => {
    const d = deck()
    let measured = 0
    watchAutofitHeights(d.doc, {
      measure: (data) => {
        measured += 1
        return measure(data)
      },
      write: () => {},
    })
    // A drag, a rotation, an opacity slider: position and compositing only.
    d.doc.transact(() => {
      d.box.set('x', 40)
      d.box.set('y', 60)
    }, LOCAL_ORIGIN)
    d.doc.transact(() => d.box.set('rotation', 0.3), LOCAL_ORIGIN)
    d.doc.transact(() => d.box.set('opacity', 0.5), LOCAL_ORIGIN)
    await flush()
    expect(measured).toBe(0)

    // A width change in the same transaction as a move is measured.
    d.doc.transact(() => {
      d.box.set('x', 41)
      d.box.set('width', 120)
    }, LOCAL_ORIGIN)
    await flush()
    expect(measured).toBe(1)
  })

  it('ignores a box that does not grow, and stops when stopped', async () => {
    const fixed = deck(false)
    const w = watch(fixed)
    fixed.doc.transact(
      () => fixed.text.insert(8, ' and more text that wraps twice over'),
      LOCAL_ORIGIN,
    )
    await flush()
    expect(w.writes).toEqual([])

    const d = deck()
    const v = watch(d)
    v.stop()
    d.doc.transact(() => d.text.insert(8, ' and more text that wraps twice over'), LOCAL_ORIGIN)
    await flush()
    expect(v.writes).toEqual([])
  })
})
