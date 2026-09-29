/**
 * commands/src/text/body.ts
 *
 * The one place that knows how a model's view of a text body maps onto the
 * slide model's Y.Text (see slide-model/src/richText.ts for the storage
 * rules):
 *
 *   - A body is a flat Y.Text. U+2029 (PARAGRAPH_SEP) ends a paragraph and
 *     carries its block attributes (list kind, level, glyph, numbering,
 *     start-at); '\n' is a SOFT line break inside a paragraph. Once any
 *     paragraph carries block attributes the body ends with a trailing
 *     separator for the last paragraph; plain bodies do not.
 *   - Models see and send text with paragraphs separated by a BLANK LINE
 *     ("\n\n") — the convention every query returns and text.set accepts —
 *     so what a model reads it can write back. Character offsets in
 *     commands (text.format / text.list ranges) count positions in THAT
 *     display string; `displayOf` maps them onto the stored body.
 *
 * Writers go through slide-model (`spliceRichText`, `applyFormat`,
 * `updateParagraphsInRange`); nothing here writes Yjs directly.
 */

import { z } from 'zod'
import type * as Y from 'yjs'
import {
  PARAGRAPH_SEP,
  applyFormat,
  blockAttrsToInsertAttrs,
  getParagraphDeltas,
  getPlainString,
  sanitizeFontFamily,
  spliceRichText,
  updateParagraphsInRange,
  type ParagraphPatch,
  type RichAttrs,
  type RichDeltaOp,
} from '@narrative/slide-model'
import {
  ParagraphAttrsSchema,
  PositiveNumberSchema,
  RgbInputSchema,
  type ParagraphAttrs,
} from '@narrative/shared'

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/** Longest body a command accepts, in characters. */
export const MAX_BODY_LENGTH = 100_000

const FontFamilyInput = z
  .string()
  .min(1)
  .max(200)
  .transform((raw, ctx) => {
    const safe = sanitizeFontFamily(raw)
    if (safe === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Font family has no usable characters', input: raw })
      return z.NEVER
    }
    return safe
  })
  .describe('Font family name, e.g. "Inter" (must be available to the deck; see its folder fonts)')

const FontWeightNumber = z
  .number()
  .int()
  .min(100)
  .max(900)
  .multipleOf(100)
  .describe('CSS font weight 100..900 in steps of 100 (400 regular, 700 bold)')

/** Inline formatting a run can carry. Colours: 0xRRGGBB int or "#RRGGBB" (no tokens inside text). */
const runFormatShape = {
  bold: z.boolean().optional().describe('Shorthand: true = fontWeight 700, false = fontWeight 400'),
  fontWeight: FontWeightNumber.optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: RgbInputSchema.optional().describe('Text colour, "#RRGGBB" or 0xRRGGBB integer'),
  fontFamily: FontFamilyInput.optional(),
  fontSize: PositiveNumberSchema.max(2000).optional().describe('Font size in slide px'),
}

function noBoldAndWeight(v: {
  bold?: boolean | undefined
  fontWeight?: number | undefined
}): boolean {
  return v.bold === undefined || v.fontWeight === undefined
}
const BOLD_AND_WEIGHT = {
  message: 'Pass either `bold` or `fontWeight`, not both',
  path: ['fontWeight'],
}

export const RunFormatSchema = z
  .strictObject(runFormatShape)
  .refine(noBoldAndWeight, BOLD_AND_WEIGHT)
export type RunFormat = z.output<typeof RunFormatSchema>

const NoParagraphSep = (s: string): boolean => !s.includes(PARAGRAPH_SEP)
const NO_SEP = { message: 'Use separate paragraphs instead of U+2029 inside a run' }

export const RunInputSchema = z
  .strictObject({
    text: z
      .string()
      .max(MAX_BODY_LENGTH)
      .refine(NoParagraphSep, NO_SEP)
      .describe('Run text; "\\n" is a soft line break'),
    ...runFormatShape,
  })
  .refine(noBoldAndWeight, BOLD_AND_WEIGHT)

