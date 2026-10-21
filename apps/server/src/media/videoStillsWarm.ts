/**
 * media/videoStillsWarm.ts — a new video's poster and thumbnail encoded by
 * imgproxy as soon as the video worker stored them, so the person who placed
 * the video does not wait for them (docs/plans/performance.md, R3: images
 * since 2026-10-18, video posters here).
 *
 * The video worker uploads `poster.jpg` and `thumb.jpg` a second after the
 * probe, writes them on the asset (`updateVideoStills`) and reports
 * `{ stage: 'stills', assetId }` on the job's progress
 * (`VideoTranscodeProgress`, @narrative/shared). This process listens to the
 * transcode queue's events and asks the imgproxy cache for exactly the URLs
 * `GET /media/:id/video-info` hands out — the poster's `display` and the
 * thumbnail's `thumb`, both JPEG (services/media.ts `videoInfo`) — signed
 * against the cache's internal address. The event names the asset only; its
 * keys are read from its row (a report on the queue is never trusted for a
 * storage key). A job's `completed` event does the same for a report that
 * was missed (a worker older than the report, a lost event); an asset is
 * warmed once (`RECENT`).
 *
 * Like the image warm-up (imgproxyWarm.ts), best effort and bounded: off
 * unless IMGPROXY_WARM_ENDPOINT names the cache; one request at a time; at
 * most MAX_PENDING videos waiting; each request ends after WARM_TIMEOUT_MS,
 * its body read to the end (nginx stores a variant once the whole body went
 * out) and dropped; failures are logged at debug level only.
 *
 * Its own small queue, not imgproxyWarm.ts's, which warms a fixed list of
 * AVIF variants per key: the two could share one queue once that warmer
 * takes the variants per key (left for after L3, which reworks that file).
 */

import { QueueEvents } from 'bullmq'
import { isVideoStillsProgress, VIDEO_TRANSCODE_QUEUE } from '@narrative/shared'
import type { Database } from '../db/client.js'
import { getVideoAsset } from './assets.js'
import { signImgproxyUrl, type ImgproxyVariant } from './imgproxyUrl.js'
import { subsystemLogger } from '../observability/logger.js'
import { mediaRedisUrl, redisConnection } from '../render/queue.js'

const log = subsystemLogger('imgproxy-warm')

/** Videos waiting to be warmed; past this, new ones are not warmed. */
export const MAX_PENDING = 200
/** One still's request. */
export const WARM_TIMEOUT_MS = 30_000
/** Assets remembered as warmed (a job's progress and its completion name the same one). */
export const RECENT = 500

/** A video's stills as the asset row holds them. */
export interface VideoStills {
  posterKey: string | null
  thumbnailKey: string | null
}

/**
 * What a viewer asks imgproxy for, in the order they are met: the canvas
 * draws the poster, the asset lists the thumbnail. Must match `videoInfo`
 * (services/media.ts) to the byte, or the cache keys differ.
 */
export const VIDEO_STILL_REQUESTS: ReadonlyArray<{
  key: keyof VideoStills
  variant: ImgproxyVariant
  extension: 'jpg'
}> = [
  { key: 'posterKey', variant: 'display', extension: 'jpg' },
  { key: 'thumbnailKey', variant: 'thumb', extension: 'jpg' },
]

export interface VideoStillsWarmer {
  /** Queue the stills of `assetId`; false when warming is off, it was warmed, or the queue is full. */
  warm(assetId: string): boolean
  /** Until everything queued so far has been requested (tests, shutdown). */
  idle(): Promise<void>
  readonly pending: number
}

