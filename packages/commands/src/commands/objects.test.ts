/**
 * Behaviour of the arrangement commands (object.duplicate / move / layer /
 * group / ungroup / align / distribute) beyond "the example runs": group
 * remapping, the crop (`imageRect`, absolute slide px) travelling with its
 * frame, stacking order and one-step undo. Documents are compared
 * structurally through listSlides(), never as CRDT bytes.
 */

import { describe, expect, it } from 'vitest'
import { createUndoManager, listSlides } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { harness, type Harness } from '../testing/harness.js'

/** s1 in the fixture, back to front. */
const S1_ORDER = ['r1', 'e1', 't1', 'img1', 'ga', 'gb', 'tbl1', 't2', 'img2']

const s1 = (h: Harness): SlideObject[] => listSlides(h.deck)[0]!.objects
const order = (h: Harness): string[] => s1(h).map((o) => o.id)
const obj = (h: Harness, id: string): Record<string, unknown> => {
  const found = s1(h).find((o) => o.id === id)
  if (found === undefined) throw new Error(`test: ${id} not on s1`)
  return found as unknown as Record<string, unknown>
}

describe('object.duplicate', () => {
  it('gives a duplicated group its own new group and leaves the original group alone', () => {
    const h = harness()
    const { objectIds } = h.run<{ objectIds: string[] }>('object.duplicate', {
      slide: 's1',
      objects: ['ga', 'gb'],
    })
    expect(objectIds).toHaveLength(2)
    const [a, b] = objectIds.map((id) => obj(h, id))
    expect(a!['groupId']).toBeDefined()
    expect(a!['groupId']).toBe(b!['groupId'])
    expect(a!['groupId']).not.toBe('grp1')
    expect(obj(h, 'ga')['groupId']).toBe('grp1')
    expect(obj(h, 'gb')['groupId']).toBe('grp1')
    // Copies land on top, in the sources' relative order, offset 20/20.
    expect(order(h).slice(-2)).toEqual(objectIds)
    expect(a).toMatchObject({ x: 120, y: 720 })
  })

  it('makes a lone copy of one group member ungrouped', () => {
    const h = harness()
    const { objectIds } = h.run<{ objectIds: string[] }>('object.duplicate', {
      slide: 's1',
      objects: ['ga'],
    })
    expect(obj(h, objectIds[0]!)['groupId']).toBeUndefined()
  })

  it("moves a cropped image's crop with the copy", () => {
    const h = harness()
    const { objectIds } = h.run<{ objectIds: string[] }>('object.duplicate', {
      slide: 's1',
      objects: ['img1'],
      offset: { x: 30, y: -10 },
    })
    expect(obj(h, objectIds[0]!)).toMatchObject({
      x: 1030,
      y: 190,
      imageRect: { x: 980, y: 140, width: 600, height: 450 },
    })
    expect(obj(h, 'img1')['imageRect']).toEqual({ x: 950, y: 150, width: 600, height: 450 })
  })

  it('is one undo step however many objects it copies', () => {
    const h = harness()
    const before = listSlides(h.deck)
    const undo = createUndoManager(h.deck)
    h.run('object.duplicate', { slide: 's1', objects: ['r1', 'e1', 't1', 'img1'] })
    expect(order(h)).toHaveLength(S1_ORDER.length + 4)
    undo.undo()
    expect(listSlides(h.deck)).toEqual(before)
    undo.destroy()
  })
})

describe('object.move', () => {
  it('moves the crop of a cropped image together with its frame', () => {
    const h = harness()
    h.run('object.move', { slide: 's1', objects: ['img1', 'r1'], dx: -50, dy: 25 })
    expect(obj(h, 'img1')).toMatchObject({
      x: 950,
      y: 225,
      imageRect: { x: 900, y: 175, width: 600, height: 450 },
    })
    expect(obj(h, 'r1')).toMatchObject({ x: 50, y: 125 })
  })
})

