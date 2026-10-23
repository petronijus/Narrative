// @vitest-environment node
/**
 * state/extractComponentSnapshot.test.ts
 *
 * M16 P6 — Unit tests for the master-doc → plain-snapshot walker.
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { extractComponentSnapshot } from './extractComponentSnapshot'

function buildMasterDoc(populate: (slide: Y.Map<unknown>, doc: Y.Doc) => void): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    const slides = doc.getArray<Y.Map<unknown>>('slides')
    const slide = new Y.Map<unknown>()
    slide.set('id', 'master')
    const objects = new Y.Array<Y.Map<unknown>>()
    const animations = new Y.Array<Y.Map<unknown>>()
    slide.set('objects', objects)
    slide.set('animations', animations)
    slides.push([slide])
    populate(slide, doc)
  })
  return doc
}

function pushObject(slide: Y.Map<unknown>, plain: Record<string, unknown>): void {
  const objects = slide.get('objects') as Y.Array<Y.Map<unknown>>
  const yMap = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(plain)) yMap.set(k, v)
  objects.push([yMap])
}

describe('extractComponentSnapshot', () => {
  it('returns null when slides array is empty (pre-sync)', () => {
    const doc = new Y.Doc()
    expect(extractComponentSnapshot(doc)).toBeNull()
  })

  it('returns null when slides[0] has no first slide', () => {
    const doc = new Y.Doc()
    doc.getArray<Y.Map<unknown>>('slides') // create the array, but empty
    expect(extractComponentSnapshot(doc)).toBeNull()
  })

  it('walks Y.Map → plain object with primitive fields', () => {
    const doc = buildMasterDoc((slide) => {
      pushObject(slide, {
        id: 'r1',
        type: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        rotation: 0,
        opacity: 1,
        fill: 0xff00ff,
      })
    })

    const snap = extractComponentSnapshot(doc)
    expect(snap).not.toBeNull()
    expect(snap!.objects).toHaveLength(1)
    expect(snap!.objects[0]).toMatchObject({
      id: 'r1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: 0xff00ff,
    })
  })

  it('computes union bounding box across multiple objects', () => {
    const doc = buildMasterDoc((slide) => {
      pushObject(slide, {
        id: 'a',
        type: 'rectangle',
        x: 100,
        y: 50,
        width: 200,
        height: 100,
        rotation: 0,
        opacity: 1,
      })
      pushObject(slide, {
        id: 'b',
        type: 'rectangle',
        x: 400,
        y: 200,
        width: 50,
        height: 50,
        rotation: 0,
        opacity: 1,
      })
    })
    const snap = extractComponentSnapshot(doc)!
    expect(snap.bbox).toEqual({ x: 100, y: 50, width: 350, height: 200 })
  })

  it('memoises by state vector — identical doc returns identity-equal snapshot', () => {
    const doc = buildMasterDoc((slide) => {
      pushObject(slide, {
        id: 'r1',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
      })
    })
    const a = extractComponentSnapshot(doc)
    const b = extractComponentSnapshot(doc)
    expect(a).toBe(b) // identity equality => cache hit
  })

  it('invalidates cache when the doc mutates', () => {
    const doc = buildMasterDoc((slide) => {
      pushObject(slide, {
        id: 'r1',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
      })
    })
    const before = extractComponentSnapshot(doc)!
    expect(before.objects).toHaveLength(1)

    doc.transact(() => {
      const slide = doc.getArray<Y.Map<unknown>>('slides').get(0)
      pushObject(slide, {
        id: 'r2',
        type: 'rectangle',
        x: 50,
        y: 50,
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
      })
    })

    const after = extractComponentSnapshot(doc)!
    expect(after).not.toBe(before)
    expect(after.objects).toHaveLength(2)
  })

  it('walks nested Y.Array fields (e.g. gradient stops) into plain arrays', () => {
    const doc = buildMasterDoc((slide) => {
      const objects = slide.get('objects') as Y.Array<Y.Map<unknown>>
      const obj = new Y.Map<unknown>()
      obj.set('id', 'r1')
      obj.set('type', 'rectangle')
      obj.set('x', 0)
      obj.set('y', 0)
      obj.set('width', 10)
      obj.set('height', 10)
      obj.set('rotation', 0)
      obj.set('opacity', 1)
      const stops = new Y.Array<Y.Map<unknown>>()
      const stop = new Y.Map<unknown>()
      stop.set('offset', 0.5)
      stop.set('color', 0xff0000)
      stops.push([stop])
      obj.set('stops', stops)
      objects.push([obj])
    })

    const snap = extractComponentSnapshot(doc)!
    const obj = snap.objects[0] as unknown as { stops: Array<{ offset: number; color: number }> }
    expect(Array.isArray(obj.stops)).toBe(true)
    expect(obj.stops[0]).toEqual({ offset: 0.5, color: 0xff0000 })
  })

  it('flattens Y.Text fields into plain strings', () => {
    const doc = buildMasterDoc((slide) => {
      const objects = slide.get('objects') as Y.Array<Y.Map<unknown>>
      const obj = new Y.Map<unknown>()
      obj.set('id', 't1')
      obj.set('type', 'text')
      obj.set('x', 0)
      obj.set('y', 0)
      obj.set('width', 100)
      obj.set('height', 30)
      obj.set('rotation', 0)
      obj.set('opacity', 1)
      obj.set('text', new Y.Text('hello world'))
      objects.push([obj])
    })
    const snap = extractComponentSnapshot(doc)!
    const t = snap.objects[0] as unknown as { text: string }
    expect(t.text).toBe('hello world')
  })
})
