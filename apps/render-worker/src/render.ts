/**
 * render.ts — one render job on the deck's render page
 * (apps/web/src/pages/DeckRender.tsx), in a browser context of its own:
 *
 *   - `export`: each slide shown in turn and captured at 1920×1080
 *     (`__narrativeRenderSlidePng`), uploaded through the presigned URL the
 *     job carries for it;
 *   - `look`: one picture for an agent — a slide, a region or a contact
 *     sheet — composed in the page (`__narrativeRenderLook`) and uploaded.
 *
 * The page opens with the job's render token as `share_token`: it reads the
 * deck like a share-link visitor, read-only, and hides from the deck's
 * collaborators. The token belongs to a render session (a few minutes per
 * person and deck), and the page is kept for the next job of that session
 * (warmPages.ts), so a second job skips loading the app. Before it draws,
 * the page waits until its copy of the deck holds the job's state vector —
 * a page kept from an earlier job included. A slide the page refuses fails
 * the job with that reason (`renderFailureMessage`), which the server maps
 * back (slide not found is the caller's mistake; a renderer fault is not).
 *
 * Two clocks bound a job: its caller's `deadline` and its own work budget
 * (`workBudgetMs` from its start). A job that arrives after its deadline is
 * not started (`late`: nobody waits, and nothing is wrong with the browser);
 * at whichever clock runs out first its context is closed and its upload
 * aborted — a hung page or a wedged upload cannot hold the
 * one-job-at-a-time queue.
 */

import type { Browser, Page } from 'playwright-core'
import {
  RENDER_HEIGHT,
  RENDER_WIDTH,
  renderFailureMessage,
  type RenderFailureReason,
  type RenderJobData,
  type RenderJobResult,
  type RenderLookSpec,
  type RenderTarget,
  type RenderedSlide,
} from '@narrative/shared'
import type { RenderWorkerConfig } from './config.js'
import { installUpstreamRouting, putToUpstream } from './routing.js'
import type { WarmPage, WarmPages } from './warmPages.js'

/** The page's own refusals (apps/web/src/pages/DeckRender.tsx, RenderErrorReason). */
type PageReason = Exclude<RenderFailureReason, 'browser' | 'deadline' | 'late' | 'upload'>

type PageOutcome<T> = { ok: true; value: T } | { ok: false; reason: PageReason; detail: string }

/** What the page's hooks look like from here (the fields used). */
interface RenderWindow {
  __narrativeRender?: { status: string; reason?: PageReason }
  __narrativeRenderSlidePng?: (
    slideId: string,
    opts: { stateVector: string },
  ) => Promise<
    PageOutcome<{ base64: string; slideIndex: number; failedLoads: number; failedFonts: string[] }>
  >
  __narrativeRenderLook?: (
    spec: RenderLookSpec,
    opts: { stateVector: string },
  ) => Promise<
    PageOutcome<{
      base64: string
      width: number
      height: number
      slides: Array<{ slideId: string; index: number; failedLoads: number }>
      failedFonts: string[]
    }>
  >
}

/** A job failure, with the reason the server maps (and whether the browser is suspect). */
export class RenderJobError extends Error {
  constructor(
    readonly reason: RenderFailureReason,
    detail: string,
  ) {
    super(renderFailureMessage(reason, detail))
  }
  /** A browser-side fault: the next job should get a fresh Chromium. */
  get browserSuspect(): boolean {
    return this.reason === 'browser' || this.reason === 'deadline'
  }
}

