/**
 * commands/src/commands/text.ts — the `text.*` domain: replace a body,
 * format ranges, and paragraph lists. Every command addresses either a text
 * object or one table cell (`target.cell`), so tables need no text commands
 * of their own.
 */

import { z } from 'zod'
import type * as Y from 'yjs'
import {
  PARAGRAPH_SEP,
  applyFormat,
  applyParagraphPatch,
  clearFormat,
  getParagraphs,
  indentParagraphs,
  toggleListKind,
  plainListValue,
  updateObject,
  updateParagraphsInRange,
  type ParagraphPatch,
  type RichAttrs,
} from '@narrative/slide-model'
import {
  ListKindSchema,
  ListNumberFormatSchema,
  MAX_LIST_LEVEL,
  type SlideObject,
  type SlideObjectPatch,
} from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { requireDeck } from '../refs.js'
import {
  RunFormatSchema,
  TextBodyInputSchema,
  planFromBody,
  planText,
  runFormatToAttrs,
  writePlan,
  displayOf,
} from '../text/body.js'
import { listLevelsOf } from '../text/listLevels.js'
import {
  TextRangeSchema,
  TextTargetSchema,
  resolveRanges,
  resolveTextTarget,
  type RawRange,
} from '../text/target.js'

const textEditor = {
  domain: 'text',
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
} as const

// ---------------------------------------------------------------------------
// text.set
// ---------------------------------------------------------------------------

