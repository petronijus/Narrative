/**
 * tableMutations.property.test.ts
 *
 * Property test for the table structure mutations: any random sequence
 * of row / column insert + delete, merge, split, border presets and bbox
 * resizes must leave the table satisfying every invariant checked by
 * `collectTableInvariantViolations` (grid shape, size sums, merge
 * geometry, border keys in-bounds) after EVERY step, and undoing the
 * whole sequence one step at a time must restore the starting table
 * (each call is exactly one undo step).
 *
 * Comparison is structural (plain snapshots, Y.Text → delta), never
 * CRDT bytes.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
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
  splitTableCell,
} from './tableMutations.js'
import { collectTableInvariantViolations } from './tableInvariants.testUtil.js'

type Op =
  | { kind: 'insertRow'; at: number }
  | { kind: 'insertCol'; at: number }
  | { kind: 'deleteRow'; at: number }
  | { kind: 'deleteCol'; at: number }
  | { kind: 'merge'; r0: number; c0: number; r1: number; c1: number }
  | { kind: 'split'; r: number; c: number }
  | { kind: 'border'; r0: number; c0: number; r1: number; c1: number; all: boolean }
  | { kind: 'resize'; width: number; height: number }

// Indices are drawn from a small range and reduced modulo the live grid
// size when applied, so every op targets a real track most of the time
// while still exercising the append (-1 / out-of-range) paths.
const idx = fc.integer({ min: -1, max: 7 })

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('insertRow' as const), at: idx }),
  fc.record({ kind: fc.constant('insertCol' as const), at: idx }),
  fc.record({ kind: fc.constant('deleteRow' as const), at: idx }),
  fc.record({ kind: fc.constant('deleteCol' as const), at: idx }),
  fc.record({ kind: fc.constant('merge' as const), r0: idx, c0: idx, r1: idx, c1: idx }),
  fc.record({ kind: fc.constant('merge' as const), r0: idx, c0: idx, r1: idx, c1: idx }),
  fc.record({ kind: fc.constant('split' as const), r: idx, c: idx }),
  fc.record({
    kind: fc.constant('border' as const),
    r0: idx,
    c0: idx,
    r1: idx,
    c1: idx,
    all: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('resize' as const),
    width: fc.integer({ min: 50, max: 900 }),
    height: fc.integer({ min: 50, max: 900 }),
  }),
)

function readTable(objects: Y.Array<Y.Map<unknown>>, id: string): TableObject {
  for (let i = 0; i < objects.length; i++) {
    const m = objects.get(i)
    if (m.get('id') === id) return yMapToPlainObject<TableObject>(m)
  }
  throw new Error(`readTable: id ${id} not found`)
}

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

const mod = (v: number, n: number): number => (v < 0 ? v : v % Math.max(1, n))

function apply(ctx: { doc: Y.Doc; objects: Y.Array<Y.Map<unknown>> }, id: string, op: Op): void {
  const t = readTable(ctx.objects, id)
  const rows = t.rows.length
  const cols = t.colWidths.length
  const r = (v: number) => Math.max(0, mod(v, rows))
  const c = (v: number) => Math.max(0, mod(v, cols))
  switch (op.kind) {
    case 'insertRow':
      insertTableRow(ctx, id, mod(op.at, rows + 1))
      return
    case 'insertCol':
      insertTableCol(ctx, id, mod(op.at, cols + 1))
      return
    case 'deleteRow':
      deleteTableRow(ctx, id, r(op.at))
      return
    case 'deleteCol':
      deleteTableCol(ctx, id, c(op.at))
      return
    case 'merge':
      mergeTableCells(ctx, id, { r0: r(op.r0), c0: c(op.c0), r1: r(op.r1), c1: c(op.c1) })
      return
    case 'split':
      splitTableCell(ctx, id, r(op.r), c(op.c))
      return
    case 'border':
      setRangeBorderPreset(
        ctx,
        id,
        { r0: r(op.r0), c0: c(op.c0), r1: r(op.r1), c1: c(op.c1) },
        op.all ? 'all' : 'outer',
        { color: 0x112233, width: 2 },
      )
      return
    case 'resize':
      // A bbox resize leaves the vectors as proportions (see the
      // `sizesDrifted` bookkeeping in the property below).
      updateObject<TableObject>(ctx, id, { width: op.width, height: op.height })
      return
  }
}

describe('table structure mutations — property', () => {
  it('random insert / delete / merge / split sequences keep every invariant and undo cleanly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(opArb, { minLength: 1, maxLength: 30 }),
        (rows0, cols0, ops) => {
          const doc = new Y.Doc()
          const objects = doc.getArray<Y.Map<unknown>>('objects')
          const ctx = { doc, objects }
          const id = addTable(ctx, {
            x: 0,
            y: 0,
            width: 100 * cols0,
            height: 50 * rows0,
            rows: rows0,
            cols: cols0,
          })
          // Label every cell so text carried by origin moves is visible in
          // the undo comparison.
          doc.transact(() => {
            for (let rr = 0; rr < rows0; rr++) {
              for (let cc = 0; cc < cols0; cc++) {
                const yt = getTableCellYMap(ctx, id, rr, cc)!.get('text') as Y.Text
                yt.insert(0, `${rr}:${cc}`, cc % 2 === 0 ? { fontWeight: 700 } : {})
              }
            }
          })
          const initial = snapshot(readTable(objects, id))
          const um = new Y.UndoManager(objects, {
            trackedOrigins: new Set([LOCAL_ORIGIN]),
            captureTimeout: 0,
          })

          let steps = 0
          // A bbox resize turns the size vectors into proportions on purpose;
          // the next op that changes the track count on an axis must
          // restore that axis' sum.
          let colsDrifted = false
          let rowsDrifted = false
          for (const op of ops) {
            const before = um.undoStack.length
            const shapeBefore = readTable(objects, id)
            apply(ctx, id, op)
            if (um.undoStack.length > before) steps++
            expect(um.undoStack.length - before).toBeLessThanOrEqual(1)
            const after = readTable(objects, id)
            if (op.kind === 'resize') {
              colsDrifted = true
              rowsDrifted = true
            }
            if (after.colWidths.length !== shapeBefore.colWidths.length) colsDrifted = false
            if (after.rows.length !== shapeBefore.rows.length) rowsDrifted = false
            const relevant = collectTableInvariantViolations(after).filter(
              (v) =>
                !(colsDrifted && v.startsWith('sum(colWidths)')) &&
                !(rowsDrifted && v.startsWith('sum(rowHeights)')),
            )
            expect(relevant).toEqual([])
          }

          for (let i = 0; i < steps; i++) um.undo()
          expect(snapshot(readTable(objects, id))).toEqual(initial)
        },
      ),
      { numRuns: 300 },
    )
  })
})
