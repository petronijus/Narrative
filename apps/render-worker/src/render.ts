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
 * aborted — a hung page or a wedged upload cannot hold one of the worker's
 * few job slots. A job beside another one waits for memory for its page
 * first (memory.ts).
 */

import type { Browser, Page } from 'playwright-core'
import {
  RENDER_HEIGHT,
  RENDER_WIDTH,
  renderFailureMessage,
  renderPageName,
  renderPagePath,
  type RenderFailureReason,
  type RenderJobData,
  type RenderJobResult,
  type RenderPageLookSpec as PageLookSpec,
  type RenderTarget,
  type RenderedSlide,
  type GrownText,
  type TextOverflow,
} from '@narrative/shared'
import type { RenderWorkerConfig } from './config.js'
import { getFromUpstream, installUpstreamRouting, putToUpstream } from './routing.js'
import type { WarmPage, WarmPages } from './warmPages.js'
import { MemoryWaitTimeout, type MemoryGate } from './memory.js'

const errorText = (err: unknown): string =>
  maskTokens(err instanceof Error ? err.message : String(err))

/** The page's own refusals (apps/web/src/pages/DeckRender.tsx, RenderErrorReason). */
type PageReason = Exclude<RenderFailureReason, 'browser' | 'deadline' | 'late' | 'upload'>

type PageOutcome<T> = { ok: true; value: T } | { ok: false; reason: PageReason; detail: string }

