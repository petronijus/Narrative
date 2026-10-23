/**
 * commands/src/commands/appearance.ts — fill, effects and the page-number
 * field as commands (A2.8).
 *
 * `object.update` sets the raw fields (`fillStyle`, `shadow`,
 * `isSlideNumber`); these commands carry what the editor adds on top, so a
 * person clicking the Inspector and an agent asking for "a gradient" or
 * "a drop shadow" get the same result:
 *   - a new gradient starts from the object's own colour (two stops: the
 *     colour and a darker tint of it), a linked colour token is resolved
 *     and unlinked first, and switching linear ↔ radial keeps the stops;
 *   - switching a shadow on starts from the editor's default shadow, and a
 *     change merges into the current one;
 *   - marking a box as the page number can give it the folder's page-number
 *     text style, linked like the Inspector's style picker links one.
 */

import { z } from 'zod'
import type * as Y from 'yjs'
import {
  bulkUpdateObjects,
  isTokenRef,
  resolveTokenValue,
  setTableCellStyle,
  setTableDefaultsPatch,
  type CellStylePatch,
  type DeckMutationContext,
  type FolderTokensSnapshot,
} from '@narrative/slide-model'
import {
  ColorInputSchema,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  RgbInputSchema,
  type FillGradientStop,
  type FillStyle,
  type ShadowStyle,
  type SlideObject,
  type SlideObjectPatch,
  type TableDefaults,
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
import type { CommandContext } from '../types.js'
import {
  CellRangeSchema,
  clearCellOverrides,
  normalizedRange,
  resolveTable,
  type CellRange,
} from './tables.js'
import {
  PAGE_NUMBER_TEXT_STYLE_NAME,
  findTextStyleByName,
  textStyleFields,
} from '../text/textStyle.js'

const objectEditor = {
  domain: 'object',
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
} as const

const EmptyOutput = z.object({})
const Unit = z.number().finite().min(0).max(1)

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

/** Object types whose fill can be a gradient (`fillStyle`). */
export const GRADIENT_FILL_TYPES = ['rectangle', 'ellipse', 'triangle', 'polygon', 'path'] as const

/** How much darker a seeded gradient's second stop is than its first. */
const SEED_TINT = 0.55

/**
 * The two stops a new gradient starts with: the object's colour, and a
 * darker tint of it (each channel × 0.55), so it reads as a gradient
 * without falling to black.
 */
export function seedGradientStops(color: number): FillGradientStop[] {
  const tint = (c: number): number => Math.max(0, Math.min(255, Math.round(c * SEED_TINT)))
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  return [
    { color, offset: 0 },
    { color: (tint(r) << 16) | (tint(g) << 8) | tint(b), offset: 1 },
  ]
}

/** The shadow the editor switches on: soft, down-right, half-transparent black. */
export const DEFAULT_SHADOW: Readonly<ShadowStyle> = Object.freeze({
  color: 0x000000,
  blur: 8,
  offsetX: 4,
  offsetY: 4,
  opacity: 0.5,
})

/** A stored colour as 0xRRGGBB: a literal, or a token resolved against the folder; null when it cannot be. */
function colorInt(value: unknown, tokens: FolderTokensSnapshot | null | undefined): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (isTokenRef(value) && tokens !== null && tokens !== undefined) {
    const hex = resolveTokenValue(value, tokens)
    if (hex !== null && /^#[0-9a-f]{6}$/i.test(hex)) return parseInt(hex.slice(1), 16)
  }
  return null
}

function plainFillStyle(map: Y.Map<unknown>): FillStyle | undefined {
  const v = map.get('fillStyle')
  return v !== null && typeof v === 'object' ? (v as FillStyle) : undefined
}

function update(id: string, patch: Record<string, unknown>) {
  return { id, patch: patch as SlideObjectPatch<SlideObject> }
}

// ---------------------------------------------------------------------------
// object.fill.gradient
// ---------------------------------------------------------------------------

const StopSchema = z.strictObject({
  color: RgbInputSchema.describe('"#RRGGBB" or 0xRRGGBB'),
  offset: Unit.describe('Position along the gradient, 0..1'),
  alpha: Unit.exactOptional().describe('0..1, default 1'),
})

export const objectFillGradient = defineCommand({
  ...objectEditor,
  id: 'object.fill.gradient',
  title: 'Gradient fill',
  description:
    'Fill shapes (rectangle, ellipse, triangle, polygon, path) or tables with a linear or radial gradient. Without ' +
    "`stops` a new gradient starts from the shape's fill colour and a darker tint of it (as the editor does), " +
    'and an existing gradient keeps its stops — so switching linear ↔ radial or changing only `angle` / `center` ' +
    'keeps the colours. `angle` (linear, degrees clockwise, 0 = top to bottom, 90 = left to right) and `center` ' +
    '(radial, 0..1 of the shape) keep their values when omitted. A fill linked to a folder colour is unlinked to ' +
    "its current colour. A table gets it as every cell's fill (replacing cells' own gradients); with `cells` (one " +
    'table in `objects`) only those cells, each from its own colour. Back to solid: object.update with ' +
    '"fillStyle": null (table cells: table.style.*).',
  input: z.strictObject({
    slide: SlideRefSchema,
    objects: ObjectIdsSchema,
    kind: z.enum(['linear', 'radial']),
    stops: z
      .array(StopSchema)
      .min(MIN_GRADIENT_STOPS)
      .max(MAX_GRADIENT_STOPS)
      .optional()
      .describe(`${MIN_GRADIENT_STOPS}–${MAX_GRADIENT_STOPS} colour stops`),
    angle: z.number().finite().optional().describe('Linear only: degrees clockwise, 0 = downwards'),
    center: z
      .strictObject({ x: Unit, y: Unit })
      .optional()
      .describe('Radial only: the centre, 0..1 of the shape (default 0.5, 0.5)'),
    cells: CellRangeSchema.optional().describe('Tables only: fill just these cells'),
  }),
  output: EmptyOutput,
  idempotent: true,
  readsFolderTokens: true,
  implementedWith: [
    'bulkUpdateObjects',
    'setTableDefaultsPatch',
    'setTableCellStyle',
    'getTableCellYMap',
  ],
  examples: [
    {
      title: "A left-to-right gradient from the shape's own colour",
      input: { slide: 's1', objects: ['r1'], kind: 'linear', angle: 90 },
    },
    {
      title: 'A radial gradient with explicit colours',
      input: {
        slide: 's1',
        objects: ['e1'],
        kind: 'radial',
        stops: [
          { color: '#ffd166', offset: 0 },
          { color: '#ef476f', offset: 1 },
        ],
      },
    },
    {
      title: 'A top-to-bottom gradient on the header row of a table',
      input: {
        slide: 's1',
        objects: ['tbl1'],
        kind: 'linear',
        cells: { from: { row: 0, col: 0 }, to: { row: 0, col: 2 } },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const maps = requireObjects(objects, input.objects, slide.id)
    if (input.kind === 'linear' && input.center !== undefined)
      throw new CommandError('invalid_input', '`center` is for a radial gradient')
    if (input.kind === 'radial' && input.angle !== undefined)
      throw new CommandError('invalid_input', '`angle` is for a linear gradient')
    const ids = [...new Set(input.objects)]
    if (
      input.cells !== undefined &&
      (ids.length !== 1 || maps.get(ids[0]!)!.get('type') !== 'table')
    )
      throw new CommandError('invalid_input', '`cells` needs exactly one table in `objects`')
    const updates: Array<ReturnType<typeof update>> = []
    const tables: string[] = []
    for (const id of ids) {
      const map = maps.get(id)!
      const type = map.get('type') as string
      if (type === 'table') {
        tables.push(id)
        continue
      }
      if (!(GRADIENT_FILL_TYPES as readonly string[]).includes(type))
        throw new CommandError(
          'invalid_input',
          `object '${id}' is a ${type}; only ${GRADIENT_FILL_TYPES.join(', ')} and tables take a gradient fill`,
        )
      const fill = { fill: map.get('fill'), fillStyle: plainFillStyle(map) }
      updates.push(update(id, gradientPatch(ctx, `object '${id}'`, fill, input)))
    }
    // Every patch is computed (and may refuse) before anything is written.
    const tableWrites = tables.map((id) => tableGradientWrites(ctx, deck, input.slide, id, input))
    if (updates.length > 0) bulkUpdateObjects(objects, updates)
    for (const write of tableWrites) write()
    return {}
  },
})

/** What a gradient is computed from: the fill a shape (or a table cell, defaults applied) shows now. */
interface FillSource {
  fill: unknown
  fillStyle: FillStyle | undefined
  /** Tables only: the fill's alpha, which a table also applies to a gradient. */
  fillAlpha?: number | undefined
}

interface GradientInput {
  kind: 'linear' | 'radial'
  stops?: FillGradientStop[] | undefined
  angle?: number | undefined
  center?: { x: number; y: number } | undefined
}

function gradientPatch(
  ctx: CommandContext,
  what: string,
  source: FillSource,
  input: GradientInput,
): Record<string, unknown> {
  const current = source.fillStyle
  const currentGradient = current !== undefined && current.kind !== 'image' ? current : undefined
  const fill = source.fill
  const patch: Record<string, unknown> = {}
  const solid = colorInt(fill, ctx.folderTokens)
  if (isTokenRef(fill)) {
    // Leaving a solid fill linked to a token: unlink it to its current
    // colour, so going back to solid shows the colour the gradient started
    // from (the Inspector does the same).
    if (solid !== null) patch['fill'] = solid
    else if (input.stops === undefined && currentGradient === undefined)
      throw new CommandError(
        ctx.folderTokens === undefined ? 'conflict' : 'invalid_input',
        `${what} is filled with the folder colour ${fill.$token}, which cannot be resolved here; give \`stops\``,
      )
  }
  // A table paints a gradient with its fill alpha: "no colour" (alpha 0)
  // would hide the gradient that was asked for.
  if (source.fillAlpha === 0) patch['fillAlpha'] = 1
  // A shape without a fill colour (a path may have none) starts from white.
  const stops = input.stops ?? currentGradient?.stops ?? seedGradientStops(solid ?? 0xffffff)
  if (input.kind === 'linear') {
    patch['fillStyle'] = {
      kind: 'linearGradient',
      stops,
      angleDeg:
        input.angle ?? (currentGradient?.kind === 'linearGradient' ? currentGradient.angleDeg : 0),
    }
  } else {
    const center =
      input.center ??
      (currentGradient?.kind === 'radialGradient' &&
      currentGradient.centerX !== undefined &&
      currentGradient.centerY !== undefined
        ? { x: currentGradient.centerX, y: currentGradient.centerY }
        : undefined)
    patch['fillStyle'] = {
      kind: 'radialGradient',
      stops,
      ...(center !== undefined ? { centerX: center.x, centerY: center.y } : {}),
    }
  }
  return patch
}

/**
 * A table's gradient, computed and checked now, written by the returned
 * function. Without `cells` the defaults get it and every cell loses its
 * own gradient and fill alpha, so all of them show it (the Inspector's
 * "paint the whole table"); with `cells` each visible cell of the range
 * gets one computed from the fill it shows (its override, else the
 * default).
 */
function tableGradientWrites(
  ctx: CommandContext,
  deck: DeckMutationContext,
  slideRef: SlideRef,
  tableId: string,
  input: GradientInput & { cells?: CellRange | undefined },
): () => void {
  const t = resolveTable(deck, slideRef, tableId)
  const d = t.table.defaults
  if (input.cells === undefined) {
    const patch = gradientPatch(
      ctx,
      `table '${tableId}'`,
      { fill: d.fill, fillStyle: d.fillStyle, fillAlpha: d.fillAlpha },
      input,
    )
    return () => {
      // Every cell shows the gradient: its own gradient and fill alpha go;
      // its own solid colour stays (it shows again when the table goes back
      // to solid, as a cell's colour does after a table-wide gradient).
      clearCellOverrides(t.objects, t.id, t, ['fillStyle', 'fillAlpha'])
      setTableDefaultsPatch(t.objects, t.id, patch as Partial<TableDefaults>)
    }
  }
  const r = normalizedRange(t, input.cells)
  const writes: Array<{ row: number; col: number; patch: Record<string, unknown> }> = []
  for (let row = r.r0; row <= r.r1; row++) {
    for (let col = r.c0; col <= r.c1; col++) {
      const cell = t.table.rows[row]?.[col]
      // Cells hidden inside a merge are skipped; the merged cell is filled.
      if (cell === undefined || cell.mergeOriginR !== undefined || cell.mergeOriginC !== undefined)
        continue
      const source: FillSource = {
        fill: cell.fill ?? d.fill,
        fillStyle: cell.fillStyle ?? d.fillStyle,
        fillAlpha: cell.fillAlpha ?? d.fillAlpha,
      }
      writes.push({
        row,
        col,
        patch: gradientPatch(ctx, `cell (${row}, ${col}) of table '${tableId}'`, source, input),
      })
    }
  }
  return () => {
    for (const w of writes)
      setTableCellStyle(t.objects, t.id, w.row, w.col, w.patch as CellStylePatch)
  }
}

// ---------------------------------------------------------------------------
// object.effects.shadow
// ---------------------------------------------------------------------------

export const objectEffectsShadow = defineCommand({
  ...objectEditor,
  id: 'object.effects.shadow',
  title: 'Drop shadow',
  description:
    'Give objects a drop shadow, change it, or remove it (`shadow: null`). The fields given are merged into ' +
    "the current shadow, or the editor's default (black, blur 8, offset 4 / 4, opacity 0.5): `{}` switches " +
    'the default on, `{ "blur": 20 }` only softens it. Any object type; for text the glyphs cast it.',
  input: z.strictObject({
    slide: SlideRefSchema,
    objects: ObjectIdsSchema,
    shadow: z
      .strictObject({
        color: ColorInputSchema.optional().describe('"#RRGGBB", 0xRRGGBB or a folder colour token'),
        blur: z.number().finite().min(0).max(500).optional().describe('Blur radius, px'),
        offsetX: z.number().finite().min(-2000).max(2000).optional().describe('px, + is right'),
        offsetY: z.number().finite().min(-2000).max(2000).optional().describe('px, + is down'),
        opacity: Unit.optional().describe('0..1'),
      })
      .nullable()
      .describe('The shadow fields to set, or null to remove the shadow'),
  }),
  output: EmptyOutput,
  idempotent: true,
  implementedWith: ['bulkUpdateObjects'],
  examples: [
    { title: 'Switch on the default shadow', input: { slide: 's1', objects: ['r1'], shadow: {} } },
    {
      title: 'A long soft shadow under a headline',
      input: { slide: 's1', objects: ['t1'], shadow: { blur: 24, offsetY: 12, opacity: 0.3 } },
    },
    { title: 'Remove a shadow', input: { slide: 's1', objects: ['e1'], shadow: null } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const maps = requireObjects(objects, input.objects, slide.id)
    const given = input.shadow
    bulkUpdateObjects(
      objects,
      [...new Set(input.objects)].map((id) => {
        if (given === null) return update(id, { shadow: undefined })
        const current = maps.get(id)!.get('shadow') as ShadowStyle | undefined
        const base = current !== undefined && current !== null ? current : DEFAULT_SHADOW
        const next: ShadowStyle = {
          color: given.color ?? base.color,
          blur: given.blur ?? base.blur,
          offsetX: given.offsetX ?? base.offsetX,
          offsetY: given.offsetY ?? base.offsetY,
          opacity: given.opacity ?? base.opacity,
        }
        return update(id, { shadow: next })
      }),
    )
    return {}
  },
})

// ---------------------------------------------------------------------------
// object.slideNumber.set
// ---------------------------------------------------------------------------

/** Whether any text box of the deck other than `exceptId` is a page-number field. */
function deckHasOtherPageNumber(ctx: CommandContext, exceptSlideId: string, exceptId: string) {
  const deck = requireDeck(ctx)
  for (const slideMap of deck.slides.toArray()) {
    const slideId = slideMap.get('id')
    const objects = slideMap.get('objects') as Y.Array<Y.Map<unknown>> | undefined
    if (objects === undefined) continue
    for (const m of objects.toArray()) {
      if (m.get('type') !== 'text' || m.get('isSlideNumber') !== true) continue
      if (slideId === exceptSlideId && m.get('id') === exceptId) continue
      return true
    }
  }
  return false
}

export const objectSlideNumberSet = defineCommand({
  ...objectEditor,
  id: 'object.slideNumber.set',
  title: 'Page-number field',
  description:
    'Make a text box show the number of its slide (`on: true`), or stop. The number replaces its text when ' +
    'drawn, counting slides in deck order without skipped ones; font, size, colour and alignment stay. ' +
    "`applyTextStyle: true` also links and applies the folder's page-number text style " +
    `("${PAGE_NUMBER_TEXT_STYLE_NAME}"), as the editor offers for a deck's first page number. The result says ` +
    'whether the deck has another page number and whether the folder has that style.',
  input: z
    .strictObject({
      slide: SlideRefSchema,
      object: ObjectIdSchema,
      on: z.boolean(),
      applyTextStyle: z
        .boolean()
        .optional()
        .describe(
          `With on: link and apply the folder's "${PAGE_NUMBER_TEXT_STYLE_NAME}" text style`,
        ),
    })
    .refine((v) => v.on || v.applyTextStyle !== true, {
      message: 'applyTextStyle goes with on: true',
    }),
  output: z.object({
    otherPageNumberInDeck: z
      .boolean()
      .describe('Another text box of the deck is already a page-number field'),
    pageNumberStyle: z
      .object({ id: z.string(), name: z.string() })
      .nullable()
      .describe("The folder's page-number text style, or null when it has none"),
  }),
  idempotent: true,
  readsFolderTokens: true,
  implementedWith: ['bulkUpdateObjects'],
  examples: [
    {
      title: 'Turn a footer box into the page number',
      input: { slide: 's1', object: 't1', on: true },
    },
    {
      title: "…and give it the folder's page-number style",
      input: { slide: 's1', object: 't1', on: true, applyTextStyle: true },
    },
    { title: 'Back to plain text', input: { slide: 's1', object: 't1', on: false } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const map = requireObjects(objects, [input.object], slide.id).get(input.object)!
    if (map.get('type') !== 'text')
      throw new CommandError(
        'invalid_input',
        `object '${input.object}' is a ${String(map.get('type'))}; only a text box can be a page number`,
      )
    const tokens = ctx.folderTokens
    const style =
      tokens === null || tokens === undefined
        ? null
        : findTextStyleByName(tokens, PAGE_NUMBER_TEXT_STYLE_NAME)
    const patch: Record<string, unknown> = { isSlideNumber: input.on ? true : undefined }
    if (input.applyTextStyle === true) {
      if (tokens === undefined)
        throw new CommandError('conflict', "the folder's text styles cannot be read here")
      if (style === null || tokens === null)
        throw new CommandError(
          'not_found',
          `the folder has no "${PAGE_NUMBER_TEXT_STYLE_NAME}" text style; set the box's typography with text.setBoxTypography`,
        )
      Object.assign(patch, textStyleFields(style, tokens), {
        textStyleId: style.id,
        textStyleOverrides: [],
      })
    }
    const otherPageNumberInDeck = deckHasOtherPageNumber(ctx, slide.id, input.object)
    bulkUpdateObjects(objects, [update(input.object, patch)])
    return {
      otherPageNumberInDeck,
      pageNumberStyle: style === null ? null : { id: style.id, name: style.name },
    }
  },
})

export const appearanceCommands = [objectFillGradient, objectEffectsShadow, objectSlideNumberSet]
