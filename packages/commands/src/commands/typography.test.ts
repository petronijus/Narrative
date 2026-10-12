import { describe, expect, it } from 'vitest'
import { createUndoManager, readParagraphAttrsForRange } from '@narrative/slide-model'
import type { TableObject } from '@narrative/shared'
import { harness, type Harness } from '../testing/harness.js'
import { FIXTURE_FONT_FAMILY, FIXTURE_PAGE_NUMBER_STYLE_ID } from '../testing/fixtureTokens.js'
import { propagateTextStyles, textStyleFieldsFromObject } from '../text/textStyle.js'

/** Inline formatting of a body as [text, attributes] runs. */
const runs = (h: Harness, slide = 's1', id = 't1') =>
  (h.text(slide, id).toDelta() as Array<{ insert: string; attributes?: object }>).map((op) => [
    op.insert,
    op.attributes ?? {},
  ])

describe('text.setBoxTypography', () => {
  it('sets the box value and removes the inline formatting that would hide it', () => {
    const h = harness()
    // t1 is "Quarterly results" with "results" bold inline.
    h.run('text.setBoxTypography', { slide: 's1', objects: ['t1'], style: { fontWeight: 300 } })
    expect(h.plain('s1', 't1')['fontWeight']).toBe(300)
    expect(runs(h)).toEqual([['Quarterly results', {}]])
  })

  it('keeps inline formatting of attributes it does not set', () => {
    const h = harness()
    h.run('text.setBoxTypography', {
      slide: 's1',
      objects: ['t1'],
      style: { fontSize: 32, align: 'center' },
    })
    expect(h.plain('s1', 't1')).toMatchObject({ fontSize: 32, align: 'center' })
    expect(runs(h)).toEqual([
      ['Quarterly ', {}],
      ['results', { fontWeight: 700 }],
    ])
  })

  it('moves the weight to the nearest cut of a new family, unless the weight is given', () => {
    const h = harness()
    // t1 is 'normal' (400); Brand Sans has 300 and 600: the browser shows 300 for 400.
    h.run('text.setBoxTypography', {
      slide: 's1',
      objects: ['t1'],
      style: { fontFamily: FIXTURE_FONT_FAMILY },
    })
    expect(h.plain('s1', 't1')).toMatchObject({ fontFamily: FIXTURE_FONT_FAMILY, fontWeight: 300 })
    h.run('text.setBoxTypography', {
      slide: 's1',
      objects: ['t1'],
      style: { fontFamily: FIXTURE_FONT_FAMILY, fontWeight: 900 },
    })
    expect(h.plain('s1', 't1')['fontWeight']).toBe(900)
    // A system stack's cuts are known without the folder's fonts.
    delete h.ctx.folderFonts
    h.run('text.setBoxTypography', {
      slide: 's1',
      objects: ['t1'],
      style: { fontFamily: "Georgia, 'Times New Roman', serif" },
    })
    expect(h.plain('s1', 't1')['fontWeight']).toBe(700)
    // Any other family needs them, rather than a guess.
    expect(
      h.fail('text.setBoxTypography', {
        slide: 's1',
        objects: ['t1'],
        style: { fontFamily: FIXTURE_FONT_FAMILY },
      }).code,
    ).toBe('conflict')
  })

  it('records hand-set fields as overrides on a box linked to a text style', () => {
    const h = harness()
    h.run('text.style.apply', { slide: 's1', objects: ['t1'], style: 'Title' })
    h.run('text.setBoxTypography', {
      slide: 's1',
      objects: ['t1'],
      style: { fontSize: 48, align: 'right' },
    })
    expect(h.plain('s1', 't1')).toMatchObject({
      textStyleId: 'title',
      fontSize: 48,
      textStyleOverrides: ['fontSize'],
    })
  })

  it('is for text boxes only', () => {
    const h = harness()
    expect(
      h.fail('text.setBoxTypography', { slide: 's1', objects: ['tbl1'], style: { fontSize: 20 } })
        .code,
    ).toBe('invalid_input')
    expect(h.fail('text.setBoxTypography', { slide: 's1', objects: ['t1'], style: {} }).code).toBe(
      'invalid_input',
    )
  })
})

