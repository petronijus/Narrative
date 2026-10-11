/**
 * services/render.ts — slides of a live deck rendered to PNG by the render
 * worker (agentic A3, docs/plans/a3-render-worker.md; apps/render-worker).
 *
 * For one request: check the caller may read the deck, pick the slides from
 * the LIVE document (what open editors see now), and give the worker one job
 * with everything it may use and nothing more — the render session's token
 * for this person and deck (render/sessions.ts, auth/renderTokens.ts: the page
 * reads the deck with it, as the caller's guest, and the worker keeps that
 * page for the session's next job), the live document's state vector (the
 * page draws once it holds those edits), and one presigned PUT URL per
 * picture (it holds no storage credentials; the URL signs the object's type
 * and caching too). Then wait until the deadline; what comes back is checked
 * to be a PNG before it is passed on. The PNGs land under
 * `decks/<id>/exports/<job>/`, where the export sweep (services/exportSweep.ts)
 * removes them after a day; a caller gets them as presigned links (15
 * minutes), inline, or — the editor's download — as the stored object.
 *
 * The worker renders one job at a time, so the queue is shared by everyone,
 * and kept fair three ways:
 *   - a person (or an agent loop) may have `MAX_IN_FLIGHT_PER_USER` renders
 *     waiting or running, and the queue takes no new job past
 *     `MAX_WAITING_JOBS`;
 *   - a job's priority is the number of slides its caller has in flight with
 *     it (lower runs first): someone asking for one slide goes ahead of
 *     someone with twenty queued;
 *   - the worker spends at most `RENDER_WORK_BASE_MS` + `RENDER_WORK_PER_SLIDE_MS`
 *     per slide on a job once it starts (≤ 70 s for 20 slides), however long
 *     it waited.
 * Every caller waits at most `RENDER_WAIT_MS`, under Cloudflare's 100 s origin
 * timeout (an answer, never a 524 page): a one-slide request behind a running
 * twenty-slide job still fits (70 s + 22.5 s).
 *
 * A deck's card picture (`refreshThumbnail`, and `backgroundThumbnail` for
 * services/deckThumbnails.ts) is a `thumbnail` look of its first slide,
 * checked and then stored like the editor's upload
 * (services/deckThumbnailStore.ts). The background ones nobody waits for run
 * behind every person's job (`BACKGROUND_PRIORITY`) and take no one's
 * in-flight share.
 */

import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { listSlides } from '@narrative/slide-model'
import * as Y from 'yjs'
import {
  parseRenderFailure,
  type RenderJobData,
  type RenderJobResult,
  type RenderLookSpec,
  type RenderedSlide,
} from '@narrative/shared'
import { MAX_RENDER_SLIDES } from '@narrative/commands'
import type {
  PngExportResult,
  RenderLookResult,
  RenderService,
  RenderSlideRef,
  RenderView,
  RenderedPngInfo,
} from '@narrative/commands'
import { resolveDeckAccess } from '../auth/permissions.js'
import { deckRecord } from './decks.js'
import { storeDeckThumbnail, ThumbnailStorageError } from './deckThumbnailStore.js'
import { buildS3Client, MEDIA_BUCKET, presignGetUrl, presignPutUrl } from '../media/s3Client.js'
import {
  clearRenderSessionsForTests,
  endRenderSession,
  sessionJobEnded,
  sessionTokenFor,
} from '../render/sessions.js'
import {
  bullRenderQueue,
  RenderTimeoutError,
  RenderUnavailableError,
  type RenderQueue,
} from '../render/queue.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, failed, forbidden, notFound, ServiceError, tooLarge } from './errors.js'
import { cardDrawnFrom, cardSourceOf, noteCardDrawn } from '../render/cardState.js'
import { readDocCopy } from './liveDocs.js'
import { EXPORT_URL_TTL_SEC, MAX_INLINE_EXPORT_BYTES } from './pptx.js'

