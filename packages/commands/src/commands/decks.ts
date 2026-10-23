/**
 * commands/src/commands/decks.ts — the `deck.*` commands backed by the
 * server's DeckService (apps/server/src/services/decks.ts), the same service
 * the /decks routes call. PowerPoint import / insert / export live in
 * ./pptx.ts.
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
  DeckListItemOutput,
  DeckOutput,
  DeckWithRoleOutput,
  FontFaceOutput,
  GET,
  IdSchema,
  PATCH,
  POST,
  TokenRebindOutput,
  serverCommand,
  targetDeckId,
  targetFolderId,
} from './serverShared.js'

const TitleSchema = z
  .string()
  .max(200)
  .refine((t) => t.trim().length > 0, 'the title must not be blank')
  .describe('Deck title, at most 200 characters')

export const deckList = defineCommand({
  ...serverCommand,
  id: 'deck.list',
  domain: 'deck',
  title: 'List decks',
  description:
    'Find decks the user can open — their own and those shared with them — most recently changed first, one ' +
    "page at a time: { id, title, folderId, updatedAt, role } each (role = the user's: owner / editor / " +
    'viewer; `updatedAt` = last change to content, title or folder). Narrow it with `query` (title contains, ' +
    'ignoring case) or `folderId` (folder.list) rather than paging through everything. A page holds `limit` ' +
    'decks (default 50, at most 200); while `nextCursor` is not null there are more: call again with `cursor: ' +
    'nextCursor` and the same filters. The full record: deck.get; the slides: query.deck.',
  input: z.strictObject({
    query: ListQuerySchema.optional().describe(
      'Title contains it, ignoring case (plain text, no wildcards)',
    ),
    folderId: IdSchema.optional().describe('Only decks in this folder (it must be yours)'),
    limit: ListLimitSchema,
    cursor: ListCursorSchema.optional(),
  }),
  output: z.object({
    decks: z.array(DeckListItemOutput),
    nextCursor: z
      .string()
      .nullable()
      .describe(
        'Pass as `cursor` (with the same filters) for the next page; null on the last page',
      ),
  }),
  role: 'viewer',
  scope: 'user',
  effects: ['server'],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/decks')],
  examples: [
    { title: 'The 5 most recently changed decks', input: { limit: 5 } },
    { title: 'Find a deck by title', input: { query: 'quarterly' } },
    { title: 'Decks in one folder', input: { folderId: 'folder_fixture' } },
  ],
  async handler(ctx, input) {
    const filter = { query: input.query ?? null, folderId: input.folderId ?? null }
    const page = await requireServices(ctx).decks.listPage({
      userId: ctx.actor.userId,
      folderId: input.folderId,
      query: input.query,
      limit: input.limit,
      after:
        input.cursor === undefined ? undefined : decodeListCursor('deck', input.cursor, filter),
    })
    return {
      decks: page.decks,
      nextCursor: page.next === null ? null : encodeListCursor('deck', page.next, filter),
    }
  },
})

export const deckGet = defineCommand({
  ...serverCommand,
  id: 'deck.get',
  domain: 'deck',
  title: 'Deck details',
  description:
    "The deck's record: title, folder, owner, thumbnail URL, created / updated times and the caller's role. " +
    'Nothing about the content: query.deck and query.slide.',
  input: z.strictObject({}),
  output: DeckWithRoleOutput,
  role: 'viewer',
  scope: 'deck',
  effects: ['server'],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/decks/:id')],
  examples: [{ title: 'Read the deck record', input: {} }],
  async handler(ctx) {
    return requireServices(ctx).decks.get({ userId: ctx.actor.userId, deckId: targetDeckId(ctx) })
  },
})

export const deckCreate = defineCommand({
  ...serverCommand,
  id: 'deck.create',
  domain: 'deck',
  title: 'Create deck',
  description:
    'Create an empty deck owned by the user — in `folderId` (where they are editor or owner: folder.list ' +
    '`role`), else in their Drafts. It holds one empty slide (`firstSlideId`): target the returned `id` with ' +
    'slide.add, object.create, text.set and the other document commands. From a PowerPoint file: ' +
    'deck.importPptx. Undo: deck.delete.',
  input: z.strictObject({
    title: TitleSchema.optional().describe('Deck title (default "Untitled Deck")'),
    folderId: IdSchema.optional().describe('Folder to create it in (default: Drafts)'),
  }),
  output: DeckOutput.extend({
    firstSlideId: z.string().describe('Id of the empty slide the deck starts with'),
  }),
  role: 'owner',
  scope: 'user',
  effects: ['server'],
  undo: 'undoable',
  undoneBy: 'deck.delete',
  confirm: 'never',
  routes: [POST('/decks')],
  examples: [
    { title: 'A deck in Drafts', input: { title: 'Q3 business review' } },
    { title: 'A deck in a client folder', input: { title: 'Pitch', folderId: 'folder_fixture' } },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).decks.create({
      userId: ctx.actor.userId,
      title: input.title?.trim(),
      folderId: input.folderId,
    })
  },
})

export const deckDuplicate = defineCommand({
  ...serverCommand,
  id: 'deck.duplicate',
  domain: 'deck',
  title: 'Duplicate deck',
  description:
    'Copy this deck whole into a NEW deck the user owns: every slide (objects, rich text, tables, animations, ' +
    'speaker notes, outline), the guides and the media the slides show (into another folder, linked component ' +
    "media too). Lands in `folderId` (where the user is editor or owner), else this deck's folder if the user " +
    'may edit it, else Drafts; in another folder, token references are rebound as deck.moveToFolder does. ' +
    'Sharing is not copied. Needs deck editor. Returns the new deck: target its `id` to edit the copy. Some ' +
    'slides into an existing deck: deck.insertFrom. Undo: deck.delete on the copy.',
  input: z.strictObject({
    title: TitleSchema.optional().describe('Title of the copy (default: "<title> (copy)")'),
    folderId: IdSchema.optional().describe(
      'Folder for the copy (default: this deck’s, else Drafts)',
    ),
  }),
  output: DeckOutput.extend({
    slideCount: z.number(),
    mediaCopied: z.number().describe('Images, videos and deck fonts copied into the new deck'),
    skippedImages: z.number().describe('Assets that could not be copied'),
    tokens: TokenRebindOutput.optional(),
  }),
  role: 'editor',
  scope: 'deck',
  effects: ['server'],
  undo: 'undoable',
  undoneBy: 'deck.delete',
  confirm: 'never',
  routes: [POST('/decks/:id/duplicate')],
  examples: [
    { title: 'Copy the deck next to the original', input: {} },
    {
      title: 'Copy it into another folder under a new title',
      input: { title: 'Pitch — Acme version', folderId: 'folder_fixture' },
    },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).decks.duplicate({
      userId: ctx.actor.userId,
      deckId: targetDeckId(ctx),
      title: input.title?.trim(),
      folderId: input.folderId,
    })
  },
})

export const deckRename = defineCommand({
  ...serverCommand,
  id: 'deck.rename',
  domain: 'deck',
  title: 'Rename deck',
  description:
    "Change the deck's title (the deck list's and the browser tab's). Slide names: slide.rename; slide text: " +
    'text.set. Undo: rename it back.',
  input: z.strictObject({ title: TitleSchema }),
  output: DeckOutput,
  role: 'editor',
  scope: 'deck',
  effects: ['server'],
  idempotent: true,
  undo: 'undoable',
  undoneBy: 'deck.rename',
  confirm: 'never',
  routes: [PATCH('/decks/:id')],
  examples: [{ title: 'Retitle the deck', input: { title: 'Q3 review — final' } }],
  async handler(ctx, input) {
    return requireServices(ctx).decks.rename({
      deckId: targetDeckId(ctx),
      title: input.title.trim(),
    })
  },
})

export const deckDelete = defineCommand({
  ...serverCommand,
  id: 'deck.delete',
  domain: 'deck',
  title: 'Delete deck',
  description:
    'Permanently delete the deck: its slides, speaker notes, collaborators, share links and uploaded media. ' +
    'People who have it open lose it — always confirm with the user first, naming the deck. Owner only. To ' +
    'remove slides: slide.delete; to tidy up: deck.moveToFolder.',
  input: z.strictObject({}),
  output: z.object({ deleted: z.literal(true) }),
  role: 'owner',
  scope: 'deck',
  effects: ['server'],
  undo: 'irreversible',
  confirm: 'always',
  routes: [DELETE('/decks/:id')],
  examples: [{ title: 'Delete the deck', input: {} }],
  async handler(ctx) {
    await requireServices(ctx).decks.delete({ deckId: targetDeckId(ctx), userId: ctx.actor.userId })
    return { deleted: true as const }
  },
})

export const deckMoveToFolder = defineCommand({
  ...serverCommand,
  id: 'deck.moveToFolder',
  domain: 'deck',
  title: 'Move deck to folder',
  description:
    'Move the deck into another folder (folder.list). Media it links from its current folder (stamped ' +
    "components' pictures and videos, the folder's own) is copied first so the new folder can load it; if a " +
    'copy fails nothing moves. Token references are rebound to the destination token of the same name (case ' +
    'and spacing ignored); a colour without one becomes its literal colour, a text style without one is ' +
    'detached (the text keeps its look). Returns the media copied / unresolved and the references rebound, ' +
    'literalised and detached. Moving back re-links neither, so confirm with the user first. Its share links ' +
    "follow and then show the new folder's component media too. Needs deck owner and editor in both folders.",
  input: z.strictObject({
    folderId: IdSchema.describe('Destination folder id'),
  }),
  output: z.object({
    moved: z.boolean().describe('False when the deck already was in that folder'),
    media: z
      .object({
        copied: z.number().describe('Linked media copied into the deck'),
        unresolved: z.number().describe('References broken before the move'),
        copyFailed: z.number().describe('Media linked during the move that failed to copy'),
        error: z.string().optional().describe('The catch-up after the move failed'),
      })
      .optional(),
    tokens: TokenRebindOutput.extend({
      error: z.string().optional().describe('Set when the references could not be rewritten'),
    }).optional(),
  }),
  role: 'owner',
  scope: 'deck',
  effects: ['server'],
  idempotent: true,
  undo: 'irreversible',
  confirm: 'always',
  routes: [POST('/folders/:id/move-decks')],
  examples: [{ title: 'Move to another client folder', input: { folderId: 'folder_b' } }],
  async handler(ctx, input) {
    const deckId = targetDeckId(ctx)
    const result = await requireServices(ctx).decks.moveDeck({
      userId: ctx.actor.userId,
      deckId,
      destFolderId: input.folderId,
      origin: ctx.origin,
    })
    const report = result.tokens.find((t) => t.deckId === deckId)
    const media = result.media.find((m) => m.deckId === deckId)
    return {
      moved: result.movedCount > 0,
      ...(media !== undefined
        ? {
            media: {
              copied: media.copied,
              unresolved: media.unresolved,
              copyFailed: media.copyFailed,
              ...(media.error !== undefined ? { error: media.error } : {}),
            },
          }
        : {}),
      ...(report !== undefined
        ? {
            tokens: {
              rebound: report.rebound,
              literalised: report.literalised,
              detached: report.detached,
              unmatched: report.unmatched,
              ...(report.error !== undefined ? { error: report.error } : {}),
            },
          }
        : {}),
    }
  },
})

export const deckActiveEditors = defineCommand({
  ...serverCommand,
  id: 'deck.activeEditors',
  domain: 'deck',
  title: 'Who is editing',
  description:
    'Which decks of a folder people have open right now, and who — e.g. before a large change, to warn the ' +
    'user colleagues are in the deck. Decks nobody has open are left out. Any folder member; owners get user ' +
    'ids and emails, other members names and stable pseudonymous ids.',
  input: z.strictObject({}),
  output: z.object({
    decks: z.array(
      z.object({
        deckId: z.string(),
        users: z.array(
          z.object({
            userId: z.string(),
            email: z.string().nullable(),
            name: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
  role: 'viewer',
  scope: 'folder',
  effects: ['server'],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/folders/:id/active-editors')],
  examples: [{ title: 'Who has decks of this folder open', input: {} }],
  async handler(ctx) {
    return {
      decks: await requireServices(ctx).decks.activeEditors({
        userId: ctx.actor.userId,
        folderId: targetFolderId(ctx),
      }),
    }
  },
})

export const deckFontsList = defineCommand({
  ...serverCommand,
  id: 'deck.fonts.list',
  domain: 'deck',
  title: 'Deck fonts',
  description:
    'Fonts bound to this deck itself — copies kept when a folder font it may use was deleted from the folder ' +
    "— with family, weight, style and a download URL. Most fonts are the folder's: folder.fonts.list. A " +
    'family listed in either can be used as fontFamily.',
  input: z.strictObject({}),
  output: z.object({ fonts: z.array(FontFaceOutput) }),
  role: 'viewer',
  scope: 'deck',
  effects: ['server'],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/api/decks/:deckId/fonts')],
  examples: [{ title: 'Fonts of this deck', input: {} }],
  async handler(ctx) {
    return { fonts: await requireServices(ctx).decks.listFonts({ deckId: targetDeckId(ctx) }) }
  },
})

export const deckCommands = [
  deckList,
  deckGet,
  deckCreate,
  deckDuplicate,
  deckRename,
  deckDelete,
  deckMoveToFolder,
  deckActiveEditors,
  deckFontsList,
]
