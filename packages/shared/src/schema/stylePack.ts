/**
 * shared/src/schema/stylePack.ts — a style pack (agentic A4.3): a client's
 * brand as Narrative's own building blocks, the shape of
 * docs/plans/a4-style-pack-schema.md §1 with the decisions of §6.
 *
 * Shape only. The cross-references (a region's text style exists, every
 * colour role a layout uses is covered by an axis, …) are
 * `validateStylePack` (./stylePackValidate.ts): zod checks each field,
 * that one checks the pack as a whole.
 *
 * Units: px on the 1920×1080 canvas for sizes, insets, indents and grid
 * lines; canvas fractions for layout rects. Ids are lowercase kebab
 * (`contoso-2026`, `title-52`); slot names and roles are A4.1's.
 */

import { z } from 'zod'
import { ListNumberFormatSchema, ObjectRoleSchema, SlotNameSchema } from './objects.js'

/** A pack id, layout id, style id, …: lowercase kebab, at most 48 characters. */
export const PackIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens, starting with a letter')
  .max(48)

const Px = z.number().finite().min(-10_000).max(10_000)
const PositivePx = z.number().finite().positive().max(10_000)
const NonNegPx = z.number().finite().min(0).max(10_000)

/** [x, y, w, h] as fractions of the canvas (4 decimals ≈ 0.19 px). */
export const PackRectSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
])

/** The colour roles a pack resolves per variant and surface — a fixed vocabulary, so a restyle maps accent to accent. */
export const COLOR_ROLES = [
  'background',
  'surface',
  'text',
  'textSecondary',
  'textMuted',
  'line',
  'accent',
  'onAccent',
] as const
export const ColorRoleSchema = z.enum(COLOR_ROLES)
export type ColorRole = z.infer<typeof ColorRoleSchema>

/**
 * A colour in a pack: `role:text` (a colour role, resolved per variant and
 * surface), `color:dark-blue` (a pack colour), or a literal `#RRGGBB` /
 * `#RRGGBBAA`.
 */
export const ColorRefSchema = z
  .string()
  .regex(
    /^(role:(background|surface|text|textSecondary|textMuted|line|accent|onAccent)|color:[a-z][a-z0-9-]*|#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?)$/,
    'role:<role>, color:<id> or #RRGGBB[AA]',
  )
export type ColorRef = z.infer<typeof ColorRefSchema>

const HexSchema = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, '#RRGGBB or #RRGGBBAA')
const LangSchema = z.string().regex(/^[a-z]{2}$/, 'a two-letter language code')
const RolesSchema = z.partialRecord(ColorRoleSchema, ColorRefSchema)

// ---------------------------------------------------------------------------
// 1.1 Tokens, variants, surfaces, chart palette
// ---------------------------------------------------------------------------

export const PackAxisSchema = z.strictObject({
  id: PackIdSchema,
  name: z.string().min(1).max(80),
  default: PackIdSchema,
  values: z
    .array(
      z.strictObject({
        id: PackIdSchema,
        name: z.string().min(1).max(80),
        /** The roles this axis governs; each role is governed by exactly one axis. */
        roles: RolesSchema,
        /** Woodgrove "best on": a warning, not a rule. */
        recommendedWith: z.record(PackIdSchema, z.array(PackIdSchema)).optional(),
      }),
    )
    .min(1)
    .max(32),
})

export const PackTokensSchema = z.strictObject({
  colors: z.record(
    PackIdSchema,
    z.strictObject({
      name: z.string().min(1).max(80),
      value: HexSchema,
      group: z.enum(['primary', 'secondary', 'accent', 'neutral', 'status']).optional(),
    }),
  ),
  axes: z.array(PackAxisSchema).min(1).max(4),
  surfaces: z
    .record(PackIdSchema, z.strictObject({ name: z.string().min(1).max(80), roles: RolesSchema }))
    .optional(),
  chart: z.strictObject({
    series: z.array(ColorRefSchema).max(24),
    highlight: ColorRefSchema.optional(),
    grid: ColorRefSchema.optional(),
    axis: ColorRefSchema.optional(),
    label: ColorRefSchema.optional(),
  }),
})

