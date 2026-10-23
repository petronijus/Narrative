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
import { MAX_PDF_SLIDES, type PdfExportJobStatus, type RenderSlideRef } from '../services/render.js'
import { CommandError, type CommandErrorCode } from '../errors.js'
import { GET, POST, PUT, serverCommand, targetDeckId, targetDocument } from './serverShared.js'

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
    'Render slides to PNG files as the editor shows them now (seconds-old edits included), with the deck’s ' +
    'fonts and pictures: 1920×1080 per slide. Returns one download URL per slide, valid 15 minutes — bearer ' +
    'links: only for the user who asked. `delivery: "base64"`: the bytes inline (≤ 8 MB in total) to pass on ' +
    '(e.g. to media.upload), not to look at (query.render). Editable: deck.exportPptx. At most 20 slides per ' +
    'call: a longer deck in parts. `failedLoads` counts a slide’s missing pictures (drawn as their error ' +
    'mark, as in the editor); `failedFonts` names families that fell back. Takes a few seconds. Any deck ' +
    'reader.',
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

/**
 * How long one `deck.exportPdf` call waits for its job before answering
 * `running` (an MCP call stays well under Cloudflare's 100 s).
 */
export const PDF_EXPORT_WAIT_MS = 50_000

/** A finished PDF export, as the command hands it over. */
const PdfDone = z.object({
  status: z.literal('done'),
  jobId: z.string(),
  delivery: z.enum(['url', 'base64']),
  url: z.string().optional(),
  expiresAt: z.string().optional(),
  base64: z.string().optional(),
  filename: z.string(),
  pages: z.number(),
  leftOut: z.number(),
  sizeBytes: z.number(),
  failedLoads: z.number(),
  failedFonts: z.array(z.string()),
})
const PdfRunning = z.object({
  status: z.enum(['queued', 'running']),
  jobId: z.string(),
  done: z.number().describe('Pages rendered so far'),
  total: z.number().describe('Pages the file will have (0 until the job has read the deck)'),
})
const PdfExportOutput = z.discriminatedUnion('status', [PdfDone, PdfRunning])

/** A job's status as the command answers it: the result flattened, a failure thrown. */
function pdfOutput(s: PdfExportJobStatus): z.infer<typeof PdfExportOutput> {
  if (s.status === 'failed') throw new CommandError(asErrorCode(s.error.code), s.error.message)
  if (s.status === 'done') return { status: 'done', jobId: s.jobId, ...s.result }
  return { status: s.status, jobId: s.jobId, done: s.done, total: s.total }
}

/** The codes a PDF export can fail with (the service's errors); anything else is `failed`. */
const PDF_FAILURE_CODES: ReadonlySet<string> = new Set<CommandErrorCode>([
  'invalid_input',
  'forbidden',
  'not_found',
  'conflict',
  'failed',
])

function asErrorCode(code: string): CommandErrorCode {
  return PDF_FAILURE_CODES.has(code) ? (code as CommandErrorCode) : 'failed'
}

export const deckExportPdf = defineCommand({
  ...serverCommand,
  id: 'deck.exportPdf',
  domain: 'deck',
  title: 'Export slides as PDF',
  description:
    'The deck as one PDF, a page per slide as the editor shows it now (pictures; editable: deck.exportPptx); ' +
    'skipped slides only with `includeSkipped`. A 15-minute bearer link (only for the asker), ' +
    `or \`delivery: "base64"\` (≤ 8 MB). At most ${MAX_PDF_SLIDES} slides, ~1 s each. ` +
    `Waits ≤ ${PDF_EXPORT_WAIT_MS / 1000} s; not done: \`jobId\` + \`status\` queued/running — call again ` +
    'with `jobId` alone. Any deck reader.',
  input: z
    .strictObject({
      slides: z
        .union([z.literal('all'), z.array(SlideRefSchema).min(1).max(MAX_PDF_SLIDES)])
        .optional()
        .describe('"all" (default) or slides in page order'),
      includeSkipped: z.boolean().optional().describe('default false'),
      // The description says it: a link unless `delivery: "base64"`.
      delivery: z.enum(['url', 'base64']).optional(),
      jobId: z.string().min(1).max(64).optional(),
    })
    // A job keeps what it was started with: another value beside its id
    // would be silently ignored.
    .refine(
      (v) =>
        v.jobId === undefined ||
        (v.slides === undefined && v.includeSkipped === undefined && v.delivery === undefined),
      { message: 'jobId alone: its slides, includeSkipped and delivery were set at the start' },
    ),
  output: PdfExportOutput,
  role: 'viewer',
  scope: 'deck',
  effects: ['server'],
  undo: 'n/a',
  confirm: 'never',
  routes: [POST('/decks/:id/export.pdf'), GET('/decks/:id/export.pdf/:jobId')],
  examples: [
    { title: 'The deck as a PDF download link', input: {} },
    { title: 'Wait for an export still running', input: { jobId: 'pdf_8f2k1c' } },
    {
      title: 'Slides 1–3 inline, the skipped ones too',
      input: {
        slides: [{ index: 0 }, { index: 1 }, { index: 2 }],
        includeSkipped: true,
        delivery: 'base64',
      },
    },
  ],
  async handler(ctx, input) {
    const render = requireServices(ctx).render
    const deckId = targetDeckId(ctx)
    const wait = (jobId: string) =>
      render.pdfExportStatus({
        userId: ctx.actor.userId,
        deckId,
        jobId,
        waitMs: PDF_EXPORT_WAIT_MS,
      })
    if (input.jobId !== undefined) return pdfOutput(await wait(input.jobId))
    const slides = input.slides ?? 'all'
    const started = await render.startPdfExport({
      userId: ctx.actor.userId,
      deckId,
      slides: slides === 'all' ? 'all' : slides.map(toRenderRef),
      includeSkipped: input.includeSkipped ?? false,
      delivery: input.delivery ?? 'url',
    })
    if (started.status === 'done' || started.status === 'failed') return pdfOutput(started)
    return pdfOutput(await wait(started.jobId))
  },
})

