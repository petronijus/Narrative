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

import { inlineCheapDefinitions } from './schemaCompact.js'

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

/** The text body input (text.set, object.create, slide.applyLayout) as the commands' zod produces it. */
const TEXT_BODY: JsonSchema = JSON.parse(
  '{"anyOf":[{"type":"string"},{"type":"object","properties":{"paragraphs":{"minItems":1,"maxItems":1000,"type":"array","items":{"type":"object","properties":{"list":{"type":"string","enum":["bullet","number","none"]},"level":{"type":"integer","minimum":0,"maximum":8},"bulletChar":{"type":"string"},"numberFormat":{"type":"string","enum":["decimal","decimalParen","lowerAlpha","lowerAlphaParen","upperAlpha","upperAlphaParen","lowerRoman","upperRoman"]},"startAt":{"type":"integer","exclusiveMinimum":0},"text":{"type":"string"},"runs":{"maxItems":1000,"type":"array","items":{"type":"object","properties":{"text":{"type":"string"},"bold":{"type":"boolean"},"fontWeight":{"type":"integer","minimum":100,"maximum":900,"multipleOf":100},"italic":{"type":"boolean"},"underline":{"type":"boolean"},"color":{"anyOf":[{"type":"integer","minimum":0,"maximum":16777215},{"type":"string","pattern":"^#(?:[0-9a-f]{3}|[0-9a-f]{6})$"}]},"fontFamily":{"type":"string"},"fontSize":{"type":"number","exclusiveMinimum":0,"maximum":2000}},"required":["text"]}}}}}},"required":["paragraphs"]}]}',
) as JsonSchema

/** A file argument (media_upload, deck_importPptx, folder_fonts_upload, …): { url } or { base64 }. */
const FILE_INPUT: JsonSchema = JSON.parse(
  '{"anyOf":[{"type":"object","properties":{"url":{"type":"string","format":"uri"},"filename":{"type":"string"},"mimeType":{"type":"string","pattern":"^[\\\\w.+-]+\\\\/[\\\\w.+-]+$"}},"required":["url"]},{"type":"object","properties":{"base64":{"type":"string"},"filename":{"type":"string"},"mimeType":{"type":"string","pattern":"^[\\\\w.+-]+\\\\/[\\\\w.+-]+$"}},"required":["base64"]}]}',
) as JsonSchema

/** The part of a text body text_format and text_list act on. */
const TEXT_RANGE: JsonSchema = JSON.parse(
  '{"anyOf":[{"type":"object","properties":{"start":{"type":"integer","minimum":0,"description":"0-based character offset in the body text as queries return it"},"length":{"type":"integer","minimum":0}},"required":["start","length"],"description":"Offsets count characters of the text exactly as query_object returns it (a paragraph break \\"\\\\n\\\\n\\" is 2)"},{"type":"object","properties":{"match":{"type":"string","description":"Exact, case-sensitive text to find"},"occurrence":{"anyOf":[{"type":"integer","minimum":1},{"type":"string","const":"all"}],"description":"Which match, 1-based (default 1), or \\"all\\""}},"required":["match"],"description":"The range(s) where `match` occurs"}],"description":"Omit to target the whole body"}',
) as JsonSchema

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
    // A4.4: slide.applyLayout's slot content made it a third tool's; the
    // instructions say what a body is (guidance.ts) and this note the run.
    name: 'text body',
    match: TEXT_BODY,
    compact: {
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { paragraphs: { type: 'array', items: { type: 'object' } } },
          required: ['paragraphs'],
        },
      ],
    },
    note:
      'A paragraph is { list?, level?, bulletChar?, numberFormat?, startAt?, text } or { …, runs }: 1 to 1000 ' +
      'paragraphs; a run is { text, bold?, fontWeight?, italic?, underline?, color?, fontFamily?, fontSize? }.',
  },
  {
    name: 'object id list',
    match: { minItems: 1, maxItems: 500, type: 'array', items: { type: 'string' } },
    compact: { type: 'array', items: { type: 'string' } },
    note: 'A list of object ids holds 1 to 500 ids.',
  },
  {
    // A5.0: the url and base64 forms each repeated filename and mimeType;
    // the vocabulary's file notes say what each field is.
    name: 'file input',
    match: FILE_INPUT,
    compact: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        base64: { type: 'string' },
        filename: { type: 'string' },
        mimeType: { type: 'string' },
      },
    },
    note: '',
  },
  {
    name: 'text range',
    match: TEXT_RANGE,
    compact: {
      type: 'object',
      properties: {
        start: { type: 'integer' },
        length: { type: 'integer' },
        match: { type: 'string' },
        occurrence: { type: ['integer', 'string'] },
      },
    },
    note:
      'A text `range` (omit it for the whole body) is { start, length } in characters of the text as query_object ' +
      'returns it (a paragraph break "\\n\\n" counts 2), or { match, occurrence? }: exact, case-sensitive text, ' +
      'occurrence 1-based (default 1) or "all".',
  },
]

