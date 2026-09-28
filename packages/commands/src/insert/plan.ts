/**
 * commands/src/insert/plan.ts — objects described as JSON (the shape
 * query.slide / query.object return) turned into objects ready to add to a
 * slide: validated, with fresh ids, rich text as a delta to replay,
 * regrouped and placed. Shared by `object.insert` (this deck) and the
 * server's `object.insertFromDeck` (objects read from another deck, whose
 * media and tokens the server rewrites before they land).
 *
 * The input is what a model — or the editor's clipboard — read: every
 * object is checked against the strict create schema of its type, so what
 * reaches the document is exactly what `object.create` would accept. Read
 * fields that are not properties (`id`, a text body's `paragraphs`) are
 * consumed here.
 */

import { z } from 'zod'
import { nanoid } from 'nanoid'
import type * as Y from 'yjs'
import type { SlideObject, SlideObjectType } from '@narrative/shared'
import { objectCreateInputSchema, slideObjectSchemaFor } from '@narrative/shared'
import {
  addObjects,
  getObjectTypeDef,
  getTableCellYMap,
  type ObjectsMutationContext,
} from '@narrative/slide-model'
import { CommandError, issuesFromZod, type CommandIssue } from '../errors.js'
import { isObjectType } from '../objectTypes.js'
import { MAX_TABLE_TRACKS } from '../commands/tables.js'
import {
  TextBodyInputSchema,
  planFromBody,
  planText,
  planToDelta,
  writePlan,
  type BodyPlan,
} from '../text/body.js'

export const MAX_INSERT_OBJECTS = 500

export const InsertObjectsSchema = z
  .array(z.record(z.string(), z.unknown()))
  .min(1)
  .max(MAX_INSERT_OBJECTS)
  .describe(
    'Objects exactly as query.slide / query.object return them (their ids are replaced with new ones; a text ' +
      "body's `paragraphs`, when present, win over its plain `text`); each is checked like object.create input",
  )

const Finite = z.number().finite()
export const PlacementSchema = {
  offset: z
    .strictObject({ x: Finite, y: Finite })
    .optional()
    .describe('Move them by this delta (slide px)'),
  at: z
    .strictObject({ x: Finite, y: Finite })
    .optional()
    .describe("Slide point the centre of the objects' combined box lands on"),
}

export interface InsertPlan {
  /** Plain objects with fresh ids; a text body's formatting rides on `_richTextOps`. */
  objects: SlideObject[]
  /** Formatted table cell bodies, written after the tables are in the document. */
  cellBodies: Array<{ objectId: string; row: number; col: number; plan: BodyPlan }>
}

function fail(message: string, issues: CommandIssue[]): never {
  throw new CommandError('invalid_input', message, { issues })
}

/** Whether a planned body carries anything a plain string would lose. */
function isFormatted(plan: BodyPlan): boolean {
  return (
    plan.hasBlocks ||
    plan.paragraphs.some((p) => p.runs.some((r) => Object.keys(r.attrs).length > 0))
  )
}

/** A read body (`text` + optional `paragraphs`) as a plan; `at` names it in errors. */
function bodyPlan(text: unknown, paragraphs: unknown, at: PropertyKey[]): BodyPlan {
  const body = paragraphs !== undefined ? { paragraphs } : (text ?? '')
  const parsed = TextBodyInputSchema.safeParse(body)
  if (!parsed.success) {
    fail(
      'invalid text body',
      issuesFromZod(parsed.error).map((i) => ({
        path: [...at, ...(paragraphs !== undefined ? ['paragraphs'] : ['text']), ...i.path],
        message: i.message,
      })),
    )
  }
  return planFromBody(parsed.data)
}

interface PreparedObject {
  obj: Record<string, unknown>
  cells: Array<{ row: number; col: number; plan: BodyPlan }>
}

