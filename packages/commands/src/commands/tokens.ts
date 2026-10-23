/**
 * commands/src/commands/tokens.ts — `token.*`: a folder's design tokens
 * (colours, text styles, effect styles), backed by the server's
 * TokenService (apps/server/src/services/tokens.ts), which reads and writes
 * the folder document (`folder:<id>`, slide-model folderDoc.ts).
 *
 * Changing a token reaches the text linked to it in every deck and
 * component master of the folder (server-side, whether or not anyone has
 * them open) — that used to be a browser effect of an open deck. The Folder
 * Settings page and the Inspector's preset actions reach the same service
 * through the routes the commands claim (apps/server routes/tokens.ts).
 */

import { z } from 'zod'
import {
  FiniteNumberSchema,
  ListNumberFormatSchema,
  NonNegativeNumberSchema,
  PositiveNumberSchema,
  RgbInputSchema,
} from '@narrative/shared'
import { MAX_COLORS } from '@narrative/slide-model'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import type { EditableTokenCategory } from '../services/tokens.js'
import { hexOf } from '../text/textStyle.js'
import {
  DELETE,
  GET,
  IdSchema,
  PATCH,
  POST,
  serverCommand,
  targetFolderId,
} from './serverShared.js'

/** A folder's tokens: members read them, editors change them (folder sharing). */
const folderToken = {
  ...serverCommand,
  domain: 'token',
  scope: 'folder',
  effects: ['server'],
  confirm: 'never',
} as const
const tokenEditor = { ...folderToken, role: 'editor' } as const
const tokenReader = { ...folderToken, role: 'viewer' } as const

const CategorySchema = z.enum(['colors', 'textStyles', 'effectStyles']).describe('Token category')
const TokenNameSchema = z.string().trim().min(1).max(80)
/** Characters that would end a CSS declaration or markup where a family name is written. */
const UNSAFE_FAMILY = /[;{}<>\\\u0000-\u001f\u007f]/
/** A colour as tokens store it: '#rrggbb' (input also 0xRRGGBB or '#RGB'). */
const HexSchema = RgbInputSchema.transform(hexOf).describe('"#RRGGBB"')
const WEIGHT = z.number().int().min(100).max(900).multipleOf(100)

/** A colour as a style stores it: '#rrggbb' or one of the folder colours. */
const StyleColorSchema = z
  .union([HexSchema, z.strictObject({ $token: z.string().regex(/^colors\.[A-Za-z0-9_-]+$/) })])
  .describe('"#RRGGBB" or one of the folder colours, { "$token": "colors.<id>" }')

/** One nesting level of a text style (A4.2b): what its paragraphs default to. */
const StyleLevelSchema = z.strictObject({
  list: z.enum(['bullet', 'number', 'none']).optional(),
  bulletChar: z.string().min(1).max(4).optional(),
  bulletColor: StyleColorSchema.optional(),
  bulletScale: PositiveNumberSchema.max(4).optional(),
  numberFormat: ListNumberFormatSchema.optional(),
  indent: NonNegativeNumberSchema.max(1920).optional(),
  hanging: NonNegativeNumberSchema.max(1920).optional(),
  spaceBefore: NonNegativeNumberSchema.max(1000).optional(),
  fontFamily: z.string().trim().min(1).max(200).optional(),
  fontWeight: WEIGHT.optional(),
  fontSize: PositiveNumberSchema.max(2000).optional(),
  color: StyleColorSchema.optional(),
  lineSpacing: PositiveNumberSchema.max(10).optional(),
})

