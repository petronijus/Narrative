/**
 * e2e/fixtures/test.ts — `test` and `expect` for every spec, with the
 * decks and folders the specs create deleted when their worker is done.
 *
 * Specs run as one `dev-user` against one database, and a spec owes it the
 * decks and folders it seeds (AGENTS.md). Many did not: 7,871 decks and 235
 * folders had piled up in the dev database by 2026-10-15, and the editor,
 * which then fetched the whole deck list to learn its role, was read-only
 * for long enough under load to drop a spec's keypress. So the cleanup is no
 * longer each spec's to remember.
 *
 * Every API request context and browser context a spec gets — the `request`
 * and `context` fixtures, `browser.newContext()` for a second person,
 * `playwright.request.newContext()` — notes each deck and folder created
 * through it: `POST /decks`, `POST /decks/:id/duplicate`, `POST /folders`,
 * `POST /folders/:id/import-pptx`, a PPTX imported over tus as a new deck,
 * and the `deck.create` / `deck.duplicate` / `deck.importPptx` /
 * `folder.create` commands — from the spec's own calls and from the page's.
 * When the worker has run its last test, they are deleted as whoever created
 * them (that context's cookies), decks before the folders they may sit in.
 * Not after each test: a `beforeAll` seeds through the same fixtures for the
 * tests that follow it. A spec that deletes its own is fine — a deck or
 * folder already gone answers 404, which is ignored.
 *
 * A network change under the browser (a tethered phone re-attaching: Chrome
 * then aborts every request in flight with `net::ERR_NETWORK_CHANGED`,
 * SETUP.md → Common first-run failures) fails a test for the machine, not
 * the code. Every worker watches for one (networkChange.ts: the host's
 * interfaces, every context's failed requests). A test that failed while
 * one touched it gets a `network-change` annotation and a `network-change`
 * attachment naming each event and its time, and is retried once (the
 * browser projects' `retries: 1`, playwright.config.ts). A test that failed
 * without one is not: its retry stops at once with "failed without a network
 * change: not retried", so it fails in the report as it did on the first
 * attempt — the retry hides nothing nobody explained.
 *
 * Import from here, not from '@playwright/test' (ESLint enforces it for
 * specs); everything else of Playwright is re-exported unchanged.
 */
