/**
 * routing.ts — where the render page's requests go.
 *
 * The page runs on `https://<domain>` (RENDER_APP_ORIGIN): the signed media
 * and font URLs the server hands out name that origin, and the CSP admits
 * only it ('self'). With RENDER_UPSTREAM set (production):
 *   - every request to the app origin — the page, its bundle, the API, the
 *     media, and the `/ws` WebSocket — is answered by the same path on the
 *     upstream (`http://caddy`), with the original `Host`, so Caddy serves it
 *     as the site it is and nothing leaves the VM for Cloudflare and back;
 *   - every other request is refused: the worker's container sits on a
 *     network with Caddy and the media Redis, and the page has no business
 *     with either directly — whatever a deck contains, the page reaches the
 *     app origin and nothing else (`installUpstreamRouting`).
 * The worker's own uploads of the finished PNGs take the same way to Caddy
 * (`putToUpstream`).
 */

import http from 'node:http'
import https from 'node:https'
import type { BrowserContext, Route, WebSocketRoute } from 'playwright-core'
import WebSocket from 'ws'

/** `url` on the upstream instead of the app origin; null when it is not on the app origin. */
export function upstreamUrl(url: string, appOrigin: string, upstream: string): string | null {
  const parsed = new URL(url)
  if (parsed.origin !== appOrigin) return null
  const target = new URL(upstream)
  const isWs = parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
  target.protocol = isWs ? (target.protocol === 'https:' ? 'wss:' : 'ws:') : target.protocol
  target.pathname = parsed.pathname
  target.search = parsed.search
  return target.toString()
}

