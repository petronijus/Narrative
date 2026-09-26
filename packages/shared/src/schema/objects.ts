/**
 * shared/src/schema/objects.ts
 *
 * Runtime schemas for every SlideObject variant and the sub-types they use,
 * mirroring `../slide.ts` one to one (enforced at compile time by
 * ./coverage.typecheck.ts).
 *
 * Everything is built by ONE factory, parameterised by the colour schemas,
 * and instantiated twice:
 *
 *   - storage: colours are the stored form (`0xRRGGBB` int or colour
 *     TokenRef). This is the `<TypeName>Schema` set exported below.
 *   - input:   colours also accept `'#RRGGBB'` / `'#RGB'` strings and are
 *     normalised to the stored form. The patch / create schemas in
 *     ./input.ts are derived from this set, so a hex colour works in every
 *     colour slot an agent can reach — including nested ones like
 *     `shadow.color` or a gradient stop — without a second hand-written
 *     copy of any object shape.
 *
 * Both variants have the same OUTPUT type, so a parsed value is always
 * ready to write into the Y.Doc.
 *
 * Every object is a `strictObject`: an unknown key is an error, not a
 * silently stripped or silently stored extra. The value constraints mirror
 * what the renderer / slide model actually honour; each non-obvious one
 * names its source.
 */

import { z } from 'zod'
import type { SlideObjectType, TokenRef } from '../slide.js'
import { MAX_LIST_LEVEL } from '../slide.js'
import { sanitizeHref } from '../sanitize.js'
import {
  ColorInputSchema,
  ColorIntSchema,
  ColorValueSchema,
  FiniteNumberSchema,
  IdSchema,
  NonNegativeIntSchema,
  NonNegativeNumberSchema,
  PointSchema,
  PositiveIntSchema,
  PositiveNumberSchema,
  RgbInputSchema,
  UnitIntervalSchema,
} from './primitives.js'

// ---------------------------------------------------------------------------
// Limits shared with the editor
// ---------------------------------------------------------------------------

/**
 * Gradient stop count bounds. The Inspector's `GradientStopsEditor`
 * (apps/web/src/ui/Inspector.tsx, `MAX_GRADIENT_STOPS` / `canRemove`)
 * never lets a gradient drop below 2 stops or grow past 10, for both object
 * fills and slide backgrounds. The renderer would tolerate 1 stop
 * (`clampStops` duplicates it), but a one-stop "gradient" is a solid fill
 * spelled wrong, so agent input follows the editor.
 */
export const MIN_GRADIENT_STOPS = 2
export const MAX_GRADIENT_STOPS = 10

/**
 * Regular-polygon side bounds. `polygonRenderer.ts` and the image-mask
 * path in `imageRenderer.ts` both clamp `sides` into [3, 12] after
 * rounding, so anything outside is silently drawn as something else.
 */
export const MIN_POLYGON_SIDES = 3
export const MAX_POLYGON_SIDES = 12

// ---------------------------------------------------------------------------
// Colour-independent leaves
// ---------------------------------------------------------------------------

/**
 * Hyperlink target. Validated AND normalised through `sanitizeHref`, the
 * same function the present-mode sink uses, so what is stored is exactly
 * what will be opened; `javascript:` / `data:` / protocol-relative targets
 * are rejected at the boundary instead of being defused at click time.
 */
const HrefSchema = z.string().transform((raw, ctx) => {
  const safe = sanitizeHref(raw)
  if (safe === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'Unsafe or unparseable link; only http(s) and mailto URLs are allowed',
      input: raw,
    })
    return z.NEVER
  }
  return safe
})

export const ObjectHyperlinkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('slide'), slideId: IdSchema }),
  z.strictObject({
    kind: z.literal('url'),
    href: HrefSchema,
    target: z.enum(['_self', '_blank']).exactOptional(),
  }),
])

export const CornerRadiusSchema = z.union([
  NonNegativeNumberSchema,
  z.strictObject({
    tl: NonNegativeNumberSchema,
    tr: NonNegativeNumberSchema,
    br: NonNegativeNumberSchema,
    bl: NonNegativeNumberSchema,
  }),
])

