/**
 * Unit tests for the paragraph + list block model in richText:
 * paragraph splitting, block-attr read/write on the U+2029 separator,
 * numbering computation across levels, and the shared HTML builder.
 */
import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import {
  PARAGRAPH_SEP,
  applyParagraphPatch,
  blockAttrsToInsertAttrs,
  buildListedHtml,
  computeMarkers,
  createTextValue,
  defaultBulletGlyph,
  formatListNumber,
  getParagraphDeltas,
  getParagraphs,
  indentParagraphs,
  readParagraphAttrsForRange,
  toggleListKind,
} from './richText.js'
import type { ParagraphAttrs } from '@narrative/shared'

function attach(initial: string): { doc: Y.Doc; yt: Y.Text } {
  const doc = new Y.Doc()
  const yt = createTextValue(initial)
  doc.getMap('m').set('text', yt)
  return { doc, yt }
}

describe('getParagraphs', () => {
  it('treats a body with no separators as one paragraph', () => {
    const { yt } = attach('hello world')
    const paras = getParagraphs(yt)
    expect(paras).toHaveLength(1)
    expect(paras[0]).toMatchObject({ text: 'hello world', start: 0, end: 11, hasSep: false })
  })

  it('empty body is a single empty paragraph', () => {
    const { yt } = attach('')
    const paras = getParagraphs(yt)
    expect(paras).toHaveLength(1)
    expect(paras[0]).toMatchObject({ text: '', hasSep: false })
  })

  it('splits on the paragraph separator (no trailing sep ⇒ N paragraphs)', () => {
    const { yt } = attach(`a${PARAGRAPH_SEP}b${PARAGRAPH_SEP}c`)
    const paras = getParagraphs(yt)
    expect(paras.map((p) => p.text)).toEqual(['a', 'b', 'c'])
    expect(paras.map((p) => p.hasSep)).toEqual([true, true, false])
  })

  it('a trailing separator does NOT create an empty final paragraph', () => {
    const { yt } = attach(`a${PARAGRAPH_SEP}b${PARAGRAPH_SEP}`)
    const paras = getParagraphs(yt)
    expect(paras.map((p) => p.text)).toEqual(['a', 'b'])
    expect(paras.map((p) => p.hasSep)).toEqual([true, true])
  })

  it('soft breaks stay inside a paragraph', () => {
    const { yt } = attach(`line1\nline2${PARAGRAPH_SEP}next`)
    const paras = getParagraphs(yt)
    expect(paras.map((p) => p.text)).toEqual(['line1\nline2', 'next'])
  })
})

describe('applyParagraphPatch + block attrs', () => {
  it('stores list attrs on the terminating separator, adding one if needed', () => {
    const { doc, yt } = attach('only')
    doc.transact(() => {
      applyParagraphPatch(yt, 0, 4, { list: 'bullet' })
    })
    // a trailing separator was appended to carry the last paragraph's attrs
    expect(yt.toString()).toBe(`only${PARAGRAPH_SEP}`)
    const paras = getParagraphs(yt)
    expect(paras).toHaveLength(1)
    expect(paras[0]!.attrs).toEqual({ list: 'bullet' })
  })

  it('applies to every paragraph overlapping the range', () => {
    const { doc, yt } = attach(`a${PARAGRAPH_SEP}b${PARAGRAPH_SEP}c`)
    doc.transact(() => {
      applyParagraphPatch(yt, 0, yt.length, { list: 'number' })
    })
    const paras = getParagraphs(yt)
    expect(paras.map((p) => p.attrs.list)).toEqual(['number', 'number', 'number'])
  })

  it('only touches the paragraphs the range covers', () => {
    const { doc, yt } = attach(`a${PARAGRAPH_SEP}b${PARAGRAPH_SEP}c`)
    // range entirely within paragraph "b" (chars 2..3)
    doc.transact(() => {
      applyParagraphPatch(yt, 2, 3, { list: 'bullet', level: 2 })
    })
    const paras = getParagraphs(yt)
    expect(paras[0]!.attrs).toEqual({})
    expect(paras[1]!.attrs).toEqual({ list: 'bullet', level: 2 })
    expect(paras[2]!.attrs).toEqual({})
  })

  it('clears an attribute when passed null', () => {
    const { doc, yt } = attach('x')
    doc.transact(() => applyParagraphPatch(yt, 0, 1, { list: 'bullet', level: 3 }))
    doc.transact(() => applyParagraphPatch(yt, 0, 1, { list: null, level: null }))
    expect(getParagraphs(yt)[0]!.attrs).toEqual({})
  })
})

