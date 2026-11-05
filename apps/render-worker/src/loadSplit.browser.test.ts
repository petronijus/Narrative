/**
 * loadSplit.browser.test.ts — `readPageLoadSnapshot` with a real Chromium
 * against pages that try to shape what the worker reads: the native timings
 * come from an isolated world (the page's overrides of `performance`,
 * `Array` and `URL` change nothing), the load stamps are three numbers or
 * nulls whatever the page put there, and a page that never answers costs the
 * read its timeout, not the job. Skipped where no Chromium can be launched.
 */

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, BrowserContext } from 'playwright-core'
import { BrowserHolder } from './browser.js'
import { loadSplit, readPageLoadSnapshot } from './loadSplit.js'

const BROWSER_TIMEOUT_MS = 120_000

/** Two real scripts from /assets/, then whatever `extra` does to the page. */
const page = (extra: string): string => `<!doctype html><html><head>
  <script src="/assets/a.js"></script><script src="/assets/b.js"></script>
</head><body><script>${extra}</script></body></html>`

const STAMPS = `window.__narrative_perf = { loadTimings: { start: performance.now(), wsSyncedMs: 12, pixiReadyMs: 7 } }`

const PAGES: Record<string, string> = {
  '/honest': page(STAMPS),
  // Everything a hostile main world can reach: a huge fake timeline, broken
  // Array / URL / String helpers, and stamps carrying ~20 MB of strings.
  '/hostile': page(`
    const fake = Array.from({ length: 1000000 }, () => ({ name: location.origin + '/assets/fake.js', startTime: 0, responseEnd: 1 }))
    performance.getEntriesByType = () => fake
    Performance.prototype.getEntriesByType = () => fake
    Array.prototype.slice = function () { return fake }
    Array.prototype.push = function () { return 0 }
    window.URL = function () { return { origin: location.origin, pathname: '/assets/fake.js' } }
    String.prototype.startsWith = () => true
    // Inherited by every object the main world serialises: a getter that would
    // hand the worker a huge timeline, and a toJSON that would replace it.
    Object.defineProperty(Object.prototype, 'resources', { enumerable: true, configurable: true, get: () => fake })
    Object.prototype.toJSON = function () { return { resources: fake, junk: 'z'.repeat(1000000) } }
    window.__narrative_perf = { loadTimings: { start: performance.now(), wsSyncedMs: 'x'.repeat(10000000), pixiReadyMs: 7, junk: 'y'.repeat(10000000) } }
  `),
  // Stamps behind getters: one throws, one never returns.
  '/throws': page(
    `window.__narrative_perf = { loadTimings: { get start() { throw new Error('no') }, wsSyncedMs: 3, pixiReadyMs: 4 } }`,
  ),
  '/hangs': page(
    `window.__narrative_perf = { loadTimings: { get start() { for (;;) {} }, wsSyncedMs: 3, pixiReadyMs: 4 } }`,
  ),
}

let server: Server
let origin = ''
const holder = new BrowserHolder({
  idleMs: 60_000,
  chromeExecutable: null,
  requireSandbox: false,
  log: () => undefined,
})
let browser: Browser | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path.startsWith('/assets/')) {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end('void 0')
    } else if (PAGES[path] !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PAGES[path])
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
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

async function snapshotOf(
  path: string,
  thenAsk = false,
): Promise<{ snapshot: unknown; ms: number; after?: number }> {
  const context: BrowserContext = await browser!.newContext()
  try {
    const p = await context.newPage()
    await p.goto(`${origin}${path}`, { waitUntil: 'load' })
    const started = Date.now()
    const snapshot = await readPageLoadSnapshot(async () => {
      const session = await context.newCDPSession(p)
      return {
        send: (method, params) => session.send(method as never, params as never),
        detach: () => session.detach(),
      }
    })
    const ms = Date.now() - started
    if (!thenAsk) return { snapshot, ms }
    // The same page, its main world, after the read gave up.
    const after = await Promise.race([
      p.evaluate(() => 1),
      new Promise<number>((r) => setTimeout(() => r(-1), 5_000)),
    ])
    return { snapshot, ms, after }
  } finally {
    await context.close()
  }
}

describe('readPageLoadSnapshot', () => {
  it(
    'reads the native timings and the load stamps of an honest page',
    async (ctx) => {
      if (browser === null) ctx.skip()
      const { snapshot } = await snapshotOf('/honest')
      expect(loadSplit(snapshot)).toMatchObject({ scriptCount: 2, pixi: 7 })
    },
    BROWSER_TIMEOUT_MS,
  )

  it(
    'takes nothing a hostile page shaped: its fake timeline, its helpers, its strings',
    async (ctx) => {
      if (browser === null) ctx.skip()
      const { snapshot } = await snapshotOf('/hostile')
      // Bounded whatever the page holds: two real scripts and the document.
      expect(JSON.stringify(snapshot).length).toBeLessThan(10_000)
      expect(snapshot).not.toHaveProperty('junk')
      const resources = (snapshot as { resources: Array<{ kind: string }> }).resources
      expect(resources.filter((r) => r.kind === 'script')).toHaveLength(2)
      // The stamps: the numbers kept, the string dropped.
      expect(snapshot).toMatchObject({ wsSyncedMs: null, pixiReadyMs: 7 })
      expect(loadSplit(snapshot)).toMatchObject({ scriptCount: 2, synced: null, pixi: 7 })
    },
    BROWSER_TIMEOUT_MS,
  )

  it(
    'gives a stamp whose getter throws as nothing, and gives up on one that never returns',
    async (ctx) => {
      if (browser === null) ctx.skip()
      const throws = await snapshotOf('/throws')
      expect(throws.snapshot).toMatchObject({ shellStart: null, wsSyncedMs: 3 })
      expect(loadSplit(throws.snapshot)).toBeNull()
      const hangs = await snapshotOf('/hangs', true)
      expect(hangs.snapshot).toBeNull()
      expect(hangs.ms).toBeLessThan(10_000)
      // V8 stopped the script before the session went: the page still answers.
      expect(hangs.after).toBe(1)
    },
    BROWSER_TIMEOUT_MS,
  )
})