// ---------------------------------------------------------------------------
// 1.2 Fonts, 1.3 text styles
// ---------------------------------------------------------------------------

const Weight = z.number().int().min(100).max(900)
const Stretch = z.number().min(50).max(200)
const Range = z.tuple([z.number(), z.number()])

export const PackFontFaceSchema = z.strictObject({
  family: z.string().min(1).max(200),
  weight: Weight,
  stretch: Stretch.optional(),
  fallbacks: z.array(z.string().min(1).max(80)).max(8),
  /** Every brand ships real bold cuts: faux bold is a brand break. */
  synthesizeBold: z.literal(false),
  requires: z
    .strictObject({
      postscriptName: z.string().min(1).max(200).optional(),
      axes: z.strictObject({ wght: Range.optional(), wdth: Range.optional() }).optional(),
    })
    .optional(),
})

export const PackListLevelSchema = z.strictObject({
  list: z.enum(['bullet', 'number', 'none']),
  bullet: z
    .strictObject({
      glyph: z.string().min(1).max(4),
      color: ColorRefSchema.optional(),
      scale: z.number().positive().max(4).optional(),
    })
    .optional(),
  numberFormat: ListNumberFormatSchema.optional(),
  indent: NonNegPx,
  hanging: NonNegPx,
  spaceBefore: NonNegPx.optional(),
  font: PackIdSchema.optional(),
  size: PositivePx.optional(),
  weight: Weight.optional(),
  color: ColorRefSchema.optional(),
  lineSpacing: z.number().positive().max(10).optional(),
})

export const PackTextStyleSchema = z.strictObject({
  name: z.string().min(1).max(80),
  font: PackIdSchema,
  size: PositivePx,
  /** The floor of autofit "shrink" (A4.2a). */
  minSize: PositivePx.optional(),
  weight: Weight.optional(),
  stretch: Stretch.optional(),
  /** CSS, × font size (Woodgrove). Exclusive with lineSpacing. */
  lineHeight: z.number().positive().max(10).optional(),
  /** PowerPoint, × the font's normal line (Contoso 0.9, Fabrikam 1.1). */
  lineSpacing: z.number().positive().max(10).optional(),
  letterSpacing: Px.optional(),
  color: ColorRefSchema,
  textTransform: z.literal('uppercase').optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  spaceBefore: NonNegPx.optional(),
  spaceAfter: NonNegPx.optional(),
  /** levels[i] applies to paragraphs at level i (0..8). */
  levels: z.array(PackListLevelSchema).max(9).optional(),
})

// ---------------------------------------------------------------------------
// 1.4 Grid, 1.5 furniture and assets
// ---------------------------------------------------------------------------

export const PackGridSchema = z.strictObject({
  margins: z.strictObject({ left: NonNegPx, right: NonNegPx, top: NonNegPx, bottom: NonNegPx }),
  columns: z.array(z.tuple([Px, Px])).max(24),
  halves: z
    .array(z.tuple([Px, Px]))
    .max(4)
    .optional(),
  gutter: NonNegPx,
  bands: z.strictObject({
    title: Px,
    subtitle: Px.optional(),
    content: Px,
    footer: Px,
  }),
})

const FieldSchema = z.strictObject({
  required: z.boolean().optional(),
  default: z.string().max(200).optional(),
  sentinel: z.string().max(200).optional(),
})

