import { describe, expect, it } from 'vitest'
import { getSlideObjectsCtx, getTableMergeInfo, updateObject } from '@narrative/slide-model'
import type { TableObject } from '@narrative/shared'
import { harness, type Harness } from '../testing/harness.js'

const table = (h: Harness, slide = 's1', id = 'tbl1') =>
  h.plain(slide, id) as unknown as TableObject
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const merge = (h: Harness, r: number, c: number, slide = 's1', id = 'tbl1') =>
  getTableMergeInfo(getSlideObjectsCtx(h.deck, slide)!, id, r, c)

describe('table.insert', () => {
  it("sizes a new table like the toolbar's grid picker (120 x 60 px per cell) unless sized", () => {
    const h = harness()
    const { objectId } = h.run<{ objectId: string }>('table.insert', {
      slide: 's3',
      rows: 2,
      cols: 5,
    })
    expect(table(h, 's3', objectId)).toMatchObject({
      x: 100,
      y: 100,
      width: 600,
      height: 120,
      colWidths: [120, 120, 120, 120, 120],
    })
    expect(h.fail('table.insert', { slide: 's3', rows: 101 }).code).toBe('invalid_input')
  })
})

describe('rows and columns', () => {
  it('inserts rows at an index or at the end, several at once, growing the table', () => {
    const h = harness()
    h.run('text.set', {
      target: { slide: 's1', object: 'tbl1', cell: { row: 1, col: 0 } },
      text: 'second',
    })
    expect(h.run('table.row.insert', { slide: 's1', table: 'tbl1', index: 1, count: 2 })).toEqual({
      rows: 5,
      cols: 3,
    })
    expect(h.text('s1', 'tbl1', { row: 3, col: 0 }).toString()).toBe('second')
    expect(h.run('table.row.insert', { slide: 's1', table: 'tbl1' })).toEqual({ rows: 6, cols: 3 })
    const t = table(h)
    expect(t.height).toBeCloseTo(480)
    expect(sum(t.rowHeights)).toBeCloseTo(t.height)
    expect(h.fail('table.row.insert', { slide: 's1', table: 'tbl1', index: 7 }).code).toBe(
      'not_found',
    )
    expect(h.fail('table.row.insert', { slide: 's1', table: 'r1' }).code).toBe('conflict')
  })

  it('deletes rows and columns but never the last one', () => {
    const h = harness()
    expect(h.run('table.col.delete', { slide: 's1', table: 'tbl1', index: 0, count: 2 })).toEqual({
      rows: 3,
      cols: 1,
    })
    expect(table(h).width).toBeCloseTo(200)
    expect(h.fail('table.col.delete', { slide: 's1', table: 'tbl1', index: 0 }).code).toBe(
      'conflict',
    )
    expect(
      h.fail('table.row.delete', { slide: 's1', table: 'tbl1', index: 2, count: 2 }).code,
    ).toBe('not_found')
    expect(h.run('table.row.delete', { slide: 's1', table: 'tbl1', index: 1 })).toEqual({
      rows: 2,
      cols: 1,
    })
  })

  it('extends a merge when a column is inserted strictly inside it, and shrinks it on delete', () => {
    const h = harness()
    // tbl2 (on s2): the top row, columns 0..2, is one merged cell.
    h.run('table.col.insert', { slide: 's2', table: 'tbl2', index: 1 })
    expect(merge(h, 0, 0, 's2', 'tbl2')).toEqual({ kind: 'origin', rowSpan: 1, colSpan: 4 })
    h.run('table.col.delete', { slide: 's2', table: 'tbl2', index: 0 })
    expect(merge(h, 0, 0, 's2', 'tbl2')).toEqual({ kind: 'origin', rowSpan: 1, colSpan: 3 })
  })
})