describe('text.style.apply', () => {
  it("links a box to a style by name or id and writes the style's fields", () => {
    const h = harness()
    expect(
      h.run('text.style.apply', { slide: 's1', objects: ['t1'], style: 'footnotes and pages' }),
    ).toEqual({ style: { id: FIXTURE_PAGE_NUMBER_STYLE_ID, name: 'Footnotes and pages' } })
    expect(h.plain('s1', 't1')).toMatchObject({
      textStyleId: FIXTURE_PAGE_NUMBER_STYLE_ID,
      textStyleOverrides: [],
      fontFamily: 'Inter',
      fontSize: 14,
      fontWeight: 400,
      letterSpacing: 0.5,
      color: 0x222222,
      textTransform: 'uppercase',
    })
    // Inline formatting stays unless reset.
    expect(runs(h)[1]).toEqual(['results', { fontWeight: 700 }])
    h.run('text.style.apply', { slide: 's1', objects: ['t1'], style: 'title', reset: true })
    expect(h.plain('s1', 't1')).toMatchObject({ textStyleId: 'title', fontSize: 72 })
    expect(runs(h)).toEqual([['Quarterly results', {}]])
  })

  it('starts the overrides afresh and unlinks with null, keeping the look', () => {
    const h = harness()
    h.run('text.style.apply', { slide: 's1', objects: ['t1'], style: 'Title' })
    h.run('text.setBoxTypography', { slide: 's1', objects: ['t1'], style: { fontSize: 50 } })
    h.run('text.style.apply', { slide: 's1', objects: ['t1'], style: 'Title' })
    expect(h.plain('s1', 't1')).toMatchObject({ fontSize: 72, textStyleOverrides: [] })
    h.run('text.style.apply', { slide: 's1', objects: ['t1'], style: null })
    const t1 = h.plain('s1', 't1')
    expect(t1['textStyleId']).toBeUndefined()
    expect(t1['textStyleOverrides']).toBeUndefined()
    expect(t1['fontSize']).toBe(72)
  })

  it("applies to a table's defaults and, with reset, clears the cells' own text styling", () => {
    const h = harness()
    h.run('table.style.cell', {
      slide: 's1',
      table: 'tbl1',
      cell: { row: 0, col: 0 },
      style: { fontSize: 30, fill: '#ff0000' },
    })
    h.run('text.style.apply', { slide: 's1', objects: ['tbl1'], style: 'Title', reset: true })
    const t = h.plain('s1', 'tbl1') as unknown as TableObject
    expect(t.defaults).toMatchObject({ textStyleId: 'title', fontSize: 72, fontWeight: 700 })
    expect(t.rows[0]![0]!.fontSize).toBeUndefined()
    expect(t.rows[0]![0]!.fill).toBe(0xff0000)
  })

  it('names the folder styles when the style is unknown, and needs the tokens', () => {
    const h = harness()
    const e = h.fail('text.style.apply', { slide: 's1', objects: ['t1'], style: 'Headline' })
    expect(e.code).toBe('not_found')
    expect(e.message).toContain('"Title"')
    expect(h.fail('text.style.apply', { slide: 's1', objects: ['r1'], style: 'Title' }).code).toBe(
      'invalid_input',
    )
    expect(
      h.fail('text.style.apply', { slide: 's1', objects: ['t1'], style: null, reset: true }).code,
    ).toBe('invalid_input')
    delete h.ctx.folderTokens
    expect(h.fail('text.style.apply', { slide: 's1', objects: ['t1'], style: 'Title' }).code).toBe(
      'conflict',
    )
    // Unlinking needs no tokens.
    h.run('text.style.apply', { slide: 's1', objects: ['t1'], style: null })
  })
})