/** Text-style fields, as stored; each optional (a style may leave one to the box). */
const textStyleShape = {
  family: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (v) => !UNSAFE_FAMILY.test(v),
      'a family name may not contain ; { } < > \\ or control characters',
    )
    .describe('Font family, e.g. "Inter"'),
  weight: WEIGHT,
  size: PositiveNumberSchema.max(2000).describe('px'),
  minSize: PositiveNumberSchema.max(2000).describe(
    'px: the smallest size a box of this style shrinks its type to (autofit "shrink")',
  ),
  fontStretch: z.number().min(50).max(200).describe('Width, % of normal (variable fonts)'),
  lineHeight: PositiveNumberSchema.max(10).describe('Multiple of the size'),
  lineSpacing: PositiveNumberSchema.max(10).describe(
    "PowerPoint's: multiple of the font's normal line; not with lineHeight",
  ),
  align: z.enum(['left', 'center', 'right']),
  letterSpacing: FiniteNumberSchema.min(-100).max(100),
  paragraphSpaceBefore: NonNegativeNumberSchema.max(1000),
  paragraphSpaceAfter: NonNegativeNumberSchema.max(1000),
  color: StyleColorSchema,
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']),
  levels: z
    .array(StyleLevelSchema)
    .max(9)
    .describe('Per paragraph level (0 = top): defaults its paragraphs take; indent/hanging in px'),
}

function optional<T extends Record<string, z.ZodType>>(shape: T) {
  return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof T]: z.ZodOptional<T[K]>
  }
}

/** Optional and clearable: `null` removes the field from the token. */
function clearable<T extends Record<string, z.ZodType>>(shape: T) {
  const out = Object.fromEntries(
    Object.entries(shape).map(([k, v]) => [
      k,
      v
        .nullable()
        .transform((x: unknown) => (x === null ? undefined : x))
        .optional(),
    ]),
  )
  return out as unknown as {
    [K in keyof T]: z.ZodOptional<z.ZodType<z.output<T[K]> | undefined, z.input<T[K]> | null>>
  }
}

const TokenIdSchema = IdSchema.describe('Token id within its category (token.list lists them)')

/** The categories agents and the page create and change (nothing applies an effect style yet). */

/** A colour token's value: '#RRGGBB', or '#RRGGBBAA' with alpha (A4.2d); stored lowercase. */
const ColorValueSchema = z
  .union([
    z
      .string()
      .regex(/^#[0-9a-fA-F]{8}$/)
      .transform((v) => v.toLowerCase()),
    HexSchema,
  ])
  .describe('"#RRGGBB" or "#RRGGBBAA"')
/** Values per deck variant on one axis (A4.2d): { axis, values: { <variant value>: colour } }. */
const ByVariantSchema = z.strictObject({
  axis: z.string().min(1).max(48),
  values: z.record(z.string().min(1).max(48), ColorValueSchema),
})
const BySurfaceSchema = z.record(z.string().min(1).max(48), ColorValueSchema)

const NewColor = z.strictObject({
  name: TokenNameSchema,
  value: ColorValueSchema,
  byVariant: ByVariantSchema.optional(),
  bySurface: BySurfaceSchema.optional(),
})
const NewTextStyle = z.strictObject({ name: TokenNameSchema, ...optional(textStyleShape) })
const ColorPatch = z.strictObject({
  name: TokenNameSchema.optional(),
  value: ColorValueSchema.optional(),
  ...clearable({ byVariant: ByVariantSchema, bySurface: BySurfaceSchema }),
})
const TextStylePatch = z.strictObject({
  name: TokenNameSchema.optional(),
  ...clearable(textStyleShape),
})

/** A token's fields refused by its schema; `issues` name them. */
export class InvalidTokenFields extends Error {
  constructor(readonly issues: ReadonlyArray<{ path: string[]; message: string }>) {
    super(issues.map((i) => `${i.path.join('.') || 'token'}: ${i.message}`).join('; '))
    this.name = 'InvalidTokenFields'
  }
}

function issuesOf(error: z.ZodError): Array<{ path: string[]; message: string }> {
  return error.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
}

/**
 * A new token's fields as they are stored (normalised: `#ABC` → `#aabbcc`).
 * Every writer goes through this — the commands, the page's route and the
 * server's own callers (a style made from a text box). Throws
 * {@link InvalidTokenFields}.
 */
export function parseNewTokenFields(
  category: EditableTokenCategory,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = (category === 'colors' ? NewColor : NewTextStyle).safeParse(fields)
  if (!parsed.success) throw new InvalidTokenFields(issuesOf(parsed.error))
  return Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined))
}