/** How long a caller waits for its render, queueing included (Cloudflare gives up at 100 s). */
export const RENDER_WAIT_MS = 95_000
/**
 * What the worker may spend on a job once it starts: a cold browser and the
 * page, then each slide — up to about 2.5 s for one whose pictures imgproxy
 * has not resized yet (measured 2026-10-10: ~1.8 s per slide of fresh
 * 800×600 photos; a warm one-slide job ~1.7 s in all).
 */
export const RENDER_WORK_BASE_MS = 20_000
export const RENDER_WORK_PER_SLIDE_MS = 2_500
/** How long a job's render token outlives the job's deadline. */
const TOKEN_MARGIN_MS = 60_000
/** Renders one user may have waiting or running at once. */
export const MAX_IN_FLIGHT_PER_USER = 2
/**
 * Under BYPASS_AUTH (development only): the e2e suite runs as one identity in
 * several parallel browsers, far above what one person does — the same reason
 * the rate limiter gives dev identities their own budget (http/rateLimit.ts).
 */
export const MAX_IN_FLIGHT_DEV = 8
/** Jobs the queue holds before it refuses new ones. */
export const MAX_WAITING_JOBS = 20
/**
 * The renderer could not take the job (busy, unavailable, or the job waited
 * in the queue past its time) — worth asking again later, unlike a job that
 * failed on its page.
 */
export class RendererBusyError extends ServiceError {}
const busy = (message: string, status: 503 | 504): RendererBusyError =>
  new RendererBusyError('failed', status, message)

/** A job nobody waits for: after every person's (BullMQ: lower runs first; at most 2^21). */
export const BACKGROUND_PRIORITY = 1_000_000
/** A card picture is 400×225: far below this, whatever the slide. */
const MAX_THUMBNAIL_BYTES = 1_000_000

export interface RenderServiceDeps extends ServiceDeps {
  /** The worker's queue; the process-wide BullMQ queue unless a test passes one. */
  renderQueue?: RenderQueue
  /** The clock (tests). */
  now?: () => number
}

/** A rendered slide and where its PNG is stored. */
export interface StoredRender extends RenderedSlide {
  key: string
}

/** A render kept in storage: its slides, and the font families that failed to load for it. */
export interface StoredRenders {
  slides: StoredRender[]
  failedFonts: string[]
}

/** Renders (jobs) and their slides in flight per user, in this process (the only one that renders). */
const inFlight = new Map<string, { jobs: number; slides: number }>()

/**
 * The slides `refs` name in `slides` (id + 0-based index), in the order asked,
 * each once; not_found for any other.
 */
export function pickSlides(
  slides: ReadonlyArray<{ id: string }>,
  refs: RenderSlideRef[] | 'all',
): Array<{ id: string; index: number }> {
  if (refs === 'all') return slides.map((s, index) => ({ id: s.id, index }))
  const picked: Array<{ id: string; index: number }> = []
  for (const ref of refs) {
    const index = 'index' in ref ? ref.index : slides.findIndex((s) => s.id === ref.id)
    const slide = index >= 0 ? slides[index] : undefined
    if (slide === undefined) {
      throw notFound(
        'index' in ref
          ? `Slide index ${ref.index} is out of range (the deck has ${slides.length} slides)`
          : `Slide ${ref.id} not found`,
      )
    }
    if (!picked.some((p) => p.id === slide.id)) picked.push({ id: slide.id, index })
  }
  return picked
}

/** The largest look the render page composes (pages/renderLook.ts MAX_LOOK_BYTES), with slack. */
const MAX_LOOK_BYTES = 4_000_000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * A PNG the worker stored, read back and deleted — refused when it is larger than
 * `maxBytes` or not a PNG: the presigned upload signs the type, not the
 * bytes, so the server does not take the worker's word for what it holds
 * before passing it on as an image.
 */
