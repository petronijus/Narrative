/**
 * slide-model/src/tableMutations.ts
 *
 * M29 Phase 1 — minimal mutation API for the first-class TableObject.
 * Only the surface needed to insert a table from the toolbar lives here;
 * the row/column/merge mutations land in Phase 2 once the renderer
 * surfaces selection state to drive them.
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
    id: nanoid(),
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

function avgOf(arr: Y.Array<number>, fallback: number): number {
  if (arr.length === 0) return fallback
  let s = 0
  for (let i = 0; i < arr.length; i++) s += arr.get(i) ?? 0
  return s / arr.length
}

/**
 * Insert a row at `atIndex`. Pass `atIndex >= rowCount` (or `-1`) to
 * append at the end. New cells start blank and inherit the table's
 * defaults; new row height = average of existing rows so the visual
 * footprint scales naturally.
 */
export function insertTableRow(
  ctx: ObjectsMutationContext,
  tableId: string,
  atIndex: number,
): void {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return
  const rowsY = yMap.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>> | undefined
  const rowHeights = yMap.get('rowHeights') as Y.Array<number> | undefined
  const colWidths = yMap.get('colWidths') as Y.Array<number> | undefined
  if (rowsY === undefined || rowHeights === undefined || colWidths === undefined) return
  const colCount = colWidths.length
  const insertAt = atIndex < 0 || atIndex > rowsY.length ? rowsY.length : Math.floor(atIndex)
  ctx.doc.transact(() => {
    const newRow = new Y.Array<Y.Map<unknown>>()
    const cells: Y.Map<unknown>[] = []
    for (let c = 0; c < colCount; c++) cells.push(buildEmptyCellYMap())
    newRow.push(cells)
    rowsY.insert(insertAt, [newRow])
    rowHeights.insert(insertAt, [avgOf(rowHeights, 40)])
  }, LOCAL_ORIGIN)
}

/**
 * Insert a column at `atIndex` (or append when out of range). Iterates
 * over each row and inserts a blank cell at the matching position. New
 * width = average of existing columns.
 */
export function insertTableCol(
  ctx: ObjectsMutationContext,
  tableId: string,
  atIndex: number,
): void {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return
  const rowsY = yMap.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>> | undefined
  const colWidths = yMap.get('colWidths') as Y.Array<number> | undefined
  if (rowsY === undefined || colWidths === undefined) return
  const colCount = colWidths.length
  const insertAt = atIndex < 0 || atIndex > colCount ? colCount : Math.floor(atIndex)
  ctx.doc.transact(() => {
    for (let r = 0; r < rowsY.length; r++) {
      const row = rowsY.get(r)
      if (row === undefined) continue
      row.insert(insertAt, [buildEmptyCellYMap()])
    }
    colWidths.insert(insertAt, [avgOf(colWidths, 60)])
  }, LOCAL_ORIGIN)
}

/**
 * Delete the row at `atIndex`. No-op when the table has only one row
 * left (a 0-row table is degenerate; let the user delete the whole
 * object via the standard delete-object path instead).
 */
export function deleteTableRow(
  ctx: ObjectsMutationContext,
  tableId: string,
  atIndex: number,
): void {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return
  const rowsY = yMap.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>> | undefined
  const rowHeights = yMap.get('rowHeights') as Y.Array<number> | undefined
  if (rowsY === undefined || rowHeights === undefined) return
  if (rowsY.length <= 1) return
  if (atIndex < 0 || atIndex >= rowsY.length) return
  ctx.doc.transact(() => {
    rowsY.delete(atIndex, 1)
    if (atIndex < rowHeights.length) rowHeights.delete(atIndex, 1)
  }, LOCAL_ORIGIN)
}

/**
 * Delete the column at `atIndex`. Same single-column guard as
 * `deleteTableRow`.
 */
