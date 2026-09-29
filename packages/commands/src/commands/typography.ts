/**
 * commands/src/commands/typography.ts — box-wide typography and folder text
 * styles (A2.11):
 *
 *   - `text.setBoxTypography` — the Inspector's Typography controls on a
 *     text box: the value becomes the box's, inline runs that would hide it
 *     lose that attribute, a new family keeps the box on a cut it has, and
 *     a box linked to a text style records the hand-set fields as
 *     overrides;
 *   - `text.style.apply` — link text boxes or tables to a folder text style
 *     (the Inspector's Preset picker), reset them to it, or unlink them.
 *
 * Inline formatting of part of a body is `text.format`; `object.update`
 * stays the raw write without these rules.
 */

import { z } from 'zod'
import * as Y from 'yjs'
import {
  bulkUpdateObjects,
  clearFormat,
  getTableCellYMap,
  setTableDefaultsPatch,
  yMapToPlainObject,
  type FolderTokensSnapshot,
  type TextStyleTokenSnapshot,
} from '@narrative/slide-model'
import {
  objectPatchInputSchema,
  type FontWeight,
  type SlideObject,
  type SlideObjectPatch,
  type TableDefaults,
  type TableObject,
} from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import {
  ObjectIdsSchema,
  SlideRefSchema,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
} from '../refs.js'
import { textObjectBody } from '../text/target.js'
import { findTextStyleByName, textStyleFields } from '../text/textStyle.js'
import { RUN_ATTR_KEYS, overridesAfter, snappedWeightForFamily } from '../text/typography.js'
import { clearCellOverrides } from './tables.js'

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
// text.setBoxTypography
// ---------------------------------------------------------------------------

/** The box fields `text.setBoxTypography` sets (the Inspector's Typography section). */
export const BOX_TYPOGRAPHY_KEYS = [
  'fontFamily',
  'fontWeight',
  'fontSize',
  'italic',
  'underline',
  'color',
  'colorAlpha',
  'align',
  'vAlign',
  'lineHeight',
  'lineSpacing',
  'letterSpacing',
  'textTransform',
  'paragraphSpaceBefore',
  'paragraphSpaceAfter',
] as const

const TypographyPatchSchema = objectPatchInputSchema('text')
  .pick(
    Object.fromEntries(BOX_TYPOGRAPHY_KEYS.map((k) => [k, true])) as {
      [K in (typeof BOX_TYPOGRAPHY_KEYS)[number]]: true
    },
  )
  .refine((v) => Object.keys(v).length > 0, { message: 'Pass at least one field' })

export const textSetBoxTypography = defineCommand({
  ...textEditor,
  id: 'text.setBoxTypography',
  idempotent: true,
  readsFolderFonts: true,
  title: 'Set box typography',
  description:
    "Set text boxes' own typography — fontFamily, fontWeight, fontSize, italic, underline, color, align, vAlign, " +
    'lineHeight, letterSpacing, textTransform, paragraph spacing — as the Inspector does: inline formatting of ' +
    'the same attributes is removed so the new value shows in the whole box; a new fontFamily without fontWeight ' +
    'moves the weight to the nearest cut the family has; on a box linked to a folder text style the fields you ' +
    'set stop following the style. `null` clears an optional field. Part of a body: text.format. Tables: ' +
    'table.style.*.',
  input: z.strictObject({
    slide: SlideRefSchema,
    objects: ObjectIdsSchema,
    style: TypographyPatchSchema,
  }),
  output: z.object({}),
  implementedWith: ['bulkUpdateObjects', 'clearFormat', 'updateObject'],
  examples: [
    {
      title: 'Set a heading in 64 px bold Inter',
      input: {
        slide: 's1',
        objects: ['t1'],
        style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 64, fontWeight: 700 },
      },
    },
    {
      title: 'Centre two boxes and colour them navy',
      input: { slide: 's1', objects: ['t1', 't2'], style: { align: 'center', color: '#1b2a4a' } },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const ids = [...new Set(input.objects)]
    const maps = requireObjects(objects, ids, slide.id)
    const style = input.style as Record<string, unknown>
    const runKeys = RUN_ATTR_KEYS.filter((k) => k in style)
    // Every patch is computed (and may refuse) before anything is written.
    const updates = ids.map((id) => {
      const map = maps.get(id)!
      const type = map.get('type')
      if (type !== 'text') {
        throw new CommandError(
          'invalid_input',
          `object '${id}' is a ${String(type)}; box typography is for text boxes${type === 'table' ? ' (tables: table.style.table)' : ''}`,
        )
      }
      const patch: Record<string, unknown> = { ...style }
      if ('fontFamily' in style && !('fontWeight' in style)) {
        const weight = snappedWeightForFamily(
          ctx,
          map.get('fontWeight') as FontWeight,
          style['fontFamily'] as string | undefined,
        )
        if (weight !== undefined) patch['fontWeight'] = weight
      }
      if (typeof map.get('textStyleId') === 'string') {
        const overrides = overridesAfter(map.get('textStyleOverrides'), Object.keys(patch))
        if (overrides !== undefined) patch['textStyleOverrides'] = overrides
      }
      return { id, map, patch }
    })
    for (const u of updates) {
      if (runKeys.length === 0) break
      const body = textObjectBody(objects, u.id, u.map)
      if (body.length > 0) clearFormat(body, 0, body.length, runKeys)
    }
    bulkUpdateObjects(
      objects,
      updates.map((u) => ({ id: u.id, patch: u.patch as SlideObjectPatch<SlideObject> })),
    )
    return {}
  },
})

