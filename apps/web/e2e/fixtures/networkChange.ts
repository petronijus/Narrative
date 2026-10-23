/**
 * e2e/fixtures/networkChange.ts — what the e2e fixture (test.ts) and the
 * perf driver (perf/lib/driver.ts) see of a network change under the
 * browser: a request failing with `net::ERR_NETWORK_CHANGED` (or another
 * error of a network that went away: `isNetworkChangeError`), an interface
 * of the machine coming, going or changing its addresses (the host watcher,
 * `@narrative/perf/node/networkWatch`), and — for the perf driver — a
 * WebSocket that dropped: closed without a close frame (1006) and not by
 * the page's own `close()`, as the page's CloseEvent tells (an init script
 * wraps `WebSocket`; Playwright's `close` event carries no code). The page
 * or the server closing a socket on purpose — present mode does on every
 * jump — is not a network change (`classifySocketClose`).
 *
 * Why: a USB-tethered phone that re-attaches every half minute makes Chrome
 * abort every request in flight, localhost included, each time macOS
 * reports the change (SETUP.md → Common first-run failures). The logic that
 * decides what to do with a disturbed sample or test is pure and lives in
 * `@narrative/perf/disturbance` with its unit tests.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Browser, BrowserContext, Page, Request } from '@playwright/test'
import {
  describeSocketClose,
  DisturbanceLog,
  isNetworkChangeError,
  socketCloseDisturbs,
  summariseDisturbances,
  type Disturbance,
  type FailedAttemptMarker,
  type SocketClose,
  type TouchMargin,
} from '@narrative/perf/disturbance'
import { watchNetwork, type NetworkWatch } from '@narrative/perf/node/networkWatch'

/** The binding the init script reports each WebSocket close through. */
const WS_CLOSE_BINDING = '__narrativePerfWsClose'

/**
 * Runs in every frame before the page's scripts: `WebSocket` becomes a
 * subclass that notes whether page code called `close()` and reports each
 * CloseEvent (code, wasClean) through the binding; it behaves the same
 * otherwise. A string, not a function: a transpiled function can carry
 * helpers (esbuild's `__name`) the page does not have.
 */
const WRAP_WEBSOCKET = `(() => {
  const binding = ${JSON.stringify(WS_CLOSE_BINDING)}
  const Native = window.WebSocket
  if (Native === undefined || window[binding + 'Installed'] === true) return
  window[binding + 'Installed'] = true
  const byPage = new WeakSet()
  const close = Native.prototype.close
  Native.prototype.close = function (code, reason) {
    byPage.add(this)
    return close.apply(this, arguments)
  }
  class WebSocket extends Native {
    constructor(url, protocols) {
      super(url, protocols)
      this.addEventListener('close', (e) => {
        const report = window[binding]
        if (typeof report !== 'function') return
        Promise.resolve(
          report({ at: Date.now(), url: this.url, code: e.code, wasClean: e.wasClean, byPage: byPage.has(this) }),
        ).catch(() => undefined)
      })
    }
  }
  window.WebSocket = WebSocket
})()`

/** A close reported by a page, not yet judged. */
interface ReportedClose extends SocketClose {
  page: Page
}

/** The path a URL is shown with in a note (no query: a token can sit there). */
function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}

export interface NetworkMonitorOptions {
  /** Count a WebSocket that closed under an open page as a disturbance (the perf driver). */
  sockets?: boolean
  /**
   * Count a request that failed because the network is gone altogether
   * (`ERR_INTERNET_DISCONNECTED`) — the perf driver does, its simulation
   * produces it; the e2e fixture does not, specs produce it on purpose
   * (`setOffline`, `route.abort('internetdisconnected')`).
   */
  offline?: boolean
  /** The host watcher's poll interval, ms (default 100). */
  pollMs?: number
}

export class NetworkMonitor {
  readonly log = new DisturbanceLog()
  private readonly watch: NetworkWatch
  private readonly sockets: boolean
  private readonly offline: boolean
  private readonly contexts = new WeakSet<BrowserContext>()
  private readonly browsers = new WeakSet<Browser>()
  private readonly pages = new WeakSet<Page>()
  private closes: ReportedClose[] = []
  /** Page → the socket URLs that closed under it and have not been opened again. */
  private readonly reconnecting = new Map<Page, Set<string>>()

  constructor(options: NetworkMonitorOptions = {}) {
    this.sockets = options.sockets === true
    this.offline = options.offline === true
    this.watch = watchNetwork(this.log, { intervalMs: options.pollMs ?? 100 })
  }