export function deleteTableCol(
  ctx: ObjectsMutationContext,
  tableId: string,
  atIndex: number,
): void {
  const yMap = findTableYMap(ctx, tableId)
  if (yMap === null) return
  const rowsY = yMap.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>> | undefined
  const colWidths = yMap.get('colWidths') as Y.Array<number> | undefined
  if (rowsY === undefined || colWidths === undefined) return
  if (colWidths.length <= 1) return
  if (atIndex < 0 || atIndex >= colWidths.length) return
  ctx.doc.transact(() => {
    for (let r = 0; r < rowsY.length; r++) {
      const row = rowsY.get(r)
      if (row === undefined) continue
      if (atIndex < row.length) row.delete(atIndex, 1)
    }
    colWidths.delete(atIndex, 1)
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

/**
 * Merge a rectangular range of cells. The top-left cell becomes the
 * origin, receives `gridSpan`/`rowSpan` for the merge extent; every
 * other cell in the range is stamped with `mergeOriginR`/`mergeOriginC`
 * pointers so the renderer can skip them and the origin can paint
 * their area. Existing merges that the range partially overlaps with
 * are first unmerged so the result is a clean rectangular merge.
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
  const rowsY = getRowsArr(ctx, tableId)
  if (rowsY === null) return
  const { r0, c0, r1, c1 } = normRange(range.r0, range.c0, range.r1, range.c1)
  if (r0 === r1 && c0 === c1) return // single-cell merge is a no-op
  if (r0 < 0 || c0 < 0 || r1 >= rowsY.length) return
  ctx.doc.transact(() => {
    // Clear any prior merge pointers within the new range so we don't
    // leave stale references to old origins.
    for (let r = r0; r <= r1; r++) {
      const row = rowsY.get(r)
      if (row === undefined) continue
      for (let c = c0; c <= c1 && c < row.length; c++) {
        const cell = row.get(c)
        if (cell === undefined) continue
        cell.delete('mergeOriginR')
        cell.delete('mergeOriginC')
        if (r !== r0 || c !== c0) {
          cell.delete('gridSpan')
          cell.delete('rowSpan')
        }
      }
    }
    // Stamp the origin with the merge extent.
    const origin = rowsY.get(r0)?.get(c0)
    if (origin === undefined) return
    origin.set('gridSpan', c1 - c0 + 1)
    origin.set('rowSpan', r1 - r0 + 1)
    // Stamp every continuation cell with pointers back to the origin.
    for (let r = r0; r <= r1; r++) {
      const row = rowsY.get(r)
      if (row === undefined) continue
      for (let c = c0; c <= c1 && c < row.length; c++) {
        if (r === r0 && c === c0) continue
        const cell = row.get(c)
        if (cell === undefined) continue
        cell.set('mergeOriginR', r0)
        cell.set('mergeOriginC', c0)
      }
    }
  }, LOCAL_ORIGIN)
}

/**
 * Split a merged cell back into individual cells. Targets the merge
 * origin at `(r, c)` — if the supplied cell is a continuation (has
 * `mergeOriginR/C`), we walk to its origin first. No-op when the
 * targeted cell isn't part of a merge.
 */
export function splitTableCell(
  ctx: ObjectsMutationContext,
  tableId: string,
  r: number,
  c: number,
): void {
  const rowsY = getRowsArr(ctx, tableId)
  if (rowsY === null) return
  const cell = rowsY.get(r)?.get(c)
  if (cell === undefined) return
  const ptrR = cell.get('mergeOriginR')
  const ptrC = cell.get('mergeOriginC')
  const originR = typeof ptrR === 'number' ? ptrR : r
  const originC = typeof ptrC === 'number' ? ptrC : c
  const origin = rowsY.get(originR)?.get(originC)
  if (origin === undefined) return
  const span = (origin.get('gridSpan') as number | undefined) ?? 1
  const rowSpan = (origin.get('rowSpan') as number | undefined) ?? 1
  if (span <= 1 && rowSpan <= 1) return
  ctx.doc.transact(() => {
    origin.delete('gridSpan')
    origin.delete('rowSpan')
    for (let rr = originR; rr < originR + rowSpan; rr++) {
      const row = rowsY.get(rr)
      if (row === undefined) continue
      for (let cc = originC; cc < originC + span && cc < row.length; cc++) {
        if (rr === originR && cc === originC) continue
        const continuation = row.get(cc)
        if (continuation === undefined) continue
        continuation.delete('mergeOriginR')
        continuation.delete('mergeOriginC')
      }
    }
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
 *   - `inside`   : Interior dividers only. Non-top cells get a top
 *                  edge (horizontal dividers); non-left cells get a
 *                  left edge (vertical dividers).
 *   - `top` / `bottom` / `left` / `right`: only the named outer edge
 *                  on the cells that touch that edge of the range.
 *   - `insideH`  : Horizontal interior dividers only (top edge on
 *                  every cell except the top row).
 *   - `insideV`  : Vertical interior dividers only (left edge on
 *                  every cell except the left column).
 *
 * Conventions for shared boundaries: we always set top + left rather
 * than bottom + right when an interior divider could be assigned to
 * either side, so adjacent cells never duplicate the same divider in
 * their stored shape.
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

type CellEdge = 'top' | 'right' | 'bottom' | 'left'

function edgesForPreset(
  preset: TableBorderPreset,
  r: number,
  c: number,
  range: { r0: number; c0: number; r1: number; c1: number },
): CellEdge[] {
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
      if (!isLeftCol) out.push('left')
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
    case 'insideH':
      return isTopRow ? [] : ['top']
    case 'insideV':
      return isLeftCol ? [] : ['left']
  }
}

/**
 * Apply a Keynote-style border preset to every cell in a range.
 * `edgeSpec` is the {color, width, dash?} stamped on each ENABLED edge.
 * DISABLED edges are written as width-0 entries so the renderer's
 * `border.width <= 0 → skip` guard suppresses them — crucial when a
 * preset is applied to a sub-range while `defaults.border` is set,
 * because otherwise interior cells of the range would fall back to the
 * default grid even when the preset says "no border here".
 *
 * Merge-continuation pointer cells are skipped (the origin sits within
 * the range anyway and gets the patch on its own iteration).
 */
export function setRangeBorderPreset(
  ctx: ObjectsMutationContext,
  tableId: string,
  range: { r0: number; c0: number; r1: number; c1: number },
  preset: TableBorderPreset,
  edgeSpec: { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' },
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
        if (cell.get('mergeOriginR') !== undefined || cell.get('mergeOriginC') !== undefined) {
          continue
        }
        const active = new Set(edgesForPreset(preset, r, c, { r0, c0, r1, c1 }))
        // Mirror the per-edge shape used by setRangeCellStyle: a Y.Map at
        // the `border` slot whose values are plain JS objects (NOT Y.Maps).
        // Every edge gets an entry — active edges carry the spec, inactive
        // edges carry width: 0 so the renderer skips them even when
        // `defaults.border` would otherwise fill in.
        const borderMap = new Y.Map<unknown>()
        for (const edge of ['top', 'right', 'bottom', 'left'] as CellEdge[]) {
          if (active.has(edge)) {
            const value: { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' } = {
              color: edgeSpec.color,
              width: edgeSpec.width,
            }
            if (edgeSpec.dash !== undefined) value.dash = edgeSpec.dash
            borderMap.set(edge, value)
          } else {
            borderMap.set(edge, { color: edgeSpec.color, width: 0 })
          }
        }
        cell.set('border', borderMap)
      }
    }
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