export const textSet = defineCommand({
  ...textEditor,
  id: 'text.set',
  idempotent: true,
  title: 'Set text',
  description:
    'Replace the WHOLE body of a text box or of one table cell (`target.cell`). Pass a plain string — a blank line ' +
    '("\\n\\n") starts a new paragraph, a single "\\n" is a line break inside the paragraph — or ' +
    '{ paragraphs: [{ runs: [{ text, bold, italic, underline, color, fontFamily, fontSize }], list, level, ' +
    'bulletChar, numberFormat, startAt }] } for formatted runs and bullet / numbered lists (level 0..8). ' +
    'A plain string drops existing inline formatting and lists. Box-level typography (the box font, size, ' +
    'alignment) is unchanged — set it with text.setBoxTypography. To restyle part of the text without retyping it use ' +
    'text.format; for lists on existing text use text.list.',
  input: z.strictObject({ target: TextTargetSchema, text: TextBodyInputSchema }),
  output: z.object({
    length: z.number().describe('Characters in the new body, as queries count them'),
    paragraphs: z.number(),
  }),
  implementedWith: [
    'spliceRichText',
    'applyFormat',
    'updateParagraphsInRange',
    'getTableCellYMap',
    'updateObject',
  ],
  examples: [
    {
      title: 'Retitle a text box',
      input: { target: { slide: 's1', object: 't1' }, text: 'Annual results' },
    },
    {
      title: 'Two paragraphs with a line break',
      input: { target: { slide: 's1', object: 't1' }, text: 'Revenue\nup 12%\n\nCosts flat' },
    },
    {
      title: 'A numbered list with a bold lead-in',
      input: {
        target: { slide: 's1', object: 't1' },
        text: {
          paragraphs: [
            { list: 'number', runs: [{ text: 'Grow: ', bold: true }, { text: 'new markets' }] },
            { list: 'number', text: 'Keep costs flat' },
            { list: 'bullet', level: 1, text: 'hiring freeze', bulletChar: '–' },
          ],
        },
      },
    },
    {
      title: 'Fill a table cell',
      input: { target: { slide: 's1', object: 'tbl1', cell: { row: 0, col: 1 } }, text: 'Q3' },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const target = resolveTextTarget(deck, input.target)
    const plan = planFromBody(input.text)
    // A rich body fully specifies its paragraphs: drop a legacy box-wide
    // `listStyle` (old decks) so it cannot re-bullet paragraphs meant plain.
    const dropLegacyList =
      typeof input.text !== 'string' &&
      target.kind === 'text' &&
      target.objectMap.get('listStyle') !== undefined
    const body = target.body()
    writePlan(deck.doc, body, plan)
    if (dropLegacyList)
      updateObject(target.objects, target.objectId, {
        listStyle: undefined,
      } as unknown as SlideObjectPatch<SlideObject>)
    return { length: displayOf(planText(plan)).display.length, paragraphs: plan.paragraphs.length }
  },
})

// ---------------------------------------------------------------------------
// text.format
// ---------------------------------------------------------------------------

const ClearableKey = z.enum([
  'bold',
  'fontWeight',
  'italic',
  'underline',
  'color',
  'fontFamily',
  'fontSize',
])
const CLEAR_ALL: ReadonlyArray<keyof RichAttrs> = [
  'fontWeight',
  'italic',
  'underline',
  'color',
  'fontFamily',
  'fontSize',
]

/** Split a stored range around paragraph separators: they never carry inline formatting. */
function inlineSegments(raw: string, r: RawRange): RawRange[] {
  const out: RawRange[] = []
  let start = r.start
  for (let i = r.start; i < r.end; i++) {
    if (raw[i] === PARAGRAPH_SEP) {
      if (i > start) out.push({ start, end: i })
      start = i + 1
    }
  }
  if (r.end > start) out.push({ start, end: r.end })
  return out
}

export const textFormat = defineCommand({
  ...textEditor,
  id: 'text.format',
  idempotent: true,
  title: 'Format text range',
  description:
    'Apply (`set`) and/or remove (`clear`) inline formatting — bold, fontWeight, italic, underline, color, ' +
    'fontFamily, fontSize — on part of a text box or table cell without changing the text. Choose the range by ' +
    '{ match: "exact text", occurrence?: n | "all" } (safest) or { start, length } in characters of the text as ' +
    'query.object returns it; omit `range` for the whole body. `clear` runs first, so clear: "all" plus set restyles ' +
    'from scratch. Clearing makes the text fall back to the box defaults. To restyle the whole box use ' +
    'text.setBoxTypography, which also removes this inline formatting.',
  input: z
    .strictObject({
      target: TextTargetSchema,
      range: TextRangeSchema.optional(),
      set: RunFormatSchema.optional(),
      clear: z.union([z.array(ClearableKey).min(1), z.literal('all')]).optional(),
    })
    .refine((v) => v.set !== undefined || v.clear !== undefined, {
      message: 'Pass `set`, `clear` or both',
    }),
  output: z.object({ ranges: z.number().describe('How many ranges were formatted') }),
  implementedWith: ['applyFormat', 'clearFormat'],
  examples: [
    {
      title: 'Make a word bold',
      input: {
        target: { slide: 's1', object: 't1' },
        range: { match: 'Quarterly' },
        set: { bold: true },
      },
    },
    {
      title: 'Colour the first 9 characters',
      input: {
        target: { slide: 's1', object: 't1' },
        range: { start: 0, length: 9 },
        set: { color: '#e03c31' },
      },
    },
    {
      title: 'Remove all inline formatting',
      input: { target: { slide: 's1', object: 't1' }, clear: 'all' },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const target = resolveTextTarget(deck, input.target)
    const ranges = resolveRanges(target.raw, input.range)
    const set = input.set !== undefined ? runFormatToAttrs(input.set) : {}
    const clear: Array<keyof RichAttrs> =
      input.clear === undefined
        ? []
        : input.clear === 'all'
          ? [...CLEAR_ALL]
          : [...new Set(input.clear.map((k) => (k === 'bold' ? 'fontWeight' : k)))]
    const body = target.body()
    for (const r of ranges) {
      for (const seg of inlineSegments(target.raw, r)) {
        if (clear.length > 0) clearFormat(body, seg.start, seg.end - seg.start, clear)
        if (Object.keys(set).length > 0) applyFormat(body, seg.start, seg.end - seg.start, set)
      }
    }
    return { ranges: ranges.length }
  },
})

// ---------------------------------------------------------------------------
// text.list
// ---------------------------------------------------------------------------

export const textList = defineCommand({
  ...textEditor,
  id: 'text.list',
  title: 'Set list formatting',
  description:
    'Turn paragraphs into a bullet or numbered list, change nesting, glyph or numbering, or remove the list — on ' +
    'the paragraphs a range touches (omit `range` for every paragraph; a range of length 0 targets the paragraph ' +
    'containing it), exactly like the Inspector list controls. `kind`: "bullet" | "number" | "none" (removes the ' +
    'list and its level/glyph/numbering; on a box with listLevels it writes list "none" so the level\'s default ' +
    'list no longer applies); `toggle`: the editor toolbar button (removes the list if every targeted ' +
    'paragraph already has that kind, else applies it); `level` 0..8 sets nesting, `indent` +1/-1 shifts it; ' +
    '`bulletChar` (implies bullet; null = default glyph), `numberFormat` (implies number), `startAt` (restart ' +
    'numbering; null clears). To write new list text use text.set with list paragraphs.',
  input: z
    .strictObject({
      target: TextTargetSchema,
      range: TextRangeSchema.optional(),
      kind: z.union([ListKindSchema, z.literal('none')]).optional(),
      toggle: z.enum(['bullet', 'number']).optional(),
      level: z.number().int().min(0).max(MAX_LIST_LEVEL).optional(),
      indent: z
        .number()
        .int()
        .min(-MAX_LIST_LEVEL)
        .max(MAX_LIST_LEVEL)
        .refine((n) => n !== 0, 'indent must not be 0')
        .optional(),
      bulletChar: z.string().min(1).max(4).nullable().optional(),
      numberFormat: ListNumberFormatSchema.optional(),
      startAt: z.number().int().min(1).nullable().optional(),
    })
    .superRefine((v, c) => {
      const fields = [
        'kind',
        'toggle',
        'level',
        'indent',
        'bulletChar',
        'numberFormat',
        'startAt',
      ] as const
      if (!fields.some((f) => v[f] !== undefined))
        c.addIssue({ code: 'custom', message: 'Pass at least one list setting' })
      if (v.kind !== undefined && v.toggle !== undefined)
        c.addIssue({
          code: 'custom',
          message: 'Pass `kind` or `toggle`, not both',
          path: ['toggle'],
        })
      if (v.level !== undefined && v.indent !== undefined)
        c.addIssue({
          code: 'custom',
          message: 'Pass `level` or `indent`, not both',
          path: ['indent'],
        })
      if (
        v.kind === 'none' &&
        (v.bulletChar != null ||
          v.numberFormat !== undefined ||
          v.startAt != null ||
          v.level !== undefined ||
          v.indent !== undefined)
      ) {
        c.addIssue({
          code: 'custom',
          message: 'kind "none" removes the list; do not combine it with list settings',
          path: ['kind'],
        })
      }
      const bulletOnly = v.bulletChar != null
      const numberOnly = v.numberFormat !== undefined
      if (bulletOnly && numberOnly)
        c.addIssue({
          code: 'custom',
          message: '`bulletChar` makes a bullet list, `numberFormat` a numbered one',
          path: ['numberFormat'],
        })
      const kind = v.kind ?? v.toggle
      if (kind === 'number' && bulletOnly)
        c.addIssue({
          code: 'custom',
          message: '`bulletChar` needs a bullet list',
          path: ['bulletChar'],
        })
      if (kind === 'bullet' && numberOnly)
        c.addIssue({
          code: 'custom',
          message: '`numberFormat` needs a numbered list',
          path: ['numberFormat'],
        })
    }),
  output: z.object({ paragraphs: z.number().describe('How many paragraphs the range touched') }),
  implementedWith: [
    'toggleListKind',
    'indentParagraphs',
    'applyParagraphPatch',
    'updateParagraphsInRange',
    'updateObject',
  ],
  examples: [
    {
      title: 'Bullet every paragraph of a text box',
      input: { target: { slide: 's1', object: 't1' }, kind: 'bullet' },
    },
    {
      title: 'Indent the "Costs" item one level',
      input: { target: { slide: 's1', object: 't2' }, range: { match: 'Costs' }, indent: 1 },
    },
    {
      title: 'Number a list as a), b), c) starting at 3',
      input: { target: { slide: 's1', object: 't2' }, numberFormat: 'lowerAlphaParen', startAt: 3 },
    },
    { title: 'Remove the list', input: { target: { slide: 's1', object: 't2' }, kind: 'none' } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const target = resolveTextTarget(deck, input.target)
    const ranges = resolveRanges(target.raw, input.range)
    const legacy = target.kind === 'text' ? target.objectMap.get('listStyle') : undefined

    const body: Y.Text = target.body()
    // Legacy frame-wide `listStyle` (old decks) becomes per-paragraph
    // attributes on the first list edit, in the same step (textListOps.ts).
    if (legacy === 'bullet' || legacy === 'numbered') {
      applyParagraphPatch(body, 0, body.length, {
        list: legacy === 'numbered' ? 'number' : 'bullet',
      })
      updateObject(target.objects, target.objectId, {
        listStyle: undefined,
      } as unknown as SlideObjectPatch<SlideObject>)
    }

    // A box's level defaults (A4.2b): a paragraph made plain where its level
    // would make it a list says so explicitly (`'none'`).
    const levels =
      target.kind === 'text' ? listLevelsOf(target.objectMap.get('listLevels')) : undefined

    let touched = 0
    for (const r of ranges) {
      const from = r.start
      const to = r.end
      if (input.toggle !== undefined) toggleListKind(body, from, to, input.toggle, levels)
      if (input.indent !== undefined) indentParagraphs(body, from, to, input.indent)
      // Everything else is one patch per paragraph, the Inspector's rules:
      // a glyph implies bullet, a number format implies number, "none"
      // clears the list with all its decorations.
      const patch: ParagraphPatch = {}
      const plain = input.kind === 'none'
      if (plain) {
        Object.assign(patch, {
          level: null,
          bulletChar: null,
          numberFormat: null,
          startAt: null,
        })
      } else if (input.kind !== undefined) {
        patch.list = input.kind
      }
      if (input.level !== undefined) patch.level = input.level === 0 ? null : input.level
      if (input.bulletChar !== undefined) {
        patch.list = 'bullet'
        patch.bulletChar = input.bulletChar
      }
      if (input.numberFormat !== undefined) {
        patch.list = 'number'
        patch.numberFormat = input.numberFormat
      }
      if (input.startAt !== undefined) patch.startAt = input.startAt
      if (plain || Object.keys(patch).length > 0) {
        updateParagraphsInRange(body, from, to, (attrs) =>
          plain
            ? { ...patch, list: plainListValue(patch.level === null ? 0 : attrs.level, levels) }
            : patch,
        )
      }
      touched += getParagraphs(body).filter((p) => p.start <= to && p.end >= from).length
    }
    return { paragraphs: touched }
  },
})

export const textCommands = [textSet, textFormat, textList]
