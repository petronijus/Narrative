/**
 * slide-model/src/tableMutations.ts
 *
 * M29 — mutation API for the first-class TableObject: creation, row /
 * column insert + delete, merge / split, cell + range styling, border
 * segments. The structural invariants the row / column / merge
 * mutations keep (size sums, merge geometry, border keys) are documented
 * above `insertTableRow` and checked by `tableMutations.property.test.ts`.
 *
 * `addTable` is a convenience wrapper over `addObject` that builds a
 * fresh TableObject (default 3×3, 8px padding, 1px #CCCCCC grid) at the
 * caller-specified bbox. The wrapper exists so toolbar callers don't
 * have to know the cell schema's internals; later mutations build
 * directly on the Y.Map handles returned by `getSlideObjectsCtx`.
 */

import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import type { SlideObject, TableCell, TableDefaults, TableObject } from '@narrative/shared'
import { addObject, LOCAL_ORIGIN, type ObjectsMutationContext } from './mutations.js'

/**
 * Default styling baked into a fresh table. Mirrors the renderer's
 * fallback values so a brand-new table looks consistent before any
 * cell-level overrides land. Matches the M29 plan's open-question
 * defaults: 8px padding, 1px #CCCCCC grid, body font 18px.
 */
export const DEFAULT_TABLE_DEFAULTS: TableDefaults = {
  fontSize: 18,
  fontWeight: 'normal',
  color: 0x111111,
  align: 'left',
  vAlign: 'middle',
  border: { color: 0xcccccc, width: 1 },
  padding: { top: 8, right: 8, bottom: 8, left: 8 },
}

/** Default columns / rows for a click-to-place table — same default as
 *  Keynote (3×3 to give the user a starting grid without being noisy). */
export const DEFAULT_TABLE_COLS = 3
export const DEFAULT_TABLE_ROWS = 3

export interface AddTableOpts {
  /** The table's id (default: a fresh nanoid); the caller makes sure the slide has no such object. */
  id?: string
  /** Slide-local position of the table's top-left. */
  x: number
  y: number
  /** Outer bbox size; col widths + row heights are divided evenly. */
  width: number
  height: number
  /** Defaults to `DEFAULT_TABLE_ROWS`. */
  rows?: number
  /** Defaults to `DEFAULT_TABLE_COLS`. */
  cols?: number
  /** Override the styling defaults — merged shallow over `DEFAULT_TABLE_DEFAULTS`. */
  defaults?: Partial<TableDefaults>
  /** Author-visible name for the layer panel (optional). */
  name?: string
}

/**
 * Build a fresh TableObject — pure construction, no Yjs side effects.
 * Used directly by `addTable` (slide-model) and by the toolbar's
 * `createObjectOfType` path on the editor side so both produce the
 * same shape.
 */
export function buildTable(opts: AddTableOpts): TableObject {
  const rowCount = Math.max(1, Math.floor(opts.rows ?? DEFAULT_TABLE_ROWS))
  const colCount = Math.max(1, Math.floor(opts.cols ?? DEFAULT_TABLE_COLS))
  // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
  // optional field, so we build `defaults` field-by-field skipping any
  // override that's explicitly undefined. Falls through to the
  // baseline `DEFAULT_TABLE_DEFAULTS` for any field the caller didn't
  // touch.
  const defaults: TableDefaults = { ...DEFAULT_TABLE_DEFAULTS }
  if (opts.defaults !== undefined) {
    for (const [k, v] of Object.entries(opts.defaults) as Array<[keyof TableDefaults, unknown]>) {
      if (v === undefined) continue
      ;(defaults as unknown as Record<string, unknown>)[k] = v
    }
  }
  // Divide the outer bbox evenly — `width / cols` per column, `height /
  // rows` per row. Rounding at the cell boundary keeps every cell on a
  // whole-px grid (no sub-pixel seams in the renderer).
  const colW = opts.width / colCount
  const rowH = opts.height / rowCount
  const colWidths: number[] = []
  for (let c = 0; c < colCount; c++) colWidths.push(colW)
  const rowHeights: number[] = []
  for (let r = 0; r < rowCount; r++) rowHeights.push(rowH)

  const rows: TableCell[][] = []
  for (let r = 0; r < rowCount; r++) {
    const row: TableCell[] = []
    for (let c = 0; c < colCount; c++) {
      row.push({ text: '' })
    }
    rows.push(row)
  }

  const table: TableObject = {
    id: opts.id ?? nanoid(),
    type: 'table',
    x: opts.x,
    y: opts.y,
    width: opts.width,
    height: opts.height,
    rotation: 0,
    opacity: 1,
    colWidths,
    rowHeights,
    rows,
    defaults,
  }
  if (opts.name !== undefined) table.name = opts.name
  return table
}

/**
 * Insert a fresh TableObject into a slide via the standard
 * `addObject` mutation. Returns the generated table's `id` so callers
 * can immediately select it.
 *
 * Cells start with empty Y.Text bodies (created during the
 * `plainObjectToYMap` → `buildTableCellYMap` binding); the editor's
 * cell-edit mode (Phase 2) populates them on user typing.
 */
export function addTable(ctx: ObjectsMutationContext, opts: AddTableOpts): string {
  const table = buildTable(opts)
  addObject(ctx, table as SlideObject)
  return table.id
}

// ---------------------------------------------------------------------------
// Phase 2 — structural & style mutations on an existing table
// ---------------------------------------------------------------------------

/**
 * Locate the table Y.Map by id in the slide's objects array. Returns
 * `null` if the id isn't present or the object isn't a table — keeps
 * callers from accidentally mutating a non-table object that happens
 * to share the id namespace (which shouldn't happen, but defensive).
 */
function findTableYMap(ctx: ObjectsMutationContext, id: string): Y.Map<unknown> | null {
  for (let i = 0; i < ctx.objects.length; i++) {
    const m = ctx.objects.get(i)
    if (m === undefined) continue
    if (m.get('id') === id && m.get('type') === 'table') return m
  }
  return null
}

/**
 * Apply a coordinate transform to every segment in `segs`. The
 * `mapper` returns the new (row, col) for a segment OR `null` to
 * drop the segment (e.g. when its line collapsed into a neighbour
 * after a row / column delete). Implemented as clear + repopulate
 * inside a single transact — the only safe way to bulk-rewrite Y.Map
 * keys without aliasing live entries during iteration.
 */