export const FurnitureItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    rect: PackRectSchema,
    textStyle: PackIdSchema,
    /** 'Page {page} | {client}'; or one per language. */
    template: z.union([z.string().max(400), z.record(LangSchema, z.string().max(400))]),
    fields: z.record(PackIdSchema, FieldSchema).optional(),
  }),
  z.strictObject({ kind: z.literal('pageNumber'), component: PackIdSchema }),
  z.strictObject({ kind: z.literal('image'), rect: PackRectSchema, asset: PackIdSchema }),
  z.strictObject({
    kind: z.literal('rule'),
    rect: PackRectSchema,
    color: ColorRefSchema,
    width: PositivePx,
  }),
  z.strictObject({
    kind: z.literal('shape'),
    shape: z.enum(['ellipse', 'rect']),
    rect: PackRectSchema,
    fill: z
      .union([
        ColorRefSchema,
        z.strictObject({
          radial: z
            .array(z.strictObject({ offset: z.number().min(0).max(1), color: ColorRefSchema }))
            .min(2)
            .max(10),
          center: z.tuple([z.number(), z.number()]),
        }),
      ])
      .optional(),
    stroke: z.strictObject({ color: ColorRefSchema, width: PositivePx }).optional(),
    radius: NonNegPx.optional(),
  }),
])
export type FurnitureItem = z.infer<typeof FurnitureItemSchema>

export const PackFurnitureSchema = z.strictObject({
  defaultSet: z.array(PackIdSchema).max(32),
  items: z.record(PackIdSchema, FurnitureItemSchema),
})

const AssetSourceSchema = z.union([
  z.strictObject({ assetId: z.string().min(1).max(64) }),
  /** A private overlay path, before the bootstrap uploads it. */
  z.strictObject({ file: z.string().min(1).max(400) }),
])

export const PackAssetSchema = z.strictObject({
  name: z.string().min(1).max(80),
  /** Per value of a role: a logo in dark blue on light backgrounds, white on dark ones. */
  byRole: z
    .strictObject({
      role: ColorRoleSchema,
      /** Keyed by the colour the role takes where the file is drawn (`color:white`). */
      files: z.record(ColorRefSchema, AssetSourceSchema),
    })
    .optional(),
  file: AssetSourceSchema.optional(),
})

// ---------------------------------------------------------------------------
// 1.6 Layouts and regions, 1.7 components
// ---------------------------------------------------------------------------

export const PackRegionSchema = z.strictObject({
  slot: SlotNameSchema,
  role: ObjectRoleSchema,
  type: z.enum(['text', 'image', 'chart', 'table']),
  rect: PackRectSchema,
  /** 1-based: which repeated item (a column, a card, an agenda row). */
  item: z.number().int().min(1).max(50).optional(),
  textStyle: PackIdSchema.optional(),
  component: PackIdSchema.optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  anchor: z.enum(['top', 'middle', 'bottom']).optional(),
  autofit: z.enum(['grow-down', 'fixed', 'shrink']).optional(),
  insets: z.tuple([NonNegPx, NonNegPx, NonNegPx, NonNegPx]).optional(),
  aspect: z.number().positive().max(20).optional(),
  focus: z.enum(['center', 'top', 'bottom', 'left', 'right']).optional(),
  maxLines: z.number().int().min(1).max(100).optional(),
  maxChars: z.number().int().min(1).max(10_000).optional(),
  required: z.boolean().optional(),
  fillOrder: z.number().int().min(1).max(100).optional(),
})
export type PackRegion = z.infer<typeof PackRegionSchema>

export const PackLayoutSchema = z.strictObject({
  id: PackIdSchema,
  name: z.string().min(1).max(120),
  /** Master names for lookup: 'Titel und Bulletpoints'. */
  aliases: z.array(z.string().min(1).max(120)).max(16).optional(),
  /** Groups layouts in pickers; else the id. */
  family: PackIdSchema,
  /** One sentence a model reads to pick it. */
  purpose: z.string().min(1).max(400),
  surface: z
    .union([
      z.strictObject({ fixed: PackIdSchema }),
      z.strictObject({ choose: z.array(PackIdSchema).min(1).max(8), default: PackIdSchema }),
    ])
    .optional(),
  background: ColorRefSchema.optional(),
  regions: z.array(PackRegionSchema).max(64),
  items: z
    .strictObject({
      count: z.number().int().min(1).max(50),
      emphasis: z
        .strictObject({ color: ColorRefSchema, others: ColorRefSchema.optional() })
        .optional(),
    })
    .optional(),
  /** Replaces the pack's defaultSet. */
  furniture: z.array(PackIdSchema).max(32).optional(),
  /** Layout-only furniture: title lines, card rules. */
  decor: z.array(FurnitureItemSchema).max(64).optional(),
})
export type PackLayout = z.infer<typeof PackLayoutSchema>

