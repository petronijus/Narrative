/**
 * mcp/sharedShapes.ts — input shapes that mean the same on every tool,
 * written compactly in each tool's schema and explained once in the server
 * instructions (vocabulary.ts does the same for field descriptions).
 *
 * The tool list is in every session's context (tools.ts). A few shapes
 * recur across dozens of tools: the slide reference alone (a slide id,
 * `{ id }` or `{ index }`) sat on 75 tools at ≈ 190 bytes each. Each entry
 * pairs the exact JSON Schema a command's input produces (after
 * compaction, schemaCompact.ts) with the compact schema the tool list shows
 * instead, and the note the instructions carry. The compact form still
 * says what a model may send; the note says the rest (bounds, the pattern
 * of a colour, an accepted alias form).
 *
 * Only the MCP projection changes. The commands validate their input with
 * zod exactly as before, so everything the full shape accepts is still
 * accepted — `{ "id": … }` as a slide reference included.
 *
 * sharedShapes.test.ts keeps the list honest in both directions: every
 * entry must still match a shape somewhere (a changed zod schema would
 * otherwise put the long form back on every tool silently), and a shape
 * repeated widely enough to be worth it must be listed here.
 */

type JsonSchema = Record<string, unknown>

export interface SharedShape {
  /** What it is, for the test's messages. */
  readonly name: string
  /** The schema exactly as a compacted command input carries it. */
  readonly match: JsonSchema
  /** What the tool list shows instead. */
  readonly compact: JsonSchema
  /** What the instructions say about it ('' when another entry's note covers it). */
  readonly note: string
}

/** A shape repeated on at least this many tools, costing at least this much to repeat, belongs here. */
export const SHAPE_MIN_TOOLS = 3
export const SHAPE_MIN_SAVED_BYTES = 1000

const HEX = '^#(?:[0-9a-f]{3}|[0-9a-f]{6})$'
const COLOUR_INT = { type: 'integer', minimum: 0, maximum: 16777215 }
const COLOUR_HEX = { type: 'string', pattern: HEX }
const TOKEN_REF = {
  type: 'object',
  properties: { $token: { type: 'string', pattern: '^(colors|textStyles)\\.[A-Za-z0-9_-]+$' } },
  required: ['$token'],
}
const COMPACT_COLOUR = { type: ['integer', 'string'] }
const COMPACT_TOKEN_REF = {
  type: 'object',
  properties: { $token: { type: 'string' } },
  required: ['$token'],
}

export const SHARED_SHAPES: readonly SharedShape[] = [
  {
    name: 'slide reference',
    match: {
      anyOf: [
        { type: 'string' },
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        {
          type: 'object',
          properties: { index: { type: 'integer', minimum: 0 } },
          required: ['index'],
        },
      ],
    },
    // The type alone: the vocabulary's slide note says the forms (vocabulary.ts).
    compact: { type: ['string', 'object'] },
    note: '',
  },
  {
    name: 'colour or token',
    match: { anyOf: [COLOUR_INT, COLOUR_HEX, TOKEN_REF] },
    compact: { anyOf: [COMPACT_COLOUR, COMPACT_TOKEN_REF] },
    note:
      'A colour is "#RRGGBB" or "#RGB" (lower-case hex) or a 0xRRGGBB integer; where a schema also takes ' +
      '{ "$token": … }, "colors.<id>" links a folder colour (token_list).',
  },
  {
    name: 'colour',
    match: { anyOf: [COLOUR_INT, COLOUR_HEX] },
    compact: COMPACT_COLOUR,
    note: '',
  },
  { name: 'hex colour', match: COLOUR_HEX, compact: { type: 'string' }, note: '' },
  {
    name: 'token reference',
    match: TOKEN_REF,
    compact: COMPACT_TOKEN_REF,
    note: 'A { "$token": … } is "colors.<id>" or "textStyles.<id>" (token_list).',
  },
  {
    name: 'table cell',
    match: {
      type: 'object',
      properties: { row: { type: 'integer', minimum: 0 }, col: { type: 'integer', minimum: 0 } },
      required: ['row', 'col'],
    },
    compact: {
      type: 'object',
      properties: { row: { type: 'integer' }, col: { type: 'integer' } },
      required: ['row', 'col'],
    },
    // The vocabulary's `cell` note says they are 0-based.
    note: '',
  },
  {
    name: 'object id list',
    match: { minItems: 1, maxItems: 500, type: 'array', items: { type: 'string' } },
    compact: { type: 'array', items: { type: 'string' } },
    note: 'A list of object ids holds 1 to 500 ids.',
  },
]

const KEYED = SHARED_SHAPES.map((s) => [JSON.stringify(s.match), s] as const)

/**
 * Replace every subtree of `schema` that is exactly a shared shape with its
 * compact form (outermost match wins; a replaced subtree is not searched
 * again).
 */
export function compactSharedShapes(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return schema
  const key = JSON.stringify(schema)
  for (const [k, shape] of KEYED) if (k === key) return structuredClone(shape.compact)
  if (Array.isArray(schema)) return schema.map(compactSharedShapes)
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>).map(([k, v]) => [k, compactSharedShapes(v)]),
  )
}

/** The instructions' sentences for the shared shapes. */
export function sharedShapesInstructions(): string {
  return SHARED_SHAPES.map((s) => s.note)
    .filter((n) => n.length > 0)
    .join(' ')
}
