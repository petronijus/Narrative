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

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { listSlides } from '@narrative/slide-model'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import {
  parseRenderFailure,
  type RenderJobData,
  type RenderJobResult,
  type RenderLookSpec,
  type RenderPage,
  type RenderedSlide,
} from '@narrative/shared'
import { MAX_MEASURE_SLIDES, MAX_RENDER_SLIDES } from '@narrative/commands'
import type {
  TextMeasurement,
  PngExportResult,
  RenderLookResult,
  RenderService,
  RenderSlideRef,
  RenderView,
  RenderedPngInfo,
} from '@narrative/commands'
import { resolveComponentAccess, resolveDeckAccess } from '../auth/permissions.js'
import { components } from '../db/schema.js'
import { componentRecord } from './components.js'
import { deckRecord } from './decks.js'
import {
  storeComponentThumbnail,
  storeDeckThumbnail,
  ThumbnailStorageError,
  type CardRef,
} from './deckThumbnailStore.js'
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
import { MAX_BEFORE_STATE_BYTES } from './runs.js'
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
  /** The deck or the master is gone. */
  | { status: 'gone' }
  /** Not stored: by the time it was drawn, someone had it open (`stillWanted`). */
  | { status: 'superseded' }

/** A live document the worker renders: what it holds now, and the page that shows it. */
interface LiveDoc {
  card: CardRef
  page: RenderPage
  role: 'viewer' | 'editor' | 'owner'
  slides: Array<{ id: string }>
  stateVector: string
  /** What its card shows (render/cardState.ts), when asked for; null without slides. */
  cardSource: string | null
}

/** Overflowing text boxes a look reports at most (the rest: `overflowTruncated`). */
export const MAX_OVERFLOW_REPORTED = 50

/** Where a render job's pictures wait to be read back (the export sweep removes strays). */
const exportsPrefix = (card: CardRef): string =>
  `${card.kind === 'deck' ? 'decks' : 'components'}/${card.id}/exports/${nanoid(16)}/`