async function readStoredPng(key: string, maxBytes: number): Promise<Uint8Array> {
  const s3 = buildS3Client()
  const object = await s3.send(new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }))
  let bytes: Uint8Array
  try {
    if (object.ContentLength !== undefined && object.ContentLength > maxBytes) {
      throw failed('The renderer returned an image that is too large', 503)
    }
    bytes = await object.Body!.transformToByteArray()
  } finally {
    // A picture handed back inline is read once: it does not wait a day for
    // the export sweep (best effort — the sweep still gets a stray one).
    void s3.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: key })).catch(() => undefined)
  }
  if (bytes.byteLength > maxBytes || !PNG_SIGNATURE.equals(Buffer.from(bytes.subarray(0, 8)))) {
    throw failed('The renderer returned something that is not a PNG', 503)
  }
  return bytes
}

/** A job before its render session's token is added (distributed over the job kinds). */
type JobWithoutToken<T> = T extends unknown ? Omit<T, 'token'> : never

/** What one job asks of the worker, before the slot, the session and the clocks are added. */
type JobRequest =
  | { kind: 'export'; uploads: Array<{ slideId: string; key: string }> }
  | { kind: 'look'; look: RenderLookSpec; key: string }

/** What a background card picture came to. */
export type BackgroundThumbnailOutcome =
  | { status: 'stored' }
  /** The first slide is as it was when the card was last drawn (render/cardState.ts). */
  | { status: 'unchanged' }
  | { status: 'no-slides' }
  /** The deck is gone. */
  | { status: 'gone' }
  /** Not stored: by the time it was drawn, someone had the deck open (`stillWanted`). */
  | { status: 'superseded' }