export const LineCapSchema = z.enum(['none', 'round', 'square', 'arrow'])

export const LineEndpointsSchema = z.strictObject({ p1: PointSchema, p2: PointSchema })

export const PathAnchorSchema = z.strictObject({
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
  cpIn: PointSchema.exactOptional(),
  cpOut: PointSchema.exactOptional(),
  moveTo: z.boolean().exactOptional(),
})

export const FontWeightSchema = z.literal([
  'normal',
  'bold',
  100,
  200,
  300,
  400,
  500,
  600,
  700,
  800,
  900,
])

export const TextVerticalAlignSchema = z.enum(['top', 'middle', 'bottom'])
export const TextListStyleSchema = z.enum(['bullet', 'numbered'])
export const ListKindSchema = z.enum(['bullet', 'number'])
export const ListNumberFormatSchema = z.enum([
  'decimal',
  'decimalParen',
  'lowerAlpha',
  'lowerAlphaParen',
  'upperAlpha',
  'upperAlphaParen',
  'lowerRoman',
  'upperRoman',
])

/**
 * Per-paragraph block attributes. Bounds follow `richText.ts`
 * (`readBlockAttrs` / `writeBlockAttrs`): `level` is floored and capped at
 * `MAX_LIST_LEVEL`, `startAt` below 1 and an empty `bulletChar` are
 * dropped. The schema rejects instead of silently rewriting.
 */
export const ParagraphAttrsSchema = z.strictObject({
  list: ListKindSchema.exactOptional(),
  level: z.number().int().min(0).max(MAX_LIST_LEVEL).exactOptional(),
  bulletChar: z.string().min(1).exactOptional(),
  numberFormat: ListNumberFormatSchema.exactOptional(),
  startAt: PositiveIntSchema.exactOptional(),
})

export const TextStyleOverrideKeySchema = z.enum([
  'fontFamily',
  'fontWeight',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'paragraphSpaceBefore',
  'paragraphSpaceAfter',
  'color',
  'textTransform',
])

/**
 * The override list is a set in practice (the Inspector merges through a
 * `Set`); a duplicate means a writer skipped that step.
 */
const TextStyleOverridesSchema = z
  .array(TextStyleOverrideKeySchema)
  .refine((keys) => new Set(keys).size === keys.length, {
    message: 'textStyleOverrides must not contain duplicates',
  })

const TextTransformSchema = z.enum(['none', 'uppercase', 'lowercase', 'capitalize'])
const HorizontalAlignSchema = z.enum(['left', 'center', 'right'])
const FitSchema = z.enum(['cover', 'contain'])

/**
 * Mask anchors are the source path's anchors divided by its width/height
 * (`normalizePathAnchors` in slide-model shapeMask.ts). The type comment
 * says 0..1, but nothing guarantees a path's anchors sit inside its stored
 * frame, and bezier handles routinely leave it — so only finiteness is
 * enforced.
 */
export const NormalizedPathAnchorSchema = z.strictObject({
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
  cpIn: PointSchema.exactOptional(),
  cpOut: PointSchema.exactOptional(),
})

const PolygonSidesSchema = z.number().int().min(MIN_POLYGON_SIDES).max(MAX_POLYGON_SIDES)

export const ImageMaskSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('rectangle'),
    cornerRadius: CornerRadiusSchema.exactOptional(),
  }),
  z.strictObject({ kind: z.literal('ellipse') }),
  z.strictObject({ kind: z.literal('triangle') }),
  z.strictObject({ kind: z.literal('polygon'), sides: PolygonSidesSchema }),
  z.strictObject({
    kind: z.literal('path'),
    anchors: z.array(NormalizedPathAnchorSchema),
    closed: z.boolean(),
  }),
])

export const TableCellPaddingSchema = z.strictObject({
  top: NonNegativeNumberSchema,
  right: NonNegativeNumberSchema,
  bottom: NonNegativeNumberSchema,
  left: NonNegativeNumberSchema,
})

