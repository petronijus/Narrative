/**
 * slide-model/src/slideObserve.replace.test.ts
 *
 * An object replaced in place — deleted and re-inserted under the same id
 * at the same index in one tick (replaceObject; a collaborator's
 * replacement arriving as one update) — must reach the subscriber. The
 * batch treated every delete + insert of one id as a pure reorder and only
 * re-emitted it when the order changed, so an in-place replacement updated
 * the internal snapshot silently: the editor kept showing a rectangle that
 * the document had already turned into a path (found 2026-09-28 by the
 * path-editing e2e spec).
 */

import { describe, it, expect } from 'vitest'
import { subscribeToSlideObjectsWithFlush, type ObjectChangeSet } from './slideObserve.js'
import { createSlideDoc } from './yDoc.js'
import { addSlide, getSlideObjectsCtx, type SlideMutationContext } from './slides.js'
import { addObject, removeObject, replaceObject } from './mutations.js'
import type { PathObject, RectangleObject } from '@narrative/shared'

const rect = (id: string, x: number): RectangleObject => ({
  id,
  type: 'rectangle',
  x,
  y: 0,
  width: 100,
  height: 50,
  rotation: 0,
  opacity: 1,
  fill: 0xff0000,
})

function makeCtx(): SlideMutationContext {
  const { doc, slides } = createSlideDoc()
  return { doc, slides }
}

describe('an object replaced in place', () => {
  it('is re-emitted (removed + added) with its new content and the same order', () => {
    const ctx = makeCtx()
    const slide = addSlide(ctx)
    const objects = getSlideObjectsCtx(ctx, slide.id)!
    addObject(objects, rect('a', 0))
    addObject(objects, rect('b', 200))
    addObject(objects, rect('c', 400))
    const emitted: ObjectChangeSet[] = []
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slide.id, (c) => {
      emitted.push(c)
    })
    const before = emitted.length

    const path: PathObject = {
      id: 'b',
      type: 'path',
      x: 200,
      y: 0,
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      anchors: [
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ],
      stroke: 0,
      strokeWidth: 1,
    }
    replaceObject(objects, path)
    flush()

    expect(emitted).toHaveLength(before + 1)
    const change = emitted.at(-1)!
    expect(change.removed).toEqual(['b'])
    expect(change.added.map((o) => [o.id, o.type])).toEqual([['b', 'path']])
    expect(change.snapshot.map((o) => [o.id, o.type])).toEqual([
      ['a', 'rectangle'],
      ['b', 'path'],
      ['c', 'rectangle'],
    ])
    unsubscribe()
  })

  it('replaced and then removed within one tick is reported as removed', () => {
    const ctx = makeCtx()
    const slide = addSlide(ctx)
    const objects = getSlideObjectsCtx(ctx, slide.id)!
    addObject(objects, rect('a', 0))
    const emitted: ObjectChangeSet[] = []
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slide.id, (c) => {
      emitted.push(c)
    })
    const before = emitted.length

    replaceObject(objects, { ...rect('a', 0), x: 50 })
    removeObject(objects, 'a')
    flush()

    const change = emitted.at(-1)!
    expect(emitted.length).toBe(before + 1)
    expect(change.removed).toEqual(['a'])
    expect(change.added).toEqual([])
    expect(change.snapshot).toEqual([])
    unsubscribe()
  })
})