import {
  test as base,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from '@playwright/test'
import { formatDisturbance, retryVerdict, summariseDisturbances } from '@narrative/perf/disturbance'
import { markerFile, NetworkMonitor, readMarker, writeMarker } from './networkChange'

export * from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const DECK_COMMANDS = new Set(['deck.create', 'deck.duplicate', 'deck.importPptx'])

type Kind = 'decks' | 'folders'
type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>

/** What a worker's specs created, and as whom. */
class Janitor {
  /** `kind/id` → the creator's cookies (none for the default identity). */
  private readonly created = new Map<string, Cookies>()
  /** Page responses whose bodies are still being read. */
  private readonly pending = new Set<Promise<void>>()
  private readonly tracked = new WeakSet<object>()

  /** Note what `api.post` creates; the original method does the request. */
  trackApi(
    api: APIRequestContext,
    cookiesOf: () => Promise<Cookies> = async () => (await api.storageState()).cookies,
  ): void {
    if (this.tracked.has(api)) return
    this.tracked.add(api)
    const post = api.post.bind(api)
    api.post = async (url: string, options?: Parameters<APIRequestContext['post']>[1]) => {
      const response: APIResponse = await post(url, options)
      if (response.ok()) {
        const hit = createdBy(
          response.url(),
          options?.data ?? null,
          parseJson(await response.text().catch(() => null)),
        )
        if (hit !== null) {
          this.note(hit, await cookiesOf().catch(() => []))
        }
      }
      return response
    }
  }

  /** Note what a browser context creates, from its API calls and its pages'. */
  trackContext(context: BrowserContext): void {
    if (this.tracked.has(context)) return
    this.tracked.add(context)
    // PW_TEXT_ENGINE=runs|html: every page of the run draws its canvas text
    // with that engine (apps/web/src/renderer/runText/flag.ts), so the
    // existing specs run against the glyph-run engine before it is the
    // default (ADR 0018). A spec's own choice (its init script) comes later
    // and wins.
    const textEngine = process.env['PW_TEXT_ENGINE']
    if (textEngine === 'runs' || textEngine === 'html') {
      void context.addInitScript((engine) => {
        ;(globalThis as { __narrative_textEngine?: string }).__narrative_textEngine = engine
      }, textEngine)
    }
    // Cookies only: storageState() also reads every page's localStorage,
    // and called while a test drives the page it can stall the context.
    const cookiesOf = () => context.cookies()
    this.trackApi(context.request, cookiesOf)
    // A PPTX imported from the page goes through tus: the POST that opens the
    // upload says (in its metadata) whether it makes a new deck, and the
    // final PATCH to the upload's URL answers with that deck's id.
    const pptxImports = new Set<string>()
    context.on('response', (response) => {
      const request = response.request()
      const method = request.method()
      if (!response.ok()) return
      if (method === 'POST' && isUploadsPath(response.url())) {
        const location = response.headers()['location']
        if (location !== undefined && opensDeckImport(request.headers()['upload-metadata'])) {
          pptxImports.add(withoutQuery(new URL(location, response.url()).href))
        }
        return
      }
      const isImportPatch = method === 'PATCH' && pptxImports.has(withoutQuery(response.url()))
      if (method !== 'POST' && !isImportPatch) return
      const read: Promise<void> = response
        .text()
        .then(async (text) => {
          const body = parseJson(text)
          const deckId = (body as { deckId?: unknown } | null)?.deckId
          const hit = isImportPatch
            ? typeof deckId === 'string'
              ? { kind: 'decks' as const, id: deckId }
              : null
            : createdBy(response.url(), parseJson(request.postData()), body)
          if (hit !== null) this.note(hit, await cookiesOf().catch(() => []))
        })
        .catch(() => {
          // The page navigated or closed before the body could be read.
        })
        .finally(() => this.pending.delete(read))
      this.pending.add(read)
    })
  }

  /** Every new context of this browser is tracked too (a second person's). */
  trackBrowser(browser: Browser): void {
    if (this.tracked.has(browser)) return
    this.tracked.add(browser)
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async (...args: Parameters<Browser['newContext']>) => {
      const context = await newContext(...args)
      this.trackContext(context)
      return context
    }
  }

  private note(hit: { kind: Kind; id: string }, cookies: Cookies): void {
    const key = `${hit.kind}/${hit.id}`
    if (!this.created.has(key)) this.created.set(key, cookies)
  }

  /** Delete everything noted, as its creator: decks first, then folders. */
  async sweep(newApi: (cookies: Cookies) => Promise<APIRequestContext>) {
    await Promise.all(this.pending)
    const byCreator = new Map<string, { cookies: Cookies; paths: string[] }>()
    const ordered = [...this.created].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [path, cookies] of ordered) {
      const creator = JSON.stringify(cookies)
      const group = byCreator.get(creator) ?? { cookies, paths: [] }
      group.paths.push(path)
      byCreator.set(creator, group)
    }
    for (const { cookies, paths } of byCreator.values()) {
      const api = await newApi(cookies)
      try {
        // 'decks/…' sorts before 'folders/…'.
        for (const path of paths) await api.delete(`${API_BASE}/${path}`).catch(() => undefined)
      } finally {
        await api.dispose()
      }
    }
    this.created.clear()
  }
}

/** The deck or folder a creating response names, if the request was one that creates. */
function createdBy(
  url: string,
  postData: unknown,
  body: unknown,
): { kind: Kind; id: string } | null {
  if (body === null || typeof body !== 'object') return null
  const path = new URL(url).pathname.replace(/^\/api(?=\/)/, '')
  const record = body as Record<string, unknown>
  const id = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null)

  if (path === '/decks' || /^\/decks\/[^/]+\/duplicate$/.test(path)) {
    const deckId = id('id')
    return deckId === null ? null : { kind: 'decks', id: deckId }
  }
  if (/^\/folders\/[^/]+\/import-pptx$/.test(path)) {
    const deckId = id('deckId') ?? id('id')
    return deckId === null ? null : { kind: 'decks', id: deckId }
  }
  if (path === '/folders') {
    const folderId = id('id')
    return folderId === null ? null : { kind: 'folders', id: folderId }
  }
  if (path === '/commands') {
    const command = (postData as { command?: unknown } | null)?.command
    const result = record['result'] as Record<string, unknown> | undefined
    if (command === 'folder.create') {
      const folderId = result?.['id']
      return typeof folderId === 'string' ? { kind: 'folders', id: folderId } : null
    }
    if (typeof command !== 'string' || !DECK_COMMANDS.has(command)) return null
    const deckId = result?.['id'] ?? result?.['deckId']
    return typeof deckId === 'string' ? { kind: 'decks', id: deckId } : null
  }
  return null
}