/** JSON with object keys sorted: two schemas that differ only in key order compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

const KEYED = new Map(SHARED_SHAPES.map((s) => [canonical(s.match), s] as const))

const REF = /^#\/\$defs\/(.+)$/

/**
 * `value` with every `$ref` into `defs` replaced by its definition (siblings
 * such as a description win, as in schemaCompact.ts' `resolve`); a recursive
 * definition stays a `$ref`.
 */
function dereferenced(
  value: unknown,
  defs: Record<string, JsonSchema>,
  open: string[] = [],
): unknown {
  if (Array.isArray(value)) return value.map((v) => dereferenced(v, defs, open))
  if (value === null || typeof value !== 'object') return value
  const node = value as JsonSchema
  const ref = typeof node['$ref'] === 'string' ? REF.exec(node['$ref']) : null
  const name = ref === null ? null : decodeURIComponent(ref[1]!)
  if (name !== null && defs[name] !== undefined && !open.includes(name)) {
    const { $ref: _ref, ...siblings } = node
    return dereferenced({ ...defs[name], ...siblings }, defs, [...open, name])
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, dereferenced(v, defs, open)]))
}

/**
 * Replace every subtree of `schema` that is a shared shape with its compact
 * form (outermost match wins; a replaced subtree is not searched again). A
 * subtree matches with its `$ref`s resolved: zod hoists a schema it meets
 * twice into `$defs`, so the same shape can be written with references on
 * one tool (object_create's text body) and inline on another. Definitions
 * left unused afterwards are dropped, those left cheap inlined.
 */
export function compactSharedShapes(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const root = schema as JsonSchema
  const defs = (root['$defs'] ?? {}) as Record<string, JsonSchema>
  let replaced = false
  const walk = (value: unknown, path: string[]): unknown => {
    if (value === null || typeof value !== 'object') return value
    // A definition that is a shape is compacted in place, for every use.
    // A bare `$ref` stays: its definition is compacted in place, and the
    // reference is shorter than any compact form.
    const bareRef = !Array.isArray(value) && Object.keys(value).length === 1 && '$ref' in value
    const shape = bareRef ? undefined : KEYED.get(canonical(dereferenced(value, defs)))
    if (shape !== undefined && path.length > 0 && !(path.length === 1 && path[0] === '$defs')) {
      replaced = true
      return structuredClone(shape.compact)
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, String(i)]))
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, [...path, k])]),
    )
  }
  const out = walk(root, []) as JsonSchema
  return replaced && root['$defs'] !== undefined ? inlineCheapDefinitions(out) : out
}

/** The instructions' sentences for the shared shapes. */
export function sharedShapesInstructions(): string {
  return SHARED_SHAPES.map((s) => s.note)
    .filter((n) => n.length > 0)
    .join(' ')
}