export function createVideoStillsWarmer(opts: {
  /** The cache's base URL, no trailing slash; null: warming off. */
  endpoint: string | null
  /** The asset's stills now (null: no such video). */
  readStills: (assetId: string) => Promise<VideoStills | null>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): VideoStillsWarmer {
  const queue: string[] = []
  const recent = new Set<string>()
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? WARM_TIMEOUT_MS
  let running = false
  const waiters: Array<() => void> = []

  const remember = (assetId: string): void => {
    recent.add(assetId)
    if (recent.size > RECENT) recent.delete(recent.values().next().value as string)
  }

  async function warmOne(assetId: string): Promise<void> {
    let stills: VideoStills | null
    try {
      stills = await opts.readStills(assetId)
    } catch (err) {
      log.debug({ assetId, err: err instanceof Error ? err.message : String(err) }, 'stills unread')
      return
    }
    if (stills === null) return
    for (const { key, variant, extension } of VIDEO_STILL_REQUESTS) {
      const storageKey = stills[key]
      if (storageKey === null) continue
      const started = Date.now()
      try {
        const url = signImgproxyUrl({ storageKey, variant, extension, baseUrl: opts.endpoint! })
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
        await res.arrayBuffer()
        log.debug(
          { assetId, variant, status: res.status, ms: Date.now() - started },
          'video still warmed',
        )
      } catch (err) {
        log.debug(
          { assetId, variant, err: err instanceof Error ? err.message : String(err) },
          'video still warm failed',
        )
      }
    }
  }

  function pump(): void {
    if (running) return
    const assetId = queue.shift()
    if (assetId === undefined) {
      for (const resolve of waiters.splice(0)) resolve()
      return
    }
    running = true
    void warmOne(assetId).finally(() => {
      running = false
      pump()
    })
  }

  return {
    warm(assetId) {
      if (opts.endpoint === null) return false
      if (recent.has(assetId)) return false
      if (queue.length >= MAX_PENDING) {
        log.debug({ assetId }, 'video stills warm queue full; skipped')
        return false
      }
      remember(assetId)
      queue.push(assetId)
      pump()
      return true
    },
    idle() {
      if (!running && queue.length === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    },
    get pending() {
      return queue.length + (running ? 1 : 0)
    },
  }
}

/** The asset a `completed` event's return value names (VideoTranscodeResult), if any. */
export function assetOfResult(returnvalue: unknown): string | null {
  let value = returnvalue
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) return null
  const assetId = (value as { assetId?: unknown }).assetId
  return typeof assetId === 'string' && assetId !== '' ? assetId : null
}

/** The events this module listens to (a BullMQ QueueEvents, or a stand-in in tests). */
export interface TranscodeEvents {
  on(event: 'progress', listener: (args: { jobId: string; data: unknown }) => void): unknown
  on(event: 'completed', listener: (args: { jobId: string; returnvalue: unknown }) => void): unknown
}

/** Warm on the worker's `stills` report, and on a completion whose report was missed. */
export function listenForVideoStills(events: TranscodeEvents, warmer: VideoStillsWarmer): void {
  events.on('progress', ({ data }) => {
    if (isVideoStillsProgress(data)) warmer.warm(data.assetId)
  })
  events.on('completed', ({ returnvalue }) => {
    const assetId = assetOfResult(returnvalue)
    if (assetId !== null) warmer.warm(assetId)
  })
}

function endpointFromEnv(): string | null {
  const raw = process.env['IMGPROXY_WARM_ENDPOINT']?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)')
    return raw.replace(/\/+$/, '')
  } catch {
    log.warn(
      { value: raw },
      'IMGPROXY_WARM_ENDPOINT is not an http(s) URL; video stills not warmed',
    )
    return null
  }
}

/**
 * Start warming the stills of new videos (the server process, at start).
 * Nothing runs — no Redis connection either — when warming is off. Returns
 * the stop for shutdown.
 */
export function startVideoStillsWarming(db: Database): () => Promise<void> {
  const endpoint = endpointFromEnv()
  if (endpoint === null) return async () => undefined
  const warmer = createVideoStillsWarmer({
    endpoint,
    readStills: async (assetId) => {
      const asset = await getVideoAsset(db, assetId)
      return asset === null
        ? null
        : { posterKey: asset.posterKey, thumbnailKey: asset.thumbnailKey }
    },
  })
  // A QueueEvents holds a blocking connection: its own.
  const connection = redisConnection(mediaRedisUrl(), 'video-events', { offlineQueue: true })
  const events = new QueueEvents(VIDEO_TRANSCODE_QUEUE, { connection })
  events.on('error', (err) => log.warn({ err: err.message }, 'video queue events error'))
  listenForVideoStills(events, warmer)
  return async () => {
    await events.close().catch(() => connection.disconnect())
  }
}
