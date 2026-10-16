/**
 * Object locks are an editor-UI concept only (decided 2026-09-26): they stop
 * a person dragging, resizing, nudging or deleting an object on the canvas,
 * and commands ignore them entirely. These tests pin that down on the
 * fixture's locked logo `lock1` (slide `s2`) so a lock check cannot creep
 * back into the command layer. Documents are compared structurally through
 * listSlides(), never as CRDT bytes.
 */

import { describe, expect, it } from 'vitest'
import { listSlides } from '@narrative/slide-model'
import { harness, type Harness } from '../testing/harness.js'

const objectsOn = (h: Harness, slide: number) => listSlides(h.deck)[slide]!.objects
const find = (h: Harness, slide: number, id: string) =>
  objectsOn(h, slide).find((o) => o.id === id)!

describe('commands ignore object locks', () => {
  it('edits a locked object and leaves the lock in place', () => {
    const h = harness()
    h.run('object.update', {
      slide: 's2',
      object: 'lock1',
      patch: { fill: '#000000', name: 'Old logo' },
    })
    h.run('object.move', { slide: 's2', objects: ['lock1'], dx: -100, dy: 20 })
    expect(find(h, 1, 'lock1')).toMatchObject({
      locked: true,
      fill: 0x000000,
      name: 'Old logo',
      x: 1500,
      y: 80,
    })
  })

  it('sets and clears `locked` like any other property, alone or mixed with other fields', () => {
    const h = harness()
    h.run('object.update', { slide: 's2', object: 'lock1', patch: { locked: null, x: 0 } })
    expect(find(h, 1, 'lock1').locked).toBeUndefined()
    expect(find(h, 1, 'lock1').x).toBe(0)
    h.run('object.update', { slide: 's2', object: 'lock1', patch: { locked: true } })
    expect(find(h, 1, 'lock1').locked).toBe(true)
  })

  it('writes text into a cell of a locked table', () => {
    const h = harness()
    h.run('object.update', { slide: 's2', object: 'tbl2', patch: { locked: true } })
    h.run('text.set', {
      target: { slide: 's2', object: 'tbl2', cell: { row: 1, col: 0 } },
      text: 'Q1',
    })
    expect(h.text('s2', 'tbl2', { row: 1, col: 0 }).toString()).toBe('Q1')
  })

  it('deletes a locked object', () => {
    const h = harness()
    const out = h.run<{ deleted: string[] }>('object.delete', { slide: 's2', objects: ['lock1'] })
    expect(out.deleted).toEqual(['lock1'])
    expect(objectsOn(h, 1).map((o) => o.id)).toEqual([
      'hd1',
      'tbl2',
      'ln1',
      'pa1',
      'st_bar',
      'st_title',
      'st_old',
    ])
  })

  it('has no `force` flag to opt past a lock', () => {
    const h = harness()
    expect(h.fail('object.delete', { slide: 's2', objects: ['lock1'], force: true }).code).toBe(
      'invalid_input',
    )
  })
})
