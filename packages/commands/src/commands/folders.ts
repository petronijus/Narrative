/**
 * commands/src/commands/folders.ts — the `folder.*` commands backed by the
 * server's FolderService (apps/server/src/services/folders.ts), the same
 * service the /folders and /api/folders/:id/fonts routes call. A folder is a
 * client / brand boundary: it owns its decks, design tokens, fonts and
 * components, and has exactly one owner.
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import {
  ListCursorSchema,
  ListLimitSchema,
  ListQuerySchema,
  decodeListCursor,
  encodeListCursor,
} from './listPaging.js'
import {
  DELETE,
  FileSourceSchema,
  FolderOutput,
  FontFaceOutput,
  GET,
  IdSchema,
  PATCH,
  POST,
  serverCommand,
  targetFolderId,
  toBinarySource,
  urlFetchConfirmation,
} from './serverShared.js'

const NameSchema = z
  .string()
  .max(200)
  .refine((t) => t.trim().length > 0, 'the name must not be blank')
  .describe('Folder name, at most 200 characters')

export const folderList = defineCommand({
  ...serverCommand,
  id: 'folder.list',
  domain: 'folder',
  title: 'List folders',
  description:
    "The user's folders, by name A→Z, one page at a time: { id, name, createdAt, deckCount } each. A folder is a " +
    'client or brand: it holds decks plus the design tokens, fonts and components they share. Every user has a ' +
    '"Drafts" folder. Narrow it with `query` (name contains, ignoring case). A page holds `limit` folders ' +
    '(default 50, at most 200); when `nextCursor` is not null there are more — call again with ' +
    '`cursor: nextCursor` and the same `query`. Decks in a folder: deck.list with folderId.',
  input: z.strictObject({
    query: ListQuerySchema.optional().describe(
      'Only folders whose name contains this text, ignoring case (plain text, no wildcards)',
    ),
    limit: ListLimitSchema,
    cursor: ListCursorSchema.optional(),
  }),
  output: z.object({
    folders: z.array(FolderOutput.extend({ deckCount: z.number() })),
    nextCursor: z
      .string()
      .nullable()
      .describe('Pass as `cursor` (with the same query) for the next page; null on the last page'),
  }),
  role: 'viewer',
  scope: 'user',
  effects: ['server'],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/folders')],
  examples: [
    { title: 'My folders', input: {} },
    { title: 'Find a client folder', input: { query: 'client' } },
  ],
  async handler(ctx, input) {
    const filter = { query: input.query ?? null }
    const page = await requireServices(ctx).folders.listPage({
      userId: ctx.actor.userId,
      query: input.query,
      limit: input.limit,
      after:
        input.cursor === undefined ? undefined : decodeListCursor('folder', input.cursor, filter),
    })
    return {
      folders: page.folders,
      nextCursor: page.next === null ? null : encodeListCursor('folder', page.next, filter),
    }
  },
})

export const folderCreate = defineCommand({
  ...serverCommand,
  id: 'folder.create',
  domain: 'folder',
  title: 'Create folder',
  description:
    'Create a folder owned by the user, e.g. for a new client — no decks yet, the default colours and text styles ' +
    '(token.list). Put decks in it with deck.create (folderId) or deck.moveToFolder, fonts with ' +
    'folder.fonts.upload. Undo: folder.delete.',
  input: z.strictObject({ name: NameSchema }),
  output: FolderOutput.extend({ deckCount: z.number() }),
  role: 'owner',
  scope: 'user',
  effects: ['server'],
  undo: 'undoable',
  undoneBy: 'folder.delete',
  confirm: 'never',
  routes: [POST('/folders')],
  examples: [{ title: 'A folder for a new client', input: { name: 'Fabrikam 2027' } }],
  async handler(ctx, input) {
    return requireServices(ctx).folders.create({
      userId: ctx.actor.userId,
      name: input.name.trim(),
    })
  },
})

export const folderRename = defineCommand({
  ...serverCommand,
  id: 'folder.rename',
  domain: 'folder',
  title: 'Rename folder',
  description:
    'Rename the folder. Its decks, tokens, fonts and components are unaffected. Undo: rename it back.',
  input: z.strictObject({ name: NameSchema }),
  output: FolderOutput,
  role: 'owner',
  scope: 'folder',
  effects: ['server'],
  idempotent: true,
  undo: 'undoable',
  undoneBy: 'folder.rename',
  confirm: 'never',
  routes: [PATCH('/folders/:id')],
  examples: [{ title: 'Rename the folder', input: { name: 'Fabrikam — archive' } }],
  async handler(ctx, input) {
    return requireServices(ctx).folders.rename({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      name: input.name.trim(),
    })
  },
})

export const folderDelete = defineCommand({
  ...serverCommand,
  id: 'folder.delete',
  domain: 'folder',
  title: 'Delete folder',
  description:
    "Permanently delete the folder AND every deck in it, with their media, plus the folder's tokens, fonts and " +
    'components. Cannot be undone; always confirm with the user first, saying how many decks go with it ' +
    '(folder.list shows deckCount). The Drafts folder cannot be deleted. To keep the decks, move them out first ' +
    'with deck.moveToFolder.',
  input: z.strictObject({}),
  output: z.object({ deletedDeckCount: z.number() }),
  role: 'owner',
  scope: 'folder',
  effects: ['server'],
  undo: 'irreversible',
  confirm: 'always',
  routes: [DELETE('/folders/:id')],
  examples: [{ title: 'Delete the folder and its decks', input: {} }],
  async handler(ctx) {
    return requireServices(ctx).folders.delete({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
    })
  },
})

export const folderFontsList = defineCommand({
  ...serverCommand,
  id: 'folder.fonts.list',
  domain: 'folder',
  title: 'Folder fonts',
  description:
    "The folder's uploaded fonts: family, weight, style, postscript name and a download URL. Every deck in the " +
    'folder can use these families as fontFamily in text (text.set, text.format, text.setBoxTypography). Folder owner only.',
  input: z.strictObject({}),
  output: z.object({ fonts: z.array(FontFaceOutput) }),
  role: 'owner',
  scope: 'folder',
  effects: ['server'],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/api/folders/:folderId/fonts')],
  examples: [{ title: 'Fonts of this folder', input: {} }],
  async handler(ctx) {
    return {
      fonts: await requireServices(ctx).folders.listFonts({
        userId: ctx.actor.userId,
        folderId: targetFolderId(ctx),
      }),
    }
  },
})

export const folderFontsUpload = defineCommand({
  ...serverCommand,
  id: 'folder.fonts.upload',
  domain: 'folder',
  title: 'Upload folder font',
  description:
    'Add one font face (a TTF, OTF, WOFF or WOFF2 file, at most 10 MB) to the folder, from a public URL or as ' +
    'base64, so every deck in the folder can use it. Upload each weight / style as its own file. The file is ' +
    'parsed to read its family, weight and style; `fontFamily` binds it to another family name instead (e.g. the ' +
    'name an imported PowerPoint uses). A face whose postscript name the folder already has is refused. Only ' +
    'upload fonts the user has the right to use. Undo: folder.fonts.delete.',
  input: z.strictObject({
    file: FileSourceSchema,
    fontFamily: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Family name to register the face under, instead of the one in the file'),
  }),
  output: FontFaceOutput,
  role: 'owner',
  scope: 'folder',
  effects: ['server'],
  undo: 'undoable',
  undoneBy: 'folder.fonts.delete',
  confirm: 'never',
  confirmWhen: urlFetchConfirmation((input) => [input.file]),
  routes: [POST('/api/folders/:folderId/fonts')],
  examples: [
    {
      title: 'Upload a font from a URL',
      input: { file: { url: 'https://fonts.example.com/Inter-Bold.ttf' } },
    },
    {
      title: 'Upload a font as base64 under the family a deck expects',
      input: {
        file: { base64: 'AAEAAAALAIAAAwAwT1MvMg8SBfAAAAC8AAAAYGNtYXAXVtKN', filename: 'Brand.ttf' },
        fontFamily: 'Brand Sans',
      },
    },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).folders.uploadFont({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      source: toBinarySource(input.file),
      familyOverride: input.fontFamily,
    })
  },
})

export const folderFontsDelete = defineCommand({
  ...serverCommand,
  id: 'folder.fonts.delete',
  domain: 'folder',
  title: 'Delete folder font',
  description:
    'Remove a font face from the folder (asset id from folder.fonts.list). Decks in the folder that the user owns ' +
    'keep a private copy so they still render; other decks fall back to another face. Confirm with the user first.',
  input: z.strictObject({ assetId: IdSchema.describe('Font asset id (folder.fonts.list)') }),
  output: z.object({
    promotedToDeckCount: z.number().describe('Decks that received a private copy of the font'),
  }),
  role: 'owner',
  scope: 'folder',
  effects: ['server'],
  undo: 'irreversible',
  confirm: 'always',
  routes: [DELETE('/api/folders/:folderId/fonts/:assetId')],
  examples: [{ title: 'Remove a font face', input: { assetId: 'font_fixture' } }],
  async handler(ctx, input) {
    return requireServices(ctx).folders.deleteFont({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      assetId: input.assetId,
    })
  },
})

export const folderCommands = [
  folderList,
  folderCreate,
  folderRename,
  folderDelete,
  folderFontsList,
  folderFontsUpload,
  folderFontsDelete,
]
