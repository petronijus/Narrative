/**
 * tableMutations.structure.test.ts
 *
 * Structural invariants of the table row / column / merge mutations:
 *
 *   - merged-cell geometry (origin `gridSpan`/`rowSpan`, covered-cell
 *     `mergeOriginR`/`mergeOriginC` pointers) follows PowerPoint when a
 *     row or column is inserted or deleted;
 *   - `borderSegments` keys move with the track they belong to and the
 *     table's outer perimeter stays on the perimeter;
 *   - `sum(colWidths) === width` and `sum(rowHeights) === height`.
 *
 * Every assertion reads a plain snapshot through `yMapToPlainObject` —
 * never CRDT bytes (see CLAUDE.md, "What NOT to test").
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import type { TableObject } from '@narrative/shared'
import { yMapToPlainObject } from './bindings.js'
import { LOCAL_ORIGIN, updateObject } from './mutations.js'
import {
  addTable,
  deleteTableCol,
  deleteTableRow,
  getTableCellYMap,
  insertTableCol,
  insertTableRow,
  mergeTableCells,
  setRangeBorderPreset,
  setTableBorderSegment,
  setTableCellStyle,
  splitTableCell,
} from './tableMutations.js'
import { collectTableInvariantViolations } from './tableInvariants.testUtil.js'

function makeCtx() {
  const doc = new Y.Doc()
  const objects = doc.getArray<Y.Map<unknown>>('objects')
  return { doc, objects }
}

function readTable(objects: Y.Array<Y.Map<unknown>>, id: string): TableObject {
  for (let i = 0; i < objects.length; i++) {
    const m = objects.get(i)
    if (m.get('id') === id) return yMapToPlainObject<TableObject>(m)
  }
  throw new Error(`readTable: id ${id} not found`)
}

/** Merge geometry of every cell, as a compact grid of strings:
 *  `O2x3` = origin spanning 2 rows × 3 cols, `>r,c` = covered, `.` = plain. */
function mergeGrid(t: TableObject): string[][] {
  return t.rows.map((row) =>
    row.map((cell) => {
      if (cell.mergeOriginR !== undefined || cell.mergeOriginC !== undefined) {
        return `>${cell.mergeOriginR},${cell.mergeOriginC}`
      }
      const rs = cell.rowSpan ?? 1
      const cs = cell.gridSpan ?? 1
      return rs > 1 || cs > 1 ? `O${rs}x${cs}` : '.'
    }),
  )
}

function cellText(t: TableObject, r: number, c: number): string {
  const v = t.rows[r]![c]!.text
  return typeof v === 'string' ? v : v.toString()
}

function writeCell(ctx: ReturnType<typeof makeCtx>, id: string, r: number, c: number, s: string) {
  const yt = getTableCellYMap(ctx, id, r, c)!.get('text') as Y.Text
  ctx.doc.transact(() => yt.insert(0, s), LOCAL_ORIGIN)
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

function expectValid(t: TableObject): void {
  expect(collectTableInvariantViolations(t)).toEqual([])
}

// ---------------------------------------------------------------------------
// Row insert / delete vs merges
// ---------------------------------------------------------------------------

describe('insertTableRow — merges', () => {
  it('inserting strictly inside a merge extends its rowSpan and covers the new cells', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 })
    insertTableRow(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)).toEqual([
      ['O3x2', '>0,0', '.'],
      ['>0,0', '>0,0', '.'],
      ['>0,0', '>0,0', '.'],
      ['.', '.', '.'],
      ['.', '.', '.'],
    ])
    expectValid(t)
  })

  it('inserting at the top edge of a merge moves it down without extending it', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    mergeTableCells(ctx, id, { r0: 1, c0: 1, r1: 2, c1: 2 })
    insertTableRow(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)).toEqual([
      ['.', '.', '.'],
      ['.', '.', '.'],
      ['.', 'O2x2', '>2,1'],
      ['.', '>2,1', '>2,1'],
      ['.', '.', '.'],
    ])
    expectValid(t)
  })

  it('inserting at the bottom edge of a merge leaves it untouched', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 0 })
    insertTableRow(ctx, id, 2)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t).map((row) => row[0])).toEqual(['O2x1', '>0,0', '.', '.', '.'])
    expectValid(t)
  })

  it('shifts the pointers of merges below the insertion point', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    mergeTableCells(ctx, id, { r0: 2, c0: 0, r1: 3, c1: 2 })
    insertTableRow(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t).slice(3)).toEqual([
      ['O2x3', '>3,0', '>3,0'],
      ['>3,0', '>3,0', '>3,0'],
    ])
    expectValid(t)
  })
})

