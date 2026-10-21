/**
 * render.browser.test.ts — renderJob with a real Chromium against a stand-in
 * render page (a local server behind the production routing): the page a
 * session opened is kept and reused by its next job, closed after a failed
 * one, and never handed to another session. Skipped where no Chromium can
 * be launched.
 *
 * Each test renders its own deck and counts only that deck's page loads and
 * uploads, so a test that ran out of time and is still finishing its jobs
 * cannot skew the next one.
 */

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { Browser } from 'playwright-core'
import type { RenderLookJob } from '@narrative/shared'
import { BrowserHolder } from './browser.js'
import { renderJob, RenderJobError } from './render.js'
import { WarmPages } from './warmPages.js'
import type { RenderWorkerConfig } from './config.js'

const APP = 'https://narrative.test'

/**
 * The clocks here are hang detectors sized for a real Chromium on a busy
 * machine, not for a unit test. The first test drives six jobs through up to
 * nine page loads: about 2.5 s alone, 27 s at a load of 29 beside the other
 * suites, and inside a full `just check` (typecheck and lint alongside) one
 * job alone ran past a 20 s work budget (MacBook, 2026-10-15).
 *
 * JOB_BUDGET_MS bounds one job (its `workBudgetMs` and `deadline`; only the
 * late-job test is about those clocks, and it sets its own deadline);
 * BROWSER_TIMEOUT_MS bounds each test and hook — the shared 30 s
 * (`vitest.timeouts.ts`) is meant for unit tests. Both still end a hang.
 */
const JOB_BUDGET_MS = 60_000
const BROWSER_TIMEOUT_MS = 240_000
/** A 1×1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

/**
 * The render page's job hooks, faked: slide "bad" is refused as not settled;
 * a compare's "before" picture comes back as the overflow's object id, so the
 * test sees what the live page was handed.
 */
const PAGE = `<!doctype html><html><body><script>
  window.__narrativeRender = { status: 'ready', slideId: 's1', slideIndex: 0, failedLoads: 0 }
  window.__narrativeRenderLook = async (spec) => {
    if (spec.slideId === 'bad') return { ok: false, reason: 'not-settled', detail: 'slide bad' }
    const before = spec.mode === 'compare' ? String(spec.beforePng) : 'none'
    return { ok: true, value: { base64: '${PNG_BASE64}', width: 1, height: 1,
      slides: [{ slideId: spec.slideId, index: 0, failedLoads: 0 }], failedFonts: [],
      overflow: [{ slideId: spec.slideId, objectId: before, boxHeight: 1, textHeight: 2 }] } }
  }
</script></body></html>`

/**
 * A frozen page (`?frozen=1`): nothing until the worker hands it a state; then
 * the slide's "picture" is that state, and a state named "missing" has no
 * such slide.
 */
const FROZEN = `<!doctype html><html><body><script>
  window.__narrativeRenderFreeze = (encoded) => {
    const state = atob(encoded)
    window.__narrativeRender = { status: 'ready', slideId: 's1', slideIndex: 0, failedLoads: 0 }
    window.__narrativeRenderLook = async () => ({ ok: false, reason: 'not-ready', detail: 'frozen' })
    window.__narrativeRenderSlidePng = async (slideId) =>
      state === 'missing'
        ? { ok: false, reason: 'slide-not-found', detail: slideId }
        : { ok: true, value: { base64: 'before-of-' + state, slideIndex: 0, failedLoads: 0,
            failedFonts: [] } }
  }
</script></body></html>`

/**
 * A page that records what the document before it left behind — everything
 * a page can keep across a navigation in its tab or its context: storage,
 * cookies, IndexedDB, Cache Storage, `window.name`, the session history and
 * the Navigation API's entries (which name earlier URLs, tokens and all) —
 * then leaves all of that behind itself, marked with its own token, and
 * holds a WebSocket open like the real page's sync connection. Its look
 * reports what it found (as the overflow's object id).
 */