/** The app origin's WebSocket form (`https:` → `wss:`), which page WebSockets use. */
export function wsOriginOf(appOrigin: string): string {
  const url = new URL(appOrigin)
  return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`
}

/**
 * A close code the page side may be closed with: 1005, 1006 and 1015 are
 * reserved for "no code / abnormal / TLS" and cannot be sent.
 */
function sendableCloseCode(code: number): number {
  return code === 1005 || code === 1006 || code === 1015 || code < 1000 ? 1011 : code
}

/**
 * Request headers that never go upstream: hop-by-hop ones and `host` (set to
 * the app's), the client-IP headers Caddy and the API key rate limits on (the
 * page must not choose its own address), and `accept-encoding` (inside the
 * network compression saves nothing, and a compressed body would have to be
 * decoded again before Chromium is handed it).
 */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'cf-connecting-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'forwarded',
  'accept-encoding',
])

/** Response headers that describe the hop, or that the page must not keep (`set-cookie`). */
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'set-cookie',
])

/** The largest response the worker passes to the page (posters and pictures are far smaller). */
export const MAX_FORWARDED_BYTES = 64 * 1024 * 1024
const FORWARD_TIMEOUT_MS = 30_000

/**
 * One HTTP exchange with the upstream, through node:http — not `fetch`,
 * which ignores a `Host` header, and Caddy picks the site by it. Uncompressed
 * (no `accept-encoding` is sent), passed on with its own headers.
 */
export function forward(
  target: string,
  req: { method: string; headers: Record<string, string>; body: Buffer | null },
  signal?: AbortSignal,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = new URL(target)
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const outgoing = transport.request(
      url,
      { method: req.method, headers: req.headers, ...(signal !== undefined ? { signal } : {}) },
      (incoming) => {
        const chunks: Buffer[] = []
        let size = 0
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > MAX_FORWARDED_BYTES) {
            incoming.destroy(
              new Error(`upstream response over ${MAX_FORWARDED_BYTES} bytes: ${url.pathname}`),
            )
            return
          }
          chunks.push(chunk)
        })
        incoming.on('error', reject)
        incoming.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value === undefined || DROP_RESPONSE_HEADERS.has(name)) continue
            headers[name] = Array.isArray(value) ? value.join(', ') : value
          }
          resolve({ status: incoming.statusCode ?? 502, headers, body: Buffer.concat(chunks) })
        })
      },
    )
    outgoing.on('error', reject)
    outgoing.setTimeout(FORWARD_TIMEOUT_MS, () =>
      outgoing.destroy(new Error(`upstream timeout: ${url.pathname}`)),
    )
    outgoing.end(req.body ?? undefined)
  })
}

/** The request headers to send upstream for a page request. */
export function upstreamHeaders(
  pageHeaders: Record<string, string>,
  appOrigin: string,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(pageHeaders)) {
    const lower = name.toLowerCase()
    if (!DROP_REQUEST_HEADERS.has(lower) && !lower.startsWith(':')) headers[lower] = value
  }
  headers['host'] = new URL(appOrigin).host
  // Caddy and the API see the visitor's scheme as Cloudflare would report it.
  headers['x-forwarded-proto'] = new URL(appOrigin).protocol.replace(':', '')
  return headers
}

export async function installUpstreamRouting(
  context: BrowserContext,
  opts: { appOrigin: string; upstream: string; log: (message: string) => void },
): Promise<void> {
  const wsOrigin = wsOriginOf(opts.appOrigin)

  // Registered first, so it runs last: anything not on the app origin.
  await context.route('**/*', async (route: Route) => {
    opts.log(`blocked a request off the app origin: ${new URL(route.request().url()).origin}`)
    await route.abort('blockedbyclient')
  })
  await context.route(`${opts.appOrigin}/**`, async (route: Route) => {
    const request = route.request()
    const target = upstreamUrl(request.url(), opts.appOrigin, opts.upstream)
    if (target === null) return route.abort('blockedbyclient')
    try {
      const response = await forward(target, {
        method: request.method(),
        headers: upstreamHeaders(await request.allHeaders(), opts.appOrigin),
        body: request.postDataBuffer(),
      })
      await route.fulfill(response)
    } catch {
      await route.abort('failed')
    }
  })

  await context.routeWebSocket(
    () => true,
    (page: WebSocketRoute) => {
      const target =
        new URL(page.url()).origin === wsOrigin
          ? upstreamUrl(page.url(), wsOrigin, opts.upstream)
          : null
      if (target === null) {
        opts.log(`blocked a WebSocket off the app origin: ${new URL(page.url()).origin}`)
        page.close({ code: 1008, reason: 'not the app origin' })
        return
      }
      const server = new WebSocket(target, {
        headers: upstreamHeaders({ origin: opts.appOrigin }, opts.appOrigin),
      })
      const pending: Array<string | Buffer> = []
      server.on('open', () => {
        for (const message of pending.splice(0)) server.send(message)
      })
      server.on('message', (data, isBinary) => {
        page.send(isBinary ? Buffer.from(data as Buffer) : data.toString())
      })
      server.on('close', (code, reason) =>
        page.close({ code: sendableCloseCode(code), reason: reason.toString() }),
      )
      server.on('error', () => page.close({ code: 1011, reason: 'upstream error' }))
      page.onMessage((message) => {
        if (server.readyState === WebSocket.OPEN) server.send(message)
        else pending.push(message)
      })
      page.onClose(() => server.close())
    },
  )
}

/**
 * GET a presigned storage URL (a compare's "before" state the server stored
 * for the job), routed like `putToUpstream`. `signal` aborts it.
 */
export async function getFromUpstream(
  url: string,
  opts: { appOrigin: string; upstream: string | null; signal?: AbortSignal },
): Promise<Buffer> {
  const target = opts.upstream !== null ? upstreamUrl(url, opts.appOrigin, opts.upstream) : url
  if (target === null)
    throw new Error(`download URL is not on the app origin: ${new URL(url).origin}`)
  const headers: Record<string, string> = {}
  if (opts.upstream !== null) headers['host'] = new URL(opts.appOrigin).host
  const response = await forward(target, { method: 'GET', headers, body: null }, opts.signal)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`download answered ${response.status}`)
  }
  return response.body
}

/**
 * PUT `body` to a presigned storage URL with the headers its signature
 * covers (`signedHeaders`, sent as given). With an upstream, a URL on the app
 * origin goes to it with the original `Host` (also signed); otherwise
 * straight to the URL (development: MinIO's own port). `signal` aborts it.
 */
export async function putToUpstream(
  url: string,
  body: Buffer,
  signedHeaders: Record<string, string>,
  opts: { appOrigin: string; upstream: string | null; signal?: AbortSignal },
): Promise<void> {
  const target = opts.upstream !== null ? upstreamUrl(url, opts.appOrigin, opts.upstream) : url
  if (target === null)
    throw new Error(`upload URL is not on the app origin: ${new URL(url).origin}`)
  const headers: Record<string, string> = {
    ...signedHeaders,
    'content-length': String(body.byteLength),
  }
  if (opts.upstream !== null) headers['host'] = new URL(opts.appOrigin).host
  const response = await forward(target, { method: 'PUT', headers, body }, opts.signal)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`upload answered ${response.status}`)
  }
}