describe('toggleListKind', () => {
  it('turns plain paragraphs into a list, then removes it on a second toggle', () => {
    const { doc, yt } = attach(`a${PARAGRAPH_SEP}b`)
    doc.transact(() => toggleListKind(yt, 0, yt.length, 'bullet'))
    expect(getParagraphs(yt).map((p) => p.attrs.list)).toEqual(['bullet', 'bullet'])
    doc.transact(() => toggleListKind(yt, 0, yt.length, 'bullet'))
    expect(getParagraphs(yt).map((p) => p.attrs.list)).toEqual([undefined, undefined])
  })

  it('switches kind rather than removing when kinds differ', () => {
    const { doc, yt } = attach('x')
    doc.transact(() => toggleListKind(yt, 0, 1, 'bullet'))
    doc.transact(() => toggleListKind(yt, 0, 1, 'number'))
    expect(getParagraphs(yt)[0]!.attrs.list).toBe('number')
  })
})

describe('indentParagraphs', () => {
  it('increments and clamps level, dropping level 0', () => {
    const { doc, yt } = attach('x')
    doc.transact(() => toggleListKind(yt, 0, 1, 'bullet'))
    doc.transact(() => indentParagraphs(yt, 0, 1, 1))
    expect(getParagraphs(yt)[0]!.attrs.level).toBe(1)
    doc.transact(() => indentParagraphs(yt, 0, 1, -1))
    expect(getParagraphs(yt)[0]!.attrs.level).toBeUndefined()
  })

  it('does not exceed MAX_LIST_LEVEL', () => {
    const { doc, yt } = attach('x')
    doc.transact(() => toggleListKind(yt, 0, 1, 'bullet'))
    doc.transact(() => indentParagraphs(yt, 0, 1, 50))
    expect(getParagraphs(yt)[0]!.attrs.level).toBe(8)
  })
})

describe('readParagraphAttrsForRange', () => {
  it('returns shared values and omits disagreements', () => {
    const { doc, yt } = attach(`a${PARAGRAPH_SEP}b`)
    doc.transact(() => {
      applyParagraphPatch(yt, 0, 1, { list: 'bullet', level: 1 })
      applyParagraphPatch(yt, 2, 3, { list: 'bullet', level: 2 })
    })
    const attrs = readParagraphAttrsForRange(yt, 0, yt.length)
    expect(attrs.list).toBe('bullet') // agree
    expect(attrs.level).toBeUndefined() // disagree (1 vs 2)
  })
})