export const ParagraphInputSchema = ParagraphAttrsSchema.extend({
  text: z
    .string()
    .max(MAX_BODY_LENGTH)
    .refine(NoParagraphSep, NO_SEP)
    .optional()
    .describe('Unformatted paragraph text (shorthand for one run)'),
  runs: z.array(RunInputSchema).max(1000).optional().describe('Formatted runs, in order'),
}).refine((p) => (p.text === undefined) !== (p.runs === undefined), {
  message: 'A paragraph takes exactly one of `text` or `runs`',
})

export const RichTextInputSchema = z
  .strictObject({ paragraphs: z.array(ParagraphInputSchema).min(1).max(1000) })
  .describe(
    'Structured body: paragraphs, each with its list attributes (list "bullet"|"number", level 0..8, bulletChar, ' +
      'numberFormat, startAt) and either plain `text` or formatted `runs`.',
  )

export const TextBodyInputSchema = z
  .union([
    z
      .string()
      .max(MAX_BODY_LENGTH)
      .describe(
        'Plain text. A blank line ("\\n\\n") or U+2029 starts a new paragraph; a single "\\n" is a soft line ' +
          'break inside the paragraph.',
      ),
    RichTextInputSchema,
  ])
  .describe('The body: a plain string, or { paragraphs: [...] } for formatting and lists')

export type TextBodyInput = z.output<typeof TextBodyInputSchema>

// ---------------------------------------------------------------------------
// Plan: the body as paragraphs of runs, independent of how it is written
// ---------------------------------------------------------------------------

export interface PlannedRun {
  text: string
  attrs: RichAttrs
}

export interface PlannedParagraph {
  runs: PlannedRun[]
  block: ParagraphAttrs
}

export interface BodyPlan {
  paragraphs: PlannedParagraph[]
  /** True when any paragraph carries block attributes (→ trailing separator). */
  hasBlocks: boolean
}

export function runFormatToAttrs(f: RunFormat): RichAttrs {
  const a: RichAttrs = {}
  if (f.bold !== undefined) a.fontWeight = f.bold ? 700 : 400
  if (f.fontWeight !== undefined) a.fontWeight = f.fontWeight
  if (f.italic !== undefined) a.italic = f.italic
  if (f.underline !== undefined) a.underline = f.underline
  if (f.color !== undefined) a.color = f.color
  if (f.fontFamily !== undefined) a.fontFamily = f.fontFamily
  if (f.fontSize !== undefined) a.fontSize = f.fontSize
  return a
}

function blockOf(p: ParagraphAttrs): ParagraphAttrs {
  const b: ParagraphAttrs = {}
  if (p.list !== undefined) b.list = p.list
  if (p.level !== undefined && p.level > 0) b.level = p.level
  if (p.bulletChar !== undefined) b.bulletChar = p.bulletChar
  if (p.numberFormat !== undefined) b.numberFormat = p.numberFormat
  if (p.startAt !== undefined) b.startAt = p.startAt
  return b
}

/**
 * Split plain text into paragraphs: U+2029 always separates; otherwise
 * "\n\n" does (greedily, left to right, so every further "\n\n" adds an
 * empty paragraph and a lone leftover "\n" stays a soft break). "\r\n" is
 * normalised to "\n".
 */
export function splitPlainParagraphs(text: string): string[] {
  const normalised = text.replace(/\r\n?/g, '\n')
  return normalised.split(PARAGRAPH_SEP).flatMap((chunk) => chunk.split('\n\n'))
}