/** Tokens out of anything that may end up in a job's error or the log. */
export function maskTokens(text: string): string {
  return text
    .replace(/(share_token=)[^&#\s"']*/g, '$1***')
    .replace(/\bnrr_[A-Za-z0-9_-]+/g, 'nrr_***')
    .replace(/(X-Amz-Signature=)[^&#\s"']*/gi, '$1***')
}

export function renderPageUrl(
  appOrigin: string,
  data: Pick<RenderJobData, 'deckId' | 'token'>,
  firstSlideId: string,
): string {
  const url = new URL(`/deck/${encodeURIComponent(data.deckId)}/render`, appOrigin)
  url.searchParams.set('slide', firstSlideId)
  url.searchParams.set('share_token', data.token)
  return url.toString()
}

/** The slide a job shows first (the page opens on it). */
export function firstSlideOf(data: RenderJobData): string | undefined {
  if (data.kind === 'export') return data.uploads[0]?.slideId
  return data.look.mode === 'sheet' ? data.look.slideIds[0] : data.look.slideId
}

/** Milliseconds left before `deadline`, at least 1 (Playwright reads 0 as "no timeout"). */
export function left(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}

/** A job nobody waits for any more is not started. */
export function refuseLate(data: RenderJobData): void {
  if (Date.now() >= data.deadline) {
    throw new RenderJobError('late', 'the job arrived after its deadline; nobody waits for it')
  }
}

function pageFailure(outcome: { reason: PageReason; detail: string }): RenderJobError {
  return new RenderJobError(outcome.reason, maskTokens(outcome.detail).slice(0, 300))
}

/** Open a page for the job: a fresh context, routed, on the render page. */
async function openPage(
  browser: Browser,
  data: RenderJobData,
  firstSlideId: string,
  deps: { config: RenderWorkerConfig; log: (message: string) => void },
  stopAt: number,
  onContext: (context: WarmPage['context']) => void,
): Promise<WarmPage> {
  const context = await browser.newContext({
    viewport: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  })
  onContext(context)
  const pageErrors: string[] = []
  try {
    if (deps.config.upstream !== null) {
      await installUpstreamRouting(context, {
        appOrigin: deps.config.appOrigin,
        upstream: deps.config.upstream,
        log: deps.log,
      })
    }
    const page = await context.newPage()
    page.on('pageerror', (err) => {
      if (pageErrors.length < 10) pageErrors.push(maskTokens(err.message).slice(0, 300))
    })
    await page.goto(renderPageUrl(deps.config.appOrigin, data, firstSlideId), {
      waitUntil: 'domcontentloaded',
      timeout: left(stopAt),
    })
    return { deckId: data.deckId, context, page, pageErrors }
  } catch (err) {
    await context.close().catch(() => undefined)
    throw err
  }
}

/** Until the page's hooks are installed (the app mounted), or it refused the deck. */
async function untilHooks(page: Page, stopAt: number): Promise<void> {
  const handle = await page.waitForFunction(
    () => {
      const w = window as unknown as RenderWindow
      if (typeof w.__narrativeRenderLook === 'function') return { ready: true }
      if (w.__narrativeRender?.status === 'error') {
        return { ready: false, reason: w.__narrativeRender.reason }
      }
      return null
    },
    undefined,
    { timeout: left(stopAt), polling: 50 },
  )
  const state = (await handle.jsonValue()) as { ready: boolean; reason?: PageReason }
  if (!state.ready) {
    throw new RenderJobError(state.reason ?? 'not-ready', 'the render page refused the deck')
  }
}

async function upload(
  target: RenderTarget,
  base64: string,
  config: RenderWorkerConfig,
  signal: AbortSignal,
): Promise<number> {
  const png = Buffer.from(base64, 'base64')
  try {
    await putToUpstream(target.url, png, target.headers, {
      appOrigin: config.appOrigin,
      upstream: config.upstream,
      signal,
    })
  } catch (err) {
    if (signal.aborted) throw new RenderJobError('deadline', 'the upload ran past the deadline')
    throw new RenderJobError('upload', maskTokens(err instanceof Error ? err.message : String(err)))
  }
  return png.byteLength
}

async function runOnPage(
  page: Page,
  data: RenderJobData,
  config: RenderWorkerConfig,
  signal: AbortSignal,
): Promise<RenderJobResult> {
  if (data.kind === 'export') {
    const slides: RenderedSlide[] = []
    const failedFonts = new Set<string>()
    for (const target of data.uploads) {
      const outcome = await page.evaluate(
        ([slideId, stateVector]) =>
          (window as unknown as RenderWindow).__narrativeRenderSlidePng!(slideId, { stateVector }),
        [target.slideId, data.stateVector] as const,
      )
      if (!outcome.ok) throw pageFailure(outcome)
      const sizeBytes = await upload(target, outcome.value.base64, config, signal)
      slides.push({
        slideId: target.slideId,
        index: outcome.value.slideIndex,
        width: RENDER_WIDTH,
        height: RENDER_HEIGHT,
        sizeBytes,
        failedLoads: outcome.value.failedLoads,
      })
      for (const family of outcome.value.failedFonts) failedFonts.add(family)
    }
    return { kind: 'export', slides, failedFonts: [...failedFonts].sort() }
  }
  const outcome = await page.evaluate(
    ([spec, stateVector]) =>
      (window as unknown as RenderWindow).__narrativeRenderLook!(spec, { stateVector }),
    [data.look, data.stateVector] as const,
  )
  if (!outcome.ok) throw pageFailure(outcome)
  const sizeBytes = await upload(data.upload, outcome.value.base64, config, signal)
  return {
    kind: 'look',
    look: {
      width: outcome.value.width,
      height: outcome.value.height,
      sizeBytes,
      slides: outcome.value.slides,
    },
    failedFonts: outcome.value.failedFonts,
  }
}

export async function renderJob(
  browser: Browser,
  data: RenderJobData,
  deps: { config: RenderWorkerConfig; log: (message: string) => void; warm: WarmPages },
): Promise<RenderJobResult> {
  const firstSlideId = firstSlideOf(data)
  if (firstSlideId === undefined) {
    return data.kind === 'export'
      ? { kind: 'export', slides: [], failedFonts: [] }
      : { kind: 'look', look: { width: 0, height: 0, sizeBytes: 0, slides: [] }, failedFonts: [] }
  }
  refuseLate(data)
  const stopAt = Math.min(data.deadline, Date.now() + data.workBudgetMs)

  let warm: WarmPage | undefined = deps.warm.take(data.token, data.deckId)
  let context = warm?.context
  // When time is up the context goes, every pending call with it, and the
  // upload in flight.
  let pastDeadline = false
  const stopUpload = new AbortController()
  const deadlineTimer = setTimeout(() => {
    pastDeadline = true
    stopUpload.abort()
    if (context !== undefined) void context.close().catch(() => undefined)
  }, left(stopAt))

  let succeeded = false
  try {
    if (warm === undefined) {
      warm = await openPage(browser, data, firstSlideId, deps, stopAt, (opened) => {
        context = opened
        if (pastDeadline) void opened.close().catch(() => undefined)
      })
    }
    await untilHooks(warm.page, stopAt)
    const result = await runOnPage(warm.page, data, deps.config, stopUpload.signal)
    succeeded = true
    return result
  } catch (err) {
    if (err instanceof RenderJobError) throw err
    if (pastDeadline) throw new RenderJobError('deadline', 'the job ran past its deadline')
    const message = maskTokens(err instanceof Error ? err.message : String(err))
    const errors = warm?.pageErrors ?? []
    const extra = errors.length > 0 ? ` (page errors: ${errors.join(' | ')})` : ''
    throw new RenderJobError('browser', `${message}${extra}`.slice(0, 1_000))
  } finally {
    clearTimeout(deadlineTimer)
    if (warm !== undefined && succeeded && !pastDeadline) {
      // Kept for the session's next job only after a clean one.
      deps.warm.keep(data.token, warm)
    } else if (context !== undefined) {
      await context.close().catch(() => undefined)
    }
  }
}
