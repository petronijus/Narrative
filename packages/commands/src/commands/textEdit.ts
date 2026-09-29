/**
 * commands/src/commands/textEdit.ts — changing text in place (A2.11):
 *
 *   - `text.edit` — splices and the editor's Enter / Backspace rules at
 *     character offsets: what typing on the canvas dispatches, and a precise
 *     edit inside a long body for an agent (no need to resend it whole);
 *   - `text.replace` — find and replace across a box, a slide or the deck,
 *     text boxes and table cells alike.
 *
 * Offsets are the display offsets queries report (a paragraph break "\n\n"
 * counts 2); the rules live in text/edit.ts.
 */

import { z } from 'zod'
import * as Y from 'yjs'
import { getPlainString, getSlideObjectsCtx, yMapToPlainObject } from '@narrative/slide-model'
import type { TableObject } from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import {
  ObjectIdsSchema,
  SlideRefSchema,
  requireDeck,
  requireObjects,
  resolveSlide,
  objectsOf,
} from '../refs.js'
import { MAX_BODY_LENGTH, displayOf } from '../text/body.js'
import {
  backspaceAt,
  displayOffsetOf,
  enterAt,
  insideBreak,
  rawOffsetOf,
  runFormatAt,
  spliceDisplay,
} from '../text/edit.js'
import { TextTargetSchema, resolveTextTarget, textObjectBody } from '../text/target.js'

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
// text.edit
// ---------------------------------------------------------------------------

const Offset = z
  .number()
  .int()
  .min(0)
  .describe('Character offset in the text as query.object returns it ("\\n\\n" counts 2)')

const SpliceSchema = z
  .strictObject({
    at: Offset,
    delete: z.number().int().min(0).optional().describe('Characters to remove from `at`'),
    insert: z
      .string()
      .max(MAX_BODY_LENGTH)
      .optional()
      .describe('Text to insert at `at`: "\\n\\n" starts a paragraph, "\\n" is a line break'),
  })
  .refine((v) => v.delete !== undefined || v.insert !== undefined, {
    message: 'Pass `delete`, `insert` or both',
  })

const KeySchema = z.strictObject({
  at: Offset,
  key: z.enum(['Enter', 'Backspace']).describe('The key pressed with the caret at `at`'),
})

