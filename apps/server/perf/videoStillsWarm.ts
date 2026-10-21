/**
 * perf/videoStillsWarm.ts — how long a new video's poster and thumbnail make
 * their first viewer wait for imgproxy (docs/plans/performance.md, R3).
 *
 * Generates a short video with ffmpeg (a 1080p and a 4K source, film-like
 * grain so the poster is not a trivially small JPEG), uploads it through the
 * command API (`media.upload`), polls `media.status` until the worker has put
 * the poster on the asset (the editor's own poll runs every 5 s, so its
 * first look comes up to that long after), waits `PERF_DELAY_MS`, and times
 * the first GET of the poster (`display`) and the thumbnail (`thumb`)
 * through the imgproxy cache, as a browser makes it. `X-Cache-Status` says
 * whether the cache had it (HIT), had to encode it (MISS) or joined an
 * encode in flight (UPDATING / the lock).
 *
 * `PERF_WARM=driver` runs the server's warming (src/media/videoStillsWarm.ts:
 * the transcode queue's events, the asset row, the signed URLs) in this
 * process against `PERF_IMG_BASE` — for a dev server started without
 * IMGPROXY_WARM_ENDPOINT, the same code where the server would run it.
 * `PERF_WARM=off` (default) measures what a stack without warming does.
 *
 *   cd apps/server && node --env-file=../../.env --import tsx perf/videoStillsWarm.ts
 *
 *   PERF_API        the API origin (default http://localhost:3001)
 *   PERF_ORIGIN     the Origin the API admits (default http://localhost:5173)
 *   PERF_IMG_BASE   the cache: replaces the URLs' `<origin>/imgproxy`
 *                   (default http://127.0.0.1:8088, the dev compose's
 *                   imgproxy-cache)
 *   PERF_RUNS       videos per size (default 3)
 *   PERF_DELAY_MS   the look after the poster is on the asset (default 2500:
 *                   half the editor's poll)
 *   PERF_WARM       off | driver (default off)
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { QueueEvents } from 'bullmq'
import { median, quantile } from '@narrative/perf/stats'
import { VIDEO_TRANSCODE_QUEUE } from '@narrative/shared'

const API = process.env['PERF_API'] ?? 'http://localhost:3001'
const ORIGIN = process.env['PERF_ORIGIN'] ?? 'http://localhost:5173'
const IMG_BASE = process.env['PERF_IMG_BASE'] ?? 'http://127.0.0.1:8088'
const RUNS = Number(process.env['PERF_RUNS'] ?? 3)
const DELAY_MS = Number(process.env['PERF_DELAY_MS'] ?? 2_500)
const WARM = process.env['PERF_WARM'] ?? 'off'
const PERSON = 'dev-perf-video-stills'

async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Origin: ORIGIN,
      Cookie: `narrative_dev_as=${PERSON}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 300)}`)
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

/**
 * A 2 s H.264 MP4 of `size` under film-like grain, each one different (a
 * fresh cache key) and small enough for the command API's 4 MB body as base64.
 */
function video(dir: string, size: string, i: number): Buffer {
  const file = path.join(dir, `v-${size}-${i}.mp4`)
  const big = size === '3840x2160'
  execFileSync('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=10:duration=2`],
    ...['-vf', `noise=alls=${big ? 14 : 30}:allf=u:all_seed=${(Date.now() + i) % 100_000}`],
    ...['-c:v', 'libx264', '-preset', big ? 'veryfast' : 'ultrafast'],
    ...['-crf', big ? '34' : '30', '-pix_fmt', 'yuv420p'],
    file,
  ])
  return readFileSync(file)
}

interface StatusOut {
  transcodeStatus: string | null
  posterUrl: string | null
  thumbnailUrl: string | null
}

async function untilPoster(deckId: string, assetId: string): Promise<StatusOut> {
  const stop = Date.now() + 120_000
  while (Date.now() < stop) {
    const s = await command<StatusOut>(deckId, 'media.status', { assetId })
    if (s.posterUrl !== null && s.thumbnailUrl !== null) return s
    if (s.transcodeStatus === 'failed') throw new Error(`transcode of ${assetId} failed`)
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no poster for ${assetId} within 120 s`)
}

async function firstView(url: string): Promise<{ ms: number; cache: string; status: number }> {
  const prefix = `${new URL(url).origin}/imgproxy`
  const target = url.startsWith(prefix) ? IMG_BASE + url.slice(prefix.length) : url
  const started = Date.now()
  const res = await fetch(target)
  await res.arrayBuffer()
  return {
    ms: Date.now() - started,
    cache: res.headers.get('x-cache-status') ?? '-',
    status: res.status,
  }
}

/** The server's warming, hosted here (PERF_WARM=driver). */
async function startDriverWarming(): Promise<() => Promise<void>> {
  const { db, pool } = await import('../src/db/client.js')
  const { getVideoAsset } = await import('../src/media/assets.js')
  const { createVideoStillsWarmer, listenForVideoStills } =
    await import('../src/media/videoStillsWarm.js')
  const { mediaRedisUrl, redisConnection } = await import('../src/render/queue.js')
  const warmer = createVideoStillsWarmer({
    endpoint: IMG_BASE,
    readStills: async (assetId) => {
      const asset = await getVideoAsset(db, assetId)
      return asset === null
        ? null
        : { posterKey: asset.posterKey, thumbnailKey: asset.thumbnailKey }
    },
  })
  const connection = redisConnection(mediaRedisUrl(), 'perf-video-events', { offlineQueue: true })
  const events = new QueueEvents(VIDEO_TRANSCODE_QUEUE, { connection })
  await events.waitUntilReady()
  listenForVideoStills(events, warmer)
  return async () => {
    await warmer.idle()
    await events.close()
    await pool.end()
  }
}

async function main(): Promise<void> {
  const stopWarming = WARM === 'driver' ? await startDriverWarming() : null
  console.log(`[perf] warm=${WARM} cache=${IMG_BASE} delay=${DELAY_MS} ms runs=${RUNS}`)
  const dir = mkdtempSync(path.join(tmpdir(), 'perf-video-stills-'))
  const { id: deckId } = await api<{ id: string }>('POST', '/decks', { title: 'perf video stills' })
  try {
    for (const size of ['1920x1080', '3840x2160']) {
      const rows: Record<'poster' | 'thumb', Array<{ ms: number; cache: string }>> = {
        poster: [],
        thumb: [],
      }
      for (let i = 0; i < RUNS; i++) {
        const file = { base64: video(dir, size, i).toString('base64'), filename: `v${i}.mp4` }
        const { assetId } = await command<{ assetId: string }>(deckId, 'media.upload', { file })
        const status = await untilPoster(deckId, assetId)
        await new Promise((r) => setTimeout(r, DELAY_MS))
        rows.poster.push(await firstView(status.posterUrl!))
        rows.thumb.push(await firstView(status.thumbnailUrl!))
      }
      for (const [what, list] of Object.entries(rows)) {
        const ms = list.map((r) => r.ms)
        console.log(
          `[perf] ${size} ${what.padEnd(6)} first view +${DELAY_MS} ms  p50=${Math.round(median(ms))} ` +
            `p95=${Math.round(quantile(ms, 0.95))} ms=${ms.join(',')} cache=${list.map((r) => r.cache).join(',')}`,
        )
      }
    }
  } finally {
    await api('DELETE', `/decks/${deckId}`).catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
    await stopWarming?.()
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
