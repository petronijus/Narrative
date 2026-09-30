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

const folderOwner = {
  ...serverCommand,
  domain: 'token',
  role: 'owner',
  scope: 'folder',
  effects: ['server'],
  confirm: 'never',
} as const

const CategorySchema = z.enum(['colors', 'textStyles', 'effectStyles']).describe('Token category')
const TokenNameSchema = z.string().trim().min(1).max(80)
/** Characters that would end a CSS declaration or markup where a family name is written. */
const UNSAFE_FAMILY = /[;{}<>\\\u0000-\u001f\u007f]/
/** A colour as tokens store it: '#rrggbb' (input also 0xRRGGBB or '#RGB'). */
const HexSchema = RgbInputSchema.transform(hexOf).describe('"#RRGGBB"')
const WEIGHT = z.number().int().min(100).max(900).multipleOf(100)

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
  lineHeight: PositiveNumberSchema.max(10).describe('Multiple of the size'),
  letterSpacing: FiniteNumberSchema.min(-100).max(100),
  paragraphSpaceBefore: NonNegativeNumberSchema.max(1000),
  paragraphSpaceAfter: NonNegativeNumberSchema.max(1000),
  color: z
    .union([HexSchema, z.strictObject({ $token: z.string().regex(/^colors\.[A-Za-z0-9_-]+$/) })])
    .describe('"#RRGGBB" or one of the folder colours, { "$token": "colors.<id>" }'),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']),
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

const NewColor = z.strictObject({ name: TokenNameSchema, value: HexSchema })
const NewTextStyle = z.strictObject({ name: TokenNameSchema, ...optional(textStyleShape) })
const ColorPatch = z.strictObject({
  name: TokenNameSchema.optional(),
  value: HexSchema.optional(),
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
    'slide index, object, field), component masters, and — for a colour — the text styles whose colour is that ' +
    'token. Check it before changing or deleting a token to know what will change. Reads the saved documents, so ' +
    'edits from the last few seconds may be missing. Folder owner only.',
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
  role: 'owner',
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
  ...folderOwner,
  id: 'token.create',
  title: 'Add a design token',
  description:
    `Add a colour or a text style to the folder, for every deck in it. A colour is { name, value }; a folder holds ` +
    `at most ${MAX_COLORS} colours. A text style names what linked text takes — family, weight, size, lineHeight ` +
    '(multiple of the size), letterSpacing, paragraph spacing, colour (a hex or a folder colour), textTransform; ' +
    'apply it with text.style.apply; its name must be new in the folder (token.list). Returns the new id. Undo: ' +
    'token.delete. Folder owner only.',
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
  ...folderOwner,
  id: 'token.update',
  idempotent: true,
  title: 'Change a design token',
  description:
    'Change a colour or a text style of the folder. Everything linked to it follows in every deck and component ' +
    'master of the folder, open or not: text boxes and tables linked to a text style take its new values (except ' +
    'fields set by hand on them), and a colour reaches the text of styles that use it. Only when the user asked ' +
    'for the folder-wide change; to restyle one box use text.setBoxTypography. `null` removes an optional ' +
    'text-style field. Returns the previous values (token.update with them undoes it) and what was re-styled.',
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
  ...folderOwner,
  id: 'token.delete',
  title: 'Delete a design token',
  description:
    'Remove a colour, text style or effect style from the folder. Anything still using it keeps its current look ' +
    "but no longer follows the token (check token.usages first). The folder's built-in text styles cannot be " +
    'deleted. Cannot be undone (it returns the token, so it can be made again); confirm with the user first.',
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
  ...folderOwner,
  id: 'token.seedDefaults',
  idempotent: true,
  title: 'Add the default tokens',
  description:
    'Give a folder that has no colours and no text styles the default palette and text styles (Title, Heading 1–3, ' +
    'Body, …, "Footnotes and pages"), and bring an older folder\'s default styles up to date. New folders get them ' +
    'when created; a folder that already has colours or text styles is not refilled. Cannot be undone — the ' +
    'default text styles are built in (token.delete refuses them); confirm with the user first.',
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

const ColorTokenOutput = z.object({ id: z.string(), name: z.string(), value: z.string() })
const TextStyleOutput = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  weight: z.number().optional(),
  size: z.number().optional(),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional(),
  paragraphSpaceBefore: z.number().optional(),
  paragraphSpaceAfter: z.number().optional(),
  color: z.union([z.string(), z.object({ $token: z.string() })]).optional(),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
  builtin: z.boolean().optional(),
})
const EffectStyleOutput = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['shadow', 'blur']),
  params: z.record(z.string(), z.unknown()),
})

export const tokenList = defineCommand({
  ...folderOwner,
  id: 'token.list',
  title: "List a folder's tokens",
  description:
    "The folder's design tokens with their ids: colours, text styles (`builtin` ones cannot be deleted; a " +
    'colour is a hex or { $token: "colors.<id>" }) and effect styles (stored, not applied to anything yet). A ' +
    "deck's folder is its `folderId` (deck.get). Link text to a style with text.style.apply (by name works too). " +
    'Folder owner only.',
  input: z.strictObject({}),
  output: z.object({
    colors: z.array(ColorTokenOutput),
    textStyles: z.array(TextStyleOutput),
    effectStyles: z.array(EffectStyleOutput),
  }),
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
