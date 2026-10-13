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
  type TextObject,
} from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import {
  ObjectIdSchema,
  ObjectIdsSchema,
  SlideRefSchema,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
  type SlideRef,
} from '../refs.js'
import { requireServices } from '../services.js'
import type { CommandContext } from '../types.js'
import { textObjectBody } from '../text/target.js'
import {
  findTextStyleByName,
  textStyleFields,
  textStyleFieldsFromObject,
} from '../text/textStyle.js'
import { RUN_ATTR_KEYS, overridesAfter, snappedWeightForFamily } from '../text/typography.js'
import { stretchRangeFor } from '../text/fontWeights.js'
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
  'minFontSize',
  'fontStretch',
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
    'lineHeight, letterSpacing, textTransform, paragraph spacing, minFontSize (the shrink floor), fontStretch ' +
    "(width %, within a variable folder font's wdth range) — as the " +
    'Inspector does: inline formatting of ' +
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
    {
      title: 'Set a title in the extended width of a variable font',
      input: { slide: 's1', objects: ['t1'], style: { fontFamily: 'Fabrikam Type', fontStretch: 130 } },
    },
    {
      title: 'Let a shrinking box go no smaller than 20 px',
      input: { slide: 's1', objects: ['t1'], style: { minFontSize: 20 } },
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
      const stretch = style['fontStretch']
      if (typeof stretch === 'number' && stretch !== 100) {
        const family = (style['fontFamily'] ?? map.get('fontFamily')) as string | undefined
        if (ctx.folderFonts === undefined) {
          throw new CommandError(
            'conflict',
            "the folder's fonts cannot be read here, so their widths are unknown",
          )
        }
        const range = stretchRangeFor(family, ctx.folderFonts ?? [])
        if (range === null || stretch < range[0] || stretch > range[1]) {
          throw new CommandError(
            'invalid_input',
            range === null
              ? `'${family ?? 'the default font'}' has no width axis in this folder; only fontStretch 100 is drawn`
              : `'${family}' is drawn at widths ${range[0]}–${range[1]}; fontStretch ${stretch} is outside it`,
          )
        }
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
    tokens === null
      ? null
      : Object.hasOwn(tokens.textStyles, ref)
        ? tokens.textStyles[ref]!
        : findTextStyleByName(tokens, ref)
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
    const fieldsFor = (target: 'text' | 'table'): Record<string, unknown> =>
      resolved === null
        ? { textStyleId: undefined, textStyleOverrides: undefined }
        : {
            ...textStyleFields(resolved.style, resolved.tokens, [], target),
            textStyleId: resolved.style.id,
            textStyleOverrides: [],
          }
    const fields = fieldsFor('text')
    const tableFields = fieldsFor('table')
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
        clearCellOverrides(objects, w.id, size, Object.keys(tableFields))
        clearTableRuns(objects, w.id, table)
      }
      setTableDefaultsPatch(objects, w.id, tableFields as Partial<TableDefaults>)
    }
    return {
      style: resolved === null ? null : { id: resolved.style.id, name: resolved.style.name },
    }
  },
})

// ---------------------------------------------------------------------------
// text.style.createFromObject / text.style.updateFromObject
// ---------------------------------------------------------------------------

/** The folder the command's deck or component master belongs to. */
async function folderOfTarget(ctx: CommandContext): Promise<string> {
  const services = requireServices(ctx)
  const userId = ctx.actor.userId
  if (ctx.target?.deckId !== undefined) {
    const deck = await services.decks.get({ userId, deckId: ctx.target.deckId })
    if (deck.folderId === null)
      throw new CommandError('conflict', 'the deck is in no folder, so it has no text styles')
    return deck.folderId
  }
  if (ctx.target?.componentId !== undefined) {
    return (await services.components.access({ userId, componentId: ctx.target.componentId }))
      .folderId
  }
  throw new CommandError('no_target', 'name the deck (deckId) or component master (componentId)')
}

interface TypographySource {
  type: 'text' | 'table'
  /** The fields a style made from it takes. */
  fields: Record<string, unknown>
  /** The text style it is linked to, if any. */
  styleId: string | undefined
}

/** What a text box (or a table's defaults) shows, as text-style fields. */
function typographySource(
  ctx: CommandContext,
  slideRef: SlideRef,
  objectId: string,
): TypographySource {
  const deck = requireDeck(ctx)
  const slide = resolveSlide(deck, slideRef)
  const map = requireObjects(objectsOf(deck, slide), [objectId], slide.id).get(objectId)!
  const type = map.get('type')
  if (type === 'text') {
    const obj = yMapToPlainObject<TextObject>(map)
    const sid = obj.textStyleId
    return {
      type,
      fields: textStyleFieldsFromObject(obj),
      styleId: typeof sid === 'string' ? sid : undefined,
    }
  }
  if (type === 'table') {
    const defaults = yMapToPlainObject<TableObject>(map).defaults
    return {
      type,
      fields: textStyleFieldsFromObject(defaults),
      styleId: defaults.textStyleId,
    }
  }
  throw new CommandError(
    'invalid_input',
    `object '${objectId}' is a ${String(type)}; text styles are made from text boxes and tables`,
  )
}

