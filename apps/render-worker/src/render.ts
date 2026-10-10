/**
 * render.ts — one render job: the deck's render page in a fresh browser
 * context, each requested slide shown in turn (`__narrativeRenderShow`, no
 * reload between slides), screenshotted once it reports `ready`, and uploaded
 * through the presigned URL the job carries for it.
 *
 * The page opens with the job's render token as `share_token`
 * (apps/web/src/pages/DeckRender.tsx): it reads the deck like a share-link
 * visitor, read-only, and hides from the deck's collaborators. A slide the
 * page reports as an error fails the job with that reason
 * (`renderFailureMessage`), which the server maps back (slide not found is
 * the caller's mistake; a renderer fault is not).
 *
 * Two clocks bound a job: its caller's `deadline` and its own work budget
 * (`workBudgetMs` from its start). A job that arrives after its deadline is
 * not started (`late`: nobody waits, and nothing is wrong with the browser);
 * at whichever clock runs out first its context is closed and its upload
 * aborted — a hung page, a stuck screenshot or a wedged upload cannot hold
 * the one-job-at-a-time queue.
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import {
  RENDER_HEIGHT,
  RENDER_WIDTH,
  renderFailureMessage,
  type RenderFailureReason,
  type RenderJobData,
  type RenderJobResult,
  type RenderedSlide,
} from '@narrative/shared'
import type { RenderWorkerConfig } from './config.js'
import { installUpstreamRouting, putToUpstream } from './routing.js'

/** The render page's status, as `window.__narrativeRender` holds it (the fields read here). */
type PageStatus =
  | { status: 'loading' }
  | {
      status: 'ready'
      slideId: string
      slideIndex: number
      failedLoads: number
      failedFonts?: string[]
    }
  | {
      status: 'error'
      reason: Exclude<RenderFailureReason, 'browser' | 'deadline' | 'late' | 'upload'>
      slideId?: string
      waitingFor?: string[]
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
  data: RenderJobData,
  firstSlideId: string,
): string {
  const url = new URL(`/deck/${encodeURIComponent(data.deckId)}/render`, appOrigin)
  url.searchParams.set('slide', firstSlideId)
  url.searchParams.set('share_token', data.token)
  return url.toString()
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

async function waitForSlide(page: Page, slideId: string, deadline: number): Promise<PageStatus> {
  const handle = await page.waitForFunction(
    (id: string) => {
      const status = (window as unknown as { __narrativeRender?: PageStatus }).__narrativeRender
      if (status === undefined) return null
      if (status.status === 'error') return status
      if (status.status === 'ready' && status.slideId === id) return status
      return null
    },
    slideId,
    { timeout: left(deadline), polling: 100 },
  )
  return (await handle.jsonValue()) as PageStatus
}

export async function renderJob(
  browser: Browser,
  data: RenderJobData,
  deps: { config: RenderWorkerConfig; log: (message: string) => void },
): Promise<RenderJobResult> {
  const [first] = data.uploads
  if (first === undefined) return { slides: [], failedFonts: [] }
  refuseLate(data)
  const stopAt = Math.min(data.deadline, Date.now() + data.workBudgetMs)

  const context: BrowserContext = await browser.newContext({
    viewport: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  })
  // When time is up the context goes, every pending call with it, and the
  // upload in flight.
  let pastDeadline = false
  const stopUpload = new AbortController()
  const deadlineTimer = setTimeout(() => {
    pastDeadline = true
    stopUpload.abort()
    void context.close().catch(() => undefined)
  }, left(stopAt))
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
    page.on('pageerror', (err) => pageErrors.push(maskTokens(err.message).slice(0, 300)))
    await page.goto(renderPageUrl(deps.config.appOrigin, data, first.slideId), {
      waitUntil: 'domcontentloaded',
      timeout: left(stopAt),
    })

    const slides: RenderedSlide[] = []
    const failedFonts = new Set<string>()
    for (const [i, upload] of data.uploads.entries()) {
      if (i > 0) {
        await page.evaluate((id: string) => {
          const show = (window as unknown as { __narrativeRenderShow?: (slide: string) => void })
            .__narrativeRenderShow
          if (show === undefined) throw new Error('the render page has no __narrativeRenderShow')
          show(id)
        }, upload.slideId)
      }
      const status = await waitForSlide(page, upload.slideId, stopAt)
      if (status.status === 'error') {
        const detail =
          status.reason === 'not-ready' && status.waitingFor !== undefined
            ? `waiting for ${status.waitingFor.join(', ')}`
            : `slide ${upload.slideId}`
        throw new RenderJobError(status.reason, detail)
      }
      if (status.status !== 'ready') throw new RenderJobError('browser', 'no status from the page')
      const png = await page.getByTestId('render-slide').screenshot({
        type: 'png',
        animations: 'disabled',
        timeout: left(stopAt),
      })
      try {
        await putToUpstream(upload.url, png, upload.headers, {
          appOrigin: deps.config.appOrigin,
          upstream: deps.config.upstream,
          signal: stopUpload.signal,
        })
      } catch (err) {
        if (pastDeadline) throw new RenderJobError('deadline', 'the upload ran past the deadline')
        throw new RenderJobError(
          'upload',
          maskTokens(err instanceof Error ? err.message : String(err)),
        )
      }
      slides.push({
        slideId: upload.slideId,
        index: status.slideIndex,
        width: RENDER_WIDTH,
        height: RENDER_HEIGHT,
        sizeBytes: png.byteLength,
        failedLoads: status.failedLoads,
      })
      for (const family of status.failedFonts ?? []) failedFonts.add(family)
    }
    return { slides, failedFonts: [...failedFonts].sort() }
  } catch (err) {
    if (err instanceof RenderJobError) throw err
    if (pastDeadline) throw new RenderJobError('deadline', 'the job ran past its deadline')
    const message = maskTokens(err instanceof Error ? err.message : String(err))
    const extra = pageErrors.length > 0 ? ` (page errors: ${pageErrors.join(' | ')})` : ''
    throw new RenderJobError('browser', `${message}${extra}`.slice(0, 1_000))
  } finally {
    clearTimeout(deadlineTimer)
    // Gone already when the deadline closed it, or the browser died.
    await context.close().catch(() => undefined)
  }
}