/** `h:<row>:<col>` / `v:<row>:<col>` — see `TableObject.borderSegments`. */
const BORDER_SEGMENT_KEY_PATTERN = /^([hv]):(\d+):(\d+)$/

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/** A schema whose output is a stored `number | TokenRef` colour. */
type ColorSlot = z.ZodType<number | TokenRef>
/** A schema whose output is a stored `0xRRGGBB` integer. */
type RgbSlot = z.ZodType<number>

function buildObjectSchemas<C extends ColorSlot, R extends RgbSlot>(color: C, rgb: R) {
  const ShadowStyleSchema = z.strictObject({
    color,
    blur: NonNegativeNumberSchema,
    offsetX: FiniteNumberSchema,
    offsetY: FiniteNumberSchema,
    opacity: UnitIntervalSchema,
  })

  const baseShape = {
    id: IdSchema,
    x: FiniteNumberSchema,
    y: FiniteNumberSchema,
    width: NonNegativeNumberSchema,
    height: NonNegativeNumberSchema,
    rotation: FiniteNumberSchema,
    opacity: UnitIntervalSchema,
    name: z.string().exactOptional(),
    locked: z.boolean().exactOptional(),
    shadow: ShadowStyleSchema.exactOptional(),
    blur: NonNegativeNumberSchema.exactOptional(),
    groupId: IdSchema.exactOptional(),
    hyperlink: ObjectHyperlinkSchema.exactOptional(),
    aspectLocked: z.boolean().exactOptional(),
    flipH: z.boolean().exactOptional(),
    flipV: z.boolean().exactOptional(),
  }
  const BaseSlideObjectSchema = z.strictObject(baseShape)

  const strokeShape = {
    stroke: color.exactOptional(),
    strokeWidth: NonNegativeNumberSchema.exactOptional(),
    strokeDash: z.boolean().exactOptional(),
    strokeAlpha: UnitIntervalSchema.exactOptional(),
  }
  const StrokeStyleFieldsSchema = z.strictObject(strokeShape)

  const FillGradientStopSchema = z.strictObject({
    color: rgb,
    offset: UnitIntervalSchema,
    alpha: UnitIntervalSchema.exactOptional(),
  })
  const fillStops = z.array(FillGradientStopSchema).min(MIN_GRADIENT_STOPS).max(MAX_GRADIENT_STOPS)

  const LinearGradientFillSchema = z.strictObject({
    kind: z.literal('linearGradient'),
    stops: fillStops,
    angleDeg: FiniteNumberSchema,
  })
  const RadialGradientFillSchema = z.strictObject({
    kind: z.literal('radialGradient'),
    stops: fillStops,
    centerX: UnitIntervalSchema.exactOptional(),
    centerY: UnitIntervalSchema.exactOptional(),
  })
  const ImageFillStyleSchema = z.strictObject({
    kind: z.literal('image'),
    assetId: IdSchema,
    fit: FitSchema.exactOptional(),
  })
  const FillStyleSchema = z.discriminatedUnion('kind', [
    LinearGradientFillSchema,
    RadialGradientFillSchema,
    ImageFillStyleSchema,
  ])

  /** The solid + rich fill trio every closed shape carries. */
  const shapeFillShape = {
    fill: color,
    fillAlpha: UnitIntervalSchema.exactOptional(),
    fillStyle: FillStyleSchema.exactOptional(),
  }

  const RectangleObjectSchema = z.strictObject({
    ...baseShape,
    ...strokeShape,
    type: z.literal('rectangle'),
    ...shapeFillShape,
    cornerRadius: CornerRadiusSchema.exactOptional(),
  })

  const EllipseObjectSchema = z.strictObject({
    ...baseShape,
    ...strokeShape,
    type: z.literal('ellipse'),
    ...shapeFillShape,
  })

  const TriangleObjectSchema = z.strictObject({
    ...baseShape,
    ...strokeShape,
    type: z.literal('triangle'),
    ...shapeFillShape,
  })

  const PolygonObjectSchema = z.strictObject({
    ...baseShape,
    ...strokeShape,
    type: z.literal('polygon'),
    ...shapeFillShape,
    sides: PolygonSidesSchema,
  })

  const lineShape = {
    ...baseShape,
    p1: PointSchema,
    p2: PointSchema,
    stroke: color,
    strokeAlpha: UnitIntervalSchema.exactOptional(),
    strokeWidth: NonNegativeNumberSchema,
    startCap: LineCapSchema.exactOptional(),
    endCap: LineCapSchema.exactOptional(),
    dash: z.boolean().exactOptional(),
  }
  const LineObjectSchema = z.strictObject({ ...lineShape, type: z.literal('line') })
  const ArrowObjectSchema = z.strictObject({ ...lineShape, type: z.literal('arrow') })

  const PathObjectSchema = z.strictObject({
    ...baseShape,
    type: z.literal('path'),
    anchors: z.array(PathAnchorSchema),
    stroke: color,
    strokeAlpha: UnitIntervalSchema.exactOptional(),
    strokeWidth: NonNegativeNumberSchema,
    fill: color.exactOptional(),
    fillAlpha: UnitIntervalSchema.exactOptional(),
    fillStyle: FillStyleSchema.exactOptional(),
    closed: z.boolean().exactOptional(),
    dash: z.boolean().exactOptional(),
  })

  const TextObjectSchema = z.strictObject({
    ...baseShape,
    type: z.literal('text'),
    // Plain string on the wire; the slide model promotes it to Y.Text on
    // write. See ./plain.ts for why the schema never models Y.Text.
    text: z.string(),
    fontSize: PositiveNumberSchema,
    fontWeight: FontWeightSchema,
    color,
    colorAlpha: UnitIntervalSchema.exactOptional(),
    align: HorizontalAlignSchema,
    fontFamily: z.string().min(1).exactOptional(),
    vAlign: TextVerticalAlignSchema.exactOptional(),
    // Both are multipliers; 0 would collapse every line onto the first.
    lineHeight: PositiveNumberSchema.exactOptional(),
    lineSpacing: PositiveNumberSchema.exactOptional(),
    wrap: z.literal('none').exactOptional(),
    // Negative tracking is legitimate (tight display type).
    letterSpacing: FiniteNumberSchema.exactOptional(),
    paragraphSpaceBefore: NonNegativeNumberSchema.exactOptional(),
    paragraphSpaceAfter: NonNegativeNumberSchema.exactOptional(),
    textTransform: TextTransformSchema.exactOptional(),
    textStyleId: IdSchema.exactOptional(),
    textStyleOverrides: TextStyleOverridesSchema.exactOptional(),
    italic: z.boolean().exactOptional(),
    underline: z.boolean().exactOptional(),
    listStyle: TextListStyleSchema.exactOptional(),
    stroke: color.exactOptional(),
    strokeAlpha: UnitIntervalSchema.exactOptional(),
    strokeWidth: NonNegativeNumberSchema.exactOptional(),
    isSlideNumber: z.boolean().exactOptional(),
  })

  const ImageObjectSchema = z.strictObject({
    ...baseShape,
    type: z.literal('image'),
    // The type allows '' as an "upload pending" placeholder, but only the
    // upload flow creates that state; nothing at a boundary should.
    assetId: IdSchema,
    variant: z.enum(['thumb', 'display', 'original']).exactOptional(),
    fit: FitSchema.exactOptional(),
    alt: z.string().exactOptional(),
    imageRect: z
      .strictObject({
        x: FiniteNumberSchema,
        y: FiniteNumberSchema,
        width: NonNegativeNumberSchema,
        height: NonNegativeNumberSchema,
      })
      .exactOptional(),
    imageRotation: FiniteNumberSchema.exactOptional(),
    mask: ImageMaskSchema.exactOptional(),
  })

  const VideoObjectSchema = z
    .strictObject({
      ...baseShape,
      type: z.literal('video'),
      assetId: IdSchema,
      fit: FitSchema.exactOptional(),
      autoplay: z.boolean().exactOptional(),
      playOnClick: z.boolean().exactOptional(),
      videoTrigger: z.enum(['onEnter', 'withPrevious', 'afterPrevious', 'onClick']).exactOptional(),
      videoDelay: NonNegativeNumberSchema.exactOptional(),
      loop: z.boolean().exactOptional(),
      muted: z.boolean().exactOptional(),
      volume: UnitIntervalSchema.exactOptional(),
      showControls: z.boolean().exactOptional(),
      posterTime: NonNegativeNumberSchema.exactOptional(),
      trimStart: NonNegativeNumberSchema.exactOptional(),
      trimEnd: NonNegativeNumberSchema.exactOptional(),
      alt: z.string().exactOptional(),
      // The renderer treats '' like "missing"; at the boundary, absence is
      // spelled by leaving the key out (or `null` in a patch).
      posterAssetId: IdSchema.exactOptional(),
    })
    .superRefine((v, ctx) => {
      if (v.trimStart !== undefined && v.trimEnd !== undefined && v.trimEnd <= v.trimStart) {
        ctx.addIssue({
          code: 'custom',
          message: 'trimEnd must be greater than trimStart',
          path: ['trimEnd'],
          input: v.trimEnd,
        })
      }
    })

  const TableBorderStyleSchema = z.strictObject({
    color,
    // 0 is meaningful: "explicitly invisible", overriding the default.
    width: NonNegativeNumberSchema,
    dash: z.enum(['solid', 'dash', 'dot']).exactOptional(),
    alpha: UnitIntervalSchema.exactOptional(),
  })

  const TableCellEdgeBordersSchema = z.strictObject({
    top: TableBorderStyleSchema.exactOptional(),
    right: TableBorderStyleSchema.exactOptional(),
    bottom: TableBorderStyleSchema.exactOptional(),
    left: TableBorderStyleSchema.exactOptional(),
  })

  const TableCellSchema = z.strictObject({
    text: z.string(),
    fontSize: PositiveNumberSchema.exactOptional(),
    fontWeight: FontWeightSchema.exactOptional(),
    italic: z.boolean().exactOptional(),
    underline: z.boolean().exactOptional(),
    lineHeight: PositiveNumberSchema.exactOptional(),
    letterSpacing: FiniteNumberSchema.exactOptional(),
    textTransform: TextTransformSchema.exactOptional(),
    color: color.exactOptional(),
    align: HorizontalAlignSchema.exactOptional(),
    vAlign: TextVerticalAlignSchema.exactOptional(),
    fill: color.exactOptional(),
    fillAlpha: UnitIntervalSchema.exactOptional(),
    fillStyle: FillStyleSchema.exactOptional(),
    border: TableCellEdgeBordersSchema.exactOptional(),
    padding: TableCellPaddingSchema.exactOptional(),
    gridSpan: PositiveIntSchema.exactOptional(),
    rowSpan: PositiveIntSchema.exactOptional(),
    mergeOriginR: NonNegativeIntSchema.exactOptional(),
    mergeOriginC: NonNegativeIntSchema.exactOptional(),
  })

  const TableDefaultsSchema = z.strictObject({
    fontFamily: z.string().min(1).exactOptional(),
    fontSize: PositiveNumberSchema,
    fontWeight: FontWeightSchema,
    italic: z.boolean().exactOptional(),
    underline: z.boolean().exactOptional(),
    lineHeight: PositiveNumberSchema.exactOptional(),
    letterSpacing: FiniteNumberSchema.exactOptional(),
    textTransform: TextTransformSchema.exactOptional(),
    paragraphSpaceBefore: NonNegativeNumberSchema.exactOptional(),
    paragraphSpaceAfter: NonNegativeNumberSchema.exactOptional(),
    textStyleId: IdSchema.exactOptional(),
    textStyleOverrides: TextStyleOverridesSchema.exactOptional(),
    color,
    align: HorizontalAlignSchema,
    vAlign: TextVerticalAlignSchema,
    fill: color.exactOptional(),
    fillAlpha: UnitIntervalSchema.exactOptional(),
    fillStyle: FillStyleSchema.exactOptional(),
    border: TableBorderStyleSchema.exactOptional(),
    padding: TableCellPaddingSchema,
  })

  const TableObjectSchema = z
    .strictObject({
      ...baseShape,
      type: z.literal('table'),
      // Tracks are proportions: the renderer rescales `colWidths` /
      // `rowHeights` to the table's width / height (see
      // `setTableColWidth`), so their sum need not equal it — but a zero
      // track cannot be rescaled, and slide-model clamps to >= 1 itself.
      colWidths: z.array(PositiveNumberSchema).min(1),
      rowHeights: z.array(PositiveNumberSchema).min(1),
      rows: z.array(z.array(TableCellSchema)),
      defaults: TableDefaultsSchema,
      borderSegments: z
        .record(
          z.string().regex(BORDER_SEGMENT_KEY_PATTERN, {
            message: 'Expected a segment key "h:<row>:<col>" or "v:<row>:<col>"',
          }),
          TableBorderStyleSchema,
        )
        .exactOptional(),
    })
    .superRefine((t, ctx) => checkTableGrid(t, ctx))

  const SlideObjectSchema = z.discriminatedUnion('type', [
    RectangleObjectSchema,
    EllipseObjectSchema,
    TriangleObjectSchema,
    PolygonObjectSchema,
    LineObjectSchema,
    ArrowObjectSchema,
    PathObjectSchema,
    TextObjectSchema,
    ImageObjectSchema,
    VideoObjectSchema,
    TableObjectSchema,
  ])

  /** Per-type lookup; `satisfies` makes a missing variant a compile error. */
  const byType = {
    rectangle: RectangleObjectSchema,
    ellipse: EllipseObjectSchema,
    triangle: TriangleObjectSchema,
    polygon: PolygonObjectSchema,
    line: LineObjectSchema,
    arrow: ArrowObjectSchema,
    path: PathObjectSchema,
    text: TextObjectSchema,
    image: ImageObjectSchema,
    video: VideoObjectSchema,
    table: TableObjectSchema,
  } as const satisfies Record<SlideObjectType, z.ZodObject>

  return {
    ShadowStyleSchema,
    BaseSlideObjectSchema,
    StrokeStyleFieldsSchema,
    FillGradientStopSchema,
    LinearGradientFillSchema,
    RadialGradientFillSchema,
    ImageFillStyleSchema,
    FillStyleSchema,
    RectangleObjectSchema,
    EllipseObjectSchema,
    TriangleObjectSchema,
    PolygonObjectSchema,
    LineObjectSchema,
    ArrowObjectSchema,
    PathObjectSchema,
    TextObjectSchema,
    ImageObjectSchema,
    VideoObjectSchema,
    TableBorderStyleSchema,
    TableCellEdgeBordersSchema,
    TableCellSchema,
    TableDefaultsSchema,
    TableObjectSchema,
    SlideObjectSchema,
    byType,
  }
}