const ISOLATION_PAGE = `<!doctype html><html><body><script>
  window.__narrativeRender = { status: 'ready', slideId: 's1', slideIndex: 0, failedLoads: 0 }
  const deckId = location.pathname.split('/')[2]
  const token = new URLSearchParams(location.search).get('share_token')
  window.__seen = (async () => {
    const out = {
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      cookie: document.cookie,
      idb: (await indexedDB.databases()).map((d) => d.name),
      caches: await caches.keys(),
      name: window.name,
      history: history.length,
      entries: window.navigation ? navigation.entries().map((e) => e.url) : [],
    }
    localStorage.setItem('secret', token)
    sessionStorage.setItem('secret', token)
    document.cookie = 'secret=' + token + '; path=/; max-age=3600; secure'
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('secret-' + token)
      open.onsuccess = () => { open.result.close(); resolve() }
      open.onerror = () => reject(open.error)
    })
    await (await caches.open('secret-' + token)).put('/secret', new Response(token))
    window.name = 'secret-' + token
    return out
  })()
  window.__socket = new WebSocket('wss://narrative.test/ws/' + deckId)
  window.__narrativeRenderLook = async (spec) => {
    const seen = await window.__seen
    return { ok: true, value: { base64: '${PNG_BASE64}', width: 1, height: 1,
      slides: [{ slideId: spec.slideId, index: 0, failedLoads: 0 }], failedFonts: [],
      overflow: [{ slideId: spec.slideId, objectId: JSON.stringify(seen), boxHeight: 1, textHeight: 2 }] } }
  }
</script></body></html>`

let server: Server
let upstream = ''
interface DeckLog {
  opened: string[]
  /** When each page load of the deck reached the server. */
  openedAt: number[]
  uploads: number
  socketOpenedAt: number | null
  socketClosedAt: number | null
}
/** Per deck: the pages opened, in order ('live' or 'frozen'), and the pictures uploaded. */
const decks = new Map<string, DeckLog>()
function deck(deckId: string): DeckLog {
  let entry = decks.get(deckId)
  if (entry === undefined) {
    entry = { opened: [], openedAt: [], uploads: 0, socketOpenedAt: null, socketClosedAt: null }
    decks.set(deckId, entry)
  }
  return entry
}
const pageLoads = (deckId: string): number => deck(deckId).opened.length
const holder = new BrowserHolder({
  idleMs: 60_000,
  chromeExecutable: null,
  requireSandbox: false,
  log: () => undefined,
})
let browser: Browser | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const url = new URL(req.url ?? '/', APP)
      const page = /^\/deck\/([^/]+)/.exec(url.pathname)
      const upload = /^\/storage\/([^/]+)\/look\.png$/.exec(url.pathname)
      if (page !== null) {
        const frozen = url.searchParams.get('frozen') === '1'
        deck(page[1]!).opened.push(frozen ? 'frozen' : 'live')
        deck(page[1]!).openedAt.push(Date.now())
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(frozen ? FROZEN : page[1]!.startsWith('iso-') ? ISOLATION_PAGE : PAGE)
      } else if (req.method === 'GET' && req.url?.startsWith('/storage/before/')) {
        // A compare's stored "before" state (here: its name).
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(req.url.slice('/storage/before/'.length))
      } else if (req.method === 'PUT' && upload !== null) {
        deck(upload[1]!).uploads += 1
        res.writeHead(200)
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  })
  // The pages' sync connections: when each deck's opened and closed.
  new WebSocketServer({ server }).on('connection', (socket, req) => {
    const deckId = /^\/ws\/([^/?]+)/.exec(req.url ?? '')?.[1]
    if (deckId === undefined) return socket.close()
    deck(deckId).socketOpenedAt = Date.now()
    socket.on('close', () => (deck(deckId).socketClosedAt = Date.now()))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await holder.use(async (b) => {
      browser = b
    })
  } catch {
    browser = null
  }
}, BROWSER_TIMEOUT_MS)

afterAll(async () => {
  await holder.close('test')
  server.close()
}, BROWSER_TIMEOUT_MS)

