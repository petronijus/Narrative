/**
 * render.browser.test.ts — renderJob with a real Chromium against a stand-in
 * render page (a local server behind the production routing): the page a
 * session opened is kept and reused by its next job, closed after a failed
 * one, and never handed to another session. Skipped where no Chromium can
 * be launched.
 */

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser } from 'playwright-core'
import type { RenderLookJob } from '@narrative/shared'
import { BrowserHolder } from './browser.js'
import { renderJob, RenderJobError } from './render.js'
import { WarmPages } from './warmPages.js'
import type { RenderWorkerConfig } from './config.js'

const APP = 'https://narrative.test'
/** A 1×1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

/** The render page's job hooks, faked: slide "bad" is refused as not settled. */
const PAGE = `<!doctype html><html><body><script>
  window.__narrativeRender = { status: 'ready', slideId: 's1', slideIndex: 0, failedLoads: 0 }
  window.__narrativeRenderLook = async (spec) => {
    if (spec.slideId === 'bad') return { ok: false, reason: 'not-settled', detail: 'slide bad' }
    return { ok: true, value: { base64: '${PNG_BASE64}', width: 1, height: 1,
      slides: [{ slideId: spec.slideId, index: 0, failedLoads: 0 }], failedFonts: [] } }
  }
</script></body></html>`

let server: Server
let upstream = ''
let pageLoads = 0
let uploads = 0
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
      if (req.url?.startsWith('/deck/')) {
        pageLoads += 1
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(PAGE)
      } else if (req.method === 'PUT') {
        uploads += 1
        res.writeHead(200)
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
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
})

afterAll(async () => {
  await holder.close('test')
  server.close()
})

const job = (token: string, slideId: string): RenderLookJob => ({
  kind: 'look',
  deckId: 'd1',
  token,
  stateVector: '',
  deadline: Date.now() + 30_000,
  workBudgetMs: 20_000,
  look: { mode: 'slide', slideId },
  upload: { url: `${APP}/storage/look.png`, headers: { 'content-type': 'image/png' } },
})

describe('renderJob and the session page', () => {
  it('reuses the page of a session, closes it after a failed job, and keeps sessions apart', async (ctx) => {
    if (browser === null) ctx.skip()
    const config: RenderWorkerConfig = {
      redisUrl: 'redis://unused',
      appOrigin: APP,
      upstream,
      idleMs: 60_000,
      warmPages: 2,
      chromeExecutable: null,
      requireSandbox: false,
    }
    const warm = new WarmPages({ max: 2, idleMs: 60_000, log: () => undefined })
    const deps = { config, log: () => undefined, warm }
    try {
      const first = await renderJob(browser!, job('nrr_a', 's1'), deps)
      expect(first).toMatchObject({
        kind: 'look',
        look: { sizeBytes: Buffer.from(PNG_BASE64, 'base64').byteLength },
      })
      expect([pageLoads, uploads, warm.size]).toEqual([1, 1, 1])
      // The session's next job: the same page, no load.
      await renderJob(browser!, job('nrr_a', 's2'), deps)
      expect([pageLoads, uploads, warm.size]).toEqual([1, 2, 1])
      // Another session never gets that page.
      await renderJob(browser!, job('nrr_b', 's1'), deps)
      expect([pageLoads, warm.size]).toEqual([2, 2])
      // A failed job closes its page; the session's next job opens a new one.
      await expect(renderJob(browser!, job('nrr_a', 'bad'), deps)).rejects.toMatchObject({
        reason: 'not-settled',
      })
      expect(warm.size).toBe(1)
      await renderJob(browser!, job('nrr_a', 's1'), deps)
      expect(pageLoads).toBe(3)
      // Background work closes its page: the people's warm pages stay as they were.
      const before = warm.size
      await renderJob(browser!, { ...job('nrr_c', 's1'), keepPage: false }, deps)
      expect([pageLoads, warm.size]).toEqual([4, before])
    } finally {
      warm.closeAll('test')
    }
  })

  it('refuses a job that arrived after its deadline without opening a page', async (ctx) => {
    if (browser === null) ctx.skip()
    const warm = new WarmPages({ max: 1, idleMs: 60_000, log: () => undefined })
    const before = pageLoads
    const late = { ...job('nrr_c', 's1'), deadline: Date.now() - 1 }
    const error = await renderJob(browser!, late, {
      config: {
        redisUrl: 'redis://unused',
        appOrigin: APP,
        upstream,
        idleMs: 60_000,
        warmPages: 1,
        chromeExecutable: null,
        requireSandbox: false,
      },
      log: () => undefined,
      warm,
    }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(RenderJobError)
    expect((error as RenderJobError).reason).toBe('late')
    expect(pageLoads).toBe(before)
  })
})