/**
 * Structural invariants of a table grid that the per-field schemas cannot
 * see. Each one guards an index the renderer dereferences without a check
 * (`tableRenderer.ts` walks `table.rows[r]!` for every `rowHeights` entry
 * and `colWidths.length` columns per row).
 */
function checkTableGrid(
  t: {
    colWidths: number[]
    rowHeights: number[]
    rows: Array<
      Array<{ gridSpan?: number; rowSpan?: number; mergeOriginR?: number; mergeOriginC?: number }>
    >
    borderSegments?: Record<string, unknown>
  },
  ctx: z.RefinementCtx,
): void {
  const R = t.rowHeights.length
  const C = t.colWidths.length
  if (t.rows.length !== R) {
    ctx.addIssue({
      code: 'custom',
      message: `rows has ${t.rows.length} rows but rowHeights has ${R}`,
      path: ['rows'],
      input: t.rows,
    })
    return
  }
  t.rows.forEach((row, r) => {
    if (row.length !== C) {
      ctx.addIssue({
        code: 'custom',
        message: `row ${r} has ${row.length} cells but colWidths has ${C}`,
        path: ['rows', r],
        input: row,
      })
      return
    }
    row.forEach((cell, c) => {
      const at = ['rows', r, c]
      if (cell.gridSpan !== undefined && c + cell.gridSpan > C) {
        ctx.addIssue({
          code: 'custom',
          message: `gridSpan ${cell.gridSpan} runs past the last column`,
          path: [...at, 'gridSpan'],
          input: cell.gridSpan,
        })
      }
      if (cell.rowSpan !== undefined && r + cell.rowSpan > R) {
        ctx.addIssue({
          code: 'custom',
          message: `rowSpan ${cell.rowSpan} runs past the last row`,
          path: [...at, 'rowSpan'],
          input: cell.rowSpan,
        })
      }
      // A merge pointer names an origin cell at or before itself.
      if (cell.mergeOriginR !== undefined && cell.mergeOriginR > r) {
        ctx.addIssue({
          code: 'custom',
          message: 'mergeOriginR must point at this row or an earlier one',
          path: [...at, 'mergeOriginR'],
          input: cell.mergeOriginR,
        })
      }
      if (cell.mergeOriginC !== undefined && cell.mergeOriginC > c) {
        ctx.addIssue({
          code: 'custom',
          message: 'mergeOriginC must point at this column or an earlier one',
          path: [...at, 'mergeOriginC'],
          input: cell.mergeOriginC,
        })
      }
    })
  })
  for (const key of Object.keys(t.borderSegments ?? {})) {
    const m = BORDER_SEGMENT_KEY_PATTERN.exec(key)
    if (m === null) continue // already reported by the key schema
    const orient = m[1]
    const row = Number(m[2])
    const col = Number(m[3])
    // Horizontal lines run 0..R (R = bottom rim) across C columns;
    // vertical lines run 0..C (C = right rim) down R rows.
    const inBounds = orient === 'h' ? row <= R && col < C : row < R && col <= C
    if (!inBounds) {
      ctx.addIssue({
        code: 'custom',
        message: `border segment ${key} lies outside a ${R}x${C} grid`,
        path: ['borderSegments', key],
        input: key,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

const storage = buildObjectSchemas(ColorValueSchema, ColorIntSchema)

/**
 * The agent-input variant: identical shapes and constraints, but every
 * colour slot also accepts hex strings. Consumed by ./input.ts; not part of
 * the public surface on its own.
 */
export const inputObjectSchemas = buildObjectSchemas(ColorInputSchema, RgbInputSchema)

export const ShadowStyleSchema = storage.ShadowStyleSchema
export const BaseSlideObjectSchema = storage.BaseSlideObjectSchema
export const StrokeStyleFieldsSchema = storage.StrokeStyleFieldsSchema
export const FillGradientStopSchema = storage.FillGradientStopSchema
export const LinearGradientFillSchema = storage.LinearGradientFillSchema
export const RadialGradientFillSchema = storage.RadialGradientFillSchema
export const ImageFillStyleSchema = storage.ImageFillStyleSchema
export const FillStyleSchema = storage.FillStyleSchema
export const RectangleObjectSchema = storage.RectangleObjectSchema
export const EllipseObjectSchema = storage.EllipseObjectSchema
export const TriangleObjectSchema = storage.TriangleObjectSchema
export const PolygonObjectSchema = storage.PolygonObjectSchema
export const LineObjectSchema = storage.LineObjectSchema
export const ArrowObjectSchema = storage.ArrowObjectSchema
export const PathObjectSchema = storage.PathObjectSchema
export const TextObjectSchema = storage.TextObjectSchema
export const ImageObjectSchema = storage.ImageObjectSchema
export const VideoObjectSchema = storage.VideoObjectSchema
export const TableBorderStyleSchema = storage.TableBorderStyleSchema
export const TableCellEdgeBordersSchema = storage.TableCellEdgeBordersSchema
export const TableCellSchema = storage.TableCellSchema
export const TableDefaultsSchema = storage.TableDefaultsSchema
export const TableObjectSchema = storage.TableObjectSchema

/** Every SlideObject variant, discriminated on `type`. */
export const SlideObjectSchema = storage.SlideObjectSchema

/** Storage schema of each object type, keyed by `type`. */
export type SlideObjectSchemas = typeof storage.byType

/** The storage schema for one object type. */
export function slideObjectSchemaFor<T extends SlideObjectType>(type: T): SlideObjectSchemas[T] {
  return storage.byType[type]
}
