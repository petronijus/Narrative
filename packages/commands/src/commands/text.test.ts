import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { PARAGRAPH_SEP, getParagraphDeltas, toDelta } from '@narrative/slide-model'
import { harness } from '../testing/harness.js'

const SEP = PARAGRAPH_SEP

describe('text.set', () => {
  it('replaces the body: blank lines split paragraphs, single newlines stay soft breaks, old formatting goes', () => {
    const h = harness()
    const out = h.run('text.set', {
      target: { slide: 's1', object: 't1' },
      text: 'A\nb\n\nC\n\n\n\nD',
    })
    expect(h.text('s1', 't1').toDelta()).toEqual([{ insert: `A\nb${SEP}C${SEP}${SEP}D` }])
    expect(out).toEqual({ length: 'A\nb\n\nC\n\n\n\nD'.length, paragraphs: 4 })
  })

  it('round-trips a formatted body read by query.object back through text.set exactly', () => {
    const h = harness()
    h.run('text.set', {
      target: { slide: 's1', object: 't1' },
      text: {
        paragraphs: [
          {
            list: 'bullet',
            runs: [
              { text: 'Bold', bold: true },
              { text: ' and ' },
              { text: 'red', color: '#ff0000', underline: true },
            ],
          },
          { list: 'number', level: 1, startAt: 4, numberFormat: 'lowerAlpha', text: 'sub\nline' },
          { text: '' },
          { runs: [{ text: 'Light', fontWeight: 300 }] },
        ],
      },
    })
    const read = h.run<{ object: { paragraphs: unknown } }>('query.object', {
      slide: 's1',
      object: 't1',
    })
    h.run('text.set', {
      target: { slide: 's1', object: 't2' },
      text: { paragraphs: read.object.paragraphs },
    })
    expect(getParagraphDeltas(h.text('s1', 't2'))).toEqual(getParagraphDeltas(h.text('s1', 't1')))
    expect(toDelta(h.text('s1', 't2'))).toEqual(toDelta(h.text('s1', 't1')))
    expect(getParagraphDeltas(h.text('s1', 't1'))[1]).toEqual({
      ops: [{ insert: 'sub\nline' }],
      attrs: { list: 'number', level: 1, startAt: 4, numberFormat: 'lowerAlpha' },
    })
  })

  it('writes table cells, and refuses covered cells, missing cells and objects without a body', () => {
    const h = harness()
    h.run('text.set', {
      target: { slide: 's1', object: 'tbl1', cell: { row: 2, col: 1 } },
      text: 'Total',
    })
    expect(h.text('s1', 'tbl1', { row: 2, col: 1 }).toString()).toBe('Total')
    expect(
      h.fail('text.set', {
        target: { slide: 's2', object: 'tbl2', cell: { row: 0, col: 1 } },
        text: 'x',
      }).code,
    ).toBe('conflict')
    expect(
      h.fail('text.set', {
        target: { slide: 's1', object: 'tbl1', cell: { row: 3, col: 0 } },
        text: 'x',
      }).code,
    ).toBe('not_found')
    expect(h.fail('text.set', { target: { slide: 's1', object: 'tbl1' }, text: 'x' }).code).toBe(
      'conflict',
    )
    expect(h.fail('text.set', { target: { slide: 's1', object: 'r1' }, text: 'x' }).code).toBe(
      'conflict',
    )
    expect(
      h.fail('text.set', {
        target: { slide: 's1', object: 't1', cell: { row: 0, col: 0 } },
        text: 'x',
      }).code,
    ).toBe('conflict')
    expect(
      h.fail('text.set', {
        target: { slide: 's1', object: 't1' },
        text: { paragraphs: [{ text: 'a', runs: [] }] },
      }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('text.set', {
        target: { slide: 's1', object: 't1' },
        text: { paragraphs: [{ runs: [{ text: `a${SEP}b` }] }] },
      }).code,
    ).toBe('invalid_input')
  })

  it('promotes a legacy plain-string body and clears a legacy box-wide listStyle when given rich text', () => {
    const h = harness()
    h.deck.doc.transact(() => {
      h.map('s1', 't1').set('text', 'legacy body')
      h.map('s1', 't1').set('listStyle', 'bullet')
    })
    h.run('text.set', {
      target: { slide: 's1', object: 't1' },
      text: { paragraphs: [{ text: 'fresh' }] },
    })
    expect(h.map('s1', 't1').get('text')).toBeInstanceOf(Y.Text)
    expect(h.text('s1', 't1').toString()).toBe('fresh')
    expect(h.map('s1', 't1').has('listStyle')).toBe(false)
  })
})

describe('text.format', () => {
  it('formats by match: first occurrence, a numbered occurrence, or all', () => {
    const h = harness()
    h.run('text.set', { target: { slide: 's1', object: 't1' }, text: 'go go go' })
    h.run('text.format', {
      target: { slide: 's1', object: 't1' },
      range: { match: 'go', occurrence: 2 },
      set: { italic: true },
    })
    expect(toDelta(h.text('s1', 't1'))).toEqual([
      { insert: 'go ' },
      { insert: 'go', attributes: { italic: true } },
      { insert: ' go' },
    ])
    h.run('text.format', {
      target: { slide: 's1', object: 't1' },
      range: { match: 'go', occurrence: 'all' },
      set: { bold: true },
    })
    expect(
      toDelta(h.text('s1', 't1'))
        .filter((op) => op.attributes?.fontWeight === 700)
        .map((op) => op.insert),
    ).toEqual(['go', 'go', 'go'])
  })

  it('fails with not_found for text that is not there, and conflict for offsets past the end', () => {
    const h = harness()
    expect(
      h.fail('text.format', {
        target: { slide: 's1', object: 't1' },
        range: { match: 'Profit' },
        set: { bold: true },
      }).code,
    ).toBe('not_found')
    expect(
      h.fail('text.format', {
        target: { slide: 's1', object: 't1' },
        range: { match: 'results', occurrence: 2 },
        set: { bold: true },
      }).code,
    ).toBe('not_found')
    expect(
      h.fail('text.format', {
        target: { slide: 's1', object: 't1' },
        range: { start: 10, length: 8 },
        set: { bold: true },
      }).code,
    ).toBe('conflict')
    expect(h.fail('text.format', { target: { slide: 's1', object: 't1' } }).code).toBe(
      'invalid_input',
    )
  })

  it('counts offsets in the text as queries show it and never formats paragraph separators', () => {
    const h = harness()
    // t2 is "Revenue¶Costs¶Margin¶" — shown as "Revenue\n\nCosts\n\nMargin".
    const shown = h.run<{ object: { text: string } }>('query.object', { slide: 's1', object: 't2' })
      .object.text
    expect(shown).toBe('Revenue\n\nCosts\n\nMargin')
    const start = shown.indexOf('Costs')
    h.run('text.format', {
      target: { slide: 's1', object: 't2' },
      range: { start: 0, length: start + 5 },
      set: { color: '#0000ff' },
    })
    const raw = h.text('s1', 't2').toDelta() as Array<{
      insert: string
      attributes?: Record<string, unknown>
    }>
    for (const op of raw) {
      if (op.insert.includes(SEP)) expect(op.attributes?.['color']).toBeUndefined()
    }
    const paras = getParagraphDeltas(h.text('s1', 't2'))
    expect(paras.map((p) => p.ops.map((o) => o.attributes?.color))).toEqual([
      [0x0000ff],
      [0x0000ff],
      [undefined],
    ])
    expect(paras.every((p) => p.attrs.list === 'bullet')).toBe(true)
  })

  it('clears first, then sets', () => {
    const h = harness()
    // t1 has "results" bold in the fixture.
    h.run('text.format', {
      target: { slide: 's1', object: 't1' },
      clear: ['bold'],
      set: { underline: true },
      range: { match: 'results' },
    })
    expect(toDelta(h.text('s1', 't1'))).toEqual([
      { insert: 'Quarterly ' },
      { insert: 'results', attributes: { underline: true } },
    ])
    h.run('text.format', { target: { slide: 's1', object: 't1' }, clear: 'all' })
    expect(toDelta(h.text('s1', 't1'))).toEqual([{ insert: 'Quarterly results' }])
  })

  it('formats a table cell', () => {
    const h = harness()
    h.run('text.set', {
      target: { slide: 's1', object: 'tbl1', cell: { row: 0, col: 0 } },
      text: 'Region',
    })
    h.run('text.format', {
      target: { slide: 's1', object: 'tbl1', cell: { row: 0, col: 0 } },
      set: { fontSize: 40 },
    })
    expect(toDelta(h.text('s1', 'tbl1', { row: 0, col: 0 }))).toEqual([
      { insert: 'Region', attributes: { fontSize: 40 } },
    ])
  })
})

describe('text.list — the Inspector rules', () => {
  const attrs = (h: ReturnType<typeof harness>, id: string) =>
    getParagraphDeltas(h.text('s1', id)).map((p) => p.attrs)

  it('bullets every paragraph when no range is given, and toggle removes it when all already match', () => {
    const h = harness()
    h.run('text.set', { target: { slide: 's1', object: 't1' }, text: 'a\n\nb' })
    h.run('text.list', { target: { slide: 's1', object: 't1' }, kind: 'bullet' })
    expect(attrs(h, 't1')).toEqual([{ list: 'bullet' }, { list: 'bullet' }])
    h.run('text.list', { target: { slide: 's1', object: 't1' }, toggle: 'bullet' })
    expect(attrs(h, 't1')).toEqual([{}, {}])
    h.run('text.list', { target: { slide: 's1', object: 't1' }, toggle: 'number' })
    expect(attrs(h, 't1')).toEqual([{ list: 'number' }, { list: 'number' }])
  })

  it('touches only the paragraphs a range overlaps; a zero-length range is its paragraph', () => {
    const h = harness()
    const out = h.run('text.list', {
      target: { slide: 's1', object: 't2' },
      range: { match: 'Costs' },
      indent: 1,
    })
    expect(out).toEqual({ paragraphs: 1 })
    expect(attrs(h, 't2')).toEqual([
      { list: 'bullet' },
      { list: 'bullet', level: 1 },
      { list: 'bullet' },
    ])
    h.run('text.list', {
      target: { slide: 's1', object: 't2' },
      range: { start: 1, length: 0 },
      level: 3,
    })
    expect(attrs(h, 't2')[0]).toEqual({ list: 'bullet', level: 3 })
  })

  it('a glyph implies bullet, a number format implies number, startAt restarts, none clears everything', () => {
    const h = harness()
    h.run('text.list', {
      target: { slide: 's1', object: 't2' },
      range: { match: 'Revenue' },
      numberFormat: 'upperRoman',
      startAt: 2,
    })
    expect(attrs(h, 't2')[0]).toEqual({ list: 'number', numberFormat: 'upperRoman', startAt: 2 })
    h.run('text.list', {
      target: { slide: 's1', object: 't2' },
      range: { match: 'Margin' },
      bulletChar: '★',
    })
    expect(attrs(h, 't2')[2]).toEqual({ list: 'bullet', bulletChar: '★' })
    h.run('text.list', {
      target: { slide: 's1', object: 't2' },
      range: { match: 'Margin' },
      bulletChar: null,
    })
    expect(attrs(h, 't2')[2]).toEqual({ list: 'bullet' })
    h.run('text.list', { target: { slide: 's1', object: 't2' }, kind: 'none' })
    expect(attrs(h, 't2')).toEqual([{}, {}, {}])
  })

  it('rejects contradictory settings', () => {
    const h = harness()
    const t = { slide: 's1', object: 't2' }
    expect(h.fail('text.list', { target: t, kind: 'number', bulletChar: '•' }).code).toBe(
      'invalid_input',
    )
    expect(h.fail('text.list', { target: t, kind: 'bullet', toggle: 'bullet' }).code).toBe(
      'invalid_input',
    )
    expect(h.fail('text.list', { target: t, level: 1, indent: 1 }).code).toBe('invalid_input')
    expect(h.fail('text.list', { target: t, kind: 'none', startAt: 3 }).code).toBe('invalid_input')
    expect(h.fail('text.list', { target: t }).code).toBe('invalid_input')
  })

  it('migrates a legacy box-wide listStyle into paragraph attributes in the same step', () => {
    const h = harness()
    h.run('text.set', { target: { slide: 's1', object: 't1' }, text: 'x\n\ny' })
    h.deck.doc.transact(() => h.map('s1', 't1').set('listStyle', 'numbered'))
    h.run('text.list', { target: { slide: 's1', object: 't1' }, range: { match: 'y' }, indent: 1 })
    expect(h.map('s1', 't1').has('listStyle')).toBe(false)
    expect(attrs(h, 't1')).toEqual([{ list: 'number' }, { list: 'number', level: 1 }])
  })
})