/** What the page's hooks look like from here (the fields used). */
interface RenderWindow {
  __narrativeRender?: { status: string; reason?: PageReason }
  /** A frozen page's (`?frozen=1`): the document state it is to show, before anything else. */
  __narrativeRenderFreeze?: (state: string) => void
  __narrativeRenderSlidePng?: (
    slideId: string,
    opts: { stateVector: string; format?: 'png' | 'jpeg' },
  ) => Promise<
    PageOutcome<{
      base64: string
      /** Absent from a page older than `format` (a PNG). */
      mimeType?: string
      slideIndex: number
      failedLoads: number
      failedFonts: string[]
      timings?: unknown
    }>
  >
  __narrativeRenderLook?: (
    spec: PageLookSpec,
    opts: { stateVector: string },
  ) => Promise<
    PageOutcome<{
      base64: string
      width: number
      height: number
      slides: Array<{ slideId: string; index: number; failedLoads: number }>
      overflow: TextOverflow[]
      /** Absent from a page older than A4.5. */
      grown?: GrownText[]
      failedFonts: string[]
      timings?: unknown
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
  data: Pick<RenderJobData, 'page' | 'token'>,
  firstSlideId: string,
  opts: { frozen?: boolean } = {},
): string {
  const url = new URL(renderPagePath(data.page), appOrigin)
  url.searchParams.set('slide', firstSlideId)
  // Nothing is looked at on screen: the jobs capture from the scene, and
  // on-screen frames would cost as much CPU as the captures (DeckRender.tsx).
  url.searchParams.set('paint', 'off')
  // A frozen page shows a state it is handed (a compare's "before"), with no
  // live document behind it.
  if (opts.frozen === true) url.searchParams.set('frozen', '1')
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

/**
 * What a recycled page's origin loses (CDP `Storage.clearDataForOrigin`):
 * every store a document can write — not `shader_cache`, which holds the
 * app's compiled GPU shaders and nothing of a deck, and costs SwiftShader a
 * recompile of each when cleared.
 */
const ORIGIN_STORAGE_TYPES = [
  'cookies',
  'file_systems',
  'indexeddb',
  'local_storage',
  'websql',
  'service_workers',
  'cache_storage',
  'storage_buckets',
  'shared_storage',
  'interest_groups',
].join(',')

/** A new tab in `context` on the job's render page, its errors collected. */
async function loadPage(
  context: WarmPage['context'],
  data: RenderJobData,
  firstSlideId: string,
  deps: { config: RenderWorkerConfig },
  stopAt: number,
  opts: { frozen?: boolean } = {},
): Promise<{ page: Page; pageErrors: string[] }> {
  const pageErrors: string[] = []
  const page = await context.newPage()
  page.on('pageerror', (err) => {
    if (pageErrors.length < 10) pageErrors.push(maskTokens(err.message).slice(0, 300))
  })
  await page.goto(renderPageUrl(deps.config.appOrigin, data, firstSlideId, opts), {
    waitUntil: 'domcontentloaded',
    timeout: left(stopAt),
  })
  return { page, pageErrors }
}

/** Open a page for the job: a fresh context, routed, on the render page. */
async function openPage(
  browser: Browser,
  data: RenderJobData,
  firstSlideId: string,
  deps: { config: RenderWorkerConfig; log: (message: string) => void; warm: WarmPages },
  stopAt: number,
  onContext: (context: WarmPage['context']) => void,
  opts: { frozen?: boolean } = {},
): Promise<WarmPage> {
  const generation = deps.warm.generation
  const context = await browser.newContext({
    viewport: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  })
  onContext(context)
  try {
    if (deps.config.upstream !== null) {
      await installUpstreamRouting(context, {
        appOrigin: deps.config.appOrigin,
        upstream: deps.config.upstream,
        log: deps.log,
      })
    }
    const { page, pageErrors } = await loadPage(context, data, firstSlideId, deps, stopAt, opts)
    return { name: renderPageName(data.page), context, page, pageErrors, generation }
  } catch (err) {
    await context.close().catch(() => undefined)
    throw err
  }
}

/**
 * Another session's idle page, made into this job's: the same browser
 * context (and so, most of the time, the same renderer process with the
 * code it compiled — the part of a cold page this saves), and nothing else
 * of what the page held before:
 *
 *   1. the old tab goes to `about:blank` first, so the old document — its
 *      deck, its token, its open WebSocket — is unloaded before anything is
 *      cleared and cannot write anything back afterwards;
 *   2. the app origin's storage (localStorage, IndexedDB, Cache Storage, …),
 *      the context's cookies and its HTTP cache are cleared;
 *   3. the job's page loads in a NEW tab of that context — a fresh session
 *      history (the old URL, token included, is in no `navigation.entries()`),
 *      sessionStorage and `window.name` — and only then is the old tab closed
 *      (closing it first could let its renderer process exit).
 *
 * Any step that fails closes the context: the job then opens a page of its
 * own, as if there had been no spare.
 */
export async function recyclePage(
  spare: WarmPage,
  data: RenderJobData,
  firstSlideId: string,
  deps: { config: RenderWorkerConfig; log?: (message: string) => void },
  stopAt: number,
): Promise<WarmPage> {
  const { context } = spare
  try {
    const started = Date.now()
    await spare.page.goto('about:blank', { timeout: left(stopAt) })
    const cdp = await context.newCDPSession(spare.page)
    try {
      await cdp.send('Storage.clearDataForOrigin', {
        origin: deps.config.appOrigin,
        storageTypes: ORIGIN_STORAGE_TYPES,
      })
      await cdp.send('Network.clearBrowserCache')
    } finally {
      await cdp.detach().catch(() => undefined)
    }
    await context.clearCookies()
    const cleared = Date.now() - started
    const { page, pageErrors } = await loadPage(context, data, firstSlideId, deps, stopAt)
    await spare.page.close().catch(() => undefined)
    deps.log?.(`${renderPageName(data.page)}: spare cleared in ${cleared} ms`)
    return {
      name: renderPageName(data.page),
      context,
      page,
      pageErrors,
      generation: spare.generation,
    }
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
  const picture = Buffer.from(base64, 'base64')
  try {
    await putToUpstream(target.url, picture, target.headers, {
      appOrigin: config.appOrigin,
      upstream: config.upstream,
      signal,
    })
  } catch (err) {
    if (signal.aborted) throw new RenderJobError('deadline', 'the upload ran past the deadline')
    throw new RenderJobError('upload', maskTokens(err instanceof Error ? err.message : String(err)))
  }
  return picture.byteLength
}

/** Where a page job's time went (pages/renderTimings.ts), one log line. */
function logTimings(log: (message: string) => void, data: RenderJobData, timings: unknown): void {
  if (timings === undefined) return
  log(`${renderPageName(data.page)} timings ${maskTokens(JSON.stringify(timings))}`)
}

/**
 * A compare's "before": the slide drawn on a frozen page — one that holds the
 * document state the job carries and nothing live — as a PNG; null when the
 * slide did not exist in that state. The page is closed before the live one
 * opens, so the two never hold memory at once.
 */
async function drawBefore(
  browser: Browser,
  data: RenderJobData & { kind: 'look' },
  look: { slideId: string; before: { url: string } },
  deps: { config: RenderWorkerConfig; log: (message: string) => void; warm: WarmPages },
  stopAt: number,
  signal: AbortSignal,
  onContext: (context: WarmPage['context'] | null) => void,
): Promise<string | null> {
  let state: string
  try {
    const bytes = await getFromUpstream(look.before.url, {
      appOrigin: deps.config.appOrigin,
      upstream: deps.config.upstream,
      signal,
    })
    state = bytes.toString('base64')
  } catch (err) {
    if (signal.aborted) throw new RenderJobError('deadline', 'the job ran past its deadline')
    throw new RenderJobError(
      'upload',
      `the before state: ${maskTokens(err instanceof Error ? err.message : String(err))}`,
    )
  }
  const frozen = await openPage(browser, data, look.slideId, deps, stopAt, onContext, {
    frozen: true,
  })
  try {
    await frozen.page.waitForFunction(
      () => typeof (window as unknown as RenderWindow).__narrativeRenderFreeze === 'function',
      undefined,
      { timeout: left(stopAt), polling: 50 },
    )
    await frozen.page.evaluate(
      (state) => (window as unknown as RenderWindow).__narrativeRenderFreeze!(state),
      state,
    )
    try {
      await untilHooks(frozen.page, stopAt)
    } catch (err) {
      if (err instanceof RenderJobError && err.reason === 'slide-not-found') return null
      throw err
    }
    const outcome = await frozen.page.evaluate(
      ([slideId]) =>
        // An empty state vector: the frozen page holds all it will ever hold.
        (window as unknown as RenderWindow).__narrativeRenderSlidePng!(slideId, {
          stateVector: 'AA==',
        }),
      [look.slideId] as const,
    )
    if (!outcome.ok) {
      if (outcome.reason === 'slide-not-found') return null
      throw pageFailure(outcome)
    }
    logTimings(deps.log, data, outcome.value.timings)
    return outcome.value.base64
  } finally {
    await frozen.context.close().catch(() => undefined)
    onContext(null)
  }
}

async function runOnPage(
  page: Page,
  data: RenderJobData,
  config: RenderWorkerConfig,
  signal: AbortSignal,
  log: (message: string) => void,
  beforePng: string | null | undefined,
): Promise<RenderJobResult> {
  if (data.kind === 'export') {
    const slides: RenderedSlide[] = []
    const failedFonts = new Set<string>()
    for (const target of data.uploads) {
      const outcome = await page.evaluate(
        ([slideId, stateVector, format]) =>
          (window as unknown as RenderWindow).__narrativeRenderSlidePng!(slideId, {
            stateVector,
            format,
          }),
        [target.slideId, data.stateVector, data.format ?? 'png'] as const,
      )
      if (!outcome.ok) throw pageFailure(outcome)
      logTimings(log, data, outcome.value.timings)
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
  const spec: PageLookSpec =
    data.look.mode === 'compare'
      ? { mode: 'compare', slideId: data.look.slideId, beforePng: beforePng ?? null }
      : data.look
  const outcome = await page.evaluate(
    ([spec, stateVector]) =>
      (window as unknown as RenderWindow).__narrativeRenderLook!(spec, { stateVector }),
    [spec, data.stateVector] as const,
  )
  if (!outcome.ok) throw pageFailure(outcome)
  logTimings(log, data, outcome.value.timings)
  const sizeBytes = await upload(data.upload, outcome.value.base64, config, signal)
  return {
    kind: 'look',
    look: {
      width: outcome.value.width,
      height: outcome.value.height,
      sizeBytes,
      slides: outcome.value.slides,
      overflow: outcome.value.overflow,
      ...(outcome.value.grown !== undefined ? { grown: outcome.value.grown } : {}),
      ...(spec.mode === 'compare' && spec.beforePng === null ? { newSlide: true } : {}),
    },
    failedFonts: outcome.value.failedFonts,
  }
}

export interface RenderJobDeps {
  config: RenderWorkerConfig
  log: (message: string) => void
  warm: WarmPages
  /** Admits a job beside others only with memory for its page (none: always). */
  gate?: MemoryGate
}

export async function renderJob(
  browser: Browser,
  data: RenderJobData,
  deps: RenderJobDeps,
): Promise<RenderJobResult> {
  const firstSlideId = firstSlideOf(data)
  if (firstSlideId === undefined) {
    return data.kind === 'export'
      ? { kind: 'export', slides: [], failedFonts: [] }
      : {
          kind: 'look',
          look: { width: 0, height: 0, sizeBytes: 0, slides: [], overflow: [] },
          failedFonts: [],
        }
  }
  refuseLate(data)
  const stopAt = Math.min(data.deadline, Date.now() + data.workBudgetMs)

  const name = renderPageName(data.page)
  let warm: WarmPage | undefined = deps.warm.take(data.token, name)
  const compare = data.kind === 'look' && data.look.mode === 'compare' ? data.look : null
  if (compare !== null && warm !== undefined) {
    // A compare draws on a frozen page first: the kept page goes, so that
    // two pages never hold memory at once (one heavy slide nearly fills it).
    await warm.context.close().catch(() => undefined)
    warm = undefined
  }
  // Another job may be rendering: this one holds a page only with room for it.
  if (deps.gate !== undefined) {
    try {
      await deps.gate.enter(stopAt, name)
    } catch (err) {
      if (warm !== undefined) await warm.context.close().catch(() => undefined)
      if (err instanceof MemoryWaitTimeout) throw new RenderJobError('late', err.message)
      throw err
    }
  }
  try {
    return await renderWithPage(browser, data, firstSlideId, deps, stopAt, warm, compare)
  } finally {
    deps.gate?.leave()
  }
}

async function renderWithPage(
  browser: Browser,
  data: RenderJobData,
  firstSlideId: string,
  deps: RenderJobDeps,
  stopAt: number,
  sessionPage: WarmPage | undefined,
  compare: { slideId: string; before: { url: string } } | null,
): Promise<RenderJobResult> {
  const name = renderPageName(data.page)
  let warm = sessionPage
  let context = warm?.context
  let frozenContext: WarmPage['context'] | null = null
  // When time is up the context goes, every pending call with it, and the
  // upload in flight.
  let pastDeadline = false
  const stopUpload = new AbortController()
  const deadlineTimer = setTimeout(() => {
    pastDeadline = true
    stopUpload.abort()
    if (context !== undefined) void context.close().catch(() => undefined)
    if (frozenContext !== null) void frozenContext.close().catch(() => undefined)
  }, left(stopAt))

  let succeeded = false
  try {
    let beforePng: string | null | undefined
    if (compare !== null && data.kind === 'look') {
      beforePng = await drawBefore(
        browser,
        data,
        compare,
        deps,
        stopAt,
        stopUpload.signal,
        (opened) => {
          frozenContext = opened
          if (opened !== null && pastDeadline) void opened.close().catch(() => undefined)
        },
      )
    }
    const started = Date.now()
    let how = 'session page'
    if (warm === undefined && compare === null && data.keepPage !== false) {
      // A person's job with no page of its own takes an idle one of another
      // session (background work leaves people's pages alone).
      const spare = deps.warm.takeSpare()
      if (spare !== undefined) {
        context = spare.context
        try {
          warm = await recyclePage(spare, data, firstSlideId, deps, stopAt)
          how = 'recycled page'
        } catch (err) {
          if (pastDeadline) throw err
          context = undefined
          deps.log(`${name}: a spare page could not be recycled, opening one (${errorText(err)})`)
        }
      }
    }
    if (warm === undefined) {
      warm = await openPage(browser, data, firstSlideId, deps, stopAt, (opened) => {
        context = opened
        if (pastDeadline) void opened.close().catch(() => undefined)
      })
      how = 'new page'
    }
    await untilHooks(warm.page, stopAt)
    deps.log(`${name}: ${how}, app ready in ${Date.now() - started} ms`)
    const result = await runOnPage(
      warm.page,
      data,
      deps.config,
      stopUpload.signal,
      deps.log,
      beforePng,
    )
    succeeded = true
    return result
  } catch (err) {
    if (err instanceof RenderJobError) throw err
    if (pastDeadline) throw new RenderJobError('deadline', 'the job ran past its deadline')
    const message = errorText(err)
    const errors = warm?.pageErrors ?? []
    const extra = errors.length > 0 ? ` (page errors: ${errors.join(' | ')})` : ''
    throw new RenderJobError('browser', `${message}${extra}`.slice(0, 1_000))
  } finally {
    clearTimeout(deadlineTimer)
    if (warm !== undefined && succeeded && !pastDeadline && data.keepPage !== false) {
      // Kept for the session's next job only after a clean one, and only
      // when the job asks for it (background work does not).
      deps.warm.keep(data.token, warm)
    } else if (context !== undefined) {
      await context.close().catch(() => undefined)
    }
  }
}