function shiftBorderSegments(
  segs: Y.Map<unknown>,
  mapper: (orient: 'h' | 'v', row: number, col: number) => { row: number; col: number } | null,
): void {
  const next: Array<[string, unknown]> = []
  segs.forEach((v, k) => {
    const m = /^(h|v):(\d+):(\d+)$/.exec(k)
    if (m === null) {
      next.push([k, v])
      return
    }
    const orient = m[1] as 'h' | 'v'
    const row = Number.parseInt(m[2]!, 10)
    const col = Number.parseInt(m[3]!, 10)
    const out = mapper(orient, row, col)
    if (out !== null) next.push([`${orient}:${out.row}:${out.col}`, v])
  })
  segs.clear()
  for (const [k, v] of next) segs.set(k, v)
}

/** Pull the borderSegments Y.Map from a table, or `null` when absent. */
function getBorderSegmentsMap(yMap: Y.Map<unknown>): Y.Map<unknown> | null {
  const segs = yMap.get('borderSegments')
  return segs instanceof Y.Map ? segs : null
}

/**
 * Build a fresh, empty cell Y.Map. Uses an EMPTY Y.Text (no text inserts)
 * so the two-phase deep-integration trap doesn't apply — callers can
 * append the result to an already-integrated parent and immediately
 * read the cell's Y.Text reference for binding to a contenteditable.
 */
function buildEmptyCellYMap(): Y.Map<unknown> {
  const y = new Y.Map<unknown>()
  y.set('text', new Y.Text())
  return y
}

// ---------------------------------------------------------------------------
// Structural model shared by the row / column / merge mutations
// ---------------------------------------------------------------------------
//
// Invariants every structural mutation below maintains (and the property
// test in `tableMutations.property.test.ts` checks on random sequences):
//
//   1. Size. `sum(colWidths) === width` and `sum(rowHeights) === height`.
//      A bbox resize (`updateObject` on width/height) deliberately leaves
//      the vectors alone and the renderer treats them as proportions, so
//      a structural mutation first re-normalises a drifted vector to the
//      px sizes the renderer currently draws (`normalizeTrackSizes`) —
//      nothing moves on screen — and then grows / shrinks the table by
//      exactly the inserted / removed track.
//
//   2. Merges. A merge is the rectangle owned by an ORIGIN cell carrying
//      `rowSpan` + `gridSpan` (both written, like PPTX import does); every
//      other cell of the rectangle carries `mergeOriginR`/`mergeOriginC`
//      pointing at the origin and no span; cells outside any merge carry
//      none of the four keys. Spans stay inside the grid, rectangles never
//      overlap. Mutations compute the merge list in the new coordinates
//      and `writeMerges` reconciles the four keys cell by cell, writing
//      only what differs (no churn on untouched cells).
//
//   3. Border segments. `h:<r>:<c>` (line above row r, in column c) and
//      `v:<r>:<c>` (line left of column c, in row r) move with the track
//      they belong to; segments inside a deleted track are removed; the
//      table perimeter stays on the perimeter (see the insert / delete
//      docs for the exact rules).
//
// Semantics on insert / delete follow PowerPoint:
//
//   - Inserting a track strictly inside a merge (between two of its
//     tracks) extends that merge's span by one; the new cells are covered.
//     Inserting at a merge's edge (before its first or after its last
//     track) does not extend it.
//   - Deleting a track that passes through a merge shrinks its span.
//     Deleting the origin's track moves the origin to the next surviving
//     cell of the rectangle, which takes over the origin's text (rich-text
//     delta, replayed in place) and its cell-level styling — the merged
//     cell looks exactly as before minus one track. That covered cell's
//     own hidden content is discarded (it was invisible and the merged
//     cell's content wins, as in PowerPoint). A merge reduced to one cell
//     dissolves; a merge whose every track is deleted disappears with it.
//   - Pointers of cells after the insertion / deletion point shift by one.
//
// Every public mutation runs in ONE `doc.transact(..., LOCAL_ORIGIN)` so
// it is one undo step.

type RowsArray = Y.Array<Y.Array<Y.Map<unknown>>>

interface TableHandles {
  yMap: Y.Map<unknown>
  rows: RowsArray
  colWidths: Y.Array<number>
  rowHeights: Y.Array<number>
}

function getTableHandles(ctx: ObjectsMutationContext, id: string): TableHandles | null {
  const yMap = findTableYMap(ctx, id)
  if (yMap === null) return null
  const rows = yMap.get('rows')
  const colWidths = yMap.get('colWidths')
  const rowHeights = yMap.get('rowHeights')
  if (!(rows instanceof Y.Array) || !(colWidths instanceof Y.Array)) return null
  if (!(rowHeights instanceof Y.Array)) return null
  return {
    yMap,
    rows: rows as RowsArray,
    colWidths: colWidths as Y.Array<number>,
    rowHeights: rowHeights as Y.Array<number>,
  }
}

function cellAt(rows: RowsArray, r: number, c: number): Y.Map<unknown> | undefined {
  const row = rows.get(r) as Y.Array<Y.Map<unknown>> | undefined
  if (!(row instanceof Y.Array)) return undefined
  const cell = row.get(c)
  return cell instanceof Y.Map ? cell : undefined
}

/** A merged rectangle: origin at (r, c), spanning `rs` rows × `cs` cols. */
interface MergeArea {
  r: number
  c: number
  rs: number
  cs: number
}

function spanOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1
}

/**
 * Read the merge list of a table from its ORIGIN cells. Row-major; the
 * first rectangle to claim a cell wins, so malformed legacy data (an
 * overlapping or out-of-bounds span, a stale pointer) is resolved
 * deterministically: spans are clamped to the grid, a later origin that
 * overlaps an earlier rectangle is dropped, pointers are ignored here
 * (they are re-derived from the origins by `writeMerges`).
 */