const configOf = (warmPages: number): RenderWorkerConfig => ({
  redisUrl: 'redis://unused',
  appOrigin: APP,
  upstream,
  idleMs: 60_000,
  concurrency: 1,
  pageReserveBytes: 0,
  warmPages,
  chromeExecutable: null,
  requireSandbox: false,
})

const job = (deckId: string, token: string, slideId: string): RenderLookJob => ({
  kind: 'look',
  page: { kind: 'deck', deckId },
  token,
  stateVector: '',
  deadline: Date.now() + JOB_BUDGET_MS,
  workBudgetMs: JOB_BUDGET_MS,
  look: { mode: 'slide', slideId },
  upload: { url: `${APP}/storage/${deckId}/look.png`, headers: { 'content-type': 'image/png' } },
})

describe('renderJob and the session page', () => {
  it(
    'reuses the page of a session, closes it after a failed job, and keeps sessions apart',
    async (ctx) => {
      if (browser === null) ctx.skip()
      const config = configOf(2)
      const warm = new WarmPages({ max: 2, idleMs: 60_000, log: () => undefined })
      const deps = { config, log: () => undefined, warm }
      const d = 'd-session'
      try {
        const first = await renderJob(browser!, job(d, 'nrr_a', 's1'), deps)
        expect(first).toMatchObject({
          kind: 'look',
          look: { sizeBytes: Buffer.from(PNG_BASE64, 'base64').byteLength },
        })
        expect([pageLoads(d), deck(d).uploads, warm.size]).toEqual([1, 1, 1])
        // The session's next job: the same page, no load.
        await renderJob(browser!, job(d, 'nrr_a', 's2'), deps)
        expect([pageLoads(d), deck(d).uploads, warm.size]).toEqual([1, 2, 1])
        // Another session never gets that page as it is. With room for a
        // second page it opens its own, and session A keeps its page warm.
        await renderJob(browser!, job(d, 'nrr_b', 's1'), deps)
        expect([pageLoads(d), warm.size]).toEqual([2, 2])
        await renderJob(browser!, job(d, 'nrr_a', 's2'), deps)
        expect([pageLoads(d), warm.size]).toEqual([2, 2])
        // A failed job closes its page (here A's own).
        await expect(renderJob(browser!, job(d, 'nrr_a', 'bad'), deps)).rejects.toMatchObject({
          reason: 'not-settled',
        })
        expect([pageLoads(d), warm.size]).toEqual([2, 1])
        await renderJob(browser!, job(d, 'nrr_a', 's1'), deps)
        expect([pageLoads(d), warm.size]).toEqual([3, 2])
        // Background work takes no spare and closes its page: the people's
        // warm pages stay as they were.
        await renderJob(browser!, { ...job(d, 'nrr_c', 's1'), keepPage: false }, deps)
        expect([pageLoads(d), warm.size]).toEqual([4, 2])
        expect(warm.take('nrr_a', `deck:${d}`)).toBeDefined()
        expect(warm.take('nrr_b', `deck:${d}`)).toBeDefined()
      } finally {
        warm.closeAll('test')
      }
    },
    BROWSER_TIMEOUT_MS,
  )

  it(
    'draws a compare’s "before" on a frozen page first, closes it, and hands the picture to the live page',
    async (ctx) => {
      if (browser === null) ctx.skip()
      const config = configOf(1)
      const warm = new WarmPages({ max: 1, idleMs: 60_000, log: () => undefined })
      const deps = { config, log: () => undefined, warm }
      const d = 'd-compare'
      const opened = deck(d).opened
      const compare = (state: string): RenderLookJob => ({
        ...job(d, 'nrr_cmp', 's1'),
        look: { mode: 'compare', slideId: 's1', before: { url: `${APP}/storage/before/${state}` } },
      })
      try {
        const result = await renderJob(browser!, compare('v1'), deps)
        expect(opened).toEqual(['frozen', 'live'])
        expect(result.kind === 'look' && result.look.overflow[0]?.objectId).toBe('before-of-v1')
        expect(result.kind === 'look' && result.look.newSlide).toBeUndefined()
        // The live page is kept; the frozen one is not. The next compare closes
        // the kept page before the frozen one opens (never two at once).
        expect(warm.size).toBe(1)
        opened.length = 0
        const added = await renderJob(browser!, compare('missing'), deps)
        expect(opened).toEqual(['frozen', 'live'])
        expect(added.kind === 'look' && added.look.newSlide).toBe(true)
        expect(added.kind === 'look' && added.look.overflow[0]?.objectId).toBe('null')
      } finally {
        warm.closeAll('test')
      }
    },
    BROWSER_TIMEOUT_MS,
  )

  it(
    'refuses a job that arrived after its deadline without opening a page',
    async (ctx) => {
      if (browser === null) ctx.skip()
      const warm = new WarmPages({ max: 1, idleMs: 60_000, log: () => undefined })
      const d = 'd-late'
      const late = { ...job(d, 'nrr_c', 's1'), deadline: Date.now() - 1 }
      const error = await renderJob(browser!, late, {
        config: configOf(1),
        log: () => undefined,
        warm,
      }).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(RenderJobError)
      expect((error as RenderJobError).reason).toBe('late')
      expect(pageLoads(d)).toBe(0)
    },
    BROWSER_TIMEOUT_MS,
  )
})