function isUploadsPath(url: string): boolean {
  return /^(\/api)?\/uploads\/?$/.test(new URL(url).pathname)
}

function withoutQuery(url: string): string {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** A tus `Upload-Metadata` header ("key base64, …") that imports a PPTX as a new deck. */
function opensDeckImport(header: string | undefined): boolean {
  if (header === undefined) return false
  const meta = new Map(
    header.split(',').map((pair) => {
      const [key = '', value = ''] = pair.trim().split(' ')
      return [key, Buffer.from(value, 'base64').toString('utf8')] as const
    }),
  )
  // folderId makes a deck; deckId inserts into one that is not ours to delete.
  return meta.get('mimeType') === PPTX_MIME && meta.has('folderId') && !meta.has('deckId')
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

export const test = base.extend<
  { networkCheck: void },
  { janitor: Janitor; network: NetworkMonitor }
>({
  network: [
    async ({}, use) => {
      const network = new NetworkMonitor()
      await use(network)
      network.stop()
    },
    { scope: 'worker' },
  ],
  networkCheck: [
    async ({ network }, use, testInfo) => {
      const outputDir = testInfo.project.outputDir
      if (testInfo.retry > 0) {
        const verdict = retryVerdict(
          testInfo.retry,
          readMarker(markerFile(outputDir, testInfo.testId, testInfo.retry - 1)),
        )
        testInfo.annotations.push({ type: 'network-change', description: verdict.because })
        if (!verdict.run) throw new Error(verdict.because)
      }
      const start = Date.now()
      await use()
      const end = Date.now()
      if (testInfo.status === testInfo.expectedStatus) return
      const seen = network.touching(start, end)
      writeMarker(markerFile(outputDir, testInfo.testId, testInfo.retry), {
        testId: testInfo.testId,
        retry: testInfo.retry,
        status: testInfo.status ?? 'unknown',
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        disturbances: seen.map((e) => ({
          at: new Date(e.at).toISOString(),
          source: e.source,
          detail: e.detail,
        })),
      })
      network.log.prune(end - 10 * 60_000)
      if (seen.length === 0) return
      testInfo.annotations.push({
        type: 'network-change',
        description: `failed while the network changed (${seen.length} event${
          seen.length === 1 ? '' : 's'
        }: ${summariseDisturbances(seen)})`,
      })
      await testInfo.attach('network-change', {
        contentType: 'text/plain',
        body: [
          `This attempt (${new Date(start).toISOString()} – ${new Date(end).toISOString()}) ` +
            `${testInfo.status} while the network under the browser changed:`,
          ...seen.map((e) => `  ${formatDisturbance(e)}`),
          '',
          'Chrome aborts every request in flight on a network change, localhost included',
          '(SETUP.md → Common first-run failures). The test is retried once.',
        ].join('\n'),
      })
    },
    // Before every other fixture, so its window spans their setup too.
    { auto: true },
  ],
  janitor: [
    async ({ playwright }, use) => {
      const janitor = new Janitor()
      const newContext = playwright.request.newContext.bind(playwright.request)
      playwright.request.newContext = async (...args) => {
        const api = await newContext(...args)
        janitor.trackApi(api)
        return api
      }
      await use(janitor)
      playwright.request.newContext = newContext
      await janitor.sweep((cookies) => newContext({ storageState: { cookies, origins: [] } }))
    },
    // Sweeping a worker's leftovers takes a DELETE each.
    { scope: 'worker', auto: true, timeout: 120_000 },
  ],
  browser: [
    async ({ browser, janitor, network }, use) => {
      janitor.trackBrowser(browser)
      network.instrumentBrowser(browser)
      await use(browser)
    },
    { scope: 'worker' },
  ],
  request: async ({ request, janitor }, use) => {
    janitor.trackApi(request)
    await use(request)
  },
  context: async ({ context, janitor, network }, use) => {
    janitor.trackContext(context)
    await network.instrumentContext(context)
    await use(context)
  },
})
