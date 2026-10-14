/**
 * commands/src/commands/pptx.ts — PowerPoint import / export and inserting
 * slides from another deck, backed by the server's PptxService
 * (apps/server/src/services/pptx.ts) — the same code the import / append /
 * export routes and the tus .pptx upload run.
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import { requireDeck } from '../refs.js'
import type { SlideInsertSource } from '../services/pptx.js'
import {
  FileSourceSchema,
  GET,
  IdSchema,
  POST,
  TokenRebindOutput,
  serverCommand,
  targetDeckId,
  targetFolderId,
  toBinarySource,
  urlFetchConfirmation,
} from './serverShared.js'

export const deckImportPptx = defineCommand({
  ...serverCommand,
  id: 'deck.importPptx',
  domain: 'deck',
  title: 'Import PowerPoint',
  description:
    'Create a NEW deck in the folder from a .pptx file (public URL or base64): slides, shapes, text with its ' +
    'formatting, tables, images, videos, speaker notes and embedded fonts are converted to Narrative objects. ' +
    'Returns the new deck id and what could not be carried over (skipped shapes, unsupported images, ignored ' +
    'elements) plus the font families the slides use — upload missing ones with folder.fonts.upload. To add a ' +
    "file's slides to an existing deck use deck.insertFrom. A .pptx by URL or base64 is limited to 200 MB; " +
    'larger decks import through the browser. Undo: deck.delete. Needs the editor role in the folder.',
  input: z.strictObject({
    file: FileSourceSchema,
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Deck title (default: the file name without .pptx)'),
  }),
  output: z.object({
    deckId: z.string(),
    slideCount: z.number(),
    objectsCreated: z.number(),
    skipped: z.object({ images: z.number(), unknownShapes: z.number(), fonts: z.number() }),
    ignoredElements: z.array(z.string()),
    embeddedFontCount: z.number(),
    referencedFontFamilies: z.array(z.string()),
    placeholders: z
      .array(
        z.object({
          slide: z.string(),
          objects: z.array(z.object({ object: z.string(), type: z.string() })),
        }),
      )
      .optional()
      .describe(
        'From a .pptx: the PowerPoint placeholder each object filled (title, subTitle, body, pic, …) — a hint for its role when restyling; not stored',
      ),
  }),
  role: 'editor',
  scope: 'folder',
  effects: ['server'],
  undo: 'undoable',
  undoneBy: 'deck.delete',
  confirm: 'never',
  routes: [POST('/folders/:folderId/import-pptx')],
  confirmWhen: urlFetchConfirmation((input) => [input.file]),
  examples: [
    {
      title: 'Import a deck from a URL',
      input: { file: { url: 'https://example.com/decks/q3-review.pptx' }, title: 'Q3 review' },
    },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).pptx.importPptx({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      source: toBinarySource(input.file),
      title: input.title,
    })
  },
})

const InsertSourceSchema = z
  .union([
    z.strictObject({ pptx: FileSourceSchema }),
    z
      .strictObject({
        deckId: IdSchema.describe('Another deck you can edit (deck.list)'),
        from: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('First source slide, 0-based (default 0)'),
        to: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Last source slide, 0-based, inclusive (default: the last)'),
        slides: z
          .array(IdSchema)
          .min(1)
          .max(500)
          .optional()
          .describe('Exactly these source slide ids, in source-deck order (instead of from/to)'),
      })
      .refine((v) => v.slides === undefined || (v.from === undefined && v.to === undefined), {
        message: 'Pass either slides or from/to, not both',
      }),
  ])
  .describe(
    '{ pptx: { url } | { base64 } } for a PowerPoint file, or { deckId, from?, to? } / { deckId, slides } for a deck',
  )

export const deckInsertFrom = defineCommand({
  ...serverCommand,
  id: 'deck.insertFrom',
  domain: 'deck',
  title: 'Insert slides from a file or deck',
  description:
    'Insert slides into this deck at position `at` (0-based; omitted = at the end; past the end = at the end), ' +
    'taken from a .pptx file (URL or base64, at most 200 MB) or from another Narrative deck you can edit ' +
    '(optionally slides `from`..`to`, or exactly the slide ids in `slides`; copying needs the same editor ' +
    'access as exporting that deck, so a deck ' +
    'you can only view is refused). Slides keep their objects, animations, speaker notes, transition and background; media this deck ' +
    "could not show is copied into it, the source folder's linked media included. From a deck in another " +
    'folder, token references are rebound to this folder the ' +
    'way deck.moveToFolder does it. One change, reverted as one step. To make the new slides match this deck: ' +
    'style.deck.apply { relayout: "archetype", slides }, then slide.applyLayout for what it lists unmatched ' +
    '(the insert-restyle prompt). A new deck from a file is deck.importPptx.',
  input: z.strictObject({
    source: InsertSourceSchema,
    at: z.number().int().min(0).optional().describe('Index the first inserted slide takes'),
  }),
  output: z.object({
    slideIds: z.array(z.string()),
    insertedAt: z.number(),
    objectsCreated: z.number(),
    mediaRegistered: z.number().describe('Media assets added to this deck'),
    skipped: z.object({ images: z.number(), unknownShapes: z.number() }),
    ignoredElements: z.array(z.string()),
    tokens: TokenRebindOutput.optional(),
    droppedLinks: z
      .number()
      .optional()
      .describe('Links to source slides that were not copied (removed)'),
    placeholders: z
      .array(
        z.object({
          slide: z.string(),
          objects: z.array(z.object({ object: z.string(), type: z.string() })),
        }),
      )
      .optional()
      .describe(
        'From a .pptx: the PowerPoint placeholder each object filled (title, subTitle, body, pic, …) — a hint for its role when restyling; not stored',
      ),
  }),
  role: 'editor',
  scope: 'deck',
  effects: ['doc', 'server'],
  undo: 'undoable',
  confirm: 'never',
  routes: [POST('/decks/:id/append-pptx'), POST('/decks/:id/insert-slides')],
  confirmWhen: urlFetchConfirmation((input) => [
    'pptx' in input.source ? input.source.pptx : undefined,
  ]),
  examples: [
    {
      title: 'Insert a PowerPoint after the first slide',
      input: { source: { pptx: { url: 'https://example.com/appendix.pptx' } }, at: 1 },
    },
    {
      title: 'Copy slides 2–3 of another deck to the end',
      input: { source: { deckId: 'deck_other', from: 1, to: 2 } },
    },
    {
      title: 'Copy two chosen slides of another deck to the front',
      input: { source: { deckId: 'deck_other', slides: ['s1', 's3'] }, at: 0 },
    },
  ],
  async load(ctx, input) {
    const source: SlideInsertSource =
      'pptx' in input.source
        ? { kind: 'pptx', file: toBinarySource(input.source.pptx) }
        : {
            kind: 'deck',
            deckId: input.source.deckId,
            range: { from: input.source.from, to: input.source.to },
            slideIds: input.source.slides,
          }
    return requireServices(ctx).pptx.prepareInsert({
      userId: ctx.actor.userId,
      deckId: targetDeckId(ctx),
      source,
    })
  },
  release: (prepared) => prepared.discard(),
  settle: (prepared) => prepared.settle(),
  handler(ctx, input, prepared) {
    let deck
    try {
      deck = requireDeck(ctx)
    } catch (e) {
      // Nothing was written: release the media staging registered.
      void prepared.discard()
      throw e
    }
    return prepared.apply(deck, input.at)
  },
})

export const deckExportPptx = defineCommand({
  ...serverCommand,
  id: 'deck.exportPptx',
  domain: 'deck',
  title: 'Export PowerPoint',
  description:
    'Export the deck as a .pptx file, exactly as it is right now (including edits made seconds ago). By default ' +
    'returns a download URL valid for 15 minutes. It is a bearer link: anyone who has it can download the deck ' +
    'without signing in, so give it only to the user who asked (or fetch it yourself) — never put it in a slide, a ' +
    'share, or a message to someone else. `delivery: "base64"` returns ' +
    'the file inline instead, only for files up to 8 MB. Colour tokens are written as their colours; everything ' +
    'the PowerPoint format can hold round-trips back through deck.importPptx.',
  input: z.strictObject({
    delivery: z
      .enum(['url', 'base64'])
      .default('url')
      .describe(
        '"url" (default): a short-lived download link; "base64": the bytes inline (≤ 8 MB)',
      ),
  }),
  output: z.discriminatedUnion('delivery', [
    z.object({
      delivery: z.literal('url'),
      filename: z.string(),
      sizeBytes: z.number(),
      slideCount: z.number(),
      url: z.string(),
      expiresAt: z.string(),
    }),
    z.object({
      delivery: z.literal('base64'),
      filename: z.string(),
      sizeBytes: z.number(),
      slideCount: z.number(),
      base64: z.string(),
    }),
  ]),
  role: 'editor',
  scope: 'deck',
  effects: ['server'],
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/decks/:id/export.pptx')],
  examples: [
    { title: 'Export and get a download link', input: {} },
    { title: 'Export inline', input: { delivery: 'base64' } },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).pptx.exportPptx({
      userId: ctx.actor.userId,
      deckId: targetDeckId(ctx),
      delivery: input.delivery,
    })
  },
})

export const pptxCommands = [deckImportPptx, deckInsertFrom, deckExportPptx]