export function createRenderService(deps: RenderServiceDeps): RenderService & {
  /** Render and keep the PNGs in storage; the keys, for the editor's download route. */
  renderStored(args: {
    userId: string
    deckId: string
    slides: RenderSlideRef[] | 'all'
  }): Promise<StoredRenders>
  /**
   * The deck's card picture for a deck nobody has open, drawn as `userId`
   * (its owner) behind everyone's jobs; skipped when its first slide is as
   * it was drawn last, and not stored when `stillWanted` says no by then.
   */
  backgroundThumbnail(args: {
    userId: string
    deckId: string
    stillWanted?: () => boolean
  }): Promise<BackgroundThumbnailOutcome>
} {
  const { db } = deps
  const queue = deps.renderQueue ?? bullRenderQueue
  const now = deps.now ?? Date.now

  /** The caller may read the deck; its slides and state vector, from the live document. */
  async function liveDeck(
    args: { userId: string; deckId: string },
    opts: { card?: boolean } = {},
  ): Promise<{
    role: 'viewer' | 'editor' | 'owner'
    slides: Array<{ id: string }>
    stateVector: string
    /** What the deck's card shows (render/cardState.ts), when asked for; null without slides. */
    cardSource: string | null
  }> {
    const access = await resolveDeckAccess(db, { deckId: args.deckId, userId: args.userId })
    if (!access) throw forbidden()
    const doc = await readDocCopy(deps, 'deck', args.deckId)
    try {
      return {
        role: access.role,
        slides: listSlides({ doc, slides: doc.getArray('slides') }).map((s) => ({ id: s.id })),
        stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
        cardSource: opts.card === true ? cardSourceOf(doc) : null,
      }
    } finally {
      doc.destroy()
    }
  }

  /**
   * One job for the worker: a fair share of the queue (`slides` weighs it),
   * presigned uploads, the session's token, the live state vector and both
   * clocks; the worker's failure mapped for the caller.
   */
  async function runJob(
    args: { userId: string; deckId: string },
    slides: number,
    stateVector: string,
    request: JobRequest,
    opts: { background?: boolean } = {},
  ): Promise<RenderJobResult> {
    // The shared queue: a fair share per person (the slot is taken here,
    // synchronously, so concurrent requests cannot all pass the check), and a
    // bound overall. A background job takes nobody's share and goes last.
    const background = opts.background === true
    const mine = inFlight.get(args.userId) ?? { jobs: 0, slides: 0 }
    if (
      !background &&
      mine.jobs >= (deps.bypass === true ? MAX_IN_FLIGHT_DEV : MAX_IN_FLIGHT_PER_USER)
    ) {
      throw failed(
        `You have ${mine.jobs} renders in progress; wait for them to finish, then ask again`,
        429,
      )
    }
    const held = { jobs: mine.jobs + 1, slides: mine.slides + slides }
    if (!background) inFlight.set(args.userId, held)
    try {
      let waiting: number
      try {
        waiting = await queue.waiting()
      } catch {
        throw busy('The renderer is unavailable right now; try again shortly', 503)
      }
      if (waiting >= MAX_WAITING_JOBS) {
        throw busy('The renderer is busy right now; try again in a minute', 503)
      }
      const deadline = now() + RENDER_WAIT_MS
      const workBudgetMs = RENDER_WORK_BASE_MS + RENDER_WORK_PER_SLIDE_MS * slides
      const uploadTtlSec = Math.ceil((RENDER_WAIT_MS + TOKEN_MARGIN_MS) / 1000)
      const target = (key: string) => presignPutUrl(key, 'image/png', uploadTtlSec)
      const base = {
        deckId: args.deckId,
        stateVector,
        deadline,
        workBudgetMs,
        // Background work leaves people's warm pages where they are.
        ...(background ? { keepPage: false } : {}),
      }
      const job: JobWithoutToken<RenderJobData> =
        request.kind === 'export'
          ? {
              ...base,
              kind: 'export',
              uploads: await Promise.all(
                request.uploads.map(async (u) => ({
                  slideId: u.slideId,
                  ...(await target(u.key)),
                })),
              ),
            }
          : { ...base, kind: 'look', look: request.look, upload: await target(request.key) }
      const token = sessionTokenFor(
        { ...args, lane: background ? 'background' : 'person' },
        RENDER_WAIT_MS + TOKEN_MARGIN_MS,
        now(),
      )
      try {
        return await queue.run(
          { ...job, token },
          { priority: background ? BACKGROUND_PRIORITY : held.slides },
        )
      } catch (err) {
        const mapped = await mapFailure(err, args)
        // The page was refused: whatever the reason, that session is over.
        if (parseRenderFailure(err instanceof Error ? err.message : '') === 'access-refused') {
          endRenderSession(token)
        }
        throw mapped
      } finally {
        sessionJobEnded(token, now())
      }
    } finally {
      if (!background) release(args.userId, slides)
    }
  }

  /** Give back a person's in-flight share of one job. */
  function release(userId: string, slides: number): void {
    const current = inFlight.get(userId)
    const left = {
      jobs: (current?.jobs ?? 1) - 1,
      slides: (current?.slides ?? slides) - slides,
    }
    if (left.jobs > 0) inFlight.set(userId, left)
    else inFlight.delete(userId)
  }

  async function renderStored(args: {
    userId: string
    deckId: string
    slides: RenderSlideRef[] | 'all'
  }): Promise<StoredRenders> {
    const deck = await liveDeck(args)
    const chosen = pickSlides(deck.slides, args.slides)
    if (chosen.length === 0) throw badRequest('The deck has no slides to render')
    if (chosen.length > MAX_RENDER_SLIDES) {
      throw tooLarge(
        `That is ${chosen.length} slides; one request renders at most ${MAX_RENDER_SLIDES} — ask for them in parts`,
      )
    }
    const prefix = `decks/${args.deckId}/exports/${nanoid(16)}/`
    const keys = new Map(chosen.map((s) => [s.id, `${prefix}slide-${s.index + 1}.png`]))
    const result = await runJob(args, chosen.length, deck.stateVector, {
      kind: 'export',
      uploads: chosen.map((s) => ({ slideId: s.id, key: keys.get(s.id)! })),
    })
    if (result.kind !== 'export') throw failed('The renderer answered another job', 503)
    return {
      slides: result.slides.map((s) => ({ ...s, key: keys.get(s.slideId)! })),
      failedFonts: result.failedFonts,
    }
  }

  async function look(args: {
    userId: string
    deckId: string
    view: RenderView
  }): Promise<RenderLookResult> {
    const deck = await liveDeck(args)
    let spec: RenderLookSpec
    let weight: number
    if ('sheet' in args.view) {
      const chosen = pickSlides(deck.slides, args.view.sheet)
      if (chosen.length === 0) throw badRequest('The deck has no slides to look at')
      if (chosen.length > MAX_RENDER_SLIDES) {
        throw tooLarge(
          `That is ${chosen.length} slides; a sheet shows at most ${MAX_RENDER_SLIDES} — ask for them in parts`,
        )
      }
      spec = { mode: 'sheet', slideIds: chosen.map((s) => s.id) }
      weight = chosen.length
    } else {
      const [one] = pickSlides(deck.slides, [args.view.slide])
      if (one === undefined) throw badRequest('The deck has no slides to look at')
      spec =
        args.view.region === undefined
          ? { mode: 'slide', slideId: one.id }
          : { mode: 'region', slideId: one.id, region: args.view.region }
      weight = 1
    }
    const key = `decks/${args.deckId}/exports/${nanoid(16)}/look.png`
    const result = await runJob(args, weight, deck.stateVector, { kind: 'look', look: spec, key })
    if (result.kind !== 'look') throw failed('The renderer answered another job', 503)
    const bytes = await readStoredPng(key, MAX_LOOK_BYTES)
    return {
      mode: spec.mode,
      width: result.look.width,
      height: result.look.height,
      slides: result.look.slides,
      failedFonts: result.failedFonts,
      image: { mimeType: 'image/png', base64: Buffer.from(bytes).toString('base64') },
    }
  }

  /**
   * Draw the first slide as the deck's card picture and store it; the deck
   * row after, or null when the deck was deleted meanwhile.
   */
  async function drawThumbnail(
    args: { userId: string; deckId: string },
    deck: { slides: Array<{ id: string }>; stateVector: string; cardSource: string | null },
    opts: { background: boolean; stillWanted?: () => boolean },
  ): Promise<{ status: 'stored'; record: ReturnType<typeof deckRecord> } | { status: 'gone' | 'superseded' }> {
    const first = deck.slides[0]!
    const key = `decks/${args.deckId}/exports/${nanoid(16)}/thumb.png`
    const result = await runJob(
      args,
      1,
      deck.stateVector,
      { kind: 'look', look: { mode: 'thumbnail', slideId: first.id }, key },
      { background: opts.background },
    )
    if (result.kind !== 'look') throw failed('The renderer answered another job', 503)
    const bytes = await readStoredPng(key, MAX_THUMBNAIL_BYTES)
    // A background card may have waited a while: someone who opened the
    // deck meanwhile uploads a newer one, which this must not replace.
    if (opts.stillWanted?.() === false) return { status: 'superseded' }
    let row
    try {
      row = await storeDeckThumbnail(db, args.deckId, { bytes, mime: 'image/png' })
    } catch (err) {
      if (!(err instanceof ThumbnailStorageError)) throw err
      deps.log.error({ deckId: args.deckId, err: err.message }, 'render: storing the card failed')
      throw failed('Storing the card picture failed; try again shortly', 503)
    }
    if (row === null) return { status: 'gone' }
    if (deck.cardSource !== null) noteCardDrawn(args.deckId, deck.cardSource)
    return { status: 'stored', record: deckRecord(row) }
  }

  async function refreshThumbnail(args: {
    userId: string
    deckId: string
  }): Promise<{ thumbnailUrl: string; updatedAt: string }> {
    const deck = await liveDeck(args, { card: true })
    // The card is the deck's face on the folder page: its editors redraw it.
    if (deck.role === 'viewer') throw forbidden('Only editors of the deck can redraw its card')
    if (deck.slides.length === 0) throw badRequest('The deck has no slides to draw its card from')
    const drawn = await drawThumbnail(args, deck, { background: false })
    if (
      drawn.status !== 'stored' ||
      drawn.record.thumbnailUrl === null ||
      drawn.record.thumbnailUpdatedAt === null
    ) {
      throw notFound('The deck was deleted')
    }
    return { thumbnailUrl: drawn.record.thumbnailUrl, updatedAt: drawn.record.thumbnailUpdatedAt }
  }

  async function backgroundThumbnail(args: {
    userId: string
    deckId: string
    stillWanted?: () => boolean
  }): Promise<BackgroundThumbnailOutcome> {
    const deck = await liveDeck(args, { card: true })
    if (deck.cardSource === null) return { status: 'no-slides' }
    if (cardDrawnFrom(args.deckId) === deck.cardSource) return { status: 'unchanged' }
    const drawn = await drawThumbnail(args, deck, {
      background: true,
      ...(args.stillWanted !== undefined ? { stillWanted: args.stillWanted } : {}),
    })
    return drawn.status === 'stored' ? { status: 'stored' } : { status: drawn.status }
  }

  /** What the caller hears when a job fails. */
  async function mapFailure(
    err: unknown,
    args: { userId: string; deckId: string },
  ): Promise<Error> {
    if (err instanceof RenderTimeoutError) {
      // Still waiting for its turn: busy. Started and not done: the slide is slow.
      return err.started
        ? failed('The render did not finish in time', 504)
        : busy('The render did not finish in time', 504)
    }
    if (err instanceof RenderUnavailableError) {
      deps.log.warn({ deckId: args.deckId, err: err.message }, 'render: queue unavailable')
      return busy('The renderer is unavailable right now; try again shortly', 503)
    }
    const message = err instanceof Error ? err.message : String(err)
    switch (parseRenderFailure(message)) {
      // The deck changed between picking and rendering.
      case 'slide-not-found':
        return notFound('A slide was removed while it was being rendered; ask again')
      case 'empty-deck':
        return badRequest('The deck has no slides to render')
      case 'access-refused': {
        // Refused for real (the caller lost access during the job), or a
        // renderer-side problem with the token: only the first is a 403.
        const still = await resolveDeckAccess(db, { deckId: args.deckId, userId: args.userId })
        if (!still) return forbidden()
        deps.log.error({ deckId: args.deckId, err: message }, 'render: the page was refused')
        return failed('The render failed', 503)
      }
      // It waited too long for its turn.
      case 'late':
        return busy('The render did not finish in time', 504)
      case 'deadline':
        return failed('The render did not finish in time', 504)
      default:
        deps.log.error({ deckId: args.deckId, err: message }, 'render: job failed')
        return failed('The render failed', 503)
    }
  }

  const info = (s: StoredRender): RenderedPngInfo => ({
    slideId: s.slideId,
    index: s.index,
    width: s.width,
    height: s.height,
    sizeBytes: s.sizeBytes,
    failedLoads: s.failedLoads,
  })

  async function exportPng(args: {
    userId: string
    deckId: string
    slides: RenderSlideRef[] | 'all'
    delivery: 'url' | 'base64'
  }): Promise<PngExportResult> {
    const { slides: rendered, failedFonts } = await renderStored(args)
    if (args.delivery === 'base64') {
      const total = rendered.reduce((sum, s) => sum + s.sizeBytes, 0)
      if (total > MAX_INLINE_EXPORT_BYTES) {
        throw tooLarge(
          `The images are ${total} bytes together, over the ${MAX_INLINE_EXPORT_BYTES}-byte inline limit; ` +
            'use delivery "url" or fewer slides',
        )
      }
      const slides = await Promise.all(
        rendered.map(async (s) => {
          const bytes = await readStoredPng(s.key, MAX_INLINE_EXPORT_BYTES)
          return { ...info(s), base64: Buffer.from(bytes).toString('base64') }
        }),
      )
      return { delivery: 'base64', slides, failedFonts }
    }
    const expiresAt = new Date(now() + EXPORT_URL_TTL_SEC * 1000).toISOString()
    const slides = await Promise.all(
      rendered.map(async (s) => ({
        ...info(s),
        url: await presignGetUrl(s.key, EXPORT_URL_TTL_SEC),
      })),
    )
    return { delivery: 'url', slides, expiresAt, failedFonts }
  }

  return { exportPng, renderStored, look, refreshThumbnail, backgroundThumbnail }
}

/** Test helper: forget the in-flight counts. */
export function clearRenderInFlightForTests(): void {
  inFlight.clear()
  clearRenderSessionsForTests()
}
