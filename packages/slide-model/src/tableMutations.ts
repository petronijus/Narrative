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
