/**
 * commands/src/commands/editor.ts — the `editor.*` domain: the calling
 * user's OPEN editors, not the document (plan §4.2, §4.5; ADR 0011 point 8).
 *
 * - `editor.context` is how an agent learns what "this" means: the slide the
 *   user is looking at and what they selected, read from the awareness
 *   state their editor tab publishes. "This" then becomes explicit ids
 *   before any command runs (commands never act on "the selection").
 * - `editor.show` points the user's open editors at a slide and highlights
 *   objects ("show me what you changed"), without writing the document.
 * - `editor.present.link` hands the user a present-mode URL at a slide.
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import { requireServices } from '../services.js'
import {
  ObjectIdsSchema,
  SlideRefSchema,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
} from '../refs.js'
import type { CommandContext } from '../types.js'

const editorCommand = {
  domain: 'editor',
  scope: 'deck',
  role: 'viewer',
  undo: 'n/a',
  confirm: 'never',
  hosts: ['server'],
  implementedWith: [],
} as const

function requireDeckId(ctx: CommandContext, commandId: string): string {
  const deckId = ctx.target?.deckId
  if (deckId === undefined) {
    throw new CommandError(
      'no_target',
      `${commandId} works on a deck someone has open in the editor: name the deck (deckId)`,
    )
  }
  return deckId
}

const OpenEditorSchema = z.object({
  activeSlideId: z.string().nullable(),
  activeSlideIndex: z.number().int().min(0).nullable(),
  selectedObjectIds: z.array(z.string()),
  lastActiveAt: z.string(),
})

export const editorContext = defineCommand({
  ...editorCommand,
  id: 'editor.context',
  title: "Read the user's editor context",
  description:
    'What the user is looking at in their open editor on this deck: the active slide (id and 0-based index) ' +
    'and the ids of the selected objects. Call it whenever the user says "this", "here", "these", "the ' +
    'selected…" or "the current slide", then pass the ids to the edit commands — they never act on "the ' +
    'selection" themselves. `open: false`: no editor open on the deck (ask which slide or object they mean). ' +
    'With several tabs, the top-level fields are the most recently active one and `editors` lists all. Reads ' +
    'presence only.',
  input: z.object({}).strict(),
  output: z.object({
    open: z.boolean(),
    activeSlideId: z.string().nullable(),
    activeSlideIndex: z.number().int().min(0).nullable(),
    selectedObjectIds: z.array(z.string()),
    editors: z.array(OpenEditorSchema),
  }),
  readOnly: true,
  effects: ['server'],
  examples: [{ title: 'What is the user looking at?', input: {} }],
  async handler(ctx) {
    const deckId = requireDeckId(ctx, 'editor.context')
    const editors = await requireServices(ctx).editor.context({ userId: ctx.actor.userId, deckId })
    const primary = editors[0]
    return {
      open: primary !== undefined,
      activeSlideId: primary?.activeSlideId ?? null,
      activeSlideIndex: primary?.activeSlideIndex ?? null,
      selectedObjectIds: primary?.selectedObjectIds ?? [],
      editors,
    }
  },
})

export const editorShow = defineCommand({
  ...editorCommand,
  id: 'editor.show',
  title: "Show something in the user's editor",
  description:
    "Point the user's open editor tabs on this deck at a slide and optionally highlight objects on it — e.g. " +
    'after an edit, to show what you changed. Each tab switches to the slide and selects the objects, ' +
    'flashing an outline; without `objects` it clears the selection. Changes nothing in the document; only ' +
    "the calling user's own tabs receive it. A tab where the user is busy (typing, cropping, editing path " +
    'points or a table cell) does not move: it shows a "Show" notice and switches only if they click it ' +
    'within 20 s — do not assume they are looking. `delivered` counts the tabs reached, not views changed; 0 ' +
    '= no editor open on the deck: tell them where to look, or give them editor.present.link.',
  input: z
    .object({
      slide: SlideRefSchema.describe('The slide to show'),
      objects: ObjectIdsSchema.optional().describe('Objects on that slide to highlight'),
    })
    .strict(),
  output: z.object({
    delivered: z
      .number()
      .int()
      .min(0)
      .describe(
        "The user's open tabs on the deck the request reached (a busy tab only shows a notice)",
      ),
    slideId: z.string(),
  }),
  effects: ['server'],
  readsDocument: true,
  examples: [
    { title: 'Show slide 2', input: { slide: 's2' } },
    {
      title: 'Highlight two objects on the first slide',
      input: { slide: { index: 0 }, objects: ['r1', 't1'] },
    },
  ],
  async handler(ctx, input) {
    const deckId = requireDeckId(ctx, 'editor.show')
    // Resolve against the live document first, so a stale ref fails here
    // instead of sending the user's editor to something that is not there.
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objectIds = input.objects ?? []
    if (objectIds.length > 0) requireObjects(objectsOf(deck, slide), objectIds, slide.id)
    const { delivered } = await requireServices(ctx).editor.show({
      userId: ctx.actor.userId,
      deckId,
      slideId: slide.id,
      objectIds: [...new Set(objectIds)],
      ...(ctx.run === undefined ? {} : { runId: ctx.run.runId }),
    })
    return { delivered, slideId: slide.id }
  },
})

export const editorPresentLink = defineCommand({
  ...editorCommand,
  id: 'editor.present.link',
  title: 'Link to present mode',
  description:
    'The URL that opens this deck in present mode at a given slide (default: the first), for the user to ' +
    'present or preview full screen with their normal access. Presenting (next slide, fullscreen, presenter ' +
    'view) is done by the person, not by an agent. Changes nothing.',
  input: z
    .object({
      slide: SlideRefSchema.optional().describe('The slide to start at (default: the first slide)'),
    })
    .strict(),
  output: z.object({
    url: z.string(),
    slideNumber: z.number().int().min(1).describe('1-based number of the slide the link starts at'),
  }),
  // Effect-free: it only reads the document (to resolve the slide) and the
  // server's public address.
  readOnly: true,
  effects: [],
  examples: [
    { title: 'Present from the start', input: {} },
    { title: 'Present from the second slide', input: { slide: { index: 1 } } },
  ],
  handler(ctx, input) {
    const deckId = requireDeckId(ctx, 'editor.present.link')
    const deck = requireDeck(ctx)
    const slideNumber = input.slide === undefined ? 1 : resolveSlide(deck, input.slide).index + 1
    const url = requireServices(ctx).editor.presentUrl({ deckId, slideNumber })
    return { url, slideNumber }
  },
})

export const editorCommands = [editorContext, editorShow, editorPresentLink]
