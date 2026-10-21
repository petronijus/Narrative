/**
 * media/imgproxyWarm.ts — the `preview`, `medium` and `display` variants of a
 * new image encoded right after its upload, so its first viewer does not wait for it.
 *
 * Open-source imgproxy has no result cache; the nginx sidecar in front of it
 * (infra/imgproxy-cache/nginx.conf) keeps each encoded variant, keyed by the
 * signed request URI. The first request of a variant still pays for its AVIF
 * encode — for `display` (2560 px) the slowest one — and that is usually the
 * person who just placed the picture on a slide. Here the server asks the
 * cache for them itself, as soon as the upload is a media asset: the
 * same signed paths a browser gets (`signImgproxyUrl`), against the cache's
 * internal address, so nothing goes out through Cloudflare and back.
 *
 * Best effort and bounded, never in the upload's way:
 *   - off unless IMGPROXY_WARM_ENDPOINT names the cache (production:
 *     `http://imgproxy-cache:80`; development has no cache, so warming would
 *     only spend imgproxy's CPU);
 *   - `warmImageVariants` returns at once; the requests run in the
 *     background, IMGPROXY_WARM_CONCURRENCY at a time (default 1: imgproxy
 *     shares the VM's four cores with everyone's live requests);
 *   - at most MAX_PENDING images wait (a PPTX import's hundred pictures
 *     included); past that, new ones are skipped and simply encode on first
 *     view, as before;
 *   - each request ends after WARM_TIMEOUT_MS, its body is drained and
 *     dropped, and a failure is logged at debug level only.
 */

import { signImgproxyUrl, type ImgproxyVariant } from './imgproxyUrl.js'
import { subsystemLogger } from '../observability/logger.js'

const log = subsystemLogger('imgproxy-warm')

/**
 * In the order a person meets them: the slide panel's, then the canvas's —
 * `medium` for a picture that covers up to 1280 device pixels (most of them),
 * `display` for larger ones and HiDPI.
 */
export const WARM_VARIANTS: readonly ImgproxyVariant[] = ['preview', 'medium', 'display']
/** Images waiting to be warmed; past this, new uploads are not warmed. */
export const MAX_PENDING = 200
/** One variant's request (a 2560-px AVIF of a large photo takes seconds). */
export const WARM_TIMEOUT_MS = 60_000

export interface ImgproxyWarmer {
  /** Queue the variants of `storageKey`; false when warming is off or the queue is full. */
  warm(storageKey: string): boolean
  /** Until everything queued so far has been requested (tests, shutdown). */
  idle(): Promise<void>
  readonly pending: number
}

export function createImgproxyWarmer(opts: {
  /** The cache's base URL, no trailing slash; null: warming off. */
  endpoint: string | null
  concurrency?: number
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): ImgproxyWarmer {
  const queue: string[] = []
  const queued = new Set<string>()
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? WARM_TIMEOUT_MS
  let running = 0
  const waiters: Array<() => void> = []

  const settle = (): void => {
    if (running === 0 && queue.length === 0) {
      for (const resolve of waiters.splice(0)) resolve()
    }
  }

  async function request(storageKey: string, variant: ImgproxyVariant): Promise<void> {
    const started = Date.now()
    try {
      const url = signImgproxyUrl({ storageKey, variant, baseUrl: opts.endpoint! })
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      // Read to the end: nginx stores the variant once the whole body went out.
      await res.arrayBuffer()
      log.debug(
        { storageKey, variant, status: res.status, ms: Date.now() - started },
        'imgproxy variant warmed',
      )
    } catch (err) {
      log.debug(
        { storageKey, variant, err: err instanceof Error ? err.message : String(err) },
        'imgproxy warm failed',
      )
    }
  }

  function pump(): void {
    while (running < concurrency && queue.length > 0) {
      const storageKey = queue.shift()!
      running += 1
      void (async () => {
        for (const variant of WARM_VARIANTS) await request(storageKey, variant)
      })().finally(() => {
        // Queued or running, a key is warmed once.
        queued.delete(storageKey)
        running -= 1
        pump()
        settle()
      })
    }
  }

  return {
    warm(storageKey) {
      if (opts.endpoint === null) return false
      if (queued.has(storageKey)) return true
      if (queue.length >= MAX_PENDING) {
        log.debug({ storageKey }, 'imgproxy warm queue full; skipped')
        return false
      }
      queue.push(storageKey)
      queued.add(storageKey)
      pump()
      return true
    },
    idle() {
      if (running === 0 && queue.length === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    },
    get pending() {
      return queue.length + running
    },
  }
}

function endpointFromEnv(): string | null {
  const raw = process.env['IMGPROXY_WARM_ENDPOINT']?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)')
    return raw.replace(/\/+$/, '')
  } catch {
    log.warn({ value: raw }, 'IMGPROXY_WARM_ENDPOINT is not an http(s) URL; warming is off')
    return null
  }
}

let shared: ImgproxyWarmer | null = null

/** The process's warmer, from the environment, on first use. */
export function imgproxyWarmer(): ImgproxyWarmer {
  shared ??= createImgproxyWarmer({
    endpoint: endpointFromEnv(),
    concurrency: Number(process.env['IMGPROXY_WARM_CONCURRENCY'] ?? 1) || 1,
  })
  return shared
}

/** Warm a new image's variants in the background (never throws, never waits). */
export function warmImageVariants(storageKey: string): void {
  try {
    imgproxyWarmer().warm(storageKey)
  } catch (err) {
    log.debug({ storageKey, err: err instanceof Error ? err.message : String(err) }, 'warm skipped')
  }
}
