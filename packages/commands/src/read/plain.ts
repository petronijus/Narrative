/**
 * commands/src/read/plain.ts
 *
 * Document state as JSON built for a model's context window: no live Yjs
 * types (a Y.Text is not JSON and would leak a CRDT handle), text bodies as
 * plain strings plus a paragraph/run structure only when formatted, and
 * colours as "#rrggbb" strings (token refs stay `{ $token }`) — the same
 * forms the write commands accept, so what a model reads it can send back.
 */

import { z } from 'zod'
import * as Y from 'yjs'
import { yMapToPlainObject } from '@narrative/slide-model'
import { hexColor, readBody } from '../text/body.js'

/** Keys whose numeric value is always a 0xRRGGBB colour, wherever they appear. */
const COLOUR_KEYS = new Set(['color', 'fill', 'stroke'])

/**
 * Deep-copy a plain value into JSON: colour numbers become "#rrggbb",
 * `undefined` entries are dropped, and any Yjs type that is still present is
 * dropped too (the callers convert text bodies before this runs).
 */
export function toJsonForModel(value: unknown, key?: string): unknown {
  if (value === null) return null
  if (typeof value === 'number') {
    return key !== undefined && COLOUR_KEYS.has(key) && Number.isInteger(value)
      ? hexColor(value)
      : value
  }
  if (typeof value !== 'object') return value
  if (value instanceof Y.AbstractType) return undefined
  if (Array.isArray(value)) {
    return value.map((v) => toJsonForModel(v)).filter((v) => v !== undefined)
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const converted = toJsonForModel(v, k)
    if (converted !== undefined) out[k] = converted
  }
  return out
}

/** One slide object as model JSON (see the module header). */
export function objectForModel(yMap: Y.Map<unknown>): Record<string, unknown> {
  const plain = yMapToPlainObject(yMap) as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...plain }
  if (plain['type'] === 'text') {
    const body = readBody(plain['text'])
    out['text'] = body.text
    if (body.paragraphs !== undefined) out['paragraphs'] = body.paragraphs
  }
  if (plain['type'] === 'table' && Array.isArray(plain['rows'])) {
    out['rows'] = (plain['rows'] as Array<Array<Record<string, unknown>>>).map((row) =>
      row.map((cell) => {
        const body = readBody(cell['text'])
        const next: Record<string, unknown> = { ...cell, text: body.text }
        if (body.paragraphs !== undefined) next['paragraphs'] = body.paragraphs
        return next
      }),
    )
  }
  return toJsonForModel(out) as Record<string, unknown>
}

/**
 * Output schema of an object in query results. Deliberately open beyond the
 * core fields: a query must describe whatever the document holds — imported
 * decks carry values outside today's strict input schemas (e.g. 1 or 12
 * gradient stops), and a strict output would make the whole query fail.
 */
export const ObjectOutputSchema = z
  .looseObject({
    id: z.string(),
    type: z.string(),
    name: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    rotation: z.number().optional().describe('Radians'),
    text: z
      .string()
      .optional()
      .describe('Text objects: plain body, paragraphs separated by "\\n\\n"'),
  })
  .describe(
    'A slide object with every stored property (see object.create for the fields per type). Colours are ' +
      '"#rrggbb" or { $token }; text bodies are plain strings plus `paragraphs` when formatted; table cells likewise.',
  )
