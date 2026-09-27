/**
 * commands/src/commands/tokens.ts — `token.*` commands backed by the
 * server's TokenService (apps/server/src/services/tokens.ts), the same
 * service GET /folders/:id/tokens/:category/:tokenId/usages calls. Token
 * CRUD itself edits the folder document and arrives with phase A2.
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import { GET, IdSchema, serverCommand, targetFolderId } from './serverShared.js'

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
    { title: 'Where is the brand colour used?', input: { category: 'colors', tokenId: 'brand' } },
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

export const tokenCommands = [tokenUsages]
