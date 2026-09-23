/**
 * pptx/ooxml/extSchema.ts
 *
 * The shapes the Narrative extensions' values must have (object fields are
 * listed per type in objectExt.ts, slide fields below).
 *
 * The extension comes out of an uploaded file, so it is untrusted input: a
 * crafted deck could put any JSON there. Only fields the exporter writes are
 * read back, each one checked against the model type it lands in, and a
 * field that fails its check is dropped (the native XML's value stands).
 * Identity and linkage fields (`id`, `type`, `groupId`, `hyperlink`,
 * `assetId`, `text`) are never read from it.
 */

import type { ParagraphAttrs } from '@narrative/shared'

/** Parse a value into T, or undefined when it does not have T's shape. */
export type Schema<T = unknown> = (v: unknown) => T | undefined

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

export const num: Schema<number> = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
export const nonNeg: Schema<number> = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
export const positive: Schema<number> = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
export const unit: Schema<number> = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined
export const bool: Schema<boolean> = (v) => (typeof v === 'boolean' ? v : undefined)
export const int =
  (min: number, max: number): Schema<number> =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined
export const str =
  (maxLength: number): Schema<string> =>
  (v) =>
    typeof v === 'string' && v.length <= maxLength ? v : undefined
export const oneOf =
  <T extends string | number>(...values: T[]): Schema<T> =>
  (v) =>
    values.includes(v as T) ? (v as T) : undefined
/** A literal 0xRRGGBB colour. Token references do not travel through PPTX. */
export const color: Schema<number> = int(0, 0xffffff)

/** An object with exactly these keys checked; `required` ones must be present. */
export function obj<T>(
  fields: Record<string, Schema>,
  required: readonly string[] = [],
): Schema<T> {
  return (v) => {
    if (!isRecord(v)) return undefined
    const out: Record<string, unknown> = {}
    for (const [k, schema] of Object.entries(fields)) {
      if (!(k in v) || v[k] === undefined) {
        if (required.includes(k)) return undefined
        continue
      }
      const parsed = schema(v[k])
      if (parsed === undefined) return undefined
      out[k] = parsed
    }
    return out as T
  }
}

export const arr =
  <T>(item: Schema<T>, maxLength: number): Schema<T[]> =>
  (v) => {
    if (!Array.isArray(v) || v.length > maxLength) return undefined
    const out: T[] = []
    for (const x of v) {
      const p = item(x)
      if (p === undefined) return undefined
      out.push(p)
    }
    return out
  }

export const union =
  <T>(...schemas: Schema<T>[]): Schema<T> =>
  (v) => {
    for (const s of schemas) {
      const p = s(v)
      if (p !== undefined) return p
    }
    return undefined
  }

/** A map whose keys match `key` and whose values match `value`. */
export const record =
  <T>(key: RegExp, value: Schema<T>, maxEntries: number): Schema<Record<string, T>> =>
  (v) => {
    if (!isRecord(v)) return undefined
    const entries = Object.entries(v)
    if (entries.length > maxEntries) return undefined
    const out: Record<string, T> = {}
    for (const [k, x] of entries) {
      if (!key.test(k)) return undefined
      const p = value(x)
      if (p === undefined) return undefined
      out[k] = p
    }
    return out
  }

// ---------------------------------------------------------------------------
// Model value shapes
// ---------------------------------------------------------------------------

export const point = obj({ x: num, y: num }, ['x', 'y'])
export const rect = obj({ x: num, y: num, width: num, height: num }, ['x', 'y', 'width', 'height'])
export const cornerRadius = union<unknown>(
  nonNeg,
  obj({ tl: nonNeg, tr: nonNeg, br: nonNeg, bl: nonNeg }, ['tl', 'tr', 'br', 'bl']),
)
/** Paths and masks are bounded: a crafted file must not hand the renderer millions of anchors. */
export const MAX_ANCHORS = 20_000
export const anchor = obj({ x: num, y: num, cpIn: point, cpOut: point, moveTo: bool }, ['x', 'y'])
export const normalizedAnchor = obj({ x: num, y: num, cpIn: point, cpOut: point }, ['x', 'y'])
export const mask = union<unknown>(
  obj({ kind: oneOf('rectangle'), cornerRadius }, ['kind']),
  obj({ kind: oneOf('ellipse') }, ['kind']),
  obj({ kind: oneOf('triangle') }, ['kind']),
  obj({ kind: oneOf('polygon'), sides: int(3, 64) }, ['kind', 'sides']),
  obj({ kind: oneOf('path'), anchors: arr(normalizedAnchor, MAX_ANCHORS), closed: bool }, [
    'kind',
    'anchors',
    'closed',
  ]),
)
export const gradientStop = obj({ color, offset: unit, alpha: unit }, ['color', 'offset'])
/** A fill style; a picture only by how it is fitted (the asset comes from the native picture). */
export const fillStyle = union<unknown>(
  obj({ kind: oneOf('linearGradient'), stops: arr(gradientStop, 64), angleDeg: num }, [
    'kind',
    'stops',
    'angleDeg',
  ]),
  obj(
    { kind: oneOf('radialGradient'), stops: arr(gradientStop, 64), centerX: unit, centerY: unit },
    ['kind', 'stops'],
  ),
  obj({ kind: oneOf('image'), fit: oneOf('cover', 'contain') }, ['kind']),
)
export const fontWeight = union<unknown>(
  oneOf('normal', 'bold'),
  oneOf(100, 200, 300, 400, 500, 600, 700, 800, 900),
)
/** A paragraph's list attributes (slide-model `ParagraphAttrs`). */
export const paragraphAttrs = obj<ParagraphAttrs>({
  list: oneOf('bullet', 'number'),
  level: int(0, 8),
  bulletChar: str(8),
  numberFormat: oneOf(
    'decimal',
    'decimalParen',
    'lowerAlpha',
    'lowerAlphaParen',
    'upperAlpha',
    'upperAlphaParen',
    'lowerRoman',
    'upperRoman',
  ),
  startAt: int(1, 100_000),
})