export const textEdit = defineCommand({
  ...textEditor,
  id: 'text.edit',
  title: 'Edit text in place',
  description:
    'Change part of a text box or table cell body without resending it, as typing in the editor does. `edits` ' +
    'run in order, each against the text the previous one left. { at, delete?, insert? } removes `delete` ' +
    'characters at `at` and inserts `insert` there; inserted text takes the formatting of the text before it, ' +
    '"\\n\\n" in it starts a new paragraph that continues the list it splits. { at, key: "Enter" | "Backspace" } ' +
    'does what the key does with the caret there: Enter splits the paragraph (on an empty list item it ' +
    'outdents, or ends the list); Backspace at the start of an indented or list paragraph outdents it or ' +
    'removes the list, elsewhere deletes the character before. Returns the new length and the caret after the ' +
    'last edit. Whole body: text.set; find and replace: text.replace.',
  input: z.strictObject({
    target: TextTargetSchema,
    edits: z
      .array(z.union([SpliceSchema, KeySchema]))
      .min(1)
      .max(500),
  }),
  output: z.object({
    length: z.number().describe('Characters in the body now, as queries count them'),
    caret: z.number().describe('Offset right after the last edit'),
  }),
  implementedWith: [
    'spliceRichText',
    'splitParagraphAt',
    'indentParagraphs',
    'applyParagraphPatch',
    'applyFormat',
    'clearFormat',
    'updateObject',
    'getTableCellYMap',
  ],
  examples: [
    {
      title: 'Change "results" (offset 10, 7 characters) to "figures"',
      input: {
        target: { slide: 's1', object: 't1' },
        edits: [{ at: 10, delete: 7, insert: 'figures' }],
      },
    },
    {
      title: 'Add a paragraph after "Revenue" (Enter at its end, then type)',
      input: {
        target: { slide: 's1', object: 't2' },
        edits: [
          { at: 7, key: 'Enter' },
          { at: 9, insert: 'New item' },
        ],
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const target = resolveTextTarget(deck, input.target)
    const body = target.body()
    let caret = 0
    for (const e of input.edits) {
      if ('key' in e) {
        const pos = rawOffsetOf(getPlainString(body), e.at)
        caret = e.key === 'Enter' ? enterAt(body, pos) : backspaceAt(deck.doc, body, pos)
      } else {
        caret = spliceDisplay(deck.doc, body, e.at, e.delete ?? 0, e.insert ?? '')
      }
    }
    const raw = getPlainString(body)
    return { length: displayOf(raw).display.length, caret: displayOffsetOf(raw, caret) }
  },
})

// ---------------------------------------------------------------------------
// text.replace
// ---------------------------------------------------------------------------

/** One body `text.replace` looks in. */
interface Body {
  slide: string
  object: string
  cell?: { row: number; col: number }
  /** The stored text as it is now. */
  raw: string
  /** The live body (promoting a legacy plain-string text box first). */
  open(): Y.Text
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function bodiesOf(
  deck: ReturnType<typeof requireDeck>,
  slideId: string,
  only: ReadonlySet<string> | null,
): Body[] {
  const objects = getSlideObjectsCtx(deck, slideId)
  if (objects === null) return []
  const out: Body[] = []
  for (const map of objects.objects.toArray()) {
    const id = map.get('id') as string
    if (only !== null && !only.has(id)) continue
    const type = map.get('type')
    if (type === 'text') {
      const stored = map.get('text')
      out.push({
        slide: slideId,
        object: id,
        raw:
          stored instanceof Y.Text
            ? getPlainString(stored)
            : typeof stored === 'string'
              ? stored
              : '',
        open: () => textObjectBody(objects, id, map),
      })
    } else if (type === 'table') {
      const table = yMapToPlainObject<TableObject>(map)
      table.rows.forEach((row, r) =>
        row.forEach((cell, c) => {
          if (cell.mergeOriginR !== undefined || cell.mergeOriginC !== undefined) return
          const text = cell.text as unknown
          if (!(text instanceof Y.Text)) return
          out.push({
            slide: slideId,
            object: id,
            cell: { row: r, col: c },
            raw: getPlainString(text),
            open: () => text,
          })
        }),
      )
    }
  }
  return out
}

export const textReplace = defineCommand({
  ...textEditor,
  id: 'text.replace',
  title: 'Find and replace text',
  description:
    'Replace every occurrence of `find` with `replace` in text boxes and visible table cells (not speaker notes) — of the whole deck, of ' +
    'one `slide`, or of some `objects` on it. Case-sensitive unless `matchCase: false`; `wholeWord: true` skips ' +
    'matches inside longer words. The replacement keeps the formatting of the text it replaces; "\\n\\n" in it ' +
    'starts a new paragraph. Returns how many were replaced and where. One change: a single undo reverts it.',
  input: z
    .strictObject({
      find: z.string().min(1).max(1000),
      replace: z.string().max(10_000),
      slide: SlideRefSchema.optional().describe('Only this slide (default: every slide)'),
      objects: ObjectIdsSchema.optional().describe('Only these objects on `slide`'),
      matchCase: z.boolean().optional(),
      wholeWord: z.boolean().optional(),
    })
    .refine((v) => v.objects === undefined || v.slide !== undefined, {
      message: '`objects` needs `slide`',
      path: ['objects'],
    }),
  output: z.object({
    replaced: z.number(),
    bodies: z.array(
      z.object({
        slide: z.string(),
        object: z.string(),
        cell: z.object({ row: z.number(), col: z.number() }).optional(),
        count: z.number(),
      }),
    ),
  }),
  implementedWith: [
    'spliceRichText',
    'splitParagraphAt',
    'applyFormat',
    'clearFormat',
    'updateObject',
  ],
  examples: [
    { title: 'Rename the product everywhere', input: { find: 'Acme One', replace: 'Acme Pro' } },
    {
      title: 'Fix a word on one slide, whole words only, any case',
      input: { find: 'colour', replace: 'color', slide: 's1', matchCase: false, wholeWord: true },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    let slideIds: string[]
    let only: ReadonlySet<string> | null = null
    if (input.slide !== undefined) {
      const slide = resolveSlide(deck, input.slide)
      slideIds = [slide.id]
      if (input.objects !== undefined) {
        const maps = requireObjects(objectsOf(deck, slide), input.objects, slide.id)
        for (const [id, map] of maps) {
          const type = map.get('type')
          if (type !== 'text' && type !== 'table')
            throw new CommandError(
              'invalid_input',
              `object '${id}' is a ${String(type)}; only text boxes and tables hold text`,
            )
        }
        only = new Set(input.objects)
      }
    } else {
      slideIds = deck.slides.toArray().map((s) => s.get('id') as string)
    }
    const word = '[\\p{L}\\p{N}_]'
    const pattern = escapeRegExp(input.find)
    const matcher = new RegExp(
      input.wholeWord === true ? `(?<!${word})${pattern}(?!${word})` : pattern,
      input.matchCase === false ? 'giu' : 'gu',
    )
    const bodies: Array<{
      slide: string
      object: string
      cell?: { row: number; col: number }
      count: number
    }> = []
    let replaced = 0
    for (const slideId of slideIds) {
      for (const b of bodiesOf(deck, slideId, only)) {
        const display = displayOf(b.raw).display
        // A match may not start or end between the two characters of a
        // paragraph break (it would cut the break in half).
        const hits = [...display.matchAll(matcher)]
          .map((m) => ({ at: m.index, length: m[0].length }))
          .filter((h) => !insideBreak(b.raw, h.at) && !insideBreak(b.raw, h.at + h.length))
        if (hits.length === 0) continue
        const body = b.open()
        // From the last match back, so earlier offsets stay valid.
        for (const hit of hits.reverse()) {
          const raw = getPlainString(body)
          const format = runFormatAt(body, rawOffsetOf(raw, hit.at))
          spliceDisplay(deck.doc, body, hit.at, hit.length, input.replace, format)
        }
        replaced += hits.length
        bodies.push({
          slide: b.slide,
          object: b.object,
          ...(b.cell === undefined ? {} : { cell: b.cell }),
          count: hits.length,
        })
      }
    }
    return { replaced, bodies }
  },
})

export const textEditCommands = [textEdit, textReplace]
