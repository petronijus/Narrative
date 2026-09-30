/**
 * state/readMasterDoc.test.ts
 *
 * Unit tests for the master-doc snapshot reader (M16 P6).
 *
 * Builds a real Y.Doc with the schema slide-model `writeComponentMaster` writes
 * and exercises the bbox + objects + animations extraction. No Hocuspocus
 * involvement — the helper is pure read-only.
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { readMasterDoc, computeBBox } from './readMasterDoc.js'
import type { SlideObject } from '@narrative/shared'

function buildMasterDoc(args: {
  objects: Array<{ id: string; type: string; x: number; y: number; w: number; h: number }>
  animations?: Array<{ id: string; objectId: string; trigger: string }>
}): Y.Doc {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')

  doc.transact(() => {
    const slide = new Y.Map<unknown>()
    slide.set('id', 'master')
    slide.set('order', 0)

    const objs = new Y.Array<Y.Map<unknown>>()
    for (const o of args.objects) {
      const m = new Y.Map<unknown>()
      m.set('id', o.id)
      m.set('type', o.type)
      m.set('x', o.x)
      m.set('y', o.y)
      m.set('width', o.w)
      m.set('height', o.h)
      m.set('rotation', 0)
      m.set('opacity', 1)
      objs.push([m])
    }
    slide.set('objects', objs)

    const anims = new Y.Array<Y.Map<unknown>>()
    for (const a of args.animations ?? []) {
      const m = new Y.Map<unknown>()
      m.set('id', a.id)
      m.set('objectId', a.objectId)
      m.set('trigger', a.trigger)
      m.set('duration', 1000)
      anims.push([m])
    }
    slide.set('animations', anims)

    slides.push([slide])
  })

  return doc
}

describe('readMasterDoc', () => {
  it('returns null on empty doc', () => {
    const doc = new Y.Doc()
    expect(readMasterDoc(doc)).toBeNull()
    doc.destroy()
  })

  it('reads objects and bbox', () => {
    const doc = buildMasterDoc({
      objects: [
        { id: 'a', type: 'rectangle', x: 100, y: 200, w: 50, h: 30 },
        { id: 'b', type: 'rectangle', x: 200, y: 250, w: 80, h: 40 },
      ],
    })
    const snapshot = readMasterDoc(doc)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.objects).toHaveLength(2)
    expect(snapshot!.bbox).toEqual({ x: 100, y: 200, width: 180, height: 90 })
    doc.destroy()
  })

  it('reads animations', () => {
    const doc = buildMasterDoc({
      objects: [{ id: 'a', type: 'rectangle', x: 0, y: 0, w: 10, h: 10 }],
      animations: [{ id: 'anim-1', objectId: 'a', trigger: 'enter' }],
    })
    const snapshot = readMasterDoc(doc)
    expect(snapshot!.animations).toHaveLength(1)
    expect(snapshot!.animations[0]?.objectId).toBe('a')
    doc.destroy()
  })
})

describe('computeBBox', () => {
  it('returns zero-size at origin for empty input', () => {
    expect(computeBBox([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('computes the union bbox', () => {
    const objs: SlideObject[] = [
      // Cast through unknown — minimal stub is fine, computeBBox only uses x/y/w/h.
      { id: '1', x: 10, y: 20, width: 30, height: 40 } as unknown as SlideObject,
      { id: '2', x: 50, y: 5, width: 10, height: 20 } as unknown as SlideObject,
    ]
    expect(computeBBox(objs)).toEqual({ x: 10, y: 5, width: 50, height: 55 })
  })
})