function prepareOne(raw: Record<string, unknown>, i: number): PreparedObject {
  const at: PropertyKey[] = ['objects', i]
  const type = raw['type']
  if (!isObjectType(type)) {
    fail(`objects[${i}] has no known type`, [
      { path: [...at, 'type'], message: `unknown object type '${String(type)}'` },
    ])
  }
  const { id: _id, type: _type, paragraphs, ...rest } = raw
  void _id
  void _type
  if (paragraphs !== undefined && type !== 'text') {
    fail(`objects[${i}]: only a text object has paragraphs`, [
      { path: [...at, 'paragraphs'], message: 'not a property of this type' },
    ])
  }

  let richOps: unknown[] | undefined
  if (type === 'text') {
    const plan = bodyPlan(rest['text'], paragraphs, at)
    rest['text'] = planText(plan)
    if (isFormatted(plan)) richOps = planToDelta(plan)
  }

  const cells: PreparedObject['cells'] = []
  if (type === 'table' && rest['rows'] !== undefined) {
    const rows = rest['rows']
    if (!Array.isArray(rows) || rows.length === 0 || !rows.every(Array.isArray)) {
      fail(`objects[${i}]: rows must be a non-empty list of rows`, [
        { path: [...at, 'rows'], message: 'expected an array of cell arrays' },
      ])
    }
    const cols = (rows[0] as unknown[]).length
    if (rows.length > MAX_TABLE_TRACKS || cols > MAX_TABLE_TRACKS) {
      fail(`objects[${i}]: a table has at most ${MAX_TABLE_TRACKS} rows and columns`, [
        { path: [...at, 'rows'], message: `at most ${MAX_TABLE_TRACKS} rows and columns` },
      ])
    }
    if (cols === 0 || !(rows as unknown[][]).every((r) => r.length === cols)) {
      fail(`objects[${i}]: every row must have the same number of cells`, [
        { path: [...at, 'rows'], message: 'rows differ in length' },
      ])
    }
    const widths = rest['colWidths']
    const heights = rest['rowHeights']
    if (!Array.isArray(widths) || widths.length !== cols) {
      fail(`objects[${i}]: colWidths must have one width per column (${cols})`, [
        { path: [...at, 'colWidths'], message: `expected ${cols} widths` },
      ])
    }
    if (!Array.isArray(heights) || heights.length !== rows.length) {
      fail(`objects[${i}]: rowHeights must have one height per row (${rows.length})`, [
        { path: [...at, 'rowHeights'], message: `expected ${rows.length} heights` },
      ])
    }
    rest['rows'] = (rows as Array<Array<Record<string, unknown>>>).map((row, r) =>
      row.map((cell, c) => {
        if (typeof cell !== 'object' || cell === null) return cell
        const { paragraphs: cellParas, ...cellRest } = cell
        const plan = bodyPlan(cellRest['text'], cellParas, [...at, 'rows', r, c])
        if (isFormatted(plan)) cells.push({ row: r, col: c, plan })
        return { ...cellRest, text: planText(plan) }
      }),
    )
  }

  const parsed = objectCreateInputSchema(type as SlideObjectType).safeParse(rest)
  if (!parsed.success) {
    fail(
      `objects[${i}]: invalid ${type}`,
      issuesFromZod(parsed.error).map((iss) => ({
        path: [...at, ...iss.path],
        message: iss.message,
      })),
    )
  }
  const def = getObjectTypeDef(type)
  if (def === undefined) throw new CommandError('failed', `object type '${type}' is not registered`)
  const required = requiredKeys(type)
  const defaults = Object.fromEntries(
    Object.entries(def.defaultProps() as Record<string, unknown>).filter(([k]) => required.has(k)),
  )
  const obj: Record<string, unknown> = {
    ...defaults,
    ...(parsed.data as Record<string, unknown>),
    id: nanoid(),
    type,
  }
  // The whole object against its storage schema: the create schema checks
  // fields one by one, the storage schema also the invariants spanning
  // several (a table's grid, merges and borders; a video's trim window; an
  // image's asset) — what object.create checks by hand.
  const stored = slideObjectSchemaFor(type as SlideObjectType).safeParse(obj)
  if (!stored.success) {
    fail(
      `objects[${i}]: invalid ${type}`,
      issuesFromZod(stored.error).map((iss) => ({
        path: [...at, ...iss.path],
        message: iss.message,
      })),
    )
  }
  if (richOps !== undefined) obj['_richTextOps'] = richOps
  return { obj, cells }
}