describe('table.resizeColumn / table.resizeRow', () => {
  it('grows the table by default and keeps the other columns', () => {
    const h = harness()
    const out = h.run('table.resizeColumn', { slide: 's1', table: 'tbl1', index: 0, size: 400 })
    expect(out).toEqual({ sizes: [400, 200, 200], total: 800 })
    expect(table(h)).toMatchObject({ colWidths: [400, 200, 200], width: 800 })
  })

  it('takes the difference from the neighbour with keepTableSize, like a boundary drag', () => {
    const h = harness()
    h.run('table.resizeRow', {
      slide: 's1',
      table: 'tbl1',
      index: 2,
      size: 50,
      keepTableSize: true,
    })
    expect(table(h)).toMatchObject({ rowHeights: [80, 110, 50], height: 240 })
    expect(
      h.fail('table.resizeRow', {
        slide: 's1',
        table: 'tbl1',
        index: 0,
        size: 188,
        keepTableSize: true,
      }).code,
    ).toBe('conflict')
    expect(h.fail('table.resizeRow', { slide: 's1', table: 'tbl1', index: 3, size: 50 }).code).toBe(
      'not_found',
    )
    expect(h.fail('table.resizeRow', { slide: 's1', table: 'tbl1', index: 0, size: 2 }).code).toBe(
      'invalid_input',
    )
  })

  it('re-normalises a drifted track vector so it sums to the frame again', () => {
    const h = harness()
    // A frame resize leaves the vector as proportions: 200/200/200 drawn at 900 px.
    updateObject(getSlideObjectsCtx(h.deck, 's1')!, 'tbl1', { width: 900 } as never)
    h.run('table.resizeColumn', { slide: 's1', table: 'tbl1', index: 1, size: 100 })
    expect(table(h)).toMatchObject({ colWidths: [300, 100, 300], width: 700 })
  })
})

describe('table.merge / table.split', () => {
  it('merges a rectangle and reports the merged cell', () => {
    const h = harness()
    const out = h.run('table.merge', {
      slide: 's1',
      table: 'tbl1',
      range: { from: { row: 2, col: 2 }, to: { row: 1, col: 1 } },
    })
    expect(out).toEqual({ origin: { row: 1, col: 1 }, rowSpan: 2, colSpan: 2 })
    expect(merge(h, 2, 2)).toEqual({ kind: 'continuation', originR: 1, originC: 1 })
  })

  it('grows the range to swallow a merge it touches', () => {
    const h = harness()
    const out = h.run('table.merge', {
      slide: 's2',
      table: 'tbl2',
      range: { from: { row: 0, col: 1 }, to: { row: 1, col: 1 } },
    })
    expect(out).toEqual({ origin: { row: 0, col: 0 }, rowSpan: 2, colSpan: 3 })
  })

  it('refuses single cells and out-of-range corners; split needs a merged cell', () => {
    const h = harness()
    expect(
      h.fail('table.merge', {
        slide: 's1',
        table: 'tbl1',
        range: { from: { row: 0, col: 0 }, to: { row: 0, col: 0 } },
      }).code,
    ).toBe('conflict')
    expect(
      h.fail('table.merge', {
        slide: 's1',
        table: 'tbl1',
        range: { from: { row: 0, col: 0 }, to: { row: 5, col: 0 } },
      }).code,
    ).toBe('not_found')
    expect(
      h.fail('table.split', { slide: 's1', table: 'tbl1', cell: { row: 0, col: 0 } }).code,
    ).toBe('conflict')
    h.run('table.split', { slide: 's2', table: 'tbl2', cell: { row: 0, col: 2 } })
    expect(merge(h, 0, 0, 's2', 'tbl2')).toBeNull()
  })
})

