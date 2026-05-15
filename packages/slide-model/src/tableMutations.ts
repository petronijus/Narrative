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
import { addObject, type ObjectsMutationContext } from './mutations.js'

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
  })
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
  })
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
  })
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
  })
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
  })
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
  })
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
  })
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
  })
}