export const textTransform = oneOf('none', 'uppercase', 'lowercase', 'capitalize')
export const align = oneOf('left', 'center', 'right')
export const vAlign = oneOf('top', 'middle', 'bottom')
export const border = obj(
  { color, width: nonNeg, dash: oneOf('solid', 'dash', 'dot'), alpha: unit },
  ['color', 'width'],
)
export const padding = obj({ top: nonNeg, right: nonNeg, bottom: nonNeg, left: nonNeg }, [
  'top',
  'right',
  'bottom',
  'left',
])
const MAX_GRID = 1_000
export const cellStyle = obj({
  fontSize: positive,
  fontWeight,
  italic: bool,
  underline: bool,
  lineHeight: positive,
  letterSpacing: num,
  textTransform,
  color,
  align,
  vAlign,
  fill: color,
  fillAlpha: unit,
  fillStyle,
  border: obj({ top: border, right: border, bottom: border, left: border }),
  padding,
  gridSpan: int(1, MAX_GRID),
  rowSpan: int(1, MAX_GRID),
  mergeOriginR: int(0, MAX_GRID),
  mergeOriginC: int(0, MAX_GRID),
})
export const tableDefaults = obj(
  {
    fontFamily: str(200),
    fontSize: positive,
    fontWeight,
    italic: bool,
    underline: bool,
    lineHeight: positive,
    letterSpacing: num,
    textTransform,
    paragraphSpaceBefore: nonNeg,
    paragraphSpaceAfter: nonNeg,
    color,
    align,
    vAlign,
    fill: color,
    fillAlpha: unit,
    fillStyle,
    border,
    padding,
  },
  ['fontSize', 'fontWeight', 'color', 'align', 'vAlign', 'padding'],
)

/** The table's model structure; cell text always comes from the native XML. */
export interface TableExt {
  defaults: Record<string, unknown>
  colWidths: number[]
  rowHeights: number[]
  borderSegments?: Record<string, unknown>
  cells: Array<Array<Record<string, unknown>>>
}
export const table = obj<TableExt>(
  {
    defaults: tableDefaults,
    colWidths: arr(nonNeg, MAX_GRID),
    rowHeights: arr(nonNeg, MAX_GRID),
    borderSegments: record(/^[hv]:\d+:\d+$/, border, MAX_GRID * MAX_GRID),
    cells: arr(arr(cellStyle, MAX_GRID), MAX_GRID),
  },
  ['defaults', 'colWidths', 'rowHeights', 'cells'],
)

/** An image's exact crop and the `srcRect` it was written as (see shapes.ts). */
export const imageCrop = obj<{
  src: string
  rect: { x: number; y: number; width: number; height: number } | null
}>({ src: str(100), rect: (v) => (v === null ? null : rect(v)) }, ['src', 'rect'])

/** A line's own box and endpoints, when they differ from the drawn frame. */
export interface LineBoxExt {
  x: number
  y: number
  width: number
  height: number
  p1: { x: number; y: number }
  p2: { x: number; y: number }
}
export const lineBox = obj<LineBoxExt>(
  { x: num, y: num, width: num, height: num, p1: point, p2: point },
  ['x', 'y', 'width', 'height', 'p1', 'p2'],
)

// ---------------------------------------------------------------------------
// Slide extension
// ---------------------------------------------------------------------------

const SLIDE_FIELDS: Record<string, Schema> = {
  indent: int(0, 16),
  collapsed: bool,
  transition: obj({ kind: oneOf('none'), durationMs: nonNeg }, ['kind', 'durationMs']),
  /** Background values OOXML cannot hold, valid only for a background of `kind`. */
  background: union<unknown>(
    obj({ kind: oneOf('radialGradient'), radius: positive }, ['kind', 'radius']),
    obj({ kind: oneOf('image'), fit: oneOf('cover', 'contain') }, ['kind', 'fit']),
  ),
}

export function slideExtFields(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, schema] of Object.entries(SLIDE_FIELDS)) {
    if (!(k in values)) continue
    const parsed = schema(values[k])
    if (parsed !== undefined) out[k] = parsed
  }
  return out
}