export function planFromBody(body: TextBodyInput): BodyPlan {
  if (typeof body === 'string') {
    return {
      paragraphs: splitPlainParagraphs(body).map((t) => ({
        runs: t === '' ? [] : [{ text: t, attrs: {} }],
        block: {},
      })),
      hasBlocks: false,
    }
  }
  const paragraphs = body.paragraphs.map((p): PlannedParagraph => {
    const runs =
      p.runs !== undefined
        ? p.runs
            .filter((r) => r.text.length > 0)
            .map((r) => ({ text: r.text, attrs: runFormatToAttrs(r) }))
        : p.text !== undefined && p.text.length > 0
          ? [{ text: p.text, attrs: {} }]
          : []
    return { runs, block: blockOf(p) }
  })
  return {
    paragraphs,
    hasBlocks: paragraphs.some((p) => blockAttrsToInsertAttrs(p.block) !== undefined),
  }
}

/** The stored string a plan produces (separators included). */
export function planText(plan: BodyPlan): string {
  const body = plan.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(PARAGRAPH_SEP)
  return plan.hasBlocks ? body + PARAGRAPH_SEP : body
}

/**
 * The plan as a Y.Text delta — the `_richTextOps` form `addObject` replays
 * onto a new text object. Separators carry their paragraph's block
 * attributes (`blockAttrsToInsertAttrs`), runs their inline attributes.
 */
export function planToDelta(plan: BodyPlan): RichDeltaOp[] {
  const ops: Array<{ insert: string; attributes?: Record<string, unknown> }> = []
  plan.paragraphs.forEach((p, i) => {
    for (const r of p.runs) {
      ops.push(
        Object.keys(r.attrs).length > 0
          ? { insert: r.text, attributes: { ...r.attrs } }
          : { insert: r.text },
      )
    }
    const last = i === plan.paragraphs.length - 1
    if (!last || plan.hasBlocks) {
      const block = blockAttrsToInsertAttrs(p.block)
      ops.push(
        block !== undefined
          ? { insert: PARAGRAPH_SEP, attributes: block }
          : { insert: PARAGRAPH_SEP },
      )
    }
  })
  return ops as RichDeltaOp[]
}

function blockToPatch(b: ParagraphAttrs): ParagraphPatch | null {
  const rec = blockAttrsToInsertAttrs(b)
  return rec === undefined ? null : (rec as ParagraphPatch)
}

/**
 * Replace a live Y.Text's whole body with a plan, in the caller's
 * transaction: the plain string first (`spliceRichText` — the body is
 * emptied first, so nothing inherits old formatting), then each formatted
 * run (`applyFormat`), then paragraph attributes on their separators
 * (`updateParagraphsInRange`).
 */
export function writePlan(doc: Y.Doc, yText: Y.Text, plan: BodyPlan): void {
  spliceRichText(doc, yText, 0, yText.length, planText(plan))
  let pos = 0
  plan.paragraphs.forEach((p) => {
    for (const r of p.runs) {
      if (Object.keys(r.attrs).length > 0) applyFormat(yText, pos, r.text.length, r.attrs)
      pos += r.text.length
    }
    pos += 1 // the separator
  })
  if (plan.hasBlocks) {
    updateParagraphsInRange(yText, 0, yText.length, (_attrs, i) => {
      const p = plan.paragraphs[i]
      return p === undefined ? null : blockToPatch(p.block)
    })
  }
}

// ---------------------------------------------------------------------------
// Display offsets
// ---------------------------------------------------------------------------

export interface DisplayText {
  /** The body as a model sees it: paragraphs separated by "\n\n". */
  display: string
  /** `toRaw[i]` = index in the stored body of display index `i` (length display.length + 1). */
  toRaw: number[]
  /** Length of the stored body without its trailing separator. */
  rawLimit: number
}

export function displayOf(raw: string): DisplayText {
  const rawLimit = raw.endsWith(PARAGRAPH_SEP) ? raw.length - 1 : raw.length
  let display = ''
  const toRaw: number[] = []
  for (let i = 0; i < rawLimit; i++) {
    if (raw[i] === PARAGRAPH_SEP) {
      display += '\n\n'
      toRaw.push(i, i)
    } else {
      display += raw[i]
      toRaw.push(i)
    }
  }
  toRaw.push(rawLimit)
  return { display, toRaw, rawLimit }
}