function readMerges(rows: RowsArray, rowCount: number, colCount: number): MergeArea[] {
  const claimed: boolean[][] = []
  for (let r = 0; r < rowCount; r++) claimed.push(new Array<boolean>(colCount).fill(false))
  const out: MergeArea[] = []
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      if (claimed[r]![c]) continue
      const cell = cellAt(rows, r, c)
      if (cell === undefined) continue
      if (cell.get('mergeOriginR') !== undefined || cell.get('mergeOriginC') !== undefined) continue
      const rs = Math.min(spanOf(cell.get('rowSpan')), rowCount - r)
      const cs = Math.min(spanOf(cell.get('gridSpan')), colCount - c)
      if (rs === 1 && cs === 1) continue
      let free = true
      for (let rr = r; rr < r + rs && free; rr++) {
        for (let cc = c; cc < c + cs; cc++) {
          if (claimed[rr]![cc]) {
            free = false
            break
          }
        }
      }
      if (!free) continue
      for (let rr = r; rr < r + rs; rr++) {
        for (let cc = c; cc < c + cs; cc++) claimed[rr]![cc] = true
      }
      out.push({ r, c, rs, cs })
    }
  }
  return out
}

const MERGE_KEYS = ['gridSpan', 'rowSpan', 'mergeOriginR', 'mergeOriginC'] as const

function setIfChanged(cell: Y.Map<unknown>, key: string, value: number): void {
  if (cell.get(key) !== value) cell.set(key, value)
}

function deleteIfPresent(cell: Y.Map<unknown>, key: string): void {
  if (cell.has(key)) cell.delete(key)
}

/**
 * Reconcile the four merge keys on every cell of a `rowCount × colCount`
 * grid with `merges` (which must be in-bounds and non-overlapping).
 * Writes only the keys whose value differs, so an untouched merge costs
 * no CRDT ops. Must run inside the caller's transaction.
 */
function writeMerges(
  rows: RowsArray,
  rowCount: number,
  colCount: number,
  merges: ReadonlyArray<MergeArea>,
): void {
  type Want =
    | { kind: 'plain' }
    | { kind: 'origin'; m: MergeArea }
    | { kind: 'covered'; m: MergeArea }
  const want: Want[][] = []
  for (let r = 0; r < rowCount; r++) {
    const row: Want[] = []
    for (let c = 0; c < colCount; c++) row.push({ kind: 'plain' })
    want.push(row)
  }
  for (const m of merges) {
    if (m.rs * m.cs <= 1) continue
    for (let r = m.r; r < m.r + m.rs && r < rowCount; r++) {
      for (let c = m.c; c < m.c + m.cs && c < colCount; c++) {
        want[r]![c] = r === m.r && c === m.c ? { kind: 'origin', m } : { kind: 'covered', m }
      }
    }
  }
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const cell = cellAt(rows, r, c)
      if (cell === undefined) continue
      const w = want[r]![c]!
      if (w.kind === 'plain') {
        for (const k of MERGE_KEYS) deleteIfPresent(cell, k)
      } else if (w.kind === 'origin') {
        setIfChanged(cell, 'gridSpan', w.m.cs)
        setIfChanged(cell, 'rowSpan', w.m.rs)
        deleteIfPresent(cell, 'mergeOriginR')
        deleteIfPresent(cell, 'mergeOriginC')
      } else {
        setIfChanged(cell, 'mergeOriginR', w.m.r)
        setIfChanged(cell, 'mergeOriginC', w.m.c)
        deleteIfPresent(cell, 'gridSpan')
        deleteIfPresent(cell, 'rowSpan')
      }
    }
  }
}

type Axis = 'row' | 'col'

/** Where a merge lands after inserting a track at `at` on `axis`. */
function mergeAfterInsert(m: MergeArea, axis: Axis, at: number): MergeArea {
  const start = axis === 'row' ? m.r : m.c
  const span = axis === 'row' ? m.rs : m.cs
  let nextStart = start
  let nextSpan = span
  if (at <= start) nextStart = start + 1
  else if (at < start + span) nextSpan = span + 1
  return axis === 'row'
    ? { r: nextStart, c: m.c, rs: nextSpan, cs: m.cs }
    : { r: m.r, c: nextStart, rs: m.rs, cs: nextSpan }
}

/**
 * Where a merge lands after deleting the track `at` on `axis`, or null
 * when nothing of it survives. When `at` is the origin's track the start
 * index stays the same: the next track slides into it and becomes the
 * origin's (the caller copies the origin's content there first).
 */
function mergeAfterDelete(m: MergeArea, axis: Axis, at: number): MergeArea | null {
  const start = axis === 'row' ? m.r : m.c
  const span = axis === 'row' ? m.rs : m.cs
  let nextStart = start
  let nextSpan = span
  if (at < start) nextStart = start - 1
  else if (at < start + span) nextSpan = span - 1
  if (nextSpan < 1) return null
  const out: MergeArea =
    axis === 'row'
      ? { r: nextStart, c: m.c, rs: nextSpan, cs: m.cs }
      : { r: m.r, c: nextStart, rs: m.rs, cs: nextSpan }
  return out.rs * out.cs > 1 ? out : null
}

/** Deep copy of a cell value so two cells never share a CRDT instance. */
function cloneCellValue(v: unknown): unknown {
  if (v instanceof Y.Map) {
    const m = new Y.Map<unknown>()
    v.forEach((sv, sk) => m.set(sk, cloneCellValue(sv)))
    return m
  }
  if (v instanceof Y.Array) {
    const a = new Y.Array<unknown>()
    a.push(v.toArray().map(cloneCellValue))
    return a
  }
  if (v instanceof Y.Text) return v.toString()
  if (Array.isArray(v)) return v.map(cloneCellValue)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, sv] of Object.entries(v as Record<string, unknown>)) o[k] = cloneCellValue(sv)
    return o
  }
  return v
}

/**
 * Make `to` a copy of `from`'s content — cell-level styling plus the text
 * body — leaving the merge keys to `writeMerges`. The text is replaced IN
 * PLACE on `to`'s Y.Text by replaying `from`'s delta, so inline runs and
 * paragraph attributes (lists, levels — carried on U+2029) survive and
 * `to` keeps its Y.Text identity. Must run inside the caller's
 * transaction, with both cells integrated.
 */
function copyCellContent(from: Y.Map<unknown>, to: Y.Map<unknown>): void {
  const skip = new Set<string>([...MERGE_KEYS, 'text'])
  for (const k of Array.from(to.keys())) {
    if (!skip.has(k) && !from.has(k)) to.delete(k)
  }
  from.forEach((v, k) => {
    if (!skip.has(k)) to.set(k, cloneCellValue(v))
  })
  const src = from.get('text')
  const dst = to.get('text')
  if (src instanceof Y.Text) {
    const delta = src.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>
    let target: Y.Text
    if (dst instanceof Y.Text) {
      target = dst
      if (target.length > 0) target.delete(0, target.length)
    } else {
      target = new Y.Text()
      to.set('text', target)
    }
    target.applyDelta(delta)
  } else if (typeof src === 'string') {
    if (dst instanceof Y.Text) {
      if (dst.length > 0) dst.delete(0, dst.length)
      if (src.length > 0) dst.insert(0, src)
    } else {
      to.set('text', src)
    }
  } else if (dst instanceof Y.Text && dst.length > 0) {
    dst.delete(0, dst.length)
  }
}