describe('computeMarkers', () => {
  const A = (a: ParagraphAttrs): ParagraphAttrs => a

  it('bullets use per-level default glyphs', () => {
    const markers = computeMarkers([
      A({ list: 'bullet', level: 0 }),
      A({ list: 'bullet', level: 1 }),
      A({ list: 'bullet', level: 2 }),
    ])
    expect(markers).toEqual([defaultBulletGlyph(0), defaultBulletGlyph(1), defaultBulletGlyph(2)])
  })

  it('custom bullet glyph overrides the default', () => {
    expect(computeMarkers([A({ list: 'bullet', bulletChar: '★' })])).toEqual(['★'])
  })

  it('numbers increment within a level', () => {
    const markers = computeMarkers([
      A({ list: 'number' }),
      A({ list: 'number' }),
      A({ list: 'number' }),
    ])
    expect(markers).toEqual(['1.', '2.', '3.'])
  })

  it('nested numbering restarts per sub-level and resumes the parent', () => {
    const markers = computeMarkers([
      A({ list: 'number', level: 0 }), // 1.
      A({ list: 'number', level: 1 }), // 1.
      A({ list: 'number', level: 1 }), // 2.
      A({ list: 'number', level: 0 }), // 2.
      A({ list: 'number', level: 1 }), // 1.  (restarted)
    ])
    expect(markers).toEqual(['1.', '1.', '2.', '2.', '1.'])
  })

  it('startAt restarts the counter', () => {
    const markers = computeMarkers([
      A({ list: 'number' }),
      A({ list: 'number', startAt: 5 }),
      A({ list: 'number' }),
    ])
    expect(markers).toEqual(['1.', '5.', '6.'])
  })

  it('a plain paragraph breaks the run so numbering restarts', () => {
    const markers = computeMarkers([A({ list: 'number' }), A({}), A({ list: 'number' })])
    expect(markers).toEqual(['1.', null, '1.'])
  })

  it('honours the legacy frame-wide list style', () => {
    expect(computeMarkers([A({}), A({})], 'numbered')).toEqual(['1.', '2.'])
    expect(computeMarkers([A({}), A({})], 'bullet')).toEqual([
      defaultBulletGlyph(0),
      defaultBulletGlyph(0),
    ])
  })
})

describe('formatListNumber', () => {
  it.each([
    [1, 'decimal', '1.'],
    [2, 'decimalParen', '2)'],
    [1, 'lowerAlpha', 'a.'],
    [27, 'lowerAlpha', 'aa.'],
    [3, 'upperAlpha', 'C.'],
    [4, 'lowerRoman', 'iv.'],
    [9, 'upperRoman', 'IX.'],
  ] as const)('formats %i as %s ⇒ %s', (n, fmt, expected) => {
    expect(formatListNumber(n, fmt)).toBe(expected)
  })
})

describe('buildListedHtml', () => {
  it('wraps each paragraph in a data-pb div with marker and indent', () => {
    const { doc, yt } = attach(`a${PARAGRAPH_SEP}b`)
    doc.transact(() => {
      applyParagraphPatch(yt, 0, 1, { list: 'bullet', level: 0 })
      applyParagraphPatch(yt, 2, 3, { list: 'bullet', level: 1 })
    })
    const html = buildListedHtml(getParagraphDeltas(yt), {})
    expect(html).toContain('<div data-pb="1"')
    expect(html).toContain('data-marker="1"')
    expect(html).toContain(defaultBulletGlyph(0))
    expect(html).toContain(defaultBulletGlyph(1))
    // nested item carries a larger left indent
    expect(html).toMatch(/padding-left:[\d.]+em/)
  })

  it('renders an empty paragraph with a placeholder break', () => {
    const { yt } = attach('')
    const html = buildListedHtml(getParagraphDeltas(yt), {})
    expect(html).toContain('<br data-empty="1">')
  })
})

describe('blockAttrsToInsertAttrs', () => {
  it('drops defaults and empty values', () => {
    expect(blockAttrsToInsertAttrs({})).toBeUndefined()
    expect(blockAttrsToInsertAttrs({ level: 0 })).toBeUndefined()
    expect(
      blockAttrsToInsertAttrs({ list: 'number', numberFormat: 'lowerRoman', level: 2 }),
    ).toEqual({ list: 'number', numberFormat: 'lowerRoman', level: 2 })
  })

  it('round-trips through a Y.Text separator insert', () => {
    const { yt } = attach('item')
    const attrs = blockAttrsToInsertAttrs({ list: 'bullet', level: 1, bulletChar: '–' })
    yt.insert(yt.length, PARAGRAPH_SEP, attrs)
    expect(getParagraphs(yt)[0]!.attrs).toEqual({ list: 'bullet', level: 1, bulletChar: '–' })
  })
})