  stop(): void {
    this.watch.stop()
  }

  /** Watch every context this browser makes from now on (a second person's, a spec's own). */
  instrumentBrowser(browser: Browser): void {
    if (this.browsers.has(browser)) return
    this.browsers.add(browser)
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async (...args: Parameters<Browser['newContext']>) => {
      const context = await newContext(...args)
      await this.instrumentContext(context)
      return context
    }
  }

  /** Watch a browser context: its failed requests, and (sockets) its pages' WebSockets. */
  async instrumentContext(context: BrowserContext): Promise<void> {
    if (this.contexts.has(context)) return
    this.contexts.add(context)
    context.on('requestfailed', (request: Request) => {
      const error = request.failure()?.errorText
      if (isNetworkChangeError(error, { offline: this.offline }))
        this.log.record('browser', `${error} ${request.method()} ${shortUrl(request.url())}`)
    })
    if (this.sockets) {
      // Pages opened from here on report their sockets' closes; the binding
      // and the script must be in place before the first page navigates.
      await context.exposeBinding(WS_CLOSE_BINDING, ({ page }, info: SocketClose) => {
        if (page !== undefined && page !== null) this.closes.push({ ...info, page })
      })
      await context.addInitScript(WRAP_WEBSOCKET)
      for (const page of context.pages()) this.instrumentPage(page)
      context.on('page', (page) => this.instrumentPage(page))
    }
  }

  private instrumentPage(page: Page): void {
    if (this.pages.has(page)) return
    this.pages.add(page)
    page.on('close', () => this.reconnecting.delete(page))
    page.on('websocket', (ws) => {
      // A new socket to the same URL: what dropped has reconnected.
      this.reconnecting.get(page)?.delete(ws.url())
    })
  }

  /**
   * Judge the WebSocket closes the pages reported so far
   * (`socketCloseDisturbs`): a dropped one is a disturbance and is waited
   * for to reconnect; one the page or the server closed on purpose is not.
   */
  private judgeSocketCloses(): void {
    const pending = this.closes
    this.closes = []
    for (const c of pending) {
      if (c.page.isClosed() || !socketCloseDisturbs(c, this.log.all())) continue
      this.log.record('browser', describeSocketClose(c, shortUrl(c.url)), c.at)
      let urls = this.reconnecting.get(c.page)
      if (urls === undefined) this.reconnecting.set(c.page, (urls = new Set()))
      urls.add(c.url)
    }
  }

  /** Every event touching [start, end] — after polling the host once more and judging the socket closes. */
  touching(start: number, end: number, margin?: TouchMargin): Disturbance[] {
    this.watch.flush()
    this.judgeSocketCloses()
    return this.log.touching(start, end, margin)
  }

  /**
   * Until the disturbance is over: no event for `quietMs`, and every socket
   * that dropped under an open page connected again. Throws when the network
   * does not settle in `timeoutMs` — the run cannot go on measuring.
   */
  async recover(opts: { quietMs?: number; timeoutMs?: number; reconnectMs?: number } = {}) {
    const quietMs = opts.quietMs ?? 2000
    const timeoutMs = opts.timeoutMs ?? 60_000
    const poll = async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms))
      this.watch.flush()
      this.judgeSocketCloses()
    }
    if (!(await this.log.waitQuiet(quietMs, timeoutMs, poll)))
      throw new Error(
        `the network did not settle for ${quietMs} ms within ${timeoutMs / 1000} s ` +
          `(last: ${summariseDisturbances(this.log.all().slice(-3))})`,
      )
    const until = Date.now() + (opts.reconnectMs ?? 15_000)
    while ([...this.reconnecting.values()].some((s) => s.size > 0) && Date.now() < until)
      await poll(100)
  }
}

// ── e2e: the note a failed attempt leaves its retry ─────────────────────────

/**
 * Where a failed attempt's marker goes: under the project's output directory,
 * which Playwright empties at the start of a run, so no marker outlives it.
 * A retry runs in a new worker process; the file is how it learns why the
 * attempt before it failed.
 */
export function markerFile(outputDir: string, testId: string, retry: number): string {
  return path.join(outputDir, '.network-changes', `${testId}-${retry}.json`)
}

export function writeMarker(file: string, marker: FailedAttemptMarker): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(marker, null, 2))
}

export function readMarker(file: string): FailedAttemptMarker | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as FailedAttemptMarker
  } catch {
    return null
  }
}