const RegionSchema = z
  .strictObject({
    x: z.number().min(0).max(1920),
    y: z.number().min(0).max(1080),
    width: z.number().positive().max(1920),
    height: z.number().positive().max(1080),
  })
  .describe('A part of `slide`, in slide px')

export const queryRender = defineCommand({
  ...serverCommand,
  id: 'query.render',
  domain: 'query',
  title: 'Look at slides',
  description:
    'See slides as they really look — the image comes back to you (fonts, pictures, layout as the editor ' +
    'draws them, seconds-old edits included). Look after every visible change before you report it done. ' +
    '`slide`: the whole slide (1430×804). `slide` + `region` (slide px): that part at full resolution, for ' +
    'small type, a table or an alignment. `slides` ("all" or a list, at most 20): one numbered contact sheet, ' +
    'for pacing and repetition. `slide` + `compare: "before"`: the slide before your current run first ' +
    'changed it, beside it now (`newSlide`: your run added it). `overflow`: text boxes whose text runs below ' +
    'the box with the real fonts — fix those you caused. `failedLoads` counts missing pictures per slide; ' +
    '`failedFonts` names fonts that fell back. A few seconds the first time on a deck, about a second after. ' +
    'Files for the user: deck.exportPng. Any deck reader.',
  input: z
    .strictObject({
      slide: SlideRefSchema.optional().describe('The slide to look at'),
      region: RegionSchema.optional(),
      slides: z
        .union([z.literal('all'), z.array(SlideRefSchema).min(1).max(MAX_RENDER_SLIDES)])
        .optional()
        .describe('Slides for one contact sheet: "all" (a deck of at most 20) or a list'),
      compare: z.literal('before').optional(),
    })
    .refine((v) => (v.slide === undefined) !== (v.slides === undefined), {
      message: 'Give either slide or slides',
    })
    .refine((v) => v.region === undefined || v.slide !== undefined, {
      message: 'region needs slide',
    })
    .refine((v) => v.compare === undefined || (v.slide !== undefined && v.region === undefined), {
      message: 'compare needs slide, and no region',
    }),
  output: z.object({
    mode: z.enum(['slide', 'region', 'sheet', 'compare']),
    width: z.number(),
    height: z.number(),
    slides: z.array(z.object({ slideId: z.string(), index: z.number(), failedLoads: z.number() })),
    overflow: z.array(
      z.object({
        slideId: z.string(),
        index: z.number(),
        objectId: z.string(),
        boxHeight: z.number(),
        textHeight: z.number(),
      }),
    ),
    overflowTruncated: z.boolean().optional(),
    newSlide: z.boolean().optional(),
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
    {
      title: 'Show the title slide before and after your changes',
      input: { slide: { index: 0 }, compare: 'before' },
    },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).render.look({
      userId: ctx.actor.userId,
      deckId: targetDeckId(ctx),
      view:
        input.slides !== undefined
          ? { sheet: input.slides === 'all' ? 'all' : input.slides.map(toRenderRef) }
          : input.compare !== undefined
            ? { compare: toRenderRef(input.slide!), runId: ctx.run?.runId ?? null }
            : {
                slide: toRenderRef(input.slide!),
                ...(input.region !== undefined ? { region: input.region } : {}),
              },
    })
  },
})

export const deckRefreshThumbnail = defineCommand({
  ...serverCommand,
  id: 'deck.refreshThumbnail',
  domain: 'deck',
  title: 'Redraw the deck card',
  description:
    'Redraw the card picture the folder page shows for the deck (or for a master, componentId) from the first ' +
    'slide, now. The card follows changes by itself (from the editor while the deck is open, else about 15 s ' +
    'after the last change, at most once a minute); call this only when it must be right at once (before ' +
    'sending someone to the folder). Returns the picture’s URL. Takes a few seconds. Deck editors (a master: ' +
    "its folder's).",
  input: z.strictObject({}),
  output: z.object({
    thumbnailUrl: z.string(),
    updatedAt: z.string().describe('ISO 8601 timestamp'),
  }),
  role: 'editor',
  scope: 'deck',
  // A master's card too; its folder's editors redraw it.
  acceptsComponent: true,
  roleOn: { component: 'editor' },
  effects: ['server'],
  undo: 'n/a',
  confirm: 'never',
  routes: [PUT('/decks/:id/thumbnail'), PUT('/components/:id/thumbnail')],
  examples: [{ title: 'Redraw the card after reworking the title slide', input: {} }],
  async handler(ctx) {
    return requireServices(ctx).render.refreshThumbnail({
      userId: ctx.actor.userId,
      target: targetDocument(ctx),
    })
  },
})

export const renderCommands = [deckExportPng, deckExportPdf, queryRender, deckRefreshThumbnail]