describe('object.layer', () => {
  it('starts from the fixture order', () => {
    expect(order(harness())).toEqual(S1_ORDER)
  })

  it('brings to the front and sends to the back, keeping a block in its relative order', () => {
    const h = harness()
    h.run('object.layer', { slide: 's1', objects: ['t1', 'r1'], move: 'front' })
    expect(order(h)).toEqual(['e1', 'img1', 'ga', 'gb', 'tbl1', 't2', 'img2', 'r1', 't1'])
    h.run('object.layer', { slide: 's1', objects: ['img2'], move: 'back' })
    expect(order(h)).toEqual(['img2', 'e1', 'img1', 'ga', 'gb', 'tbl1', 't2', 'r1', 't1'])
  })

  it('moves forward and backward past one neighbour, and is a no-op at the end', () => {
    const h = harness()
    h.run('object.layer', { slide: 's1', objects: ['e1'], move: 'forward' })
    expect(order(h)).toEqual(['r1', 't1', 'e1', 'img1', 'ga', 'gb', 'tbl1', 't2', 'img2'])
    h.run('object.layer', { slide: 's1', objects: ['tbl1'], move: 'backward' })
    expect(order(h)).toEqual(['r1', 't1', 'e1', 'img1', 'ga', 'tbl1', 'gb', 't2', 'img2'])
    h.run('object.layer', { slide: 's1', objects: ['img2'], move: 'forward' })
    h.run('object.layer', { slide: 's1', objects: ['r1'], move: 'backward' })
    expect(order(h)).toEqual(['r1', 't1', 'e1', 'img1', 'ga', 'tbl1', 'gb', 't2', 'img2'])
  })

  it('puts one object at an exact index (0 = backmost) and validates the input shape', () => {
    const h = harness()
    h.run('object.layer', { slide: 's1', objects: ['img2'], move: 'toIndex', toIndex: 2 })
    expect(order(h)).toEqual(['r1', 'e1', 'img2', 't1', 'img1', 'ga', 'gb', 'tbl1', 't2'])
    expect(
      h.fail('object.layer', { slide: 's1', objects: ['r1', 'e1'], move: 'toIndex', toIndex: 0 })
        .code,
    ).toBe('invalid_input')
    expect(h.fail('object.layer', { slide: 's1', objects: ['r1'], move: 'toIndex' }).code).toBe(
      'invalid_input',
    )
    expect(
      h.fail('object.layer', { slide: 's1', objects: ['r1'], move: 'front', toIndex: 1 }).code,
    ).toBe('invalid_input')
  })
})

describe('object.group / object.ungroup', () => {
  it('groups objects under one new id', () => {
    const h = harness()
    const { groupId } = h.run<{ groupId: string }>('object.group', {
      slide: 's1',
      objects: ['r1', 'e1'],
    })
    expect(obj(h, 'r1')['groupId']).toBe(groupId)
    expect(obj(h, 'e1')['groupId']).toBe(groupId)
  })

  it('moves only the listed members of an old group into the new one', () => {
    const h = harness()
    const { groupId } = h.run<{ groupId: string }>('object.group', {
      slide: 's1',
      objects: ['ga', 'r1'],
    })
    expect(obj(h, 'ga')['groupId']).toBe(groupId)
    expect(obj(h, 'gb')['groupId']).toBe('grp1')
  })

  it('ungroups the listed objects only', () => {
    const h = harness()
    h.run('object.ungroup', { slide: 's1', objects: ['ga'] })
    expect(obj(h, 'ga')['groupId']).toBeUndefined()
    expect(obj(h, 'gb')['groupId']).toBe('grp1')
    h.run('object.ungroup', { slide: 's1', objects: ['gb'] })
    expect(obj(h, 'gb')['groupId']).toBeUndefined()
  })
})

describe('object.align', () => {
  it('aligns edges and centres to the combined bounding box', () => {
    const h = harness()
    // r1: x 100..300, y 100..200; e1: x 500..650, y 100..250
    h.run('object.align', { slide: 's1', objects: ['r1', 'e1'], axis: 'right' })
    expect(obj(h, 'r1')['x']).toBe(450)
    expect(obj(h, 'e1')['x']).toBe(500)
    h.run('object.align', { slide: 's1', objects: ['r1', 'e1'], axis: 'center-y' })
    expect(obj(h, 'r1')['y']).toBe(125)
    expect(obj(h, 'e1')['y']).toBe(100)
  })

  it('moves the crop of a cropped image with its frame', () => {
    const h = harness()
    // img1 y 200 (crop y 150) aligned to r1's top at 100.
    h.run('object.align', { slide: 's1', objects: ['r1', 'img1'], axis: 'top' })
    expect(obj(h, 'img1')).toMatchObject({
      y: 100,
      imageRect: { x: 950, y: 50, width: 600, height: 450 },
    })
  })
})

describe('object.distribute', () => {
  it('evens the gaps and keeps the outermost objects in place, crop included', () => {
    const h = harness()
    // r1 100..300, img1 1000..1400 (crop x 950), img2 1500..1700: span 1600, widths 800, gaps 400.
    h.run('object.distribute', { slide: 's1', objects: ['img2', 'img1', 'r1'], axis: 'horizontal' })
    expect(obj(h, 'r1')['x']).toBe(100)
    expect(obj(h, 'img2')['x']).toBe(1500)
    expect(obj(h, 'img1')).toMatchObject({
      x: 700,
      imageRect: { x: 650, y: 150, width: 600, height: 450 },
    })
  })

  it('distributes vertically', () => {
    const h = harness()
    // r1 y 100..200, t1 y 400..480, ga y 700..800: span 700, heights 280, gaps 210.
    h.run('object.distribute', { slide: 's1', objects: ['r1', 't1', 'ga'], axis: 'vertical' })
    expect(obj(h, 't1')['y']).toBe(410)
  })
})
