/**
 * perf/imgproxyWarm.ts — how long a new image's first view waits for
 * imgproxy (docs/plans/performance.md, R3).
 *
 * Uploads a photo-sized picture through the command API (`media.upload`, the
 * path agents and the editor's server-side uploads take), asks for its
 * `display` and `preview` URLs (`media.url`) and times the first GET of each
 * the way a browser makes it: through the app origin's `/imgproxy/*`, which
 * in production is the nginx disk cache in front of imgproxy. Each sample is
 * a fresh picture (a fresh cache key). The first view is timed right after
 * the upload answered, and again `PERF_DELAY_MS` later — the moment someone
 * who just uploaded it would look at it on the canvas. `X-Cache-Status`
 * says whether the cache had it (HIT), had to encode it (MISS), or joined
 * an encode in flight.
 *
 * Run against a stack whose `/imgproxy/*` goes through a cache:
 *
 *   node --import tsx apps/server/perf/imgproxyWarm.ts
 *
 *   PERF_API        the API origin (default http://localhost:3001)
 *   PERF_ORIGIN     the Origin the API admits (default http://localhost:5173)
 *   PERF_IMG_BASE   the cache to fetch from instead: replaces the URLs'
 *                   `<origin>/imgproxy` (e.g. http://127.0.0.1:8088, the dev
 *                   compose's imgproxy-cache port; default: the URL as given)
 *   PERF_RUNS       pictures per delay (default 4)
 *   PERF_DELAY_MS   the later look (default 5000)
 *   PERF_SIZE       the picture, WxH (default 3000x2000: a phone photo)
 */

import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { median, quantile } from '@narrative/perf/stats'

const API = process.env['PERF_API'] ?? 'http://localhost:3001'
const ORIGIN = process.env['PERF_ORIGIN'] ?? 'http://localhost:5173'
const IMG_BASE = process.env['PERF_IMG_BASE'] ?? null
const RUNS = Number(process.env['PERF_RUNS'] ?? 4)
const DELAY_MS = Number(process.env['PERF_DELAY_MS'] ?? 5_000)
const [W, H] = (process.env['PERF_SIZE'] ?? '3000x2000').split('x').map(Number) as [number, number]
const PERSON = 'dev-perf-imgproxy'

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      Cookie: `narrative_dev_as=${PERSON}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function command<T>(deckId: string, id: string, input: unknown): Promise<T> {
  const body = await api<{ ok: boolean; result: T; error?: { message: string } }>(
    'POST',
    '/commands',
    { target: { deckId }, command: id, input },
  )
  if (!body.ok) throw new Error(`${id}: ${body.error?.message}`)
  return body.result
}

/** A photo-like JPEG: smooth gradients under noise, so it neither compresses away nor is pure noise. */
async function photo(): Promise<Buffer> {
  const noise = randomBytes(W * H * 3)
  for (let i = 0; i < noise.length; i++) {
    const p = Math.floor(i / 3)
    const x = p % W
    const y = Math.floor(p / W)
    noise[i] = (noise[i]! >> 4) + Math.round((x / W) * 150 + (y / H) * 60 + (i % 3) * 10)
  }
  return sharp(noise, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 88 })
    .toBuffer()
}

async function firstView(url: string): Promise<{ ms: number; cache: string; status: number }> {
  const prefix = `${new URL(url).origin}/imgproxy`
  const target =
    IMG_BASE !== null && url.startsWith(prefix) ? IMG_BASE + url.slice(prefix.length) : url
  const started = Date.now()
  const res = await fetch(target)
  await res.arrayBuffer()
  return {
    ms: Date.now() - started,
    cache: res.headers.get('x-cache-status') ?? '-',
    status: res.status,
  }
}

async function main(): Promise<void> {
  const { id: deckId } = await api<{ id: string }>('POST', '/decks', {
    title: 'perf imgproxy warm',
  })
  const rows: Record<string, Array<{ ms: number; cache: string; status: number }>> = {}
  try {
    for (const delay of [0, DELAY_MS]) {
      for (const variant of ['display', 'preview'] as const) {
        const key = `${variant} first view +${delay} ms`
        rows[key] = []
        for (let i = 0; i < RUNS; i++) {
          const file = { base64: (await photo()).toString('base64'), filename: `photo-${i}.jpg` }
          const { assetId } = await command<{ assetId: string }>(deckId, 'media.upload', { file })
          const { url } = await command<{ url: string }>(deckId, 'media.url', { assetId, variant })
          if (delay > 0) await new Promise((r) => setTimeout(r, delay))
          rows[key].push(await firstView(url))
        }
        const ms = rows[key].map((r) => r.ms)
        console.log(
          `[perf] ${key.padEnd(28)} p50=${Math.round(median(ms))} p95=${Math.round(quantile(ms, 0.95))} ` +
            `cache=${rows[key].map((r) => r.cache).join(',')}`,
        )
      }
    }
  } finally {
    await api('DELETE', `/decks/${deckId}`).catch(() => undefined)
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