describe('a recycled page', () => {
  it(
    "carries nothing of the deck or token before it into another deck's job",
    async (ctx) => {
      if (browser === null) ctx.skip()
      const logs: string[] = []
      const warm = new WarmPages({ max: 1, idleMs: 60_000, log: () => undefined })
      const deps = { config: configOf(1), log: (m: string) => logs.push(m), warm }
      const seenBy = (result: Awaited<ReturnType<typeof renderJob>>) => {
        if (result.kind !== 'look') throw new Error('not a look')
        return JSON.parse(result.look.overflow[0]!.objectId) as {
          local: string[]
          session: string[]
          cookie: string
          idb: string[]
          caches: string[]
          name: string
          history: number
          entries: string[]
        }
      }
      const nothing = {
        local: [],
        session: [],
        cookie: '',
        idb: [],
        caches: [],
        name: '',
        // A new tab's initial about:blank and the render page: a fresh page's.
        history: 2,
      }
      try {
        // Deck A's page leaves its token in every place a page can keep it.
        const a = seenBy(await renderJob(browser!, job('iso-a', 'nrr_iso_a', 's1'), deps))
        expect(a).toMatchObject(nothing)
        expect(deck('iso-a').socketOpenedAt).not.toBeNull()
        expect(warm.size).toBe(1)

        // Deck B, another session, gets A's idle page recycled…
        const b = seenBy(await renderJob(browser!, job('iso-b', 'nrr_iso_b', 's1'), deps))
        expect(logs.some((m) => m.startsWith('deck:iso-b: recycled page'))).toBe(true)
        // …and finds none of it: no storage, cookie, database, cache, window
        // name, and no session history naming A's URL (its token).
        expect(b).toMatchObject(nothing)
        expect(b.entries.every((url) => url.includes('nrr_iso_b'))).toBe(true)
        expect(JSON.stringify(b)).not.toContain('nrr_iso_a')
        // A's document — its sync connection — was gone before B's page loaded.
        const closedAt = deck('iso-a').socketClosedAt
        expect(closedAt).not.toBeNull()
        expect(closedAt!).toBeLessThanOrEqual(deck('iso-b').openedAt[0]!)
        // One tab in the kept context: A's was closed.
        const kept = warm.take('nrr_iso_b', 'deck:iso-b')
        expect(kept?.context.pages()).toHaveLength(1)
        if (kept !== undefined) warm.keep('nrr_iso_b', kept)

        // And A's session gets B's page back only recycled again, seeing
        // nothing of B either.
        const again = seenBy(await renderJob(browser!, job('iso-a', 'nrr_iso_a2', 's1'), deps))
        expect(again).toMatchObject(nothing)
        expect(JSON.stringify(again)).not.toContain('nrr_iso_b')
      } finally {
        warm.closeAll('test')
      }
    },
    BROWSER_TIMEOUT_MS,
  )
})