describe('deleteTableRow — merges', () => {
  it('deleting a row that passes through a merge shrinks its rowSpan', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 1, r1: 2, c1: 2 })
    deleteTableRow(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)).toEqual([
      ['.', 'O2x2', '>0,1'],
      ['.', '>0,1', '>0,1'],
      ['.', '.', '.'],
    ])
    expectValid(t)
  })

  it("deleting the origin's row moves the origin to the next row, carrying text and style", () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    writeCell(ctx, id, 0, 0, 'Merged')
    const yt = getTableCellYMap(ctx, id, 0, 0)!.get('text') as Y.Text
    ctx.doc.transact(() => yt.format(0, 3, { fontWeight: 700 }), LOCAL_ORIGIN)
    setTableCellStyle(ctx, id, 0, 0, { fill: 0xff0000 })
    writeCell(ctx, id, 1, 0, 'hidden')
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 2, c1: 1 })
    deleteTableRow(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)).toEqual([
      ['O2x2', '>0,0', '.'],
      ['>0,0', '>0,0', '.'],
      ['.', '.', '.'],
    ])
    const origin = t.rows[0]![0]!
    expect(origin.fill).toBe(0xff0000)
    expect((origin.text as Y.Text).toDelta()).toEqual([
      { insert: 'Mer', attributes: { fontWeight: 700 } },
      { insert: 'ged' },
    ])
    expectValid(t)
  })

  it('dissolves the merge when deleting the origin row leaves a single cell', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    writeCell(ctx, id, 1, 2, 'Keep me')
    mergeTableCells(ctx, id, { r0: 1, c0: 2, r1: 2, c1: 2 })
    deleteTableRow(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t).map((row) => row[2])).toEqual(['.', '.', '.'])
    expect(cellText(t, 1, 2)).toBe('Keep me')
    expectValid(t)
  })

  it('dissolves the merge when deleting a covered row leaves a single cell', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    mergeTableCells(ctx, id, { r0: 1, c0: 0, r1: 2, c1: 0 })
    deleteTableRow(ctx, id, 2)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t).map((row) => row[0])).toEqual(['.', '.', '.'])
    expectValid(t)
  })

  it('shifts pointers of merges below the deleted row up by one', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    mergeTableCells(ctx, id, { r0: 2, c0: 0, r1: 3, c1: 1 })
    deleteTableRow(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t).slice(1)).toEqual([
      ['O2x2', '>1,0', '.'],
      ['>1,0', '>1,0', '.'],
    ])
    expectValid(t)
  })

  it('removes a horizontal-only merge together with its row', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 400, rows: 4, cols: 3 })
    mergeTableCells(ctx, id, { r0: 1, c0: 0, r1: 1, c1: 2 })
    deleteTableRow(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(
      mergeGrid(t)
        .flat()
        .every((s) => s === '.'),
    ).toBe(true)
    expectValid(t)
  })
})

// ---------------------------------------------------------------------------
// Column insert / delete vs merges
// ---------------------------------------------------------------------------