const REQUIRED = new Map<SlideObjectType, ReadonlySet<string>>()

/**
 * The properties an object of `type` must carry (not optional in its
 * storage schema). Only these take the type's defaults when the input
 * leaves them out: an optional property the read object did not have stays
 * absent, so a copy is the object it was read from, not a normalised one.
 */
function requiredKeys(type: SlideObjectType): ReadonlySet<string> {
  let keys = REQUIRED.get(type)
  if (keys === undefined) {
    const shape = slideObjectSchemaFor(type).shape as Record<string, z.core.SomeType>
    keys = new Set(
      Object.entries(shape)
        .filter(([, field]) => !(field instanceof z.ZodExactOptional))
        .map(([k]) => k),
    )
    REQUIRED.set(type, keys)
  }
  return keys
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Validate and prepare `raw` objects for insertion. Groups are regrouped the
 * way a copy is: members that came in together keep a new group of their
 * own, a lone member comes out ungrouped. `offset` moves them; `at` puts the
 * centre of their combined box on a point (a crop moves with its image).
 */
export function planInsert(
  raw: readonly Record<string, unknown>[],
  placement: {
    offset?: { x: number; y: number } | undefined
    at?: { x: number; y: number } | undefined
  },
): InsertPlan {
  if (placement.offset !== undefined && placement.at !== undefined) {
    fail('give `offset` or `at`, not both', [{ path: ['at'], message: 'not with offset' }])
  }
  const prepared = raw.map((r, i) => prepareOne(r, i))

  const members = new Map<string, number>()
  for (const { obj } of prepared) {
    const g = obj['groupId']
    if (typeof g === 'string' && g !== '') members.set(g, (members.get(g) ?? 0) + 1)
  }
  const groups = new Map<string, string>()
  for (const [g, count] of members) if (count >= 2) groups.set(g, nanoid())

  let dx = placement.offset?.x ?? 0
  let dy = placement.offset?.y ?? 0
  if (placement.at !== undefined) {
    const boxes = prepared.map(({ obj }) => ({
      x: num(obj['x']),
      y: num(obj['y']),
      w: num(obj['width']),
      h: num(obj['height']),
    }))
    const left = Math.min(...boxes.map((b) => b.x))
    const top = Math.min(...boxes.map((b) => b.y))
    const right = Math.max(...boxes.map((b) => b.x + b.w))
    const bottom = Math.max(...boxes.map((b) => b.y + b.h))
    dx = placement.at.x - (left + right) / 2
    dy = placement.at.y - (top + bottom) / 2
  }

  const objects: SlideObject[] = []
  const cellBodies: InsertPlan['cellBodies'] = []
  for (const { obj, cells } of prepared) {
    const g = obj['groupId']
    if (typeof g === 'string' && g !== '') {
      const to = groups.get(g)
      if (to === undefined) delete obj['groupId']
      else obj['groupId'] = to
    }
    obj['x'] = num(obj['x']) + dx
    obj['y'] = num(obj['y']) + dy
    const crop = obj['imageRect'] as
      | { x: number; y: number; width: number; height: number }
      | undefined
    if (crop !== undefined) obj['imageRect'] = { ...crop, x: crop.x + dx, y: crop.y + dy }
    objects.push(obj as unknown as SlideObject)
    for (const c of cells) cellBodies.push({ objectId: obj['id'] as string, ...c })
  }
  return { objects, cellBodies }
}

/** Add planned objects on top of a slide's stacking order; returns their ids in order. */
export function applyInsertPlan(ctx: ObjectsMutationContext, plan: InsertPlan): string[] {
  addObjects(ctx, plan.objects)
  for (const { objectId, row, col, plan: body } of plan.cellBodies) {
    const cell = getTableCellYMap(ctx, objectId, row, col)
    const text = cell?.get('text') as Y.Text | undefined
    if (text !== undefined && typeof text === 'object' && 'toDelta' in text)
      writePlan(ctx.doc, text, body)
  }
  return plan.objects.map((o) => o.id)
}