describe('table styling and borders', () => {
  it('styles one cell with hex colours and clears an override with null', () => {
    const h = harness()
    h.run('table.style.cell', {
      slide: 's1',
      table: 'tbl1',
      cell: { row: 0, col: 0 },
      style: { fill: '#102030', color: '#fff', align: 'center' },
    })
    expect(table(h).rows[0]![0]).toMatchObject({ fill: 0x102030, color: 0xffffff, align: 'center' })
    h.run('table.style.cell', {
      slide: 's1',
      table: 'tbl1',
      cell: { row: 0, col: 0 },
      style: { fill: null },
    })
    expect(table(h).rows[0]![0]!.fill).toBeUndefined()
    expect(
      h.fail('table.style.cell', {
        slide: 's1',
        table: 'tbl1',
        cell: { row: 0, col: 0 },
        style: { text: 'x' },
      }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('table.style.cell', {
        slide: 's1',
        table: 'tbl1',
        cell: { row: 0, col: 0 },
        style: { gridSpan: 2 },
      }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('table.style.cell', {
        slide: 's2',
        table: 'tbl2',
        cell: { row: 0, col: 1 },
        style: { fill: '#000000' },
      }).code,
    ).toBe('conflict')
  })

  it('styles a range, skipping cells hidden in a merge', () => {
    const h = harness()
    h.run('table.style.range', {
      slide: 's2',
      table: 'tbl2',
      range: { from: { row: 0, col: 0 }, to: { row: 1, col: 2 } },
      style: { fontSize: 30 },
    })
    const t = table(h, 's2', 'tbl2')
    expect(t.rows[0]!.map((c) => c.fontSize)).toEqual([30, undefined, undefined])
    expect(t.rows[1]!.map((c) => c.fontSize)).toEqual([30, 30, 30])
  })

  it('changes table defaults; required defaults cannot be cleared', () => {
    const h = harness()
    h.run('table.style.table', {
      slide: 's1',
      table: 'tbl1',
      style: {
        color: '#333333',
        fill: '#eeeeee',
        padding: { top: 4, right: 4, bottom: 4, left: 4 },
      },
    })
    expect(table(h).defaults).toMatchObject({
      color: 0x333333,
      fill: 0xeeeeee,
      padding: { top: 4, right: 4, bottom: 4, left: 4 },
    })
    h.run('table.style.table', { slide: 's1', table: 'tbl1', style: { fill: null } })
    expect(table(h).defaults.fill).toBeUndefined()
    expect(
      h.fail('table.style.table', { slide: 's1', table: 'tbl1', style: { color: null } }).code,
    ).toBe('invalid_input')
    expect(h.fail('table.style.table', { slide: 's1', table: 'tbl1', style: {} }).code).toBe(
      'invalid_input',
    )
  })

  it('applies border presets to segments, with none writing width 0', () => {
    const h = harness()
    h.run('table.border.preset', {
      slide: 's1',
      table: 'tbl1',
      preset: 'outer',
      color: '#ff0000',
      width: 2,
      dash: 'dash',
    })
    const segs = table(h).borderSegments!
    expect(segs['h:0:0']).toEqual({ color: 0xff0000, width: 2, dash: 'dash' })
    expect(segs['v:1:3']).toEqual({ color: 0xff0000, width: 2, dash: 'dash' })
    expect(segs['h:1:0']).toBeUndefined()
    h.run('table.border.preset', {
      slide: 's1',
      table: 'tbl1',
      preset: 'none',
      range: { from: { row: 0, col: 0 }, to: { row: 0, col: 0 } },
    })
    expect(table(h).borderSegments!['h:0:0']).toEqual({ color: 0, width: 0 })
    expect(h.fail('table.border.preset', { slide: 's1', table: 'tbl1', preset: 'all' }).code).toBe(
      'invalid_input',
    )
  })

  it('sets and clears one segment, within the grid only', () => {
    const h = harness()
    h.run('table.border.segment', {
      slide: 's1',
      table: 'tbl1',
      segment: { orientation: 'horizontal', row: 3, col: 2 },
      style: { color: '#00ff00', width: 4 },
    })
    expect(table(h).borderSegments!['h:3:2']).toEqual({ color: 0x00ff00, width: 4 })
    h.run('table.border.segment', {
      slide: 's1',
      table: 'tbl1',
      segment: { orientation: 'horizontal', row: 3, col: 2 },
      style: null,
    })
    expect(table(h).borderSegments!['h:3:2']).toBeUndefined()
    expect(
      h.fail('table.border.segment', {
        slide: 's1',
        table: 'tbl1',
        segment: { orientation: 'horizontal', row: 3, col: 3 },
        style: null,
      }).code,
    ).toBe('not_found')
    expect(
      h.fail('table.border.segment', {
        slide: 's1',
        table: 'tbl1',
        segment: { orientation: 'vertical', row: 3, col: 0 },
        style: null,
      }).code,
    ).toBe('not_found')
  })
})
