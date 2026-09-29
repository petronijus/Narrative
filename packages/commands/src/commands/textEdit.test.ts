import { describe, expect, it } from 'vitest'
import { getParagraphs, getPlainString } from '@narrative/slide-model'
import { harness, type Harness } from '../testing/harness.js'

const T1 = { slide: 's1', object: 't1' }

/** The body of t1 as queries show it, and its inline runs. */
const shown = (h: Harness, target = T1) =>
  h.run<{
    object: { text: string; paragraphs?: Array<{ runs: unknown[]; list?: string; level?: number }> }
  }>('query.object', { slide: target.slide, object: target.object }).object

const lists = (h: Harness) =>
  getParagraphs(h.text('s1', 't1')).map((p) => [p.text, p.attrs.list ?? null, p.attrs.level ?? 0])

describe('text.edit', () => {
  it('splices at display offsets; inserted text takes the formatting before it', () => {
    const h = harness()
    // "Quarterly results", "results" bold: typing at its end stays bold,
    // replacing it whole takes the plain space before it.
    const out = h.run('text.edit', {
      target: T1,
      edits: [
        { at: 17, insert: '!' },
        { at: 0, delete: 9, insert: 'Annual' },
      ],
    })
    expect(out).toEqual({ length: 15, caret: 6 })
    expect(shown(h).paragraphs?.[0]?.runs).toEqual([
      { text: 'Annual ' },
      { text: 'results!', fontWeight: 700 },
    ])
    h.run('text.edit', { target: T1, edits: [{ at: 7, delete: 8, insert: 'figures' }] })
    expect(shown(h)).toMatchObject({ text: 'Annual figures' })
    expect(shown(h).paragraphs).toBeUndefined()
  })

  it('counts a paragraph break as two characters and continues a list on "\\n\\n"', () => {
    const h = harness()
    h.run('text.set', {
      target: T1,
      text: { paragraphs: [{ list: 'bullet', text: 'One' }, { text: 'Two' }] },
    })
    // "One\n\nTwo": Two starts at 5.
    h.run('text.edit', { target: T1, edits: [{ at: 5, delete: 3, insert: 'Dos' }] })
    h.run('text.edit', { target: T1, edits: [{ at: 3, insert: '\n\nOne and a half' }] })
    expect(lists(h)).toEqual([
      ['One', 'bullet', 0],
      ['One and a half', 'bullet', 0],
      ['Dos', null, 0],
    ])
  })

  it("applies the editor's Enter rules", () => {
    const h = harness()
    h.run('text.set', {
      target: T1,
      text: { paragraphs: [{ list: 'number', text: 'First' }] },
    })
    // Enter at the end continues the list, typing fills the new item.
    let out = h.run<{ caret: number }>('text.edit', {
      target: T1,
      edits: [
        { at: 5, key: 'Enter' },
        { at: 7, insert: 'Second' },
      ],
    })
    expect(out.caret).toBe(13)
    // Enter on a new empty item nested at level 1 outdents it, then ends the list.
    h.run('text.edit', { target: T1, edits: [{ at: 13, key: 'Enter' }] })
    h.run('text.list', { target: T1, range: { start: 15, length: 0 }, indent: 1 })
    expect(lists(h)[2]).toEqual(['', 'number', 1])
    h.run('text.edit', { target: T1, edits: [{ at: 15, key: 'Enter' }] })
    expect(lists(h)[2]).toEqual(['', 'number', 0])
    out = h.run('text.edit', { target: T1, edits: [{ at: 15, key: 'Enter' }] })
    expect(lists(h)[2]).toEqual(['', null, 0])
    expect(out.caret).toBe(15)
  })

  it("applies the editor's Backspace rules at the start of a paragraph", () => {
    const h = harness()
    h.run('text.set', {
      target: T1,
      text: {
        paragraphs: [
          { list: 'bullet', text: 'A' },
          { list: 'bullet', level: 1, text: 'B' },
          { text: 'C' },
        ],
      },
    })
    // "A\n\nB\n\nC": B at 3, C at 6.
    h.run('text.edit', { target: T1, edits: [{ at: 3, key: 'Backspace' }] })
    expect(lists(h)[1]).toEqual(['B', 'bullet', 0])
    const out = h.run<{ caret: number }>('text.edit', {
      target: T1,
      edits: [{ at: 6, key: 'Backspace' }],
    })
    expect(lists(h).map((p) => p[0])).toEqual(['A', 'BC'])
    expect(out.caret).toBe(4)
    h.run('text.edit', { target: T1, edits: [{ at: 0, key: 'Backspace' }] })
    expect(lists(h)[0]).toEqual(['A', null, 0])
    // Mid-paragraph it deletes the character before, a surrogate pair whole.
    h.run('text.edit', { target: T1, edits: [{ at: 1, insert: '😀' }] })
    h.run('text.edit', { target: T1, edits: [{ at: 3, key: 'Backspace' }] })
    expect(getPlainString(h.text('s1', 't1')).startsWith('A ')).toBe(true)
  })

  it('edits a table cell, and refuses offsets past the end', () => {
    const h = harness()
    const cell = { slide: 's1', object: 'tbl1', cell: { row: 0, col: 0 } }
    h.run('text.set', { target: cell, text: 'Q3' })
    h.run('text.edit', { target: cell, edits: [{ at: 1, delete: 1, insert: '4' }] })
    expect(h.text('s1', 'tbl1', { row: 0, col: 0 }).toString()).toBe('Q4')
    expect(h.fail('text.edit', { target: cell, edits: [{ at: 3, insert: 'x' }] }).code).toBe(
      'conflict',
    )
    expect(h.fail('text.edit', { target: T1, edits: [{ at: 0 }] }).code).toBe('invalid_input')
  })
})

