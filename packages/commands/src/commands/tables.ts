/**
 * commands/src/commands/tables.ts — the `table.*` domain: insert, rows and
 * columns, track sizes, merge / split, cell / range / table styling and
 * borders. Cell TEXT is not here: text.set / text.format / text.list take a
 * `cell` on their target.
 *
 * Coordinates: rows and columns are 0-based; a range is inclusive on both
 * ends. Track sizes are slide px as drawn (the stored vectors are
 * proportions the renderer scales to the table's frame; every command here
 * leaves them summing to the frame again).
 */

import { z } from 'zod'
import {
  addTable,
  deleteTableCol,
  deleteTableRow,
  getTableMergeInfo,
  insertTableCol,
  insertTableRow,
  mergeTableCells,
  setRangeBorderPreset,
  setRangeCellStyle,
  setTableBorderSegment,
  setTableCellStyle,
  setTableColWidth,
  setTableDefaultsPatch,
  setTableRowHeight,
  splitTableCell,
  updateObject,
  yMapToPlainObject,
  type CellStylePatch,
  type DeckMutationContext,
  type ObjectsMutationContext,
  type TableBorderPreset,
} from '@narrative/slide-model'
import {
  FiniteNumberSchema,
  NonNegativeNumberSchema,
  PositiveNumberSchema,
  RgbInputSchema,
  objectCreateInputSchema,
  objectPatchInputSchema,
  type TableDefaults,
  type TableObject,
} from '@narrative/shared'
import type * as Y from 'yjs'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import {
  ObjectIdSchema,
  SlideRefSchema,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
  type SlideRef,
} from '../refs.js'
import { CellAddressSchema, type CellAddress } from '../text/target.js'

const tableEditor = {
  domain: 'table',
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
} as const

/** Upper bound on rows and on columns (a guard against runaway agent input). */
export const MAX_TABLE_TRACKS = 100
/** Smallest track, px, a resize may leave (the editor's drag handles stop at 4). */
export const MIN_TRACK_PX = 4
/** Toolbar grid-picker cell size: a new table is cols × 120 by rows × 60 px unless sized. */
const DEFAULT_CELL_W = 120
const DEFAULT_CELL_H = 60

const EmptyOutput = z.object({})
const TableIdSchema = ObjectIdSchema.describe('Table object id')
const TrackCount = z.number().int().min(1).max(MAX_TABLE_TRACKS)

export const CellRangeSchema = z
  .strictObject({ from: CellAddressSchema, to: CellAddressSchema })
  .describe('Inclusive rectangle of cells between two corners')

type CellRange = z.infer<typeof CellRangeSchema>

// ---------------------------------------------------------------------------
// Style schemas, derived from the shared table schemas (colour-input variant:
// every colour slot takes 0xRRGGBB, "#RRGGBB" or a colour token ref)
// ---------------------------------------------------------------------------

function isExactOptional(field: unknown): field is z.ZodExactOptional<z.ZodType> {
  return field instanceof z.ZodExactOptional
}

/**
 * A strict partial of `schema`: required fields become optional; fields
 * that are optional in storage become optional and — when `clearable` —
 * nullable, `null` parsing to `undefined` (which the table mutations turn
 * into "delete this override").
 */
function partialOf(
  schema: z.ZodObject,
  omit: ReadonlySet<string>,
  clearable: boolean,
): z.ZodObject {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    if (omit.has(key)) continue
    if (isExactOptional(field)) {
      const inner = field.unwrap()
      shape[key] = clearable
        ? inner
            .nullable()
            .transform((v: unknown) => (v === null ? undefined : v))
            .optional()
        : inner.optional()
    } else {
      shape[key] = (field as z.ZodType).optional()
    }
  }
  return z.strictObject(shape)
}

const InputTableDefaults = (
  objectCreateInputSchema('table').shape.defaults as z.ZodExactOptional<z.ZodObject>
).unwrap()
const InputTableCell = (
  objectPatchInputSchema('table').shape.rows as z.ZodExactOptional<
    z.ZodArray<z.ZodArray<z.ZodObject>>
  >
).unwrap().element.element

const nonEmpty = (v: Record<string, unknown>): boolean => Object.keys(v).length > 0

/** Merge keys and the body are structure, not style; per-cell `border` is legacy (use table.border.*). */
const CELL_NON_STYLE = new Set([
  'text',
  'gridSpan',
  'rowSpan',
  'mergeOriginR',
  'mergeOriginC',
  'border',
])