export function createRenderService(deps: RenderServiceDeps): RenderService & {
  /** Render and keep the PNGs in storage; the keys, for the editor's download route. */
  renderStored(args: {
    userId: string
    deckId: string
    slides: RenderSlideRef[] | 'all'
  }): Promise<StoredRenders>
  /**
   * The card picture of a deck or master nobody has open, drawn as `userId`
   * (the deck's owner, the master's folder's owner) behind everyone's jobs;
   * skipped when its first slide is as it was drawn last, and not stored
   * when `stillWanted` says no by then.
   */
  backgroundThumbnail(args: {
    userId: string
    card: CardRef
    stillWanted?: () => boolean
  }): Promise<BackgroundThumbnailOutcome>
} {
  const { db } = deps
  const queue = deps.renderQueue ?? bullRenderQueue
  const now = deps.now ?? Date.now

  /** The caller may read it; its slides and state vector, from the live document. */
  async function live(
    userId: string,
    card: CardRef,
    opts: { cardSource?: boolean } = {},
  ): Promise<LiveDoc> {
    let role: LiveDoc['role']
    let page: RenderPage
    if (card.kind === 'deck') {
      const access = await resolveDeckAccess(db, { deckId: card.id, userId })
      if (!access) throw forbidden()
      role = access.role
      page = { kind: 'deck', deckId: card.id }
    } else {
      const access = await resolveComponentAccess(db, { componentId: card.id, userId })
      const [row] = await db
        .select({ folderId: components.folderId })
        .from(components)
        .where(eq(components.id, card.id))
        .limit(1)
      if (!access || row === undefined) throw forbidden()
      role = access.role
      page = { kind: 'component', componentId: card.id, folderId: row.folderId }
    }
    const doc = await readDocCopy(deps, card.kind, card.id)
    try {
      return {
        card,
        page,
        role,
        slides: listSlides({ doc, slides: doc.getArray('slides') }).map((s) => ({ id: s.id })),
        stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
        cardSource: opts.cardSource === true ? cardSourceOf(doc) : null,
      }
    } finally {
      doc.destroy()
    }
  }

  const liveDeck = (args: { userId: string; deckId: string }) =>
    live(args.userId, { kind: 'deck', id: args.deckId })

  /**
   * One job for the worker: a fair share of the queue (`slides` weighs it),
   * presigned uploads, the session's token, the live state vector and both
   * clocks; the worker's failure mapped for the caller.
   */
  async function runJob(
    userId: string,
    doc: Pick<LiveDoc, 'card' | 'page' | 'stateVector'>,
    slides: number,
    request: JobRequest,
    opts: { background?: boolean } = {},
  ): Promise<RenderJobResult> {
    // The shared queue: a fair share per person (the slot is taken here,
    // synchronously, so concurrent requests cannot all pass the check), and a
    // bound overall. A background job takes nobody's share and goes last.
    const background = opts.background === true
    const mine = inFlight.get(userId) ?? { jobs: 0, slides: 0 }
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
    if (!background) inFlight.set(userId, held)
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
        page: doc.page,
        stateVector: doc.stateVector,
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
        { target: doc.card, userId, lane: background ? 'background' : 'person' },
        RENDER_WAIT_MS + TOKEN_MARGIN_MS,
        now(),
      )
      try {
        return await queue.run(
          { ...job, token },
          { priority: background ? BACKGROUND_PRIORITY : held.slides },
        )
      } catch (err) {
        const mapped = await mapFailure(err, userId, doc.card)
        // The page was refused: whatever the reason, that session is over.
        if (parseRenderFailure(err instanceof Error ? err.message : '') === 'access-refused') {
          endRenderSession(token)
        }
        throw mapped
      } finally {
        sessionJobEnded(token, now())
      }
    } finally {
      if (!background) release(userId, slides)
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
    const prefix = exportsPrefix(deck.card)
    const keys = new Map(chosen.map((s) => [s.id, `${prefix}slide-${s.index + 1}.png`]))
    const result = await runJob(args.userId, deck, chosen.length, {
      kind: 'export',
      uploads: chosen.map((s) => ({ slideId: s.id, key: keys.get(s.id)! })),
    })
    if (result.kind !== 'export') throw failed('The renderer answered another job', 503)
    return {
      slides: result.slides.map((s) => ({ ...s, key: keys.get(s.slideId)! })),
      failedFonts: result.failedFonts,
    }
  }

  /**
   * The deck as it was before run `runId` first changed it, for a compare:
   * the caller's own run on this very deck.
   */
  function stateBeforeRun(deckId: string, runId: string | null): Uint8Array {
    const before = runId === null ? null : (deps.runs?.stateBefore(runId) ?? null)
    if (before === null) {
      throw badRequest(
        'Nothing to compare yet: your current run has not changed this deck (or its history is gone)',
      )
    }
    if (before.document.kind !== 'deck' || before.document.deckId !== deckId) {
      throw badRequest('Your current run changed another document, not this deck')
    }
    if (before.update.byteLength > MAX_BEFORE_STATE_BYTES) {
      throw tooLarge('The deck is too large to compare with how it was')
    }
    return before.update
  }

  /**
   * Store a compare's "before" state for its job, read back by the worker
   * through a presigned GET (it never travels in the queue); the key, to
   * delete once the job is over (the export sweep takes a stray one).
   */
  async function stageBefore(
    card: CardRef,
    update: Uint8Array,
  ): Promise<{ key: string; url: string }> {
    const key = `${exportsPrefix(card)}before.bin`
    await buildS3Client().send(
      new PutObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: key,
        Body: update,
        ContentType: 'application/octet-stream',
        CacheControl: 'private, no-store',
      }),
    )
    const ttlSec = Math.ceil((RENDER_WAIT_MS + TOKEN_MARGIN_MS) / 1000)
    return { key, url: await presignGetUrl(key, ttlSec) }
  }

  async function look(args: {
    userId: string
    deckId: string
    view: RenderView
  }): Promise<RenderLookResult> {
    const deck = await liveDeck(args)
    let spec: Exclude<RenderLookSpec, { mode: 'thumbnail' }>
    let weight: number
    let staged: string | null = null
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
    } else if ('compare' in args.view) {
      const [one] = pickSlides(deck.slides, [args.view.compare])
      if (one === undefined) throw badRequest('The deck has no slides to look at')
      const before = await stageBefore(deck.card, stateBeforeRun(args.deckId, args.view.runId))
      staged = before.key
      spec = { mode: 'compare', slideId: one.id, before: { url: before.url } }
      // Two pages and two slides: the frozen "before" page, then the live one.
      weight = 4
    } else {
      const [one] = pickSlides(deck.slides, [args.view.slide])
      if (one === undefined) throw badRequest('The deck has no slides to look at')
      spec =
        args.view.region === undefined
          ? { mode: 'slide', slideId: one.id }
          : { mode: 'region', slideId: one.id, region: args.view.region }
      weight = 1
    }
    const key = `${exportsPrefix(deck.card)}look.png`
    let result: RenderJobResult
    try {
      result = await runJob(args.userId, deck, weight, { kind: 'look', look: spec, key })
    } finally {
      if (staged !== null) {
        const stale = staged
        void buildS3Client()
          .send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: stale }))
          .catch(() => undefined)
      }
    }
    if (result.kind !== 'look') throw failed('The renderer answered another job', 503)
    const bytes = await readStoredPng(key, MAX_LOOK_BYTES)
    const indexOf = new Map(deck.slides.map((s, i) => [s.id, i]))
    const overflow = result.look.overflow ?? []
    return {
      mode: spec.mode,
      width: result.look.width,
      height: result.look.height,
      slides: result.look.slides,
      // A bounded answer for the model, however many boxes a sheet holds.
      overflow: overflow.slice(0, MAX_OVERFLOW_REPORTED).map((o) => ({
        slideId: o.slideId,
        index: indexOf.get(o.slideId) ?? -1,
        objectId: o.objectId,
        boxHeight: o.boxHeight,
        textHeight: o.textHeight,
      })),
      ...(overflow.length > MAX_OVERFLOW_REPORTED ? { overflowTruncated: true } : {}),
      ...(result.look.newSlide === true ? { newSlide: true } : {}),
      failedFonts: result.failedFonts,
      image: { mimeType: 'image/png', base64: Buffer.from(bytes).toString('base64') },
    }
  }

  /**
   * Draw the first slide as the card picture and store it; the card's URL and
   * time after, or why it was not stored.
   */
  async function drawCard(
    userId: string,
    doc: LiveDoc,
    opts: { background: boolean; stillWanted?: () => boolean },
  ): Promise<
    | { status: 'stored'; thumbnailUrl: string; updatedAt: string }
    | { status: 'gone' | 'superseded' }
  > {
    const first = doc.slides[0]!
    const key = `${exportsPrefix(doc.card)}thumb.png`
    const result = await runJob(
      userId,
      doc,
      1,
      { kind: 'look', look: { mode: 'thumbnail', slideId: first.id }, key },
      { background: opts.background },
    )
    if (result.kind !== 'look') throw failed('The renderer answered another job', 503)
    const bytes = await readStoredPng(key, MAX_THUMBNAIL_BYTES)
    // A background card may have waited a while: someone who opened it
    // meanwhile uploads a newer one, which this must not replace.
    if (opts.stillWanted?.() === false) return { status: 'superseded' }
    const picture = { bytes, mime: 'image/png' } as const
    let stored: { thumbnailUrl: string | null; updatedAt: string | null } | null
    try {
      if (doc.card.kind === 'deck') {
        const row = await storeDeckThumbnail(db, doc.card.id, picture)
        const record = row === null ? null : deckRecord(row)
        stored =
          record === null
            ? null
            : { thumbnailUrl: record.thumbnailUrl, updatedAt: record.thumbnailUpdatedAt }
      } else {
        const row = await storeComponentThumbnail(db, doc.card.id, picture)
        const record = row === null ? null : componentRecord(row)
        stored =
          record === null
            ? null
            : { thumbnailUrl: record.thumbnailUrl, updatedAt: record.updatedAt }
      }
    } catch (err) {
      if (!(err instanceof ThumbnailStorageError)) throw err
      deps.log.error(
        { card: `${doc.card.kind}:${doc.card.id}`, err: err.message },
        'render: storing the card failed',
      )
      throw failed('Storing the card picture failed; try again shortly', 503)
    }
    if (stored === null || stored.thumbnailUrl === null || stored.updatedAt === null) {
      return { status: 'gone' }
    }
    if (doc.cardSource !== null) noteCardDrawn(doc.card, doc.cardSource)
    return { status: 'stored', thumbnailUrl: stored.thumbnailUrl, updatedAt: stored.updatedAt }
  }

  async function refreshThumbnail(args: {
    userId: string
    target: { deckId: string } | { componentId: string }
  }): Promise<{ thumbnailUrl: string; updatedAt: string }> {
    const card: CardRef =
      'deckId' in args.target
        ? { kind: 'deck', id: args.target.deckId }
        : { kind: 'component', id: args.target.componentId }
    const doc = await live(args.userId, card, { cardSource: true })
    // The card is its face on the folder page: its editors redraw it.
    if (doc.role === 'viewer') {
      throw forbidden(
        card.kind === 'deck'
          ? 'Only editors of the deck can redraw its card'
          : 'Only editors of the folder can redraw a master’s card',
      )
    }
    if (doc.slides.length === 0) {
      throw badRequest(
        card.kind === 'deck'
          ? 'The deck has no slides to draw its card from'
          : 'The master has no slide to draw its card from',
      )
    }
    const drawn = await drawCard(args.userId, doc, { background: false })
    if (drawn.status !== 'stored') {
      throw notFound(card.kind === 'deck' ? 'The deck was deleted' : 'The component was deleted')
    }
    return { thumbnailUrl: drawn.thumbnailUrl, updatedAt: drawn.updatedAt }
  }

  async function backgroundThumbnail(args: {
    userId: string
    card: CardRef
    stillWanted?: () => boolean
  }): Promise<BackgroundThumbnailOutcome> {
    const doc = await live(args.userId, args.card, { cardSource: true })
    if (doc.cardSource === null) return { status: 'no-slides' }
    if (cardDrawnFrom(args.card) === doc.cardSource) return { status: 'unchanged' }
    const drawn = await drawCard(args.userId, doc, {
      background: true,
      ...(args.stillWanted !== undefined ? { stillWanted: args.stillWanted } : {}),
    })
    return drawn.status === 'stored' ? { status: 'stored' } : { status: drawn.status }
  }

  /** What the caller hears when a job fails. */
  async function mapFailure(err: unknown, userId: string, card: CardRef): Promise<Error> {
    const where = { [card.kind === 'deck' ? 'deckId' : 'componentId']: card.id }
    if (err instanceof RenderTimeoutError) {
      // Still waiting for its turn: busy. Started and not done: the slide is slow.
      return err.started
        ? failed('The render did not finish in time', 504)
        : busy('The render did not finish in time', 504)
    }
    if (err instanceof RenderUnavailableError) {
      deps.log.warn({ ...where, err: err.message }, 'render: queue unavailable')
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
        const still =
          card.kind === 'deck'
            ? await resolveDeckAccess(db, { deckId: card.id, userId })
            : await resolveComponentAccess(db, { componentId: card.id, userId })
        if (!still) return forbidden()
        deps.log.error({ ...where, err: message }, 'render: the page was refused')
        return failed('The render failed', 503)
      }
      // It waited too long for its turn.
      case 'late':
        return busy('The render did not finish in time', 504)
      case 'deadline':
        return failed('The render did not finish in time', 504)
      default:
        deps.log.error({ ...where, err: message }, 'render: job failed')
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

  /**
   * The text of up to MAX_MEASURE_SLIDES slides, measured in sheets of
   * MAX_RENDER_SLIDES (the sheet's picture is the job's by-product, never
   * read): every overflow, and every growing box's drawn height.
   */
  async function measure(args: {
    userId: string
    deckId: string
    slides: RenderSlideRef[] | 'all'
  }): Promise<TextMeasurement> {
    const deck = await liveDeck(args)
    const chosen = pickSlides(deck.slides, args.slides)
    if (chosen.length === 0) throw badRequest('The deck has no slides to check')
    if (chosen.length > MAX_MEASURE_SLIDES) {
      throw tooLarge(
        `That is ${chosen.length} slides; one check measures at most ${MAX_MEASURE_SLIDES} — ask for them in parts`,
      )
    }
    const key = `${exportsPrefix(deck.card)}measure.png`
    const indexOf = new Map(chosen.map((s) => [s.id, s.index]))
    const out: TextMeasurement = { slides: [], overflow: [], grown: [], failedFonts: [] }
    const fonts = new Set<string>()
    for (let i = 0; i < chosen.length; i += MAX_RENDER_SLIDES) {
      const part = chosen.slice(i, i + MAX_RENDER_SLIDES)
      const result = await runJob(args.userId, deck, part.length, {
        kind: 'look',
        look: { mode: 'sheet', slideIds: part.map((s) => s.id) },
        key,
      })
      if (result.kind !== 'look') throw failed('The renderer answered another job', 503)
      for (const s of result.look.slides) out.slides.push({ slideId: s.slideId, index: s.index })
      for (const o of result.look.overflow ?? [])
        out.overflow.push({
          slideId: o.slideId,
          index: indexOf.get(o.slideId) ?? -1,
          objectId: o.objectId,
          boxHeight: o.boxHeight,
          textHeight: o.textHeight,
        })
      // A renderer older than A4.5 says nothing of growing boxes: not "none".
      if (result.look.grown === undefined) out.grown = null
      else if (out.grown !== null) out.grown.push(...result.look.grown)
      for (const f of result.failedFonts) fonts.add(f)
    }
    out.failedFonts = [...fonts]
    void buildS3Client()
      .send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }))
      .catch(() => undefined)
    return out
  }

  return { exportPng, renderStored, look, measure, refreshThumbnail, backgroundThumbnail }
}

/** Test helper: forget the in-flight counts. */
export function clearRenderInFlightForTests(): void {
  inFlight.clear()
  clearRenderSessionsForTests()
}
