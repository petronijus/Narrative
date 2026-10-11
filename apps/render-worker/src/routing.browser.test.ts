/**
 * routing.browser.test.ts — the production routing (routing.ts) with a real
 * Chromium: the page runs on `https://narrative.test`, and a local server
 * stands in for Caddy. The page's requests to its origin and its WebSocket
 * must reach that server with the app's `Host`; a request anywhere else must
 * be blocked. Skipped where no Chromium can be launched.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { Browser } from 'playwright-core'
import { BrowserHolder } from './browser.js'
import { installUpstreamRouting, putToUpstream } from './routing.js'

const APP = 'https://narrative.test'

let server: Server
let upstream = ''
const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = []
const blocked: string[] = []
const holder = new BrowserHolder({
  idleMs: 60_000,
  chromeExecutable: null,
  requireSandbox: false,
  log: (message) => {
    if (message.startsWith('blocked')) blocked.push(message)
  },
})
let browser: Browser | null = null

const PAGE = `<!doctype html><html><body><script>
  window.results = (async () => {
    const api = await fetch('/api/ping?x=1').then((r) => r.text())
    const echo = await new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://narrative.test/ws?share_token=t')
      ws.onopen = () => ws.send('hello')
      ws.onmessage = (e) => { resolve(String(e.data)); ws.close() }
      ws.onerror = () => reject(new Error('ws failed'))
    })
    let elsewhere = 'reached'
    try { await fetch('https://other.test/secret') } catch { elsewhere = 'blocked' }
    let ip = 'reached'
    try { await fetch('http://127.0.0.1:9/secret') } catch { ip = 'blocked' }
    return { api, echo, elsewhere, ip }
  })()
</script></body></html>`

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'leak=1' })
        res.end(PAGE)
      } else if (req.url?.startsWith('/api/ping')) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('pong')
      } else if (req.url === '/stall') {
        // Never answers: a wedged storage.
      } else if (req.method === 'PUT') {
        res.writeHead(200)
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (socket, req) => {
    seen.push({ method: 'WS', url: req.url ?? '', headers: req.headers, body: '' })
    socket.on('message', (data) => socket.send(`echo:${data.toString()}`))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    // The holder launches like production (sandbox on); keep its browser open.
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

describe('installUpstreamRouting (real Chromium)', () => {
  it('serves the app origin from the upstream with its Host, WebSocket included, and blocks the rest', async (ctx) => {
    if (browser === null) ctx.skip()
    const context = await browser!.newContext()
    try {
      await installUpstreamRouting(context, {
        appOrigin: APP,
        upstream,
        log: (m) => blocked.push(m),
      })
      const page = await context.newPage()
      await page.goto(`${APP}/`)
      const results = await page.evaluate(
        () => (window as unknown as { results: Promise<unknown> }).results,
      )
      expect(results).toEqual({
        api: 'pong',
        echo: 'echo:hello',
        elsewhere: 'blocked',
        ip: 'blocked',
      })
      const apiCall = seen.find((r) => r.url === '/api/ping?x=1')!
      expect(apiCall.headers.host).toBe('narrative.test')
      expect(apiCall.headers['x-forwarded-proto']).toBe('https')
      // The page cannot pick the address the rate limits key on.
      expect(apiCall.headers['cf-connecting-ip']).toBeUndefined()
      const ws = seen.find((r) => r.method === 'WS')!
      expect(ws.url).toBe('/ws?share_token=t')
      expect(ws.headers.host).toBe('narrative.test')
      // The cookie the upstream set never reached the page.
      expect(await context.cookies()).toEqual([])
      expect(blocked.some((m) => m.includes('other.test'))).toBe(true)
    } finally {
      await context.close()
    }
  })

  it('uploads a finished PNG through the upstream with the app Host', async () => {
    await putToUpstream(
      `${APP}/storage/narrative-media/decks/d/x.png?X-Amz-Signature=s`,
      Buffer.from('png'),
      { 'content-type': 'image/png', 'cache-control': 'private, no-store' },
      {
        appOrigin: APP,
        upstream,
      },
    )
    const put = seen.find((r) => r.method === 'PUT')!
    expect(put.url).toBe('/storage/narrative-media/decks/d/x.png?X-Amz-Signature=s')
    expect(put.headers.host).toBe('narrative.test')
    // The signed headers go as given (storage checks them against the signature).
    expect(put.headers['content-type']).toBe('image/png')
    expect(put.headers['cache-control']).toBe('private, no-store')
    expect(put.body).toBe('png')
    await expect(
      putToUpstream(
        'https://other.test/x.png',
        Buffer.from('png'),
        {},
        {
          appOrigin: APP,
          upstream,
        },
      ),
    ).rejects.toThrow(/not on the app origin/)
  })

  it('abandons an upload when its job runs out of time', async () => {
    const stop = new AbortController()
    const put = putToUpstream(
      `${APP}/stall`,
      Buffer.from('png'),
      {},
      {
        appOrigin: APP,
        upstream,
        signal: stop.signal,
      },
    )
    stop.abort()
    await expect(put).rejects.toThrow(/abort/i)
  })
})