describe('insertTableCol / deleteTableCol — merges', () => {
  it('inserting strictly inside a merge extends its gridSpan', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 400, height: 300, rows: 3, cols: 4 })
    mergeTableCells(ctx, id, { r0: 0, c0: 1, r1: 1, c1: 2 })
    insertTableCol(ctx, id, 2)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)).toEqual([
      ['.', 'O2x3', '>0,1', '>0,1', '.'],
      ['.', '>0,1', '>0,1', '>0,1', '.'],
      ['.', '.', '.', '.', '.'],
    ])
    expectValid(t)
  })

  it('inserting at the left edge of a merge moves it right', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 400, height: 300, rows: 3, cols: 4 })
    mergeTableCells(ctx, id, { r0: 1, c0: 1, r1: 2, c1: 2 })
    insertTableCol(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)).toEqual([
      ['.', '.', '.', '.', '.'],
      ['.', '.', 'O2x2', '>1,2', '.'],
      ['.', '.', '>1,2', '>1,2', '.'],
    ])
    expectValid(t)
  })

  it('inserting at the right edge of a merge leaves it untouched', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 400, height: 300, rows: 3, cols: 4 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 0, c1: 1 })
    insertTableCol(ctx, id, 2)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)[0]).toEqual(['O1x2', '>0,0', '.', '.', '.'])
    expectValid(t)
  })

  it('deleting a column that passes through a merge shrinks its gridSpan', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 400, height: 300, rows: 3, cols: 4 })
    mergeTableCells(ctx, id, { r0: 1, c0: 0, r1: 2, c1: 2 })
    deleteTableCol(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)).toEqual([
      ['.', '.', '.'],
      ['O2x2', '>1,0', '.'],
      ['>1,0', '>1,0', '.'],
    ])
    expectValid(t)
  })

  it("deleting the origin's column moves the origin right, carrying its text", () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 400, height: 300, rows: 3, cols: 4 })
    writeCell(ctx, id, 0, 1, 'Title')
    mergeTableCells(ctx, id, { r0: 0, c0: 1, r1: 0, c1: 3 })
    deleteTableCol(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)[0]).toEqual(['.', 'O1x2', '>0,1'])
    expect(cellText(t, 0, 1)).toBe('Title')
    expectValid(t)
  })

  it('shifts pointers of merges right of the deleted column', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 400, height: 300, rows: 3, cols: 4 })
    mergeTableCells(ctx, id, { r0: 0, c0: 2, r1: 1, c1: 3 })
    deleteTableCol(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t).slice(0, 2)).toEqual([
      ['.', 'O2x2', '>0,1'],
      ['.', '>0,1', '>0,1'],
    ])
    expectValid(t)
  })

  it('dissolves the merge when deleting a column leaves a single cell', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 400, height: 300, rows: 3, cols: 4 })
    writeCell(ctx, id, 2, 2, 'Lone')
    mergeTableCells(ctx, id, { r0: 2, c0: 2, r1: 2, c1: 3 })
    deleteTableCol(ctx, id, 2)
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)[2]).toEqual(['.', '.', '.'])
    expect(cellText(t, 2, 2)).toBe('Lone')
    expectValid(t)
  })
})

// ---------------------------------------------------------------------------
// Border segments
// ---------------------------------------------------------------------------

