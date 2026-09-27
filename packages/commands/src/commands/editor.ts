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
    'Read what the user is looking at in their open editor on this deck: the active slide (id and 0-based ' +
    'index) and the ids of the objects they have selected. Call it whenever the user says "this", "here", ' +
    '"these", "the selected…" or "the current slide", then pass the returned ids to the edit commands — edit ' +
    'commands never act on "the selection" themselves. `open: false` means the user has no editor open on the ' +
    'deck (ask them which slide or object they mean). With several tabs open, the top-level fields describe ' +
    'the most recently active tab and `editors` lists all of them. Reads presence only; changes nothing.',
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
    "Point the user's open editor(s) on this deck at a slide and, optionally, highlight objects on it — e.g. " +
    'after an edit, to show the user what you changed ("here is the new chart"). Each tab switches to that ' +
    'slide and selects the objects, flashing an outline around them for a moment; a show without `objects` ' +
    "clears the tab's selection. Nothing in the document changes and other people are not affected; only the " +
    "calling user's own tabs receive it. If the user is busy in a tab — typing in a text box, cropping an " +
    'image, editing path points or a table cell — that tab does not move: it shows a "Show" notice instead ' +
    'and switches only if the user clicks it within 20 seconds, so do not assume they are looking at it. ' +
    "`delivered` is the number of the user's tabs the request reached, not views that changed; 0 means no " +
    'editor open on the deck — tell them where to look instead, or give them editor.present.link.',
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
    'Get the URL that opens this deck in present mode, starting at a given slide (default: the first). Give ' +
    'it to the user when they want to present or preview the deck full screen; opening it needs their normal ' +
    'access to the deck. Presenting itself (next slide, fullscreen, presenter view) is done by the person, not ' +
    'by an agent. Changes nothing.',
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
