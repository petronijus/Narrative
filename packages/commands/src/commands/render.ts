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
    'total) to pass on (e.g. to media.upload), not to look at: this tool cannot show you a slide. An editable ' +
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

export const renderCommands = [deckExportPng]
