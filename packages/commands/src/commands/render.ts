/**
 * commands/src/commands/render.ts — slides rendered by the render worker
 * (agentic A3, docs/plans/a3-render-worker.md): the real web renderer in
 * headless Chromium on the deck's live document
 * (apps/server/src/services/render.ts).
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import { SlideRefSchema, type SlideRef } from '../refs.js'
import type { RenderSlideRef } from '../services/render.js'
import { GET, serverCommand, targetDeckId } from './serverShared.js'

/**
 * Slides one call renders at most: a slide with fresh pictures costs up to
 * about 2.5 s, and a request must finish under Cloudflare's 100 s
 * (apps/server/src/services/render.ts).
 */
export const MAX_RENDER_SLIDES = 20

function toRenderRef(ref: SlideRef): RenderSlideRef {
  if (typeof ref === 'string') return { id: ref }
  return 'index' in ref ? { index: ref.index } : { id: ref.id }
}

const RenderedPng = z.object({
  slideId: z.string(),
  index: z.number(),
  width: z.number(),
  height: z.number(),
  sizeBytes: z.number(),
  failedLoads: z.number(),
})

export const deckExportPng = defineCommand({
  ...serverCommand,
  id: 'deck.exportPng',
  domain: 'deck',
  title: 'Export slides as PNG',
  description:
    'Render slides to PNG files exactly as the editor shows them now (seconds-old edits included), with the ' +
    'deck’s fonts and pictures: 1920×1080 per slide. Returns one download URL per slide, valid for 15 minutes — ' +
    'bearer links: give them only to the user who asked. `delivery: "base64"` returns the bytes inline (≤ 8 MB in ' +
    'total) to pass on (e.g. to media.upload), not to look at (to see a slide, query.render). An editable ' +
    'file is deck.exportPptx. At most 20 slides per call: ask for a longer deck in parts. `failedLoads` counts ' +
    'a slide’s pictures that no longer exist (they show their error mark, as in the editor); `failedFonts` names ' +
    'font families that failed to load (their text shows a fallback face). Takes a few seconds. Any reader of ' +
    'the deck.',
  input: z.strictObject({
    slides: z
      .union([z.literal('all'), z.array(SlideRefSchema).min(1).max(MAX_RENDER_SLIDES)])
      .default('all')
      .describe(
        '"all" (default; a deck of at most 20 slides), or the slides, in the order to return them',
      ),
    delivery: z.enum(['url', 'base64']).default('url').describe('"url" (default) or "base64"'),
  }),
  output: z.discriminatedUnion('delivery', [
    z.object({
      delivery: z.literal('url'),
      slides: z.array(RenderedPng.extend({ url: z.string() })),
      expiresAt: z.string(),
      failedFonts: z.array(z.string()),
    }),
    z.object({
      delivery: z.literal('base64'),
      slides: z.array(RenderedPng.extend({ base64: z.string() })),
      failedFonts: z.array(z.string()),
    }),
  ]),
  role: 'viewer',
  scope: 'deck',
  effects: ['server'],
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/decks/:id/export.png')],
  examples: [
    { title: 'Every slide, as download links', input: {} },
    {
      title: 'The first slide inline, to pass on',
      input: { slides: [{ index: 0 }], delivery: 'base64' },
    },
    { title: 'Two slides by id', input: { slides: ['s2', 's3'] } },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).render.exportPng({
      userId: ctx.actor.userId,
      deckId: targetDeckId(ctx),
      slides: input.slides === 'all' ? 'all' : input.slides.map(toRenderRef),
      delivery: input.delivery,
    })
  },
})

const RegionSchema = z
  .strictObject({
    x: z.number().min(0).max(1920),
    y: z.number().min(0).max(1080),
    width: z.number().positive().max(1920),
    height: z.number().positive().max(1080),
  })
  .describe('A part of `slide`, in slide px (the slide is 1920×1080)')

export const queryRender = defineCommand({
  ...serverCommand,
  id: 'query.render',
  domain: 'query',
  title: 'Look at slides',
  description:
    'See slides as they really look — the image comes back to you (fonts, pictures, layout, as the editor ' +
    'draws them, seconds-old edits included). Look after every visible change before you report it done. ' +
    '`slide`: the whole slide (1430×804). `slide` + `region` (slide px, 1920×1080 space): that part at full ' +
    'resolution, for small type, a table or an alignment. `slides` ("all" or a list, at most 20): one contact ' +
    'sheet, each slide numbered, for pacing and repetition across the deck. `failedLoads` counts missing ' +
    'pictures per slide; `failedFonts` names fonts that fell back. A few seconds the first time on a deck, ' +
    'about a second after. Files for the user are deck.exportPng. Any reader of the deck.',
  input: z
    .strictObject({
      slide: SlideRefSchema.optional().describe('The slide to look at'),
      region: RegionSchema.optional(),
      slides: z
        .union([z.literal('all'), z.array(SlideRefSchema).min(1).max(MAX_RENDER_SLIDES)])
        .optional()
        .describe('Slides for one contact sheet: "all" (a deck of at most 20) or a list'),
    })
    .refine((v) => (v.slide === undefined) !== (v.slides === undefined), {
      message: 'Give either slide or slides',
    })
    .refine((v) => v.region === undefined || v.slide !== undefined, {
      message: 'region needs slide',
    }),
  output: z.object({
    mode: z.enum(['slide', 'region', 'sheet']),
    width: z.number(),
    height: z.number(),
    slides: z.array(z.object({ slideId: z.string(), index: z.number(), failedLoads: z.number() })),
    failedFonts: z.array(z.string()),
    image: z.object({ mimeType: z.literal('image/png'), base64: z.string() }),
  }),
  role: 'viewer',
  scope: 'deck',
  // Nothing changes: the picture is made from the live deck and handed back.
  effects: [],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  examples: [
    { title: 'Look at the first slide', input: { slide: { index: 0 } } },
    {
      title: 'Check the small print at the bottom of a slide',
      input: { slide: 's2', region: { x: 0, y: 900, width: 1920, height: 180 } },
    },
    { title: 'The whole deck on one sheet', input: { slides: 'all' } },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).render.look({
      userId: ctx.actor.userId,
      deckId: targetDeckId(ctx),
      view:
        input.slides !== undefined
          ? { sheet: input.slides === 'all' ? 'all' : input.slides.map(toRenderRef) }
          : {
              slide: toRenderRef(input.slide!),
              ...(input.region !== undefined ? { region: input.region } : {}),
            },
    })
  },
})

export const renderCommands = [deckExportPng, queryRender]