describe('the shrink floor (A4.2a)', () => {
  function withBodyFloor(h: Harness, minSize: number): void {
    h.ctx.folderTokens!.textStyles['body']!.minSize = minSize
  }

  it("reaches a linked text box as minFontSize, never a table's defaults", () => {
    const h = harness()
    withBodyFloor(h, 18)
    h.run('text.style.apply', { slide: 's1', objects: ['t1', 'tbl1'], style: 'Body' })
    expect(h.plain('s1', 't1')).toMatchObject({ textStyleId: 'body', minFontSize: 18 })
    const table = h.plain('s1', 'tbl1') as unknown as TableObject
    expect(table.defaults.textStyleId).toBe('body')
    expect(table.defaults).not.toHaveProperty('minFontSize')
    h.run('text.style.apply', { slide: 's1', objects: ['tbl1'], style: 'Body', reset: true })
    expect(h.plain('s1', 'tbl1') as unknown as TableObject).not.toHaveProperty(
      'defaults.minFontSize',
    )
  })

  it('follows a changed style on boxes, not on tables, unless the box set its own', () => {
    const h = harness()
    h.run('text.style.apply', { slide: 's1', objects: ['t1', 'tbl1'], style: 'Body' })
    withBodyFloor(h, 12)
    expect(propagateTextStyles(h.ctx.deck!, h.ctx.folderTokens!, new Set(['body']))).toBe(1)
    expect(h.plain('s1', 't1')['minFontSize']).toBe(12)
    expect((h.plain('s1', 'tbl1') as unknown as TableObject).defaults).not.toHaveProperty(
      'minFontSize',
    )
    // Set by hand on the box: an override the style no longer reaches.
    h.run('text.setBoxTypography', { slide: 's1', objects: ['t1'], style: { minFontSize: 20 } })
    expect(h.plain('s1', 't1')['textStyleOverrides']).toEqual(['minFontSize'])
    withBodyFloor(h, 10)
    propagateTextStyles(h.ctx.deck!, h.ctx.folderTokens!, new Set(['body']))
    expect(h.plain('s1', 't1')['minFontSize']).toBe(20)
  })

  it('a style made from a box takes its floor', () => {
    expect(textStyleFieldsFromObject({ fontSize: 24, minFontSize: 12 })).toMatchObject({
      size: 24,
      minSize: 12,
    })
  })
})

describe('table.style.table typography rules', () => {
  it('keeps a cut of a new family and records overrides on a linked table', () => {
    const h = harness()
    h.run('table.style.table', {
      slide: 's1',
      table: 'tbl1',
      style: { fontFamily: FIXTURE_FONT_FAMILY },
    })
    let t = h.plain('s1', 'tbl1') as unknown as TableObject
    expect(t.defaults).toMatchObject({ fontFamily: FIXTURE_FONT_FAMILY, fontWeight: 300 })
    h.run('text.style.apply', { slide: 's1', objects: ['tbl1'], style: 'Title' })
    h.run('table.style.table', { slide: 's1', table: 'tbl1', style: { fontSize: 20 } })
    t = h.plain('s1', 'tbl1') as unknown as TableObject
    expect(t.defaults).toMatchObject({ fontSize: 20, textStyleOverrides: ['fontSize'] })
  })
})

describe('undo: one gesture, one step (the editor runs commands with LOCAL_ORIGIN)', () => {
  // `captureTimeout = 0` stops the manager from merging separate
  // transactions by time, so "one stack item" really means "one command".
  const undoManagerOf = (h: Harness) => {
    const um = createUndoManager(h.deck)
    um.captureTimeout = 0
    return um
  }

  it('the run strip and the box value of text.setBoxTypography undo together', () => {
    const h = harness()
    const um = undoManagerOf(h)
    h.run('text.setBoxTypography', { slide: 's1', objects: ['t1'], style: { fontWeight: 300 } })
    expect(runs(h)).toEqual([['Quarterly results', {}]])
    expect(um.undoStack).toHaveLength(1)
    um.undo()
    expect(h.plain('s1', 't1')['fontWeight']).toBe('normal')
    expect(runs(h)[1]).toEqual(['results', { fontWeight: 700 }])
  })

  it("a legacy box-wide list becomes paragraphs in the same step as text.list's change", () => {
    const h = harness()
    h.run('object.update', { slide: 's1', object: 't1', patch: { listStyle: 'bullet' } })
    const um = undoManagerOf(h)
    h.run('text.list', { target: { slide: 's1', object: 't1' }, kind: 'number' })
    const body = h.text('s1', 't1')
    expect(h.plain('s1', 't1')['listStyle']).toBeUndefined()
    expect(readParagraphAttrsForRange(body, 0, body.length).list).toBe('number')
    expect(um.undoStack).toHaveLength(1)
    um.undo()
    expect(h.plain('s1', 't1')['listStyle']).toBe('bullet')
    expect(readParagraphAttrsForRange(body, 0, body.length).list).toBeUndefined()
  })
})