export const CellStyleInputSchema = partialOf(InputTableCell, CELL_NON_STYLE, true)
  .refine(nonEmpty, { message: 'Pass at least one style field' })
  .describe(
    'Cell overrides: fill, fillAlpha, fillStyle, color, fontSize, fontWeight, italic, underline, lineHeight, ' +
      'letterSpacing, textTransform, align, vAlign, padding. `null` removes an override so the cell falls back to ' +
      'the table defaults.',
  )

export const TableDefaultsPatchSchema = partialOf(InputTableDefaults, new Set(), true)
  .refine(nonEmpty, { message: 'Pass at least one field' })
  .describe(
    'Table-wide defaults every cell inherits: fontFamily, fontSize, fontWeight, color, align, vAlign, fill, border ' +
      '(the default grid line), padding (all four sides), … `null` clears an optional default.',
  )

export const TableDefaultsCreateSchema = partialOf(InputTableDefaults, new Set(), false).describe(
  'Overrides merged over the standard table defaults (18 px text, #111111, 1 px #cccccc grid, 8 px padding)',
)

// ---------------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------------

interface ResolvedTable {
  objects: ObjectsMutationContext
  id: string
  map: Y.Map<unknown>
  table: TableObject
  rows: number
  cols: number
}

export function resolveTable(
  deck: DeckMutationContext,
  slideRef: SlideRef,
  tableId: string,
): ResolvedTable {
  const slide = resolveSlide(deck, slideRef)
  const objects = objectsOf(deck, slide)
  const map = requireObjects(objects, [tableId], slide.id).get(tableId)!
  if (map.get('type') !== 'table') {
    throw new CommandError(
      'conflict',
      `object '${tableId}' is a ${String(map.get('type'))}, not a table`,
    )
  }
  const table = yMapToPlainObject<TableObject>(map)
  return {
    objects,
    id: tableId,
    map,
    table,
    rows: table.rowHeights.length,
    cols: table.colWidths.length,
  }
}

function requireCell(t: ResolvedTable, cell: CellAddress, what = 'cell'): void {
  if (cell.row >= t.rows || cell.col >= t.cols) {
    throw new CommandError(
      'not_found',
      `${what} (${cell.row}, ${cell.col}) is outside table '${t.id}' (${t.rows} rows x ${t.cols} columns)`,
    )
  }
}

function normalizedRange(
  t: ResolvedTable,
  range: CellRange,
): { r0: number; c0: number; r1: number; c1: number } {
  requireCell(t, range.from, 'range corner')
  requireCell(t, range.to, 'range corner')
  return {
    r0: Math.min(range.from.row, range.to.row),
    c0: Math.min(range.from.col, range.to.col),
    r1: Math.max(range.from.row, range.to.row),
    c1: Math.max(range.from.col, range.to.col),
  }
}

function requireNotCovered(t: ResolvedTable, cell: CellAddress): void {
  const info = getTableMergeInfo(t.objects, t.id, cell.row, cell.col)
  if (info?.kind === 'continuation') {
    throw new CommandError(
      'conflict',
      `cell (${cell.row}, ${cell.col}) is covered by the merged cell at (${info.originR}, ${info.originC}); address that cell instead`,
    )
  }
}

/** Track sizes in px as the renderer draws them (stored proportions scaled to the frame). */
function drawnSizes(stored: readonly number[], total: number): number[] {
  const sum = stored.reduce((a, b) => a + b, 0)
  // Not drifted: the stored sizes already are the drawn ones (no float churn).
  if (!(sum > 0) || !(total > 0) || Math.abs(sum - total) < 1e-9) return [...stored]
  return stored.map((v) => (v * total) / sum)
}

const SizeOutput = z.object({ rows: z.number(), cols: z.number() })

function sizeOf(map: Y.Map<unknown>): { rows: number; cols: number } {
  const t = yMapToPlainObject<TableObject>(map)
  return { rows: t.rowHeights.length, cols: t.colWidths.length }
}

// ---------------------------------------------------------------------------
// table.insert (also behind object.create with type "table")
// ---------------------------------------------------------------------------

export interface InsertTableOptions {
  x?: number | undefined
  y?: number | undefined
  width?: number | undefined
  height?: number | undefined
  rows?: number | undefined
  cols?: number | undefined
  defaults?: Partial<TableDefaults> | undefined
  name?: string | undefined
}