// ---------------------------------------------------------------------------
// text.style.apply
// ---------------------------------------------------------------------------

function resolveStyle(
  tokens: FolderTokensSnapshot | null | undefined,
  ref: string,
): { style: TextStyleTokenSnapshot; tokens: FolderTokensSnapshot } {
  if (tokens === undefined)
    throw new CommandError('conflict', "the folder's text styles cannot be read here")
  const styles = tokens === null ? [] : Object.values(tokens.textStyles)
  const style =
    tokens?.textStyles[ref] ?? (tokens === null ? null : findTextStyleByName(tokens, ref))
  if (style === null || style === undefined || tokens === null) {
    throw new CommandError(
      'not_found',
      styles.length === 0
        ? 'the folder has no text styles'
        : `no text style ${JSON.stringify(ref)}; the folder has: ${styles.map((s) => JSON.stringify(s.name)).join(', ')}`,
    )
  }
  return { style, tokens }
}

/** Strip inline run attributes from every cell body of a table. */
function clearTableRuns(
  objects: Parameters<typeof clearCellOverrides>[0],
  tableId: string,
  table: TableObject,
): void {
  for (let r = 0; r < table.rowHeights.length; r++) {
    for (let c = 0; c < table.colWidths.length; c++) {
      const body = getTableCellYMap(objects, tableId, r, c)?.get('text')
      if (body instanceof Y.Text && body.length > 0)
        clearFormat(body, 0, body.length, RUN_ATTR_KEYS)
    }
  }
}

export const textStyleApply = defineCommand({
  ...textEditor,
  id: 'text.style.apply',
  idempotent: true,
  readsFolderTokens: true,
  title: 'Apply text style',
  description:
    "Link text boxes or tables (their defaults) to one of the folder's text styles, by id or name: the style's " +
    'font, size, weight, line height, spacing, colour and case are written and later changes of the style ' +
    'follow; fields set by hand before are reset to the style. `reset: true` also removes inline formatting ' +
    "(and, in a table, the cells' own text styling). `style: null` unlinks and keeps the current look. An " +
    "unknown style name fails with the list of the folder's styles.",
  input: z
    .strictObject({
      slide: SlideRefSchema,
      objects: ObjectIdsSchema,
      style: z.string().min(1).max(200).nullable().describe('Text style id or name; null unlinks'),
      reset: z.boolean().optional(),
    })
    .refine((v) => v.style !== null || v.reset !== true, {
      message: '`reset` needs a style',
      path: ['reset'],
    }),
  output: z.object({
    style: z.object({ id: z.string(), name: z.string() }).nullable(),
  }),
  implementedWith: [
    'bulkUpdateObjects',
    'setTableDefaultsPatch',
    'clearFormat',
    'setTableCellStyle',
    'getTableCellYMap',
  ],
  examples: [
    {
      title: 'Set a heading in the "Title" style',
      input: { slide: 's1', objects: ['t1'], style: 'Title' },
    },
    {
      title: 'Back to the linked style, without the inline highlights',
      input: { slide: 's1', objects: ['t1'], style: 'title', reset: true },
    },
    { title: 'Unlink a box from its style', input: { slide: 's1', objects: ['t1'], style: null } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const ids = [...new Set(input.objects)]
    const maps = requireObjects(objects, ids, slide.id)
    const resolved = input.style === null ? null : resolveStyle(ctx.folderTokens, input.style)
    const fields: Record<string, unknown> =
      resolved === null
        ? { textStyleId: undefined, textStyleOverrides: undefined }
        : {
            ...textStyleFields(resolved.style, resolved.tokens),
            textStyleId: resolved.style.id,
            textStyleOverrides: [],
          }
    const writes = ids.map((id) => {
      const map = maps.get(id)!
      const type = map.get('type')
      if (type !== 'text' && type !== 'table') {
        throw new CommandError(
          'invalid_input',
          `object '${id}' is a ${String(type)}; text styles apply to text boxes and tables`,
        )
      }
      return { id, map, type }
    })
    const boxes = writes.filter((w) => w.type === 'text')
    if (input.reset === true) {
      for (const w of boxes) {
        const body = textObjectBody(objects, w.id, w.map)
        if (body.length > 0) clearFormat(body, 0, body.length, RUN_ATTR_KEYS)
      }
    }
    if (boxes.length > 0) {
      bulkUpdateObjects(
        objects,
        boxes.map((w) => ({ id: w.id, patch: fields as SlideObjectPatch<SlideObject> })),
      )
    }
    for (const w of writes) {
      if (w.type !== 'table') continue
      const table = yMapToPlainObject<TableObject>(w.map)
      if (input.reset === true) {
        const size = { rows: table.rowHeights.length, cols: table.colWidths.length }
        clearCellOverrides(objects, w.id, size, Object.keys(fields))
        clearTableRuns(objects, w.id, table)
      }
      setTableDefaultsPatch(objects, w.id, fields as Partial<TableDefaults>)
    }
    return {
      style: resolved === null ? null : { id: resolved.style.id, name: resolved.style.name },
    }
  },
})

export const typographyCommands = [textSetBoxTypography, textStyleApply]
