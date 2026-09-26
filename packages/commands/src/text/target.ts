/**
 * commands/src/text/target.ts
 *
 * Addressing a text body — a text object's body or one table cell's body —
 * and a character range inside it. Resolution only READS; the one write a
 * target may need (promoting a legacy plain-string body to a Y.Text via
 * `updateObject`, the slide model's lazy migration point) happens in
 * `body()`, which handlers call only after every precondition passed.
 */

import { z } from 'zod'
import * as Y from 'yjs'
import {
  getPlainString,
  getTableCellYMap,
  updateObject,
  type ObjectsMutationContext,
} from '@narrative/slide-model'
import type { DeckMutationContext } from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'
import { CommandError } from '../errors.js'
import {
  ObjectIdSchema,
  SlideRefSchema,
  objectsOf,
  requireObjects,
  resolveSlide,
  type ResolvedSlide,
} from '../refs.js'
import { displayOf, type DisplayText } from './body.js'

export const CellAddressSchema = z
  .strictObject({ row: z.number().int().min(0), col: z.number().int().min(0) })
  .describe('Table cell, 0-based row and column')

export type CellAddress = z.infer<typeof CellAddressSchema>

export const TextTargetSchema = z
  .strictObject({
    slide: SlideRefSchema,
    object: ObjectIdSchema.describe('A text object, or a table when `cell` is given'),
    cell: CellAddressSchema.optional().describe('Required for tables: which cell body to address'),
  })
  .describe(
    'A text object body, or one table cell body ({ slide, object: tableId, cell: { row, col } })',
  )

export type TextTarget = z.infer<typeof TextTargetSchema>

export interface ResolvedTextTarget {
  slide: ResolvedSlide
  objects: ObjectsMutationContext
  objectId: string
  objectMap: Y.Map<unknown>
  kind: 'text' | 'cell'
  cell?: CellAddress
  /** Current stored body as a string (separators included). */
  raw: string
  /** The live Y.Text, promoting a legacy plain-string body first. Call only after all checks. */
  body(): Y.Text
}

/**
 * The live Y.Text of a text object. A legacy plain-string body (decks from
 * before the Y.Text era) is promoted first through `updateObject`, the
 * slide model's lazy migration point — so this may WRITE; call it only
 * after every precondition of the command has passed.
 */
export function textObjectBody(
  objects: ObjectsMutationContext,
  objectId: string,
  objectMap: Y.Map<unknown>,
): Y.Text {
  const current = objectMap.get('text')
  if (current instanceof Y.Text) return current
  updateObject<TextObject>(objects, objectId, { text: typeof current === 'string' ? current : '' })
  return objectMap.get('text') as Y.Text
}

export function resolveTextTarget(
  deck: DeckMutationContext,
  target: TextTarget,
): ResolvedTextTarget {
  const slide = resolveSlide(deck, target.slide)
  const objects = objectsOf(deck, slide)
  const objectMap = requireObjects(objects, [target.object], slide.id).get(target.object)!
  const type = objectMap.get('type')
  if (type === 'text') {
    if (target.cell !== undefined) {
      throw new CommandError(
        'conflict',
        `object '${target.object}' is a text box; \`cell\` only applies to tables`,
      )
    }
    const stored = objectMap.get('text')
    const raw =
      stored instanceof Y.Text ? getPlainString(stored) : typeof stored === 'string' ? stored : ''
    return {
      slide,
      objects,
      objectId: target.object,
      objectMap,
      kind: 'text',
      raw,
      body: () => textObjectBody(objects, target.object, objectMap),
    }
  }
  if (type === 'table') {
    const cell = target.cell
    if (cell === undefined) {
      throw new CommandError(
        'conflict',
        `object '${target.object}' is a table; pass \`cell: { row, col }\``,
      )
    }
    const cellMap = getTableCellYMap(objects, target.object, cell.row, cell.col)
    if (cellMap === null) {
      throw new CommandError(
        'not_found',
        `table '${target.object}' has no cell at row ${cell.row}, column ${cell.col}`,
      )
    }
    const originR = cellMap.get('mergeOriginR')
    const originC = cellMap.get('mergeOriginC')
    if (typeof originR === 'number' || typeof originC === 'number') {
      throw new CommandError(
        'conflict',
        `cell (${cell.row}, ${cell.col}) is covered by the merged cell at (${String(originR)}, ${String(originC)}); address that cell instead`,
      )
    }
    const stored = cellMap.get('text')
    if (!(stored instanceof Y.Text)) {
      throw new CommandError(
        'conflict',
        `cell (${cell.row}, ${cell.col}) has no editable text body`,
      )
    }
    return {
      slide,
      objects,
      objectId: target.object,
      objectMap,
      kind: 'cell',
      cell,
      raw: getPlainString(stored),
      body: () => stored,
    }
  }
  throw new CommandError(
    'conflict',
    `object '${target.object}' is a ${String(type)}, which has no text body (only text objects and table cells do)`,
  )
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export const TextRangeSchema = z
  .union([
    z
      .strictObject({
        start: z
          .number()
          .int()
          .min(0)
          .describe('0-based character offset in the body text as queries return it'),
        length: z.number().int().min(0),
      })
      .describe(
        'Offsets count characters of the text exactly as query.object returns it (a paragraph break "\\n\\n" is 2)',
      ),
    z
      .strictObject({
        match: z.string().min(1).max(10_000).describe('Exact, case-sensitive text to find'),
        occurrence: z
          .union([z.number().int().min(1), z.literal('all')])
          .optional()
          .describe('Which match, 1-based (default 1), or "all"'),
      })
      .describe('The range(s) where `match` occurs'),
  ])
  .describe('Omit to target the whole body')

export type TextRange = z.infer<typeof TextRangeSchema>

/** A half-open range [start, end) in the STORED body. */
export interface RawRange {
  start: number
  end: number
}

/**
 * Resolve a range (display offsets or a match) into stored-body ranges.
 * Throws `conflict` when offsets run past the body and `not_found` when the
 * match (or its occurrence) does not exist. Never writes.
 */
export function resolveRanges(raw: string, range: TextRange | undefined): RawRange[] {
  const d: DisplayText = displayOf(raw)
  if (range === undefined) return [{ start: 0, end: raw.length }]
  if ('start' in range) {
    if (range.start + range.length > d.display.length) {
      throw new CommandError(
        'conflict',
        `range ${range.start}+${range.length} runs past the end of the text (${d.display.length} characters)`,
      )
    }
    return [{ start: d.toRaw[range.start]!, end: d.toRaw[range.start + range.length]! }]
  }
  const hits: number[] = []
  for (
    let i = d.display.indexOf(range.match);
    i !== -1;
    i = d.display.indexOf(range.match, i + range.match.length)
  ) {
    hits.push(i)
  }
  const wanted = range.occurrence ?? 1
  const chosen = wanted === 'all' ? hits : hits[wanted - 1] === undefined ? [] : [hits[wanted - 1]!]
  if (chosen.length === 0) {
    throw new CommandError(
      'not_found',
      hits.length === 0
        ? `text ${JSON.stringify(range.match)} does not occur in the body`
        : `text ${JSON.stringify(range.match)} occurs ${hits.length} time(s), not ${String(wanted)}`,
    )
  }
  return chosen.map((i) => ({ start: d.toRaw[i]!, end: d.toRaw[i + range.match.length]! }))
}