/** Insert a table with the editor's grid-picker sizing; returns its id. */
export function insertTable(objects: ObjectsMutationContext, o: InsertTableOptions): string {
  const rows = o.rows ?? 3
  const cols = o.cols ?? 3
  return addTable(objects, {
    x: o.x ?? 100,
    y: o.y ?? 100,
    width: o.width ?? cols * DEFAULT_CELL_W,
    height: o.height ?? rows * DEFAULT_CELL_H,
    rows,
    cols,
    ...(o.defaults !== undefined ? { defaults: o.defaults } : {}),
    ...(o.name !== undefined ? { name: o.name } : {}),
  })
}

export const tableInsert = defineCommand({
  ...tableEditor,
  id: 'table.insert',
  title: 'Insert table',
  description:
    'Insert an empty table of `rows` x `cols` cells (default 3 x 3) on a slide. Position and size are slide px ' +
    '(slide 1920 x 1080); without a size each cell is 120 x 60 px, split evenly. `defaults` restyles every cell at ' +
    'once (font, colours, padding, grid line). Fill cells afterwards with text.set using target.cell, and style ' +
    'them with table.style.*; do not use object.update for table structure.',
  input: z.strictObject({
    slide: SlideRefSchema,
    x: FiniteNumberSchema.optional(),
    y: FiniteNumberSchema.optional(),
    width: PositiveNumberSchema.optional(),
    height: PositiveNumberSchema.optional(),
    rows: TrackCount.optional(),
    cols: TrackCount.optional(),
    defaults: TableDefaultsCreateSchema.optional(),
    name: z.string().max(200).optional(),
  }),
  output: z.object({ objectId: z.string() }),
  implementedWith: ['addTable'],
  examples: [
    {
      title: 'Insert a 4 x 3 table at the default position',
      input: { slide: 's2', rows: 4, cols: 3 },
    },
    {
      title: 'Insert a full-width 5 x 2 table with a navy header colour default',
      input: {
        slide: 's1',
        x: 160,
        y: 300,
        width: 1600,
        height: 500,
        rows: 5,
        cols: 2,
        defaults: { color: '#1b2a4a', fontSize: 24 },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const objects = objectsOf(deck, resolveSlide(deck, input.slide))
    return {
      objectId: insertTable(objects, {
        ...input,
        defaults: input.defaults as Partial<TableDefaults> | undefined,
      }),
    }
  },
})

// ---------------------------------------------------------------------------
// Rows and columns
// ---------------------------------------------------------------------------

function trackCommands(axis: 'row' | 'col') {
  const noun = axis === 'row' ? 'row' : 'column'
  const nouns = axis === 'row' ? 'rows' : 'columns'
  const insert = axis === 'row' ? insertTableRow : insertTableCol
  const remove = axis === 'row' ? deleteTableRow : deleteTableCol
  const countOf = (t: ResolvedTable): number => (axis === 'row' ? t.rows : t.cols)

  const insertCmd = defineCommand({
    ...tableEditor,
    id: `table.${axis}.insert`,
    title: `Insert table ${nouns}`,
    description:
      `Insert \`count\` (default 1) blank ${nouns} so the first new one sits at \`index\` (0-based; omit to append ` +
      `at the ${axis === 'row' ? 'bottom' : 'right'}). The table grows by the new ${nouns}, each as ` +
      `${axis === 'row' ? 'tall' : 'wide'} as the current average. Inserting strictly inside a merged cell extends ` +
      `the merge, as in PowerPoint. To set an exact size use table.resize${axis === 'row' ? 'Row' : 'Column'}.`,
    input: z.strictObject({
      slide: SlideRefSchema,
      table: TableIdSchema,
      index: z.number().int().min(0).optional(),
      count: z.number().int().min(1).max(MAX_TABLE_TRACKS).optional(),
    }),
    output: SizeOutput,
    implementedWith: [axis === 'row' ? 'insertTableRow' : 'insertTableCol'],
    examples: [
      { title: `Append one ${noun}`, input: { slide: 's1', table: 'tbl1' } },
      {
        title: `Insert two ${nouns} before the second one`,
        input: { slide: 's1', table: 'tbl1', index: 1, count: 2 },
      },
    ],
    handler(ctx, input) {
      const deck = requireDeck(ctx)
      const t = resolveTable(deck, input.slide, input.table)
      const count = input.count ?? 1
      if (input.index !== undefined && input.index > countOf(t)) {
        throw new CommandError(
          'not_found',
          `${noun} index ${input.index} is past the end (the table has ${countOf(t)} ${nouns})`,
        )
      }
      if (countOf(t) + count > MAX_TABLE_TRACKS) {
        throw new CommandError('conflict', `a table can have at most ${MAX_TABLE_TRACKS} ${nouns}`)
      }
      for (let i = 0; i < count; i++) insert(t.objects, t.id, input.index ?? -1)
      return sizeOf(t.map)
    },
  })

  const deleteCmd = defineCommand({
    ...tableEditor,
    id: `table.${axis}.delete`,
    title: `Delete table ${nouns}`,
    description:
      `Delete \`count\` (default 1) ${nouns} starting at \`index\` (0-based). The table shrinks by their size. ` +
      `Merged cells crossing them shrink; a merge whose top-left cell is deleted hands its text and style to the ` +
      `next cell of the merge. A table keeps at least one ${noun} — to remove the whole table use object.delete.`,
    input: z.strictObject({
      slide: SlideRefSchema,
      table: TableIdSchema,
      index: z.number().int().min(0),
      count: z.number().int().min(1).max(MAX_TABLE_TRACKS).optional(),
    }),
    output: SizeOutput,
    implementedWith: [axis === 'row' ? 'deleteTableRow' : 'deleteTableCol'],
    examples: [
      {
        title: `Delete the last ${noun} of the 3 x 3 table`,
        input: { slide: 's1', table: 'tbl1', index: 2 },
      },
    ],
    handler(ctx, input) {
      const deck = requireDeck(ctx)
      const t = resolveTable(deck, input.slide, input.table)
      const count = input.count ?? 1
      if (input.index + count > countOf(t)) {
        throw new CommandError(
          'not_found',
          `${nouns} ${input.index}..${input.index + count - 1} do not all exist (the table has ${countOf(t)} ${nouns})`,
        )
      }
      if (count >= countOf(t)) {
        throw new CommandError(
          'conflict',
          `a table keeps at least one ${noun}; delete the table with object.delete`,
        )
      }
      for (let i = input.index + count - 1; i >= input.index; i--) remove(t.objects, t.id, i)
      return sizeOf(t.map)
    },
  })
  return [insertCmd, deleteCmd]
}

// ---------------------------------------------------------------------------
// Track sizes
// ---------------------------------------------------------------------------

function resizeCommand(axis: 'row' | 'col') {
  const isCol = axis === 'col'
  const noun = isCol ? 'column' : 'row'
  const dim = isCol ? 'width' : 'height'
  const setTrack = isCol ? setTableColWidth : setTableRowHeight
  return defineCommand({
    ...tableEditor,
    id: isCol ? 'table.resizeColumn' : 'table.resizeRow',
    title: isCol ? 'Resize table column' : 'Resize table row',
    description:
      `Set one ${noun}'s ${dim} in slide px as drawn. By default the other ${noun}s keep their size and the table ` +
      `${isCol ? 'widens or narrows' : 'grows or shrinks'} by the difference. With \`keepTableSize: true\` the ` +
      `table keeps its ${dim} and the difference comes from the next ${noun} (the previous one for the last ${noun}) ` +
      `— what dragging a boundary in the editor does. No ${noun} may end up smaller than ${MIN_TRACK_PX} px.`,
    input: z.strictObject({
      slide: SlideRefSchema,
      table: TableIdSchema,
      index: z.number().int().min(0).describe(`0-based ${noun}`),
      size: z.number().min(MIN_TRACK_PX).max(100_000).describe(`New ${dim}, slide px`),
      keepTableSize: z.boolean().optional(),
    }),
    output: z.object({
      sizes: z.array(z.number()).describe(`Every ${noun}'s ${dim}, px`),
      total: z.number(),
    }),
    implementedWith: [isCol ? 'setTableColWidth' : 'setTableRowHeight', 'updateObject'],
    examples: [
      {
        title: `Make the first ${noun} 300 px and let the table grow`,
        input: { slide: 's1', table: 'tbl1', index: 0, size: 300 },
      },
      {
        title: `Make the first ${noun} 100 px, taking the space from its neighbour`,
        input: { slide: 's1', table: 'tbl1', index: 0, size: 100, keepTableSize: true },
      },
    ],
    handler(ctx, input) {
      const deck = requireDeck(ctx)
      const t = resolveTable(deck, input.slide, input.table)
      const stored = isCol ? t.table.colWidths : t.table.rowHeights
      const total = isCol ? t.table.width : t.table.height
      if (input.index >= stored.length) {
        throw new CommandError(
          'not_found',
          `${noun} ${input.index} does not exist (the table has ${stored.length})`,
        )
      }
      const drawn = drawnSizes(stored, total)
      const next = [...drawn]
      next[input.index] = input.size
      if (input.keepTableSize === true) {
        if (drawn.length < 2) {
          throw new CommandError(
            'conflict',
            `a single ${noun} cannot be resized without changing the table's ${dim}`,
          )
        }
        const neighbour = input.index + 1 < drawn.length ? input.index + 1 : input.index - 1
        const give = drawn[neighbour]! - (input.size - drawn[input.index]!)
        if (give < MIN_TRACK_PX) {
          throw new CommandError(
            'conflict',
            `${noun} ${neighbour} would shrink to ${Math.round(give)} px (minimum ${MIN_TRACK_PX}); the table is too small to keep its ${dim}`,
          )
        }
        next[neighbour] = give
      }
      // Rewrite every track that changed — including a drifted vector, so
      // the stored sizes sum to the frame again afterwards.
      next.forEach((size, i) => {
        if (stored[i] !== size) setTrack(t.objects, t.id, i, size)
      })
      const newTotal = next.reduce((a, b) => a + b, 0)
      if (newTotal !== total)
        updateObject(t.objects, t.id, isCol ? { width: newTotal } : { height: newTotal })
      return { sizes: next, total: newTotal }
    },
  })
}

// ---------------------------------------------------------------------------
// Merge / split
// ---------------------------------------------------------------------------

export const tableMerge = defineCommand({
  ...tableEditor,
  id: 'table.merge',
  title: 'Merge table cells',
  description:
    'Merge a rectangle of cells into one cell. The range grows until it contains every merged cell it touches ' +
    '(whole merges only, as in PowerPoint), so check the returned origin and spans. The top-left cell shows its ' +
    'text; the other cells keep theirs hidden, and it reappears after table.split.',
  input: z.strictObject({ slide: SlideRefSchema, table: TableIdSchema, range: CellRangeSchema }),
  output: z.object({
    origin: z.object({ row: z.number(), col: z.number() }),
    rowSpan: z.number(),
    colSpan: z.number(),
  }),
  implementedWith: ['mergeTableCells', 'getTableMergeInfo'],
  examples: [
    {
      title: 'Merge the first row into a header cell',
      input: {
        slide: 's1',
        table: 'tbl1',
        range: { from: { row: 0, col: 0 }, to: { row: 0, col: 2 } },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const t = resolveTable(deck, input.slide, input.table)
    const r = normalizedRange(t, input.range)
    if (r.r0 === r.r1 && r.c0 === r.c1) {
      const info = getTableMergeInfo(t.objects, t.id, r.r0, r.c0)
      if (info === null) throw new CommandError('conflict', 'a merge needs at least two cells')
    }
    mergeTableCells(t.objects, t.id, r)
    const at = getTableMergeInfo(t.objects, t.id, r.r0, r.c0)
    const origin =
      at?.kind === 'continuation' ? { row: at.originR, col: at.originC } : { row: r.r0, col: r.c0 }
    const info = getTableMergeInfo(t.objects, t.id, origin.row, origin.col)
    if (info?.kind !== 'origin')
      throw new CommandError('failed', 'the merge did not produce a merged cell')
    return { origin, rowSpan: info.rowSpan, colSpan: info.colSpan }
  },
})

export const tableSplit = defineCommand({
  ...tableEditor,
  id: 'table.split',
  title: 'Split merged cell',
  description:
    'Split a merged cell back into its individual cells. `cell` may be the merged cell itself or any cell it ' +
    'covers. Each cell shows again whatever text it kept while hidden. Fails with conflict when the cell is not merged.',
  input: z.strictObject({ slide: SlideRefSchema, table: TableIdSchema, cell: CellAddressSchema }),
  output: EmptyOutput,
  implementedWith: ['splitTableCell', 'getTableMergeInfo'],
  examples: [
    {
      title: 'Split the merged header of the second table',
      input: { slide: 's2', table: 'tbl2', cell: { row: 0, col: 0 } },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const t = resolveTable(deck, input.slide, input.table)
    requireCell(t, input.cell)
    if (getTableMergeInfo(t.objects, t.id, input.cell.row, input.cell.col) === null) {
      throw new CommandError(
        'conflict',
        `cell (${input.cell.row}, ${input.cell.col}) is not part of a merged cell`,
      )
    }
    splitTableCell(t.objects, t.id, input.cell.row, input.cell.col)
    return {}
  },
})

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

export const tableStyleCell = defineCommand({
  ...tableEditor,
  id: 'table.style.cell',
  title: 'Style a table cell',
  description:
    'Set or clear style overrides on one cell (fill, text colour, font size/weight, alignment, padding, …). ' +
    'Colours: "#RRGGBB", 0xRRGGBB or a colour token ref. `null` removes an override. For many cells use ' +
    'table.style.range, for the whole table table.style.table, for borders table.border.*, for the text itself text.set.',
  input: z.strictObject({
    slide: SlideRefSchema,
    table: TableIdSchema,
    cell: CellAddressSchema,
    style: CellStyleInputSchema,
  }),
  output: EmptyOutput,
  implementedWith: ['setTableCellStyle'],
  examples: [
    {
      title: 'Give the top-left cell a dark fill with white bold text',
      input: {
        slide: 's1',
        table: 'tbl1',
        cell: { row: 0, col: 0 },
        style: { fill: '#1b2a4a', color: '#ffffff', fontWeight: 700 },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const t = resolveTable(deck, input.slide, input.table)
    requireCell(t, input.cell)
    requireNotCovered(t, input.cell)
    setTableCellStyle(
      t.objects,
      t.id,
      input.cell.row,
      input.cell.col,
      input.style as CellStylePatch,
    )
    return {}
  },
})

export const tableStyleRange = defineCommand({
  ...tableEditor,
  id: 'table.style.range',
  title: 'Style a range of table cells',
  description:
    'Set or clear the same style overrides on every visible cell of a rectangle (e.g. colour a header row or a ' +
    'column). Cells hidden inside a merge are skipped; the merged cell itself is styled. Same fields as table.style.cell.',
  input: z.strictObject({
    slide: SlideRefSchema,
    table: TableIdSchema,
    range: CellRangeSchema,
    style: CellStyleInputSchema,
  }),
  output: EmptyOutput,
  implementedWith: ['setRangeCellStyle'],
  examples: [
    {
      title: 'Colour the first row',
      input: {
        slide: 's1',
        table: 'tbl1',
        range: { from: { row: 0, col: 0 }, to: { row: 0, col: 2 } },
        style: { fill: '#e8eef8', fontWeight: 'bold' },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const t = resolveTable(deck, input.slide, input.table)
    setRangeCellStyle(
      t.objects,
      t.id,
      normalizedRange(t, input.range),
      input.style as CellStylePatch,
    )
    return {}
  },
})

export const tableStyleTable = defineCommand({
  ...tableEditor,
  id: 'table.style.table',
  title: 'Style a whole table',
  description:
    'Change the table-wide defaults every cell inherits unless it has its own override: font family/size/weight, ' +
    'text colour, alignment, fill, the default grid line (`border`) and padding. `null` clears an optional default. ' +
    'Cell overrides set with table.style.cell/range still win.',
  input: z.strictObject({
    slide: SlideRefSchema,
    table: TableIdSchema,
    style: TableDefaultsPatchSchema,
  }),
  output: EmptyOutput,
  implementedWith: ['setTableDefaultsPatch'],
  examples: [
    {
      title: 'Set the whole table in 20 px Inter, centred',
      input: {
        slide: 's1',
        table: 'tbl1',
        style: { fontFamily: 'Inter', fontSize: 20, align: 'center' },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const t = resolveTable(deck, input.slide, input.table)
    setTableDefaultsPatch(t.objects, t.id, input.style as Partial<TableDefaults>)
    return {}
  },
})

// ---------------------------------------------------------------------------
// Borders
// ---------------------------------------------------------------------------

const BorderDashSchema = z.enum(['solid', 'dash', 'dot'])
const BorderPresetSchema = z.enum([
  'none',
  'all',
  'outer',
  'inside',
  'top',
  'bottom',
  'left',
  'right',
  'insideH',
  'insideV',
])

export const tableBorderPreset = defineCommand({
  ...tableEditor,
  id: 'table.border.preset',
  title: 'Apply a table border preset',
  description:
    'Draw grid lines on a range of cells (default: the whole table) with a preset: all, outer (perimeter), inside ' +
    '(inner lines), insideH / insideV, top / bottom / left / right (that edge of the range), or none (hide the ' +
    'lines, overriding the default grid). `color` and `width` (px) are required except for none. ' +
    'For one individual line use table.border.segment.',
  input: z
    .strictObject({
      slide: SlideRefSchema,
      table: TableIdSchema,
      range: CellRangeSchema.optional(),
      preset: BorderPresetSchema,
      color: RgbInputSchema.optional().describe('"#RRGGBB" or 0xRRGGBB'),
      width: NonNegativeNumberSchema.max(100).optional(),
      dash: BorderDashSchema.optional(),
    })
    .refine((v) => v.preset === 'none' || (v.color !== undefined && v.width !== undefined), {
      message: '`color` and `width` are required unless preset is "none"',
      path: ['color'],
    }),
  output: EmptyOutput,
  implementedWith: ['setRangeBorderPreset'],
  examples: [
    {
      title: 'Outline the whole table with a 2 px navy line',
      input: { slide: 's1', table: 'tbl1', preset: 'outer', color: '#1b2a4a', width: 2 },
    },
    {
      title: 'Hide the inner lines of the first two rows',
      input: {
        slide: 's1',
        table: 'tbl1',
        preset: 'none',
        range: { from: { row: 0, col: 0 }, to: { row: 1, col: 2 } },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const t = resolveTable(deck, input.slide, input.table)
    const range =
      input.range !== undefined
        ? normalizedRange(t, input.range)
        : { r0: 0, c0: 0, r1: t.rows - 1, c1: t.cols - 1 }
    setRangeBorderPreset(t.objects, t.id, range, input.preset as TableBorderPreset, {
      color: input.color ?? 0,
      width: input.width ?? 0,
      ...(input.dash !== undefined ? { dash: input.dash } : {}),
    })
    return {}
  },
})

export const tableBorderSegment = defineCommand({
  ...tableEditor,
  id: 'table.border.segment',
  title: 'Style one table grid line',
  description:
    'Set or clear the style of ONE grid-line segment. A horizontal segment {orientation: "horizontal", row, col} is ' +
    'the line above row `row` in column `col` (row = number of rows is the bottom edge); a vertical one is the line ' +
    'left of column `col` in row `row` (col = number of columns is the right edge). `style: null` removes the ' +
    'segment so it falls back to the table default. Width 0 hides the line. For ranges use table.border.preset.',
  input: z.strictObject({
    slide: SlideRefSchema,
    table: TableIdSchema,
    segment: z.strictObject({
      orientation: z.enum(['horizontal', 'vertical']),
      row: z.number().int().min(0),
      col: z.number().int().min(0),
    }),
    style: z
      .strictObject({
        color: RgbInputSchema.describe('"#RRGGBB" or 0xRRGGBB'),
        width: NonNegativeNumberSchema.max(100),
        dash: BorderDashSchema.optional(),
      })
      .nullable(),
  }),
  output: EmptyOutput,
  implementedWith: ['setTableBorderSegment'],
  examples: [
    {
      title: 'Draw a 3 px line under the first row, first column',
      input: {
        slide: 's1',
        table: 'tbl1',
        segment: { orientation: 'horizontal', row: 1, col: 0 },
        style: { color: '#000000', width: 3 },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const t = resolveTable(deck, input.slide, input.table)
    const { orientation, row, col } = input.segment
    const inBounds =
      orientation === 'horizontal' ? row <= t.rows && col < t.cols : row < t.rows && col <= t.cols
    if (!inBounds) {
      throw new CommandError(
        'not_found',
        `segment ${orientation} ${row}:${col} lies outside a ${t.rows} x ${t.cols} table`,
      )
    }
    const key = `${orientation === 'horizontal' ? 'h' : 'v'}:${row}:${col}`
    const style = input.style
    setTableBorderSegment(
      t.objects,
      t.id,
      key,
      style === null
        ? undefined
        : {
            color: style.color,
            width: style.width,
            ...(style.dash !== undefined ? { dash: style.dash } : {}),
          },
    )
    return {}
  },
})

export const tableCommands = [
  tableInsert,
  ...trackCommands('row'),
  ...trackCommands('col'),
  resizeCommand('col'),
  resizeCommand('row'),
  tableMerge,
  tableSplit,
  tableStyleCell,
  tableStyleRange,
  tableStyleTable,
  tableBorderPreset,
  tableBorderSegment,
]