/**
 * A range of the STORED body (Y.Text offsets, as the editor tracks its
 * selection) as the display offsets commands take (`{ start, length }` of
 * `TextRangeSchema`, where a paragraph break counts 2). Offsets past the
 * body's last paragraph clamp to its end.
 */
export function displayRangeOf(
  raw: string,
  rawStart: number,
  rawEnd: number,
): { start: number; length: number } {
  const { rawLimit } = displayOf(raw)
  const toDisplay = (i: number): number => {
    const at = Math.max(0, Math.min(i, rawLimit))
    let seps = 0
    for (let k = 0; k < at; k++) if (raw[k] === PARAGRAPH_SEP) seps++
    return at + seps
  }
  const start = toDisplay(Math.min(rawStart, rawEnd))
  return { start, length: toDisplay(Math.max(rawStart, rawEnd)) - start }
}

// ---------------------------------------------------------------------------
// Reading a body for model output
// ---------------------------------------------------------------------------

export function hexColor(n: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.trunc(n)))
    .toString(16)
    .padStart(6, '0')}`
}

export const RunOutputSchema = z.object({
  text: z.string(),
  fontWeight: z.number().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: z.string().optional().describe('"#rrggbb"'),
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
})

export const ParagraphOutputSchema = z.object({
  runs: z.array(RunOutputSchema),
  list: z.enum(['bullet', 'number']).optional(),
  level: z.number().optional(),
  bulletChar: z.string().optional(),
  numberFormat: z.string().optional(),
  startAt: z.number().optional(),
})

export const BodyOutputSchema = z.object({
  text: z
    .string()
    .describe('Plain text; paragraphs separated by a blank line ("\\n\\n"), "\\n" = soft break'),
  paragraphs: z
    .array(ParagraphOutputSchema)
    .optional()
    .describe(
      'Present only when the body has inline formatting or lists; same shape text.set accepts',
    ),
})

export type BodyOutput = z.output<typeof BodyOutputSchema>

/** A live Y.Text (or legacy string) body as JSON for a model. */
export function readBody(body: unknown): BodyOutput {
  if (typeof body === 'string') return { text: displayOf(body).display }
  if (body === null || typeof body !== 'object' || !('toDelta' in body)) return { text: '' }
  const yText = body as Y.Text
  const text = displayOf(getPlainString(yText)).display
  const paras = getParagraphDeltas(yText)
  const formatted = paras.some(
    (p) => Object.keys(p.attrs).length > 0 || p.ops.some((op) => op.attributes !== undefined),
  )
  if (!formatted) return { text }
  return {
    text,
    paragraphs: paras.map((p) => {
      const out: z.input<typeof ParagraphOutputSchema> = {
        runs: p.ops.map((op) => {
          const run: z.input<typeof RunOutputSchema> = { text: op.insert }
          const a = op.attributes
          if (a?.fontWeight !== undefined) run.fontWeight = a.fontWeight
          if (a?.italic !== undefined) run.italic = a.italic
          if (a?.underline !== undefined) run.underline = a.underline
          if (a?.color !== undefined) run.color = hexColor(a.color)
          if (a?.fontFamily !== undefined) run.fontFamily = a.fontFamily
          if (a?.fontSize !== undefined) run.fontSize = a.fontSize
          return run
        }),
      }
      if (p.attrs.list !== undefined) out.list = p.attrs.list
      if (p.attrs.level !== undefined) out.level = p.attrs.level
      if (p.attrs.bulletChar !== undefined) out.bulletChar = p.attrs.bulletChar
      if (p.attrs.numberFormat !== undefined) out.numberFormat = p.attrs.numberFormat
      if (p.attrs.startAt !== undefined) out.startAt = p.attrs.startAt
      return out
    }),
  }
}