/** Link the object to `styleId` as matching it exactly (no overrides). */
function linkExactly(
  ctx: CommandContext,
  slideRef: SlideRef,
  objectId: string,
  type: 'text' | 'table',
  styleId: string,
): void {
  const deck = requireDeck(ctx)
  const objects = objectsOf(deck, resolveSlide(deck, slideRef))
  const link = { textStyleId: styleId, textStyleOverrides: [] }
  if (type === 'text')
    bulkUpdateObjects(objects, [{ id: objectId, patch: link as SlideObjectPatch<SlideObject> }])
  else setTableDefaultsPatch(objects, objectId, link as Partial<TableDefaults>)
}

const fromObjectBase = {
  domain: 'text',
  role: 'editor',
  effects: ['doc', 'server'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['server'],
  acceptsComponent: true,
} as const

export const textStyleCreateFromObject = defineCommand({
  ...fromObjectBase,
  id: 'text.style.createFromObject',
  title: 'Create a text style from a box',
  description:
    "Add a text style to the deck's folder that reproduces a text box's (or a table's) typography — family, " +
    'weight, size, line height, spacing, colour (a folder colour stays linked), case — and link the box to it, so ' +
    'other text can take it with text.style.apply. The name must be new in the folder (the defaults include ' +
    'Title, Body, Quote, Caption…; token.list). Needs the editor role in the folder. Returns the new style id. Undo unlinks ' +
    'the box; the style stays in the folder until token.delete.',
  input: z.strictObject({
    slide: SlideRefSchema,
    object: ObjectIdSchema,
    name: z.string().trim().min(1).max(80),
  }),
  output: z.object({ styleId: z.string() }),
  implementedWith: ['addFolderToken', 'bulkUpdateObjects', 'setTableDefaultsPatch'],
  examples: [
    {
      title: 'Make a "Quote" style from a box',
      input: { slide: 's1', object: 't1', name: 'Quote' },
    },
  ],
  async load(ctx, input) {
    const source = typographySource(ctx, input.slide, input.object)
    const folderId = await folderOfTarget(ctx)
    const { tokenId } = await requireServices(ctx).tokens.create({
      userId: ctx.actor.userId,
      folderId,
      category: 'textStyles',
      fields: { name: input.name, ...source.fields },
    })
    return { type: source.type, styleId: tokenId }
  },
  handler(ctx, input, loaded) {
    linkExactly(ctx, input.slide, input.object, loaded.type, loaded.styleId)
    return { styleId: loaded.styleId }
  },
})

export const textStyleUpdateFromObject = defineCommand({
  ...fromObjectBase,
  id: 'text.style.updateFromObject',
  title: 'Update a text style from a box',
  description:
    'Make the text style a text box (or table) is linked to match the box: its typography becomes the style, and ' +
    'every other text linked to the style in the folder follows (except fields set by hand there). The box then ' +
    'matches its style exactly. Only when the user asked for the style to change. Needs the editor role in the folder. Returns ' +
    'the style and its previous values (token.update with them undoes the style change).',
  input: z.strictObject({ slide: SlideRefSchema, object: ObjectIdSchema }),
  output: z.object({
    styleId: z.string(),
    style: z.string().describe("The style's name"),
    previous: z.record(z.string(), z.unknown()),
    propagated: z.object({
      decks: z.number(),
      components: z.number(),
      objects: z.number(),
      failed: z.array(z.string()),
    }),
  }),
  implementedWith: [
    'updateFolderToken',
    'updateObject',
    'bulkUpdateObjects',
    'setTableDefaultsPatch',
  ],
  examples: [
    { title: "Push a heading's look into its style", input: { slide: 's2', object: 'hd1' } },
  ],
  async load(ctx, input) {
    const source = typographySource(ctx, input.slide, input.object)
    if (source.styleId === undefined) {
      throw new CommandError(
        'conflict',
        `object '${input.object}' is not linked to a text style; link it with text.style.apply or make one with text.style.createFromObject`,
      )
    }
    const folderId = await folderOfTarget(ctx)
    const services = requireServices(ctx)
    const { previous, propagated } = await services.tokens.update({
      userId: ctx.actor.userId,
      folderId,
      category: 'textStyles',
      tokenId: source.styleId,
      patch: source.fields,
    })
    const tokens = await services.tokens.list({ userId: ctx.actor.userId, folderId })
    const style = tokens.textStyles[source.styleId]?.name ?? source.styleId
    return { type: source.type, styleId: source.styleId, style, previous, propagated }
  },
  handler(ctx, input, loaded) {
    linkExactly(ctx, input.slide, input.object, loaded.type, loaded.styleId)
    return {
      styleId: loaded.styleId,
      style: loaded.style,
      previous: loaded.previous,
      propagated: loaded.propagated,
    }
  },
})

export const typographyCommands = [
  textSetBoxTypography,
  textStyleApply,
  textStyleCreateFromObject,
  textStyleUpdateFromObject,
]