function sumOf(xs: ReadonlyArray<number>): number {
  let s = 0
  for (const x of xs) s += x
  return s
}

function replaceNumberArray(arr: Y.Array<number>, values: ReadonlyArray<number>): void {
  if (arr.length > 0) arr.delete(0, arr.length)
  if (values.length > 0) arr.insert(0, values.slice())
}

/**
 * Return the px size of each of `count` tracks as the renderer draws them
 * (`stored * total / sum(stored)`), rewriting `arr` to those values when
 * the stored vector had drifted from `total` (bbox resize, legacy data,
 * length mismatch). After this, `sum(arr) === total` up to float error.
 * `total` falls back to the stored sum when the table has no usable
 * size. Must run inside the caller's transaction.
 */
function normalizeTrackSizes(arr: Y.Array<number>, count: number, total: unknown): number[] {
  const stored: number[] = []
  for (let i = 0; i < Math.min(arr.length, count); i++) {
    const v = arr.get(i)
    stored.push(typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  }
  const positive = stored.filter((v) => v > 0)
  const fill = positive.length > 0 ? sumOf(positive) / positive.length : 1
  const filled = stored.map((v) => (v > 0 ? v : fill))
  while (filled.length < count) filled.push(fill)
  const storedSum = sumOf(filled)
  const target =
    typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : storedSum
  const scale = storedSum > 0 ? target / storedSum : 1
  const sizes = scale === 1 ? filled : filled.map((v) => v * scale)
  let same = arr.length === sizes.length
  for (let i = 0; same && i < sizes.length; i++) same = arr.get(i) === sizes[i]
  if (!same) replaceNumberArray(arr, sizes)
  return sizes
}

function avgSize(sizes: ReadonlyArray<number>, fallback: number): number {
  return sizes.length > 0 ? sumOf(sizes) / sizes.length : fallback
}

/**
 * Insert a row at `atIndex`. Pass `atIndex >= rowCount` (or `-1`) to
 * append at the end. New cells start blank and inherit the table's
 * defaults; the new row's height is the average of the existing rows and
 * the table grows by it (`height` += new row).
 *
 * Merges: see the module notes above — inserting strictly inside a merge
 * extends its rowSpan and covers the new cells; merges at or below the
 * insertion point move down by one.
 *
 * Border segments keep their physical lines:
 *   - Vertical segments of rows >= `atIndex` move down with their row.
 *   - Horizontal lines strictly below the insertion point shift down.
 *   - The line at the insertion point stays above the new row, except
 *     when appending: the table's bottom edge moves down to stay the
 *     bottom edge. The new row's other lines start unset and fall back
 *     to `defaults.border`.
 */
export function insertTableRow(
  ctx: ObjectsMutationContext,
  tableId: string,
  atIndex: number,
): void {
  const t = getTableHandles(ctx, tableId)
  if (t === null) return
  const rowCount = t.rows.length
  const colCount = t.colWidths.length
  const insertAt = atIndex < 0 || atIndex > rowCount ? rowCount : Math.floor(atIndex)
  ctx.doc.transact(() => {
    const merges = readMerges(t.rows, rowCount, colCount)
    const heights = normalizeTrackSizes(t.rowHeights, rowCount, t.yMap.get('height'))
    const newHeight = avgSize(heights, 40)

    const newRow = new Y.Array<Y.Map<unknown>>()
    const cells: Y.Map<unknown>[] = []
    for (let c = 0; c < colCount; c++) cells.push(buildEmptyCellYMap())
    newRow.push(cells)
    t.rows.insert(insertAt, [newRow])
    t.rowHeights.insert(insertAt, [newHeight])
    heights.splice(insertAt, 0, newHeight)
    t.yMap.set('height', sumOf(heights))

    writeMerges(
      t.rows,
      rowCount + 1,
      colCount,
      merges.map((m) => mergeAfterInsert(m, 'row', insertAt)),
    )

    const segs = getBorderSegmentsMap(t.yMap)
    if (segs !== null) {
      const appending = insertAt === rowCount && rowCount > 0
      shiftBorderSegments(segs, (orient, row, col) => {
        if (orient === 'v') return { row: row >= insertAt ? row + 1 : row, col }
        if (row > insertAt || (row === insertAt && appending)) return { row: row + 1, col }
        return { row, col }
      })
    }
  }, LOCAL_ORIGIN)
}

/**
 * Insert a column at `atIndex` (or append when out of range). New cells
 * start blank; the new column's width is the average of the existing
 * columns and the table grows by it (`width` += new column). Merges and
 * border segments follow the same rules as `insertTableRow`, with the
 * axes swapped (appending keeps the right edge on the right).
 */
export function insertTableCol(
  ctx: ObjectsMutationContext,
  tableId: string,
  atIndex: number,
): void {
  const t = getTableHandles(ctx, tableId)
  if (t === null) return
  const rowCount = t.rows.length
  const colCount = t.colWidths.length
  const insertAt = atIndex < 0 || atIndex > colCount ? colCount : Math.floor(atIndex)
  ctx.doc.transact(() => {
    const merges = readMerges(t.rows, rowCount, colCount)
    const widths = normalizeTrackSizes(t.colWidths, colCount, t.yMap.get('width'))
    const newWidth = avgSize(widths, 60)

    for (let r = 0; r < rowCount; r++) {
      const row = t.rows.get(r)
      if (!(row instanceof Y.Array)) continue
      row.insert(Math.min(insertAt, row.length), [buildEmptyCellYMap()])
    }
    t.colWidths.insert(insertAt, [newWidth])
    widths.splice(insertAt, 0, newWidth)
    t.yMap.set('width', sumOf(widths))

    writeMerges(
      t.rows,
      rowCount,
      colCount + 1,
      merges.map((m) => mergeAfterInsert(m, 'col', insertAt)),
    )

    const segs = getBorderSegmentsMap(t.yMap)
    if (segs !== null) {
      const appending = insertAt === colCount && colCount > 0
      shiftBorderSegments(segs, (orient, row, col) => {
        if (orient === 'h') return { row, col: col >= insertAt ? col + 1 : col }
        if (col > insertAt || (col === insertAt && appending)) return { row, col: col + 1 }
        return { row, col }
      })
    }
  }, LOCAL_ORIGIN)
}

/**
 * Delete the row at `atIndex`. No-op when the table has only one row
 * left (a 0-row table is degenerate; let the user delete the whole
 * object via the standard delete-object path instead). The table
 * shrinks by the removed row (`height` -= its height).
 *
 * Merges: rowSpans through the row shrink; a merge whose origin sits in
 * the row hands its origin role, text and styling to the cell below it
 * (see the module notes); merges below shift up; one-cell leftovers
 * dissolve.
 *
 * Border segments: vertical segments in the deleted row are removed and
 * everything below shifts up. Of the two horizontal lines bounding the
 * row, the interior one is removed: normally the line below it (the one
 * above survives), but for the last row the line above it, so the
 * table's bottom edge stays the bottom edge.
 */
export function deleteTableRow(
  ctx: ObjectsMutationContext,
  tableId: string,
  atIndex: number,
): void {
  const t = getTableHandles(ctx, tableId)
  if (t === null) return
  const rowCount = t.rows.length
  const colCount = t.colWidths.length
  if (rowCount <= 1) return
  if (atIndex < 0 || atIndex >= rowCount) return
  const at = Math.floor(atIndex)
  ctx.doc.transact(() => {
    const merges = readMerges(t.rows, rowCount, colCount)
    for (const m of merges) {
      if (m.r !== at || m.rs < 2) continue
      const from = cellAt(t.rows, at, m.c)
      const to = cellAt(t.rows, at + 1, m.c)
      if (from !== undefined && to !== undefined) copyCellContent(from, to)
    }
    const heights = normalizeTrackSizes(t.rowHeights, rowCount, t.yMap.get('height'))

    t.rows.delete(at, 1)
    t.rowHeights.delete(at, 1)
    heights.splice(at, 1)
    t.yMap.set('height', sumOf(heights))

    const next: MergeArea[] = []
    for (const m of merges) {
      const moved = mergeAfterDelete(m, 'row', at)
      if (moved !== null) next.push(moved)
    }
    writeMerges(t.rows, rowCount - 1, colCount, next)

    const segs = getBorderSegmentsMap(t.yMap)
    if (segs !== null) {
      const dropH = at === rowCount - 1 ? at : at + 1
      shiftBorderSegments(segs, (orient, row, col) => {
        if (orient === 'v') {
          if (row === at) return null
          return { row: row > at ? row - 1 : row, col }
        }
        if (row === dropH) return null
        return { row: row > dropH ? row - 1 : row, col }
      })
    }
  }, LOCAL_ORIGIN)
}

/**
 * Delete the column at `atIndex`. Same single-column guard as
 * `deleteTableRow`; the table shrinks by the removed column (`width` -=
 * its width). Merges and border segments mirror `deleteTableRow` with
 * the axes swapped: an origin in the deleted column hands over to the
 * cell on its right, horizontal segments in the column are removed, and
 * deleting the last column keeps the right edge on the right.
 */
export function deleteTableCol(
  ctx: ObjectsMutationContext,
  tableId: string,
  atIndex: number,
): void {
  const t = getTableHandles(ctx, tableId)
  if (t === null) return
  const rowCount = t.rows.length
  const colCount = t.colWidths.length
  if (colCount <= 1) return
  if (atIndex < 0 || atIndex >= colCount) return
  const at = Math.floor(atIndex)
  ctx.doc.transact(() => {
    const merges = readMerges(t.rows, rowCount, colCount)
    for (const m of merges) {
      if (m.c !== at || m.cs < 2) continue
      const from = cellAt(t.rows, m.r, at)
      const to = cellAt(t.rows, m.r, at + 1)
      if (from !== undefined && to !== undefined) copyCellContent(from, to)
    }
    const widths = normalizeTrackSizes(t.colWidths, colCount, t.yMap.get('width'))

    for (let r = 0; r < rowCount; r++) {
      const row = t.rows.get(r)
      if (!(row instanceof Y.Array)) continue
      if (at < row.length) row.delete(at, 1)
    }
    t.colWidths.delete(at, 1)
    widths.splice(at, 1)
    t.yMap.set('width', sumOf(widths))

    const next: MergeArea[] = []
    for (const m of merges) {
      const moved = mergeAfterDelete(m, 'col', at)
      if (moved !== null) next.push(moved)
    }
    writeMerges(t.rows, rowCount, colCount - 1, next)

    const segs = getBorderSegmentsMap(t.yMap)
    if (segs !== null) {
      const dropV = at === colCount - 1 ? at : at + 1
      shiftBorderSegments(segs, (orient, row, col) => {
        if (orient === 'h') {
          if (col === at) return null
          return { row, col: col > at ? col - 1 : col }
        }
        if (col === dropV) return null
        return { row, col: col > dropV ? col - 1 : col }
      })
    }
  }, LOCAL_ORIGIN)
}

/**
 * Read the cell Y.Map at (r, c) — useful for callers that need to bind
 * a contenteditable to the cell's Y.Text. Returns null when out of
 * range or the table doesn't exist.
 */
export function getTableCellYMap(
  ctx: ObjectsMutationContext,
  tableId: string,
  r: number,
  c: number,
): Y.Map<unknown> | null {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return null
  const rowsY = yMap.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>> | undefined
  if (rowsY === undefined) return null
  const row = rowsY.get(r)
  if (row === undefined) return null
  const cell = row.get(c)
  return cell ?? null
}

/**
 * Patch fields on a single cell. Pass `value === undefined` for any key
 * to delete that field (the cell falls back to the table's `defaults`
 * for the affected style). `text` must be a Y.Text — string assignment
 * here would orphan the Y.Text binding and break collab; use the
 * Y.Text's own delete/insert API instead.
 */
// Each field may be `undefined` to *delete* the cell-level override and
// fall back to the table's defaults. `exactOptionalPropertyTypes`
// requires the union with `undefined` to be explicit on every property
// (a bare optional `?:` doesn't accept `undefined`).
type WithUndefined<T> = { [K in keyof T]: T[K] | undefined }
export type CellStylePatch = Partial<
  WithUndefined<Omit<TableCell, 'text' | 'border' | 'padding'>>
> & {
  border?: TableCell['border'] | undefined
  padding?: TableCell['padding'] | undefined
}

export function setTableCellStyle(
  ctx: ObjectsMutationContext,
  tableId: string,
  r: number,
  c: number,
  patch: CellStylePatch,
): void {
  const cellY = getTableCellYMap(ctx, tableId, r, c)
  if (cellY === null) return
  ctx.doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) {
        cellY.delete(k)
        continue
      }
      if ((k === 'border' || k === 'padding') && v !== null && typeof v === 'object') {
        const sub = new Y.Map<unknown>()
        for (const [sk, sv] of Object.entries(v as unknown as Record<string, unknown>)) {
          sub.set(sk, sv)
        }
        cellY.set(k, sub)
        continue
      }
      cellY.set(k, v)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Patch the table-wide defaults. Same delete-on-undefined semantics as
 * `setTableCellStyle`. Border / padding are replaced wholesale (it's
 * rare to patch a single edge default in practice; per-cell overrides
 * cover that case).
 */
export function setTableDefaultsPatch(
  ctx: ObjectsMutationContext,
  tableId: string,
  patch: Partial<TableDefaults>,
): void {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return
  const defaultsY = yMap.get('defaults') as Y.Map<unknown> | undefined
  if (defaultsY === undefined) return
  ctx.doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) {
        defaultsY.delete(k)
        continue
      }
      if ((k === 'border' || k === 'padding') && v !== null && typeof v === 'object') {
        const sub = new Y.Map<unknown>()
        for (const [sk, sv] of Object.entries(v as unknown as Record<string, unknown>)) {
          sub.set(sk, sv)
        }
        defaultsY.set(k, sub)
        continue
      }
      defaultsY.set(k, v)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Set the absolute width of a single column (Phase 5 drag handles use
 * this). The renderer rescales `colWidths` to fit `table.width` so the
 * value is effectively a proportion within the column-vector sum.
 */
export function setTableColWidth(
  ctx: ObjectsMutationContext,
  tableId: string,
  colIndex: number,
  width: number,
): void {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return
  const colWidths = yMap.get('colWidths') as Y.Array<number> | undefined
  if (colWidths === undefined) return
  if (colIndex < 0 || colIndex >= colWidths.length) return
  ctx.doc.transact(() => {
    colWidths.delete(colIndex, 1)
    colWidths.insert(colIndex, [Math.max(1, width)])
  }, LOCAL_ORIGIN)
}

export function setTableRowHeight(
  ctx: ObjectsMutationContext,
  tableId: string,
  rowIndex: number,
  height: number,
): void {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return
  const rowHeights = yMap.get('rowHeights') as Y.Array<number> | undefined
  if (rowHeights === undefined) return
  if (rowIndex < 0 || rowIndex >= rowHeights.length) return
  ctx.doc.transact(() => {
    rowHeights.delete(rowIndex, 1)
    rowHeights.insert(rowIndex, [Math.max(1, height)])
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// Phase 3 — Merge / unmerge + range-wide style apply
// ---------------------------------------------------------------------------

/** Normalise an (r0, c0, r1, c1) rectangle so lo ≤ hi on each axis. */
function normRange(
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): { r0: number; c0: number; r1: number; c1: number } {
  return {
    r0: Math.min(r0, r1),
    c0: Math.min(c0, c1),
    r1: Math.max(r0, r1),
    c1: Math.max(c0, c1),
  }
}

/**
 * Read the rows Y.Array helper — handles the cell lookup boilerplate.
 * Returns null when the table doesn't exist or the structure is broken.
 */
function getRowsArr(
  ctx: ObjectsMutationContext,
  tableId: string,
): Y.Array<Y.Array<Y.Map<unknown>>> | null {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return null
  const rowsY = yMap.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>> | undefined
  return rowsY ?? null
}

function intersects(m: MergeArea, g: { r0: number; c0: number; r1: number; c1: number }): boolean {
  return m.r <= g.r1 && m.r + m.rs - 1 >= g.r0 && m.c <= g.c1 && m.c + m.cs - 1 >= g.c0
}

/**
 * Merge a rectangular range of cells. The top-left cell becomes the
 * origin and receives `gridSpan`/`rowSpan` for the merge extent; every
 * other cell in the range is stamped with `mergeOriginR`/`mergeOriginC`
 * pointers so the renderer can skip them and the origin can paint
 * their area.
 *
 * The range is first clamped to the table, then grown until it contains
 * every existing merge it touches — the PowerPoint rule that a selection
 * always consists of whole merged cells — so the result is one clean
 * rectangle that swallows those merges; merges outside it are untouched.
 * A range that ends up as a single cell is a no-op.
 *
 * Cell text on the continuation cells is preserved (a future "split"
 * surfaces it again) — destructive truncation would surprise users
 * who merge by mistake and split right after.
 */
export function mergeTableCells(
  ctx: ObjectsMutationContext,
  tableId: string,
  range: { r0: number; c0: number; r1: number; c1: number },
): void {
  const t = getTableHandles(ctx, tableId)
  if (t === null) return
  const rowCount = t.rows.length
  const colCount = t.colWidths.length
  const n = normRange(range.r0, range.c0, range.r1, range.c1)
  const g = {
    r0: Math.max(0, Math.floor(n.r0)),
    c0: Math.max(0, Math.floor(n.c0)),
    r1: Math.min(rowCount - 1, Math.floor(n.r1)),
    c1: Math.min(colCount - 1, Math.floor(n.c1)),
  }
  if (g.r0 > g.r1 || g.c0 > g.c1) return // range entirely outside the table
  const merges = readMerges(t.rows, rowCount, colCount)
  let grown = true
  while (grown) {
    grown = false
    for (const m of merges) {
      if (!intersects(m, g)) continue
      const r1 = m.r + m.rs - 1
      const c1 = m.c + m.cs - 1
      if (m.r < g.r0 || m.c < g.c0 || r1 > g.r1 || c1 > g.c1) {
        g.r0 = Math.min(g.r0, m.r)
        g.c0 = Math.min(g.c0, m.c)
        g.r1 = Math.max(g.r1, r1)
        g.c1 = Math.max(g.c1, c1)
        grown = true
      }
    }
  }
  if (g.r0 === g.r1 && g.c0 === g.c1) return // single-cell merge is a no-op
  const next = merges.filter((m) => !intersects(m, g))
  next.push({ r: g.r0, c: g.c0, rs: g.r1 - g.r0 + 1, cs: g.c1 - g.c0 + 1 })
  ctx.doc.transact(() => {
    writeMerges(t.rows, rowCount, colCount, next)
  }, LOCAL_ORIGIN)
}

/**
 * Split a merged cell back into individual cells. `(r, c)` may be the
 * origin or any cell the merge covers. No-op when the targeted cell
 * isn't part of a merge. Every cell of the rectangle becomes a plain
 * cell again, showing whatever (hidden) content it kept while merged.
 */
export function splitTableCell(
  ctx: ObjectsMutationContext,
  tableId: string,
  r: number,
  c: number,
): void {
  const t = getTableHandles(ctx, tableId)
  if (t === null) return
  const rowCount = t.rows.length
  const colCount = t.colWidths.length
  const merges = readMerges(t.rows, rowCount, colCount)
  const hit = merges.find((m) => r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs)
  if (hit === undefined) return
  ctx.doc.transact(() => {
    writeMerges(
      t.rows,
      rowCount,
      colCount,
      merges.filter((m) => m !== hit),
    )
  }, LOCAL_ORIGIN)
}

/**
 * Apply a style patch to every cell in a rectangular range. Skips merge
 * continuation pointers so the patch lands on visible cells only — the
 * origin still gets the patch even when the merge covers the whole
 * range, which is what callers expect from "select rows + recolor".
 */
export function setRangeCellStyle(
  ctx: ObjectsMutationContext,
  tableId: string,
  range: { r0: number; c0: number; r1: number; c1: number },
  patch: CellStylePatch,
): void {
  const rowsY = getRowsArr(ctx, tableId)
  if (rowsY === null) return
  const { r0, c0, r1, c1 } = normRange(range.r0, range.c0, range.r1, range.c1)
  ctx.doc.transact(() => {
    for (let r = r0; r <= r1; r++) {
      const row = rowsY.get(r)
      if (row === undefined) continue
      for (let c = c0; c <= c1 && c < row.length; c++) {
        const cell = row.get(c)
        if (cell === undefined) continue
        // Skip continuation pointers — the origin sits within the range
        // anyway and will pick up the patch on its own iteration.
        if (cell.get('mergeOriginR') !== undefined || cell.get('mergeOriginC') !== undefined) {
          continue
        }
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) {
            cell.delete(k)
            continue
          }
          if ((k === 'border' || k === 'padding') && v !== null && typeof v === 'object') {
            const sub = new Y.Map<unknown>()
            for (const [sk, sv] of Object.entries(v as unknown as Record<string, unknown>)) {
              sub.set(sk, sv)
            }
            cell.set(k, sub)
            continue
          }
          cell.set(k, v)
        }
      }
    }
  }, LOCAL_ORIGIN)
}

/**
 * Border preset names — Keynote-style 9-cell preset grid in the
 * Inspector. Each preset maps every cell in the range to a specific
 * set of edges (top/right/bottom/left). Cells whose computed edge set
 * is empty get their `border` field deleted so they fall back to the
 * table defaults.
 *
 *   - `none`     : Clear all borders on every cell in the range.
 *   - `all`      : Every cell gets all four edges.
 *   - `outer`    : Perimeter of the range only. Cells on the top/bottom
 *                  row get top/bottom; cells on the left/right column
 *                  get left/right. Interior cells get no edges.
 *   - `inside`   : Interior dividers only. Stamped on BOTH sides of
 *                  every inner line so width 0 truly hides it instead
 *                  of leaving the unowned half drawing via the table
 *                  default — see the comment above `edgesForPreset`.
 *   - `top` / `bottom` / `left` / `right`: only the named outer edge
 *                  on the cells that touch that edge of the range.
 *   - `insideH`  : Horizontal interior dividers only (stamped on both
 *                  sides — see `inside`).
 *   - `insideV`  : Vertical interior dividers only (stamped on both
 *                  sides — see `inside`).
 */
export type TableBorderPreset =
  | 'none'
  | 'all'
  | 'outer'
  | 'inside'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'insideH'
  | 'insideV'

export type TableCellEdge = 'top' | 'right' | 'bottom' | 'left'
type CellEdge = TableCellEdge

/**
 * Pick the per-cell edges this preset wants stamped at `(r, c)` inside
 * `range`. Symmetry for inside-family presets matters: each inner
 * divider gets BOTH adjacent cells' opposing edges (e.g. (r,c).bottom
 * AND (r+1,c).top for an inner horizontal). The renderer would
 * otherwise resurrect a "cleared" divider from `defaults.border` via
 * the unowned half when the caller stamps width 0 — Keynote-style
 * "hide inside borders" only works if BOTH halves drop to width 0.
 * The extra write at width > 0 is a no-op visually (same color/width
 * on both sides of one line).
 */
export function edgesForPreset(
  preset: TableBorderPreset,
  r: number,
  c: number,
  range: { r0: number; c0: number; r1: number; c1: number },
): TableCellEdge[] {
  const isTopRow = r === range.r0
  const isBottomRow = r === range.r1
  const isLeftCol = c === range.c0
  const isRightCol = c === range.c1
  switch (preset) {
    case 'none':
      return []
    case 'all':
      return ['top', 'right', 'bottom', 'left']
    case 'outer': {
      const out: CellEdge[] = []
      if (isTopRow) out.push('top')
      if (isBottomRow) out.push('bottom')
      if (isLeftCol) out.push('left')
      if (isRightCol) out.push('right')
      return out
    }
    case 'inside': {
      const out: CellEdge[] = []
      if (!isTopRow) out.push('top')
      if (!isBottomRow) out.push('bottom')
      if (!isLeftCol) out.push('left')
      if (!isRightCol) out.push('right')
      return out
    }
    case 'top':
      return isTopRow ? ['top'] : []
    case 'bottom':
      return isBottomRow ? ['bottom'] : []
    case 'left':
      return isLeftCol ? ['left'] : []
    case 'right':
      return isRightCol ? ['right'] : []
    case 'insideH': {
      const out: CellEdge[] = []
      if (!isTopRow) out.push('top')
      if (!isBottomRow) out.push('bottom')
      return out
    }
    case 'insideV': {
      const out: CellEdge[] = []
      if (!isLeftCol) out.push('left')
      if (!isRightCol) out.push('right')
      return out
    }
  }
}

/**
 * Compute the segment keys a preset targets on a given range. Mirrors
 * the visual presets the inspector exposes:
 *   - `none`     → every segment in the perimeter of the range (so we
 *                  can write width 0 and force the renderer to skip).
 *   - `all`      → every segment touching the range (outer + inner).
 *   - `outer`    → top + bottom + left + right of the range only.
 *   - `inside`   → inner-horizontal + inner-vertical lines only.
 *   - `top` / `bottom` / `left` / `right` → that single outer line.
 *   - `insideH` / `insideV` → the inner subset of the matching axis.
 *
 * Horizontal lines in range cover rows `[r0..r1+1]` × cols `[c0..c1]`.
 * Vertical lines cover rows `[r0..r1]` × cols `[c0..c1+1]`.
 */
export function segmentsForPreset(
  preset: TableBorderPreset,
  range: { r0: number; c0: number; r1: number; c1: number },
): Set<string> {
  const { r0, c0, r1, c1 } = range
  const out = new Set<string>()
  const addHRow = (row: number): void => {
    for (let c = c0; c <= c1; c++) out.add(`h:${row}:${c}`)
  }
  const addVCol = (col: number): void => {
    for (let r = r0; r <= r1; r++) out.add(`v:${r}:${col}`)
  }
  switch (preset) {
    case 'none':
    case 'all': {
      for (let row = r0; row <= r1 + 1; row++) addHRow(row)
      for (let col = c0; col <= c1 + 1; col++) addVCol(col)
      return out
    }
    case 'outer': {
      addHRow(r0)
      addHRow(r1 + 1)
      addVCol(c0)
      addVCol(c1 + 1)
      return out
    }
    case 'top':
      addHRow(r0)
      return out
    case 'bottom':
      addHRow(r1 + 1)
      return out
    case 'left':
      addVCol(c0)
      return out
    case 'right':
      addVCol(c1 + 1)
      return out
    case 'inside': {
      for (let row = r0 + 1; row <= r1; row++) addHRow(row)
      for (let col = c0 + 1; col <= c1; col++) addVCol(col)
      return out
    }
    case 'insideH': {
      for (let row = r0 + 1; row <= r1; row++) addHRow(row)
      return out
    }
    case 'insideV': {
      for (let col = c0 + 1; col <= c1; col++) addVCol(col)
      return out
    }
  }
}

/**
 * Apply a Keynote-style border preset to a range. Writes to the
 * table's flat `borderSegments` Y.Map keyed by segment address. Each
 * grid line in a table is now a SINGLE value (one segment, one
 * stroke spec) — the renderer paints each line once without the
 * per-cell-edge ambiguity the older `cell.border` model had.
 *
 *   - Preset → `segmentsForPreset` → key set targeted on the range.
 *   - For each key: `borderSegments.set(key, value)` where `value` is
 *     `{ color, width, dash? }` from the inspector. `preset === 'none'`
 *     writes width 0 so the renderer's `width <= 0 → skip` guard
 *     suppresses any `defaults.border` fallback on those lines.
 *
 * Legacy `cell.border` data on the same table is intentionally NOT
 * cleared — the renderer's segment-lookup falls back to
 * `cell.border` only when `borderSegments[key]` is missing, so once
 * any preset stamps the affected keys the new value wins.
 */
export function setRangeBorderPreset(
  ctx: ObjectsMutationContext,
  tableId: string,
  range: { r0: number; c0: number; r1: number; c1: number },
  preset: TableBorderPreset,
  edgeSpec: { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' },
): void {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return
  const norm = normRange(range.r0, range.c0, range.r1, range.c1)
  const keys = segmentsForPreset(preset, norm)
  if (keys.size === 0) return
  const value: { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' } = {
    color: edgeSpec.color,
    width: preset === 'none' ? 0 : edgeSpec.width,
  }
  if (preset !== 'none' && edgeSpec.dash !== undefined) value.dash = edgeSpec.dash
  ctx.doc.transact(() => {
    let segs = yMap.get('borderSegments')
    if (!(segs instanceof Y.Map)) {
      segs = new Y.Map<unknown>()
      yMap.set('borderSegments', segs)
    }
    for (const key of keys) (segs as Y.Map<unknown>).set(key, value)
  }, LOCAL_ORIGIN)
}

/**
 * Write a single border segment directly. Used by inspector controls
 * that operate on one line at a time (e.g. a future per-segment style
 * picker); `setRangeBorderPreset` is the bulk path.
 */
export function setTableBorderSegment(
  ctx: ObjectsMutationContext,
  tableId: string,
  key: string,
  value: { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' } | undefined,
): void {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return
  ctx.doc.transact(() => {
    let segs = yMap.get('borderSegments')
    if (!(segs instanceof Y.Map)) {
      if (value === undefined) return
      segs = new Y.Map<unknown>()
      yMap.set('borderSegments', segs)
    }
    if (value === undefined) (segs as Y.Map<unknown>).delete(key)
    else (segs as Y.Map<unknown>).set(key, value)
  }, LOCAL_ORIGIN)
}

/**
 * Read whether the cell at (r, c) is the origin of a merge (returns its
 * extent), a continuation (returns the origin coords), or neither.
 * Used by UI to decide whether to render "Merge" vs "Split" in menus.
 */
export function getTableMergeInfo(
  ctx: ObjectsMutationContext,
  tableId: string,
  r: number,
  c: number,
):
  | { kind: 'origin'; rowSpan: number; colSpan: number }
  | { kind: 'continuation'; originR: number; originC: number }
  | null {
  const rowsY = getRowsArr(ctx, tableId)
  if (rowsY === null) return null
  const cell = rowsY.get(r)?.get(c)
  if (cell === undefined) return null
  const ptrR = cell.get('mergeOriginR')
  const ptrC = cell.get('mergeOriginC')
  if (typeof ptrR === 'number' && typeof ptrC === 'number') {
    return { kind: 'continuation', originR: ptrR, originC: ptrC }
  }
  const colSpan = (cell.get('gridSpan') as number | undefined) ?? 1
  const rowSpan = (cell.get('rowSpan') as number | undefined) ?? 1
  if (colSpan > 1 || rowSpan > 1) return { kind: 'origin', rowSpan, colSpan }
  return null
}
