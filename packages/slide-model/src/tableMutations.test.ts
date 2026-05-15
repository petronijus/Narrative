/**
 * tableMutations.test.ts
 *
 * Phase 2 mutations: insert/delete row & col, setCellStyle, setTableDefaults.
 * Every test boots a fresh Y.Doc + objects array, inserts a 2×3 table via
 * `addTable`, then exercises the mutation and reads back via
 * `yMapToPlainObject` to validate the post-mutation shape.
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { yMapToPlainObject } from './bindings.js'
import {
  addTable,
  deleteTableCol,
  deleteTableRow,
  getTableCellYMap,
  getTableMergeInfo,
  insertTableCol,
  insertTableRow,
  mergeTableCells,
  setRangeBorderPreset,
  setRangeCellStyle,
  setTableCellStyle,
  setTableColWidth,
  setTableDefaultsPatch,
  setTableRowHeight,
  splitTableCell,
} from './tableMutations.js'
import type { TableObject } from '@narrative/shared'

function makeCtx() {
  const doc = new Y.Doc()
  const objects = doc.getArray<Y.Map<unknown>>('objects')
  return { doc, objects }
}

function readTable(objects: Y.Array<Y.Map<unknown>>, id: string): TableObject {
  for (let i = 0; i < objects.length; i++) {
    const m = objects.get(i)!
    if (m.get('id') === id) return yMapToPlainObject<TableObject>(m)
  }
  throw new Error(`readTable: id ${id} not found`)
}

describe('insertTableRow', () => {
  it('appends a row when atIndex is out of range', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    insertTableRow(ctx, id, 99)
    const t = readTable(ctx.objects, id)
    expect(t.rows).toHaveLength(3)
    expect(t.rowHeights).toHaveLength(3)
    expect(t.rows[2]).toHaveLength(3)
  })

  it('inserts at the given index, shifting later rows down', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    // Mark row 0 cell 0 so we can tell the rows apart after insertion.
    setTableCellStyle(ctx, id, 0, 0, { fill: 0xff0000 })
    insertTableRow(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(t.rows).toHaveLength(3)
    // The previously-red cell should now be at row 1.
    expect(t.rows[0]![0]!.fill).toBeUndefined()
    expect(t.rows[1]![0]!.fill).toBe(0xff0000)
  })

  it('new row height = avg of existing rows', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    // Initial 2 rows split 200px → each row = 100. Avg = 100.
    insertTableRow(ctx, id, -1)
    const t = readTable(ctx.objects, id)
    expect(t.rowHeights[2]).toBeCloseTo(100, 5)
  })
})

describe('insertTableCol', () => {
  it('appends a column', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    insertTableCol(ctx, id, -1)
    const t = readTable(ctx.objects, id)
    expect(t.colWidths).toHaveLength(4)
    expect(t.rows[0]).toHaveLength(4)
    expect(t.rows[1]).toHaveLength(4)
  })

  it('inserts at the given index', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    setTableCellStyle(ctx, id, 0, 0, { fill: 0xff00ff })
    insertTableCol(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(t.rows[0]![0]!.fill).toBeUndefined()
    expect(t.rows[0]![1]!.fill).toBe(0xff00ff)
  })
})

describe('deleteTableRow / deleteTableCol', () => {
  it('refuses to delete the last row', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 60, rows: 1, cols: 3 })
    deleteTableRow(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(t.rows).toHaveLength(1)
  })

  it('removes the row + its height entry', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    deleteTableRow(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(t.rows).toHaveLength(1)
    expect(t.rowHeights).toHaveLength(1)
  })

  it('refuses to delete the last column', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 100, height: 60, rows: 2, cols: 1 })
    deleteTableCol(ctx, id, 0)
    const t = readTable(ctx.objects, id)
    expect(t.colWidths).toHaveLength(1)
  })

  it('removes the column from every row', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    deleteTableCol(ctx, id, 1)
    const t = readTable(ctx.objects, id)
    expect(t.colWidths).toHaveLength(2)
    expect(t.rows[0]).toHaveLength(2)
    expect(t.rows[1]).toHaveLength(2)
  })
})

describe('setTableCellStyle', () => {
  it('patches fill + color + align in one transact', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    setTableCellStyle(ctx, id, 1, 2, {
      fill: 0x123456,
      color: 0xabcdef,
      align: 'center',
      vAlign: 'middle',
    })
    const t = readTable(ctx.objects, id)
    const cell = t.rows[1]![2]!
    expect(cell.fill).toBe(0x123456)
    expect(cell.color).toBe(0xabcdef)
    expect(cell.align).toBe('center')
    expect(cell.vAlign).toBe('middle')
  })

  it('deletes a field when patched with undefined', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    setTableCellStyle(ctx, id, 0, 0, { fill: 0xff0000 })
    setTableCellStyle(ctx, id, 0, 0, { fill: undefined })
    const t = readTable(ctx.objects, id)
    expect(t.rows[0]![0]!.fill).toBeUndefined()
  })

  it('stores border + padding as nested Y.Map (still round-trips to plain)', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    setTableCellStyle(ctx, id, 0, 0, {
      border: { top: { color: 0x111111, width: 2 } },
      padding: { top: 12, right: 16, bottom: 12, left: 16 },
    })
    const t = readTable(ctx.objects, id)
    const cell = t.rows[0]![0]!
    expect(cell.border?.top?.color).toBe(0x111111)
    expect(cell.padding?.top).toBe(12)
    expect(cell.padding?.left).toBe(16)
  })
})

describe('setTableDefaultsPatch', () => {
  it('updates fontSize + color', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    setTableDefaultsPatch(ctx, id, { fontSize: 24, color: 0x222222 })
    const t = readTable(ctx.objects, id)
    expect(t.defaults.fontSize).toBe(24)
    expect(t.defaults.color).toBe(0x222222)
  })

  it('replaces border wholesale', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    setTableDefaultsPatch(ctx, id, { border: { color: 0x999999, width: 3 } })
    const t = readTable(ctx.objects, id)
    expect(t.defaults.border?.color).toBe(0x999999)
    expect(t.defaults.border?.width).toBe(3)
  })
})

describe('setTableColWidth / setTableRowHeight', () => {
  it('changes the entry at the given index without touching neighbours', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    const before = readTable(ctx.objects, id)
    setTableColWidth(ctx, id, 1, 250)
    setTableRowHeight(ctx, id, 0, 80)
    const after = readTable(ctx.objects, id)
    expect(after.colWidths[0]).toBe(before.colWidths[0])
    expect(after.colWidths[1]).toBe(250)
    expect(after.colWidths[2]).toBe(before.colWidths[2])
    expect(after.rowHeights[0]).toBe(80)
    expect(after.rowHeights[1]).toBe(before.rowHeights[1])
  })

  it('clamps to a 1px minimum (no zero/negative widths)', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    setTableColWidth(ctx, id, 0, 0)
    setTableRowHeight(ctx, id, 0, -50)
    const t = readTable(ctx.objects, id)
    expect(t.colWidths[0]).toBe(1)
    expect(t.rowHeights[0]).toBe(1)
  })
})

describe('mergeTableCells / splitTableCell', () => {
  it('stamps origin with gridSpan/rowSpan and continuation cells with pointers', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 3, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 })
    const t = readTable(ctx.objects, id)
    expect(t.rows[0]![0]!.gridSpan).toBe(2)
    expect(t.rows[0]![0]!.rowSpan).toBe(2)
    expect(t.rows[0]![1]!.mergeOriginR).toBe(0)
    expect(t.rows[0]![1]!.mergeOriginC).toBe(0)
    expect(t.rows[1]![0]!.mergeOriginR).toBe(0)
    expect(t.rows[1]![1]!.mergeOriginC).toBe(0)
    // Untouched cells stay clean.
    expect(t.rows[2]![2]!.mergeOriginR).toBeUndefined()
    expect(t.rows[2]![2]!.gridSpan).toBeUndefined()
  })

  it('single-cell range is a no-op', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 3, cols: 3 })
    mergeTableCells(ctx, id, { r0: 1, c0: 1, r1: 1, c1: 1 })
    const t = readTable(ctx.objects, id)
    expect(t.rows[1]![1]!.gridSpan).toBeUndefined()
    expect(t.rows[1]![1]!.rowSpan).toBeUndefined()
  })

  it('split clears gridSpan/rowSpan and removes pointers', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 3, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 2 })
    splitTableCell(ctx, id, 0, 0)
    const t = readTable(ctx.objects, id)
    expect(t.rows[0]![0]!.gridSpan).toBeUndefined()
    expect(t.rows[0]![0]!.rowSpan).toBeUndefined()
    for (let r = 0; r <= 1; r++) {
      for (let c = 0; c <= 2; c++) {
        expect(t.rows[r]![c]!.mergeOriginR).toBeUndefined()
        expect(t.rows[r]![c]!.mergeOriginC).toBeUndefined()
      }
    }
  })

  it('split walks from a continuation pointer back to the origin', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 3, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 })
    splitTableCell(ctx, id, 1, 1) // continuation cell
    const t = readTable(ctx.objects, id)
    expect(t.rows[0]![0]!.gridSpan).toBeUndefined()
    expect(t.rows[1]![1]!.mergeOriginR).toBeUndefined()
  })

  it('getTableMergeInfo distinguishes origin, continuation, and plain cells', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 3, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 })
    expect(getTableMergeInfo(ctx, id, 0, 0)).toEqual({
      kind: 'origin',
      rowSpan: 2,
      colSpan: 2,
    })
    expect(getTableMergeInfo(ctx, id, 1, 1)).toEqual({
      kind: 'continuation',
      originR: 0,
      originC: 0,
    })
    expect(getTableMergeInfo(ctx, id, 2, 2)).toBeNull()
  })
})

describe('setRangeCellStyle', () => {
  it('applies the patch to every non-continuation cell in the range', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 3, cols: 3 })
    setRangeCellStyle(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 2 }, { fill: 0x123456 })
    const t = readTable(ctx.objects, id)
    for (let r = 0; r <= 1; r++) {
      for (let c = 0; c <= 2; c++) {
        expect(t.rows[r]![c]!.fill).toBe(0x123456)
      }
    }
    // Out of range
    expect(t.rows[2]![0]!.fill).toBeUndefined()
  })

  it('skips merge continuation cells (origin still gets patched)', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 3, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 0, c1: 1 })
    setRangeCellStyle(ctx, id, { r0: 0, c0: 0, r1: 0, c1: 2 }, { color: 0x111111 })
    const t = readTable(ctx.objects, id)
    expect(t.rows[0]![0]!.color).toBe(0x111111) // origin patched
    expect(t.rows[0]![1]!.color).toBeUndefined() // continuation skipped
    expect(t.rows[0]![2]!.color).toBe(0x111111) // unmerged cell patched
  })
})

describe('setRangeBorderPreset', () => {
  const spec = { color: 0x111111, width: 2 }

  it('outer: only perimeter cells of the range carry an active matching edge', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 3, cols: 3 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 2, c1: 2 }, 'outer', spec)
    const t = readTable(ctx.objects, id)
    // Top-left corner — top + left active (width 2), right + bottom inactive (width 0)
    expect(t.rows[0]![0]!.border?.top?.width).toBe(2)
    expect(t.rows[0]![0]!.border?.left?.width).toBe(2)
    expect(t.rows[0]![0]!.border?.right?.width).toBe(0)
    expect(t.rows[0]![0]!.border?.bottom?.width).toBe(0)
    // Bottom-right — bottom + right active
    expect(t.rows[2]![2]!.border?.bottom?.width).toBe(2)
    expect(t.rows[2]![2]!.border?.right?.width).toBe(2)
    expect(t.rows[2]![2]!.border?.top?.width).toBe(0)
    expect(t.rows[2]![2]!.border?.left?.width).toBe(0)
    // Interior cell — every edge written with width 0 so the default grid
    // is suppressed inside the range.
    expect(t.rows[1]![1]!.border?.top?.width).toBe(0)
    expect(t.rows[1]![1]!.border?.right?.width).toBe(0)
    expect(t.rows[1]![1]!.border?.bottom?.width).toBe(0)
    expect(t.rows[1]![1]!.border?.left?.width).toBe(0)
  })

  it('all: every cell gets all four edges', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 2 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'all', spec)
    const t = readTable(ctx.objects, id)
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const cell = t.rows[r]![c]!
        expect(cell.border?.top?.color).toBe(0x111111)
        expect(cell.border?.right?.color).toBe(0x111111)
        expect(cell.border?.bottom?.color).toBe(0x111111)
        expect(cell.border?.left?.color).toBe(0x111111)
      }
    }
  })

  it('inside: only interior cells carry top/left (one line per divider)', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 2 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'inside', spec)
    const t = readTable(ctx.objects, id)
    // (0,0): top-row + left-col → no interior edges active
    expect(t.rows[0]![0]!.border?.top?.width).toBe(0)
    expect(t.rows[0]![0]!.border?.left?.width).toBe(0)
    // (0,1): top-row but not left-col → only left edge active (vertical divider)
    expect(t.rows[0]![1]!.border?.left?.width).toBe(2)
    expect(t.rows[0]![1]!.border?.top?.width).toBe(0)
    // (1,0): left-col but not top-row → only top edge active (horizontal divider)
    expect(t.rows[1]![0]!.border?.top?.width).toBe(2)
    expect(t.rows[1]![0]!.border?.left?.width).toBe(0)
    // (1,1): interior cell → both top and left active
    expect(t.rows[1]![1]!.border?.top?.width).toBe(2)
    expect(t.rows[1]![1]!.border?.left?.width).toBe(2)
  })

  it('none: every edge of every cell in range is suppressed (width 0)', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 2 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'all', spec)
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'none', spec)
    const t = readTable(ctx.objects, id)
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const b = t.rows[r]![c]!.border
        expect(b?.top?.width).toBe(0)
        expect(b?.right?.width).toBe(0)
        expect(b?.bottom?.width).toBe(0)
        expect(b?.left?.width).toBe(0)
      }
    }
  })

  it('bottom: only the bottom-row cells carry an active bottom edge', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 3, cols: 2 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 2, c1: 1 }, 'bottom', spec)
    const t = readTable(ctx.objects, id)
    expect(t.rows[0]![0]!.border?.bottom?.width).toBe(0)
    expect(t.rows[1]![0]!.border?.bottom?.width).toBe(0)
    expect(t.rows[2]![0]!.border?.bottom?.width).toBe(2)
    expect(t.rows[2]![1]!.border?.bottom?.width).toBe(2)
  })

  it('honours an optional dash style on active edges', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 2 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'all', {
      color: 0xff0000,
      width: 3,
      dash: 'dash',
    })
    const t = readTable(ctx.objects, id)
    expect(t.rows[0]![0]!.border?.top?.dash).toBe('dash')
    expect(t.rows[0]![0]!.border?.bottom?.dash).toBe('dash')
    // Inactive (zero-width) edges shouldn't carry a dash field.
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 1 }, 'outer', {
      color: 0xff0000,
      width: 3,
      dash: 'dot',
    })
    const t2 = readTable(ctx.objects, id)
    // (0,0) interior edges (right/bottom) are inactive → width 0, no dash
    expect(t2.rows[0]![0]!.border?.right?.width).toBe(0)
    expect(t2.rows[0]![0]!.border?.right?.dash).toBeUndefined()
    expect(t2.rows[0]![0]!.border?.top?.dash).toBe('dot')
  })

  it('skips merge continuation cells', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    mergeTableCells(ctx, id, { r0: 0, c0: 0, r1: 0, c1: 1 })
    setRangeBorderPreset(ctx, id, { r0: 0, c0: 0, r1: 1, c1: 2 }, 'all', spec)
    const t = readTable(ctx.objects, id)
    // Origin gets the border, continuation pointer is untouched.
    expect(t.rows[0]![0]!.border?.top?.width).toBe(2)
    expect(t.rows[0]![1]!.border).toBeUndefined()
    expect(t.rows[0]![2]!.border?.top?.width).toBe(2)
  })
})

describe('getTableCellYMap', () => {
  it('returns the cell Y.Map with a live Y.Text reference', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    const cellY = getTableCellYMap(ctx, id, 0, 1)
    expect(cellY).not.toBeNull()
    const yt = cellY!.get('text')
    expect(yt).toBeInstanceOf(Y.Text)
    // Mutate the Y.Text directly — read back via plain projection.
    ;(yt as Y.Text).insert(0, 'hi')
    const t = readTable(ctx.objects, id)
    expect((t.rows[0]![1]!.text as Y.Text).toString()).toBe('hi')
  })

  it('returns null for out-of-range indices', () => {
    const ctx = makeCtx()
    const id = addTable(ctx, { x: 0, y: 0, width: 300, height: 200, rows: 2, cols: 3 })
    expect(getTableCellYMap(ctx, id, 5, 0)).toBeNull()
    expect(getTableCellYMap(ctx, id, 0, 10)).toBeNull()
    expect(getTableCellYMap(ctx, 'no-such-id', 0, 0)).toBeNull()
  })
})