describe('border segments follow their tracks', () => {
  const spec = { color: 0x111111, width: 4 }

  it('appending a row keeps the outer bottom border on the new bottom edge', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 200, height: 200, rows: 2, cols: 2 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'bottom', spec)
    insertTableRow(ctx, id, -1)
    const t = readTable(ctx.objects, id)
    expect(t.borderSegments?.['h:3:0']?.width).toBe(4)
    expect(t.borderSegments?.['h:3:1']?.width).toBe(4)
    expect(t.borderSegments?.['h:2:0']).toBeUndefined()
  })

  it('inserting a row at the top keeps the outer top border on top', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 200, height: 200, rows: 2, cols: 2 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'top', spec)
    insertTableRow(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(t.borderSegments?.['h:0:0']?.width).toBe(4)
    expect(t.borderSegments?.['h:1:0']).toBeUndefined()
  })

  it('inserting a row moves the vertical segments of later rows down with them', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 200, height: 200, rows: 2, cols: 2 })
    setTableBorderSegment(ctx, id, 'v:1:1', spec)
    insertTableRow(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(t.borderSegments?.['v:2:1']?.width).toBe(4)
    expect(t.borderSegments?.['v:1:1']).toBeUndefined()
  })

  it('deleting the last row keeps the outer bottom border on the new bottom edge', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 200, height: 300, rows: 3, cols: 2 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 2, c1: 1 }, 'bottom', spec)
    setTableBorderSegment(ctx, id, 'h:2:0', { color: 0xabcdef, width: 1 })
    deleteTableRow(ctx, id, 2)
    const t = readTable(ctx.objects, id)
    expect(t.borderSegments?.['h:2:0']).toEqual(spec)
    expect(t.borderSegments?.['h:2:1']).toEqual(spec)
    expect(t.borderSegments?.['h:3:0']).toBeUndefined()
  })

  it('deleting a row drops the vertical segments that lived in it', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 200, height: 300, rows: 3, cols: 2 })
    setTableBorderSegment(ctx, id, 'v:1:1', spec)
    setTableBorderSegment(ctx, id, 'v:2:1', { color: 0x00ff00, width: 2 })
    deleteTableRow(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(t.borderSegments?.['v:1:1']).toEqual({ color: 0x00ff00, width: 2 })
    expect(t.borderSegments?.['v:2:1']).toBeUndefined()
  })

  it('appending a column keeps the outer right border on the new right edge', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 200, height: 200, rows: 2, cols: 2 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'right', spec)
    insertTableCol(ctx, id, -1)
    const t = readTable(ctx.objects, id)
    expect(t.borderSegments?.['v:0:3']?.width).toBe(4)
    expect(t.borderSegments?.['v:1:3']?.width).toBe(4)
    expect(t.borderSegments?.['v:0:2']).toBeUndefined()
  })

  it('deleting the last column keeps the outer right border on the new right edge', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 2 }, 'right', spec)
    deleteTableCol(ctx, id, 2)
    const t = readTable(ctx.objects, id)
    expect(t.borderSegments?.['v:0:2']).toEqual(spec)
    expect(t.borderSegments?.['v:1:2']).toEqual(spec)
    expect(t.borderSegments?.['v:0:3']).toBeUndefined()
  })

  it('deleting a column drops the horizontal segments that lived in it', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    setTableBorderSegment(ctx, id, 'h:1:1', spec)
    setTableBorderSegment(ctx, id, 'h:1:2', { color: 0x00ff00, width: 2 })
    deleteTableCol(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(t.borderSegments?.['h:1:1']).toEqual({ color: 0x00ff00, width: 2 })
    expect(t.borderSegments?.['h:1:2']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Size invariant
// ---------------------------------------------------------------------------

describe('size invariant: sum(colWidths) === width, sum(rowHeights) === height', () => {
  it('inserting a row grows the table by the new row', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    insertTableRow(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(t.rowHeights).toEqual([100, 100, 100])
    expect(t.height).toBe(300)
  })

  it('inserting a column grows the table by the new column', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    insertTableCol(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(t.colWidths).toEqual([100, 100, 100, 100])
    expect(t.width).toBe(400)
  })

  it('deleting a row / column shrinks the table by the removed track', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    deleteTableRow(ctx, id, 0)
    deleteTableCol(ctx, id, 2)
    const t = readTable(ctx.objects, id)
    expect(t.height).toBe(100)
    expect(t.width).toBe(200)
    expect(sum(t.rowHeights)).toBe(t.height)
    expect(sum(t.colWidths)).toBe(t.width)
  })

  it('re-establishes the invariant on a proportional (resized) table, keeping rendered sizes', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    // A bbox resize only touches width/height; the renderer then treats the
    // stored vectors as proportions (col px = w * width / sum).
    updateObject<TableObject>(ctx, id, { width: 600, height: 100 })
    insertTableCol(ctx, id, -1)
    insertTableRow(ctx, id, -1)
    const t = readTable(ctx.objects, id)
    // Existing columns kept their rendered 200px; the new one is the average.
    expect(t.colWidths).toEqual([200, 200, 200, 200])
    expect(t.width).toBe(800)
    expect(t.rowHeights).toEqual([50, 50, 50])
    expect(t.height).toBe(150)
  })
})

// ---------------------------------------------------------------------------
// merge / split
// ---------------------------------------------------------------------------

describe('mergeTableCells / splitTableCell keep the invariants', () => {
  it('a range partially overlapping an existing merge grows to cover it', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 300, rows: 3, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 })
    mergeTableCells(ctx, id, { r0: 1, c0: 1, r1: 2, c1: 2 })
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)).toEqual([
      ['O3x3', '>0,0', '>0,0'],
      ['>0,0', '>0,0', '>0,0'],
      ['>0,0', '>0,0', '>0,0'],
    ])
    expectValid(t)
  })

  it('a range containing only part of a merge whose origin is inside it grows too', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 300, rows: 3, cols: 3 })
    mergeTableCells(ctx, id, { r0: 1, c0: 1, r1: 2, c1: 2 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 })
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)[0]![0]).toBe('O3x3')
    expectValid(t)
  })

  it('clamps a range reaching past the table edge', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 300, rows: 3, cols: 3 })
    mergeTableCells(ctx, id, { r0: 1, c0: 1, r1: 9, c1: 9 })
    const t = readTable(ctx.objects, id)
    expect(mergeGrid(t)[1]![1]).toBe('O2x2')
    expectValid(t)
  })

  it('split restores plain cells and keeps the hidden text of covered cells', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 300, rows: 3, cols: 3 })
    writeCell(ctx, id, 1, 1, 'inner')
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 })
    splitTableCell(ctx, id, 1, 0)
    const t = readTable(ctx.objects, id)
    expect(
      mergeGrid(t)
        .flat()
        .every((s) => s === '.'),
    ).toBe(true)
    expect(cellText(t, 1, 1)).toBe('inner')
    expectValid(t)
  })
})