/**
 * A change to a token as it is stored: normalised, and `null` or
 * `undefined` (removal) kept as `undefined` under its key. Only optional
 * text-style fields can be removed. Throws {@link InvalidTokenFields}.
 */
export function parseTokenPatch(
  category: EditableTokenCategory,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const raw = Object.fromEntries(
    Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v]),
  )
  const parsed = (category === 'colors' ? ColorPatch : TextStylePatch).safeParse(raw)
  // Only optional fields can be removed: a colour's name and value cannot.
  if (!parsed.success) throw new InvalidTokenFields(issuesOf(parsed.error))
  const out: Record<string, unknown> = { ...parsed.data }
  for (const [k, v] of Object.entries(raw)) if (v === null) out[k] = undefined
  return out
}

/** The values a change replaced, `null` for a field that was not set — `token.update` them back to undo. */
const PreviousSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'The changed fields as they were (null = not set); token.update with them undoes the change',
  )

export const tokenUsages = defineCommand({
  ...serverCommand,
  id: 'token.usages',
  domain: 'token',
  title: 'Where a token is used',
  description:
    "Every place that uses one of the folder's design tokens: objects and text runs on each deck slide (deck, " +
    'slide index, object, field), component masters, and for a colour the text styles using it. Check it ' +
    'before changing or deleting a token. Reads the saved documents: edits of the last few seconds may be ' +
    'missing. Any folder member.',
  input: z.strictObject({
    category: z.enum(['colors', 'textStyles', 'effectStyles']).describe('Token category'),
    tokenId: IdSchema.describe('Token id within the category'),
  }),
  output: z.object({
    usages: z.array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('deck'),
          deckId: z.string(),
          deckTitle: z.string(),
          slideIndex: z.number(),
          objectId: z.string().optional(),
          field: z.string(),
        }),
        z.object({
          kind: z.literal('component'),
          componentId: z.string(),
          componentName: z.string(),
          objectId: z.string().optional(),
          field: z.string(),
        }),
        z.object({
          kind: z.literal('textStyle'),
          styleId: z.string(),
          styleName: z.string(),
          field: z.literal('color'),
        }),
      ]),
    ),
  }),
  role: 'viewer',
  scope: 'folder',
  effects: ['server'],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/folders/:folderId/tokens/:category/:tokenId/usages')],
  examples: [
    {
      title: 'Where is the brand colour used?',
      input: { category: 'colors', tokenId: 'brandBlue' },
    },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).tokens.usages({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      category: input.category,
      tokenId: input.tokenId,
    })
  },
})

// ---------------------------------------------------------------------------
// token.create / token.update / token.delete / token.seedDefaults
// ---------------------------------------------------------------------------

export const tokenCreate = defineCommand({
  ...tokenEditor,
  id: 'token.create',
  title: 'Add a design token',
  description:
    `Add a colour or a text style to the folder, for every deck in it. A colour is { name, value } ("#RRGGBB" or ` +
    `"#RRGGBBAA"), optionally byVariant { axis, values } (a value per deck variant) and bySurface; at most ` +
    `${MAX_COLORS} colours per folder. A text style holds the typography linked text takes (its fields are the ` +
    "schema's; apply it with text.style.apply); its name must be new in the folder (token.list). Returns the new " +
    'id. Undo: token.delete. Needs folder editor.',
  input: z.discriminatedUnion('category', [
    NewColor.extend({ category: z.literal('colors') }),
    NewTextStyle.extend({ category: z.literal('textStyles') }),
  ]),
  output: z.object({ tokenId: z.string() }),
  undo: 'undoable',
  undoneBy: 'token.delete',
  implementedWith: ['addFolderToken'],
  routes: [POST('/folders/:folderId/tokens/:category')],
  examples: [
    {
      title: 'Add the brand colour',
      input: { category: 'colors', name: 'Brand blue', value: '#1b4fd8' },
    },
    {
      title: 'Add a subtitle style in a folder colour',
      input: {
        category: 'textStyles',
        name: 'Subtitle',
        family: 'Inter',
        weight: 500,
        size: 32,
        lineHeight: 1.2,
        color: { $token: 'colors.brandBlue' },
      },
    },
    {
      title: 'Add a text colour that turns white on dark decks',
      input: {
        category: 'colors',
        name: 'Ink',
        value: '#1b2a4a',
        byVariant: { axis: 'background', values: { dark: '#ffffff' } },
      },
    },
    {
      title: 'Add a body style whose bullets are red dashes, smaller one level down',
      input: {
        category: 'textStyles',
        name: 'Body list',
        size: 28,
        levels: [
          { list: 'bullet', bulletChar: '–', bulletColor: '#e4002b', indent: 36, hanging: 36 },
          { list: 'bullet', bulletChar: '–', indent: 72, hanging: 36, fontSize: 24 },
        ],
      },
    },
  ],
  async handler(ctx, input) {
    const { category, ...fields } = input
    return requireServices(ctx).tokens.create({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      category,
      fields,
    })
  },
})

