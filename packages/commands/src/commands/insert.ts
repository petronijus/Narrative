/**
 * commands/src/commands/insert.ts — putting objects described as JSON onto a
 * slide: what an agent read with query.slide / query.object (from this deck
 * or another one), and the editor's clipboard once the source objects are
 * gone (cut) or live in another deck. Copies of objects that still exist in
 * this deck are exact with object.copyTo instead.
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import { SlideRefSchema, objectsOf, requireDeck, resolveSlide } from '../refs.js'
import { requireServices } from '../services.js'
import {
  InsertObjectsSchema,
  PlacementSchema,
  applyInsertPlan,
  planInsert,
  type InsertPlan,
} from '../insert/plan.js'
import type { PreparedObjectInsert } from '../services/decks.js'
import { IdSchema, POST, TokenRebindOutput, serverCommand, targetDeckId } from './serverShared.js'

const EXAMPLE_OBJECTS = [
  {
    id: 'card',
    type: 'rectangle',
    x: 200,
    y: 300,
    width: 500,
    height: 260,
    rotation: 0,
    opacity: 1,
    fill: '#1b2a4a',
    cornerRadius: 16,
  },
  {
    id: 'label',
    type: 'text',
    x: 240,
    y: 340,
    width: 420,
    height: 80,
    rotation: 0,
    opacity: 1,
    fontSize: 40,
    color: '#ffffff',
    text: 'Revenue up 12%',
    paragraphs: [{ runs: [{ text: 'Revenue ' }, { text: 'up 12%', fontWeight: 700 }] }],
  },
]

export const objectInsert = defineCommand({
  id: 'object.insert',
  domain: 'object',
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
  title: 'Insert objects from JSON',
  description:
    'Put objects onto a slide from their JSON — exactly what query.slide or query.object returns, formatted ' +
    'text and table cells included — with new ids, on top of the stacking order, in one step: to recreate or ' +
    'transplant what you read. Each object is checked like object.create input. Objects read together that ' +
    'shared a group get a new group of their own. `offset` moves them, `at` puts the centre of their combined ' +
    "box on a point. Pictures and videos must be this deck's media: from ANOTHER deck use " +
    'object.insertFromDeck, which copies them. To copy objects that are still in this deck use object.copyTo.',
  input: z.strictObject({
    slide: SlideRefSchema,
    objects: InsertObjectsSchema,
    ...PlacementSchema,
  }),
  output: z.object({ objectIds: z.array(z.string()) }),
  implementedWith: ['addObjects'],
  examples: [
    {
      title: 'Recreate a card and its formatted label on slide 3, centred',
      input: { slide: 's3', objects: EXAMPLE_OBJECTS, at: { x: 960, y: 540 } },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const objects = objectsOf(deck, resolveSlide(deck, input.slide))
    const plan = planInsert(input.objects, { offset: input.offset, at: input.at })
    return { objectIds: applyInsertPlan(objects, plan) }
  },
})

interface LoadedInsert {
  plan: InsertPlan
  prepared: PreparedObjectInsert
}

export const objectInsertFromDeck = defineCommand({
  ...serverCommand,
  id: 'object.insertFromDeck',
  domain: 'object',
  role: 'editor',
  scope: 'deck',
  effects: ['doc', 'server'],
  undo: 'undoable',
  confirm: 'never',
  title: 'Insert objects read from another deck',
  description:
    'object.insert for objects read (query.slide / query.object) from ANOTHER deck, `fromDeck`: the pictures, ' +
    "videos and fonts they use are copied into this deck, colour and text-style tokens are rebound to this deck's " +
    "folder when the folders differ, and links to the other deck's slides are removed. Copying out of a deck " +
    'needs editor access to it (the same as exporting it), so a deck you can only view is refused.',
  input: z.strictObject({
    slide: SlideRefSchema,
    fromDeck: IdSchema.describe('The deck the objects were read from'),
    objects: InsertObjectsSchema,
    ...PlacementSchema,
  }),
  output: z.object({
    objectIds: z.array(z.string()),
    mediaRegistered: z.number().describe('Media assets copied into this deck'),
    skippedImages: z.number().describe('Pictures whose file could not be copied'),
    droppedLinks: z.number().describe("Links to the other deck's slides (removed)"),
    tokens: TokenRebindOutput.optional(),
  }),
  routes: [POST('/decks/:id/insert-objects')],
  examples: [
    {
      title: 'Bring a card read from another deck onto slide 1',
      input: { slide: { index: 0 }, fromDeck: 'deck_other', objects: EXAMPLE_OBJECTS },
    },
  ],
  async load(ctx, input): Promise<LoadedInsert> {
    if (input.fromDeck === targetDeckId(ctx)) {
      throw new CommandError(
        'invalid_input',
        'fromDeck is this deck: its objects already have their media here — use object.insert (or object.copyTo)',
        { issues: [{ path: ['fromDeck'], message: 'the same deck as the target' }] },
      )
    }
    // Validate before anything is copied: a bad object costs no media staging.
    const plan = planInsert(input.objects, { offset: input.offset, at: input.at })
    const prepared = await requireServices(ctx).decks.prepareObjectInsert({
      userId: ctx.actor.userId,
      sourceDeckId: input.fromDeck,
      targetDeckId: targetDeckId(ctx),
      plan,
    })
    return { plan, prepared }
  },
  handler(ctx, input, loaded) {
    let objects
    try {
      const deck = requireDeck(ctx)
      objects = objectsOf(deck, resolveSlide(deck, input.slide))
    } catch (e) {
      void loaded.prepared.discard()
      throw e
    }
    return loaded.prepared.apply(objects)
  },
})

export const insertCommands = [objectInsert, objectInsertFromDeck]