export const PackComponentSchema = z.strictObject({
  id: PackIdSchema,
  kind: z.enum(['pagination', 'headline', 'subline', 'copy', 'divider', 'grid', 'label']),
  name: z.string().min(1).max(80),
  /** Objects relative to the component's origin, px; they become the folder master. */
  objects: z
    .array(
      z.strictObject({
        slot: SlotNameSchema,
        role: ObjectRoleSchema,
        type: z.enum(['text', 'shape', 'image']),
        rect: z.tuple([Px, Px, NonNegPx, NonNegPx]),
        textStyle: PackIdSchema.optional(),
        fill: ColorRefSchema.optional(),
        stroke: z.strictObject({ color: ColorRefSchema, width: PositivePx }).optional(),
        /** A shape's corner radius (a pill: half its height). */
        radius: NonNegPx.optional(),
        autofit: z.enum(['grow-down', 'fixed']).optional(),
        isSlideNumber: z.literal(true).optional(),
        text: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(32),
})
export type PackComponent = z.infer<typeof PackComponentSchema>

// ---------------------------------------------------------------------------
// 1.8 Imagery, editorial, QA, archetypes, provenance
// ---------------------------------------------------------------------------

export const PackImagerySchema = z.strictObject({
  pool: z
    .strictObject({
      kind: z.literal('drive'),
      path: z.string().min(1).max(400),
      count: z.number().int().min(0).optional(),
    })
    .optional(),
  rights: z.string().max(400).optional(),
  minDpi: z.number().positive().max(1200).optional(),
  defaultFocus: z.enum(['center', 'top', 'bottom', 'left', 'right']).optional(),
  scrims: z.boolean(),
  aiLabel: z
    .strictObject({
      required: z.literal(true),
      since: z.string().max(40),
      corner: z.literal('top-right'),
      spacer: z.strictObject({ cover: NonNegPx, content: NonNegPx }),
    })
    .optional(),
})

export const PackEditorialSchema = z.strictObject({
  titleMode: z.enum(['action-title', 'label+message']),
  title: z.strictObject({
    maxWords: z.number().int().min(1).max(100).optional(),
    maxLines: z.number().int().min(1).max(20).optional(),
    trailingPeriod: z.enum(['forbid', 'allow']),
  }),
  allCaps: z.enum(['forbid', 'styles-only']),
  italics: z.literal('forbid'),
  underline: z.literal('forbid').optional(),
  accentBudget: z
    .strictObject({ color: ColorRefSchema, perSlide: z.number().int().min(0).max(20) })
    .optional(),
  eyebrows: z.enum(['none', 'minimal', 'furniture']),
  minBodySize: PositivePx.optional(),
  recommendedBodySize: PositivePx.optional(),
  typography: z.strictObject({
    quotes: z.enum(['de', 'en']),
    enDashRanges: z.boolean(),
    emDash: z.enum(['allow', 'sparingly', 'forbid']),
    nbspBeforeUnits: z.boolean(),
    ellipsis: z.boolean(),
    emoji: z.literal('forbid'),
  }),
  replace: z
    .array(
      z.strictObject({
        pattern: z.string().min(1).max(200),
        with: z.string().max(200).optional(),
        level: z.enum(['error', 'warn']),
        note: z.string().max(400).optional(),
      }),
    )
    .max(100)
    .optional(),
  register: z.enum(['du', 'Sie', 'audience']).optional(),
  languages: z.array(LangSchema).min(1).max(8),
  bilingual: z
    .strictObject({ marker: z.literal('{de|en}'), order: z.array(LangSchema).min(2).max(2) })
    .optional(),
  voice: z.array(z.string().min(1).max(400)).max(50).optional(),
})

export const QA_RULE_IDS = [
  'fit',
  'partial-overlap',
  'outside-grid',
  'text-color',
  'variant-mix',
  'furniture',
  'sentinel',
  'missing-picture',
  'caps',
  'italics',
  'bullet-glyph',
  'title-period',
  'accent-budget',
  'typography',
  'emoji',
  'font-missing',
] as const
export const QaRuleIdSchema = z.enum(QA_RULE_IDS)
export type QaRuleId = z.infer<typeof QaRuleIdSchema>

export const PackQaSchema = z.strictObject({
  fit: z.strictObject({
    slackLines: z.number().min(0).max(10),
    growWarnRatio: z.number().positive().max(20).optional(),
  }),
  textColors: z.array(ColorRefSchema).max(32),
  oneVariantPerDeck: z.boolean(),
  requiredFurniture: z.array(PackIdSchema).max(32),
  sentinels: z.array(z.string().min(1).max(200)).max(50),
  rules: z.partialRecord(QaRuleIdSchema, z.enum(['error', 'warn', 'off'])).optional(),
})

export const ARCHETYPES = [
  'cover',
  'agenda',
  'divider',
  'statement',
  'content',
  'comparison',
  'process',
  'evidence',
  'decision',
  'picture',
  'closer',
  'contact',
] as const
export const ArchetypeSchema = z.enum(ARCHETYPES)

export const PackProvenanceSchema = z.strictObject({
  bootstrap: z.strictObject({
    tool: z.string().min(1).max(200),
    version: z.string().min(1).max(40),
    at: z.string().min(1).max(40),
  }),
  sources: z
    .array(
      z.strictObject({
        repo: z.string().min(1).max(200),
        commit: z.string().min(1).max(64),
        path: z.string().min(1).max(400),
      }),
    )
    .max(50),
  calls: z
    .array(
      z.strictObject({
        topic: z.string().min(1).max(200),
        decision: z.string().min(1).max(1000),
        why: z.string().max(1000).optional(),
      }),
    )
    .max(200),
  derivedFrom: z.strictObject({ packId: PackIdSchema, at: z.string().max(40) }).optional(),
})

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

/** Most layouts a pack holds (§3.10). */
export const MAX_PACK_LAYOUTS = 200
/** Largest pack, encoded as JSON (§3.10, §4). */
export const MAX_PACK_BYTES = 256 * 1024

export const StylePackSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: PackIdSchema,
  name: z.string().min(1).max(120),
  canvas: z.strictObject({ width: z.literal(1920), height: z.literal(1080) }),
  tokens: PackTokensSchema,
  /** 'head' and 'text' are required (validateStylePack). */
  fonts: z.record(PackIdSchema, PackFontFaceSchema),
  textStyles: z.record(PackIdSchema, PackTextStyleSchema),
  grid: PackGridSchema,
  furniture: PackFurnitureSchema,
  assets: z.record(PackIdSchema, PackAssetSchema),
  layouts: z.array(PackLayoutSchema).max(MAX_PACK_LAYOUTS),
  components: z.array(PackComponentSchema).max(64),
  imagery: PackImagerySchema.optional(),
  editorial: PackEditorialSchema,
  qa: PackQaSchema,
  /** Layout ids per archetype, preferred first. */
  archetypeMap: z.partialRecord(ArchetypeSchema, z.array(PackIdSchema).max(20)),
  provenance: PackProvenanceSchema,
})
export type StylePack = z.infer<typeof StylePackSchema>
export type PackTextStyle = z.infer<typeof PackTextStyleSchema>
export type PackListLevel = z.infer<typeof PackListLevelSchema>
export type PackFontFace = z.infer<typeof PackFontFaceSchema>
export type PackAxis = z.infer<typeof PackAxisSchema>