export const tokenUpdate = defineCommand({
  ...tokenEditor,
  id: 'token.update',
  idempotent: true,
  title: 'Change a design token',
  description:
    'Change a colour or a text style of the folder. Everything linked to it follows, in every deck and master ' +
    'of the folder, open or not: linked text boxes and tables take the new values (except fields set by hand ' +
    'on them), and a colour reaches the text of styles that use it. Only when the user asked for the ' +
    'folder-wide change; one box: text.setBoxTypography. `null` removes an optional text-style field. Returns ' +
    'the previous values (token.update with them undoes it) and what was restyled. Needs folder editor.',
  input: z.discriminatedUnion('category', [
    ColorPatch.extend({ category: z.literal('colors'), tokenId: TokenIdSchema }),
    TextStylePatch.extend({ category: z.literal('textStyles'), tokenId: TokenIdSchema }),
  ]),
  output: z.object({
    previous: PreviousSchema,
    propagated: z.object({
      decks: z.number(),
      components: z.number(),
      objects: z.number().describe('Text boxes and tables re-styled'),
      failed: z.array(z.string()),
    }),
  }),
  undo: 'undoable',
  undoneBy: 'token.update',
  implementedWith: ['updateFolderToken', 'updateObject', 'setTableDefaultsPatch'],
  routes: [PATCH('/folders/:folderId/tokens/:category/:tokenId')],
  examples: [
    {
      title: 'Make the Title style 80 px (linked titles follow)',
      input: { category: 'textStyles', tokenId: 'title', size: 80 },
    },
    {
      title: 'Change the brand colour',
      input: { category: 'colors', tokenId: 'brandBlue', value: '#0f3fb8' },
    },
    {
      title: 'Body text may shrink to fit, never below 18 px',
      input: { category: 'textStyles', tokenId: 'body', minSize: 18 },
    },
    {
      title: 'Make the brand colour 80% opaque and drop its per-variant values',
      input: { category: 'colors', tokenId: 'brandBlue', value: '#1b4fd8cc', byVariant: null },
    },
  ],
  async handler(ctx, input) {
    const { category, tokenId, ...patch } = input
    return requireServices(ctx).tokens.update({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      category,
      tokenId,
      patch,
    })
  },
})

export const tokenDelete = defineCommand({
  ...tokenEditor,
  id: 'token.delete',
  title: 'Delete a design token',
  description:
    'Remove a colour, text style or effect style from the folder. What uses it keeps its look but no longer ' +
    'follows it (token.usages first). Built-in text styles cannot be deleted. It returns the token, so it can ' +
    'be made again; confirm with the user first. Needs folder editor.',
  input: z.strictObject({ category: CategorySchema, tokenId: TokenIdSchema }),
  output: z.object({
    deleted: z.literal(true),
    token: z.record(z.string(), z.unknown()).describe('The token as it was'),
  }),
  undo: 'irreversible',
  confirm: 'always',
  implementedWith: ['deleteFolderToken'],
  routes: [DELETE('/folders/:folderId/tokens/:category/:tokenId')],
  examples: [
    { title: 'Delete an unused colour', input: { category: 'colors', tokenId: 'retired' } },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).tokens.delete({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      category: input.category,
      tokenId: input.tokenId,
    })
  },
})