describe('offsets inside a paragraph break', () => {
  it('are refused by text.edit and never matched by text.replace', () => {
    const h = harness()
    h.run('text.set', { target: T1, text: 'ab\n\ncd' })
    // "ab\n\ncd": the break is display 2..4; 3 is between its characters.
    expect(h.fail('text.edit', { target: T1, edits: [{ at: 3, delete: 1 }] }).code).toBe('conflict')
    expect(h.fail('text.edit', { target: T1, edits: [{ at: 2, delete: 1 }] }).code).toBe('conflict')
    h.run('text.edit', { target: T1, edits: [{ at: 2, delete: 2 }] })
    expect(shown(h).text).toBe('abcd')
    h.run('text.set', { target: T1, text: 'ab\n\ncd' })
    expect(
      h.run<{ replaced: number }>('text.replace', { find: '\nc', replace: 'X' }).replaced,
    ).toBe(0)
  })
})

describe('text.replace', () => {
  it('replaces across the deck in boxes and cells, keeping the replaced formatting', () => {
    const h = harness()
    h.run('text.set', {
      target: { slide: 's1', object: 'tbl1', cell: { row: 1, col: 1 } },
      text: 'results table',
    })
    const out = h.run('text.replace', { find: 'results', replace: 'figures' })
    expect(out).toEqual({
      replaced: 2,
      bodies: [
        { slide: 's1', object: 't1', count: 1 },
        { slide: 's1', object: 'tbl1', cell: { row: 1, col: 1 }, count: 1 },
      ],
    })
    // "results" was bold: so is "figures".
    expect(shown(h).paragraphs?.[0]?.runs).toEqual([
      { text: 'Quarterly ' },
      { text: 'figures', fontWeight: 700 },
    ])
    expect(h.text('s1', 'tbl1', { row: 1, col: 1 }).toString()).toBe('figures table')
  })

  it('matches case and whole words only when asked', () => {
    const h = harness()
    h.run('text.set', { target: T1, text: 'Cat, cat and concatenate' })
    expect(
      h.run<{ replaced: number }>('text.replace', {
        find: 'cat',
        replace: 'dog',
        slide: 's1',
        objects: ['t1'],
        matchCase: false,
        wholeWord: true,
      }).replaced,
    ).toBe(2)
    expect(shown(h).text).toBe('dog, dog and concatenate')
    expect(
      h.run<{ replaced: number }>('text.replace', { find: 'Dog', replace: 'x' }).replaced,
    ).toBe(0)
  })

  it('refuses objects that hold no text, and objects without a slide', () => {
    const h = harness()
    expect(
      h.fail('text.replace', { find: 'a', replace: 'b', slide: 's1', objects: ['r1'] }).code,
    ).toBe('invalid_input')
    expect(h.fail('text.replace', { find: 'a', replace: 'b', objects: ['t1'] }).code).toBe(
      'invalid_input',
    )
  })
})