// ---------------------------------------------------------------------------
// One call = one transaction = one undo step
// ---------------------------------------------------------------------------

describe('atomicity', () => {
  it('each structural call is one transaction and undoes as one step', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 300, rows: 3, cols: 3 })
    writeCell(ctx, id, 0, 0, 'origin')
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 2, c1: 2 }, 'all', {
      color: 0x111111,
      width: 2,
    })
    const um = new Y.UndoManager(ctx.objects, {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0,
    })
    const ops: Array<() => void> = [
      () => insertTableRow(ctx, id, 1),
      () => insertTableCol(ctx, id, 1),
      () => deleteTableRow(ctx, id, 0),
      () => deleteTableCol(ctx, id, 0),
      () => mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 2 }),
      () => splitTableCell(ctx, id, 0, 0),
    ]
    for (const op of ops) {
      const before = snapshot(readTable(ctx.objects, id))
      let txCount = 0
      const onTx = () => {
        txCount++
      }
      ctx.doc.on('afterTransaction', onTx)
      op()
      ctx.doc.off('afterTransaction', onTx)
      expect(txCount).toBe(1)
      expectValid(readTable(ctx.objects, id))
      um.undo()
      expect(snapshot(readTable(ctx.objects, id))).toEqual(before)
      um.redo()
    }
  })
})

/** JSON-safe structural snapshot (Y.Text bodies → delta). */
function snapshot(t: TableObject): unknown {
  return {
    ...t,
    rows: t.rows.map((row) =>
      row.map((cell) => ({
        ...cell,
        text: typeof cell.text === 'string' ? cell.text : cell.text.toDelta(),
      })),
    ),
  }
}