export const tokenSeedDefaults = defineCommand({
  ...tokenEditor,
  id: 'token.seedDefaults',
  idempotent: true,
  title: 'Add the default tokens',
  description:
    'Give a folder with no colours and no text styles the default palette and text styles (Title, Heading ' +
    '1–3, Body, …, "Footnotes and pages"), and bring an older folder\'s default styles up to date. New folders ' +
    'get them when created; a folder with colours or text styles is not refilled. The default text styles are ' +
    'built in (token.delete refuses them); confirm with the user first. Needs folder editor.',
  input: z.strictObject({}),
  output: z.object({ seeded: z.boolean(), migrated: z.boolean() }),
  undo: 'irreversible',
  confirm: 'always',
  implementedWith: ['seedDefaultTokens', 'migrateFolderTokens'],
  examples: [{ title: 'Give this folder the default tokens', input: {} }],
  async handler(ctx) {
    return requireServices(ctx).tokens.seedDefaults({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
    })
  },
})

const ColorTokenOutput = z.object({
  id: z.string(),
  name: z.string(),
  value: z.string(),
  byVariant: z.object({ axis: z.string(), values: z.record(z.string(), z.string()) }).optional(),
  bySurface: z.record(z.string(), z.string()).optional(),
  origin: z.object({ pack: z.string(), key: z.string() }).optional(),
})
const OutputColor = z.union([z.string(), z.object({ $token: z.string() })])
const StyleLevelOutput = z.object({
  list: z.enum(['bullet', 'number', 'none']).optional(),
  bulletChar: z.string().optional(),
  bulletColor: OutputColor.optional(),
  bulletScale: z.number().optional(),
  numberFormat: ListNumberFormatSchema.optional(),
  indent: z.number().optional(),
  hanging: z.number().optional(),
  spaceBefore: z.number().optional(),
  fontFamily: z.string().optional(),
  fontWeight: z.number().optional(),
  fontSize: z.number().optional(),
  color: OutputColor.optional(),
  lineSpacing: z.number().optional(),
})
const TextStyleOutput = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  weight: z.number().optional(),
  size: z.number().optional(),
  minSize: z.number().optional(),
  fontStretch: z.number().optional(),
  lineHeight: z.number().optional(),
  lineSpacing: z.number().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  letterSpacing: z.number().optional(),
  paragraphSpaceBefore: z.number().optional(),
  paragraphSpaceAfter: z.number().optional(),
  color: z.union([z.string(), z.object({ $token: z.string() })]).optional(),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
  levels: z.array(StyleLevelOutput).optional(),
  builtin: z.boolean().optional(),
})
const EffectStyleOutput = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['shadow', 'blur']),
  params: z.record(z.string(), z.unknown()),
})

export const tokenList = defineCommand({
  ...tokenReader,
  id: 'token.list',
  title: "List a folder's tokens",
  description:
    "The folder's design tokens with their ids: colours, text styles (`builtin` ones cannot be deleted; a " +
    'colour is a hex or { $token: "colors.<id>" }) and effect styles (stored, not applied yet). A deck\'s ' +
    'folder is its `folderId` (deck.get). Link text to a style with text.style.apply (by name too). Any folder member, or anyone with access to one of its decks.',
  input: z.strictObject({}),
  output: z.object({
    colors: z.array(ColorTokenOutput),
    textStyles: z.array(TextStyleOutput),
    effectStyles: z.array(EffectStyleOutput),
  }),
  folderReaders: 'content',
  readOnly: true,
  undo: 'n/a',
  implementedWith: ['readFolderTokens'],
  examples: [{ title: "List the folder's colours and text styles", input: {} }],
  async handler(ctx) {
    const tokens = await requireServices(ctx).tokens.list({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
    })
    return {
      colors: Object.values(tokens.colors),
      textStyles: Object.values(tokens.textStyles),
      effectStyles: Object.values(tokens.effectStyles),
    }
  },
})

export const tokenCommands = [
  tokenUsages,
  tokenList,
  tokenCreate,
  tokenUpdate,
  tokenDelete,
  tokenSeedDefaults,
]
