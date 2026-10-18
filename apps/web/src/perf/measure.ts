/**
 * perf/measure.ts — the pure parts of the harness (docs/plans/perf-harness.md):
 * the size of a texture upload from a WebGL call's arguments, a request's
 * route and counter bucket, and the latency bookkeeping of input-to-pixel.
 * No DOM, no GL: harness.ts feeds them, harness tests cover them.
 */

/** Width × height of an upload source (image, canvas, bitmap, video, frame, ImageData). */
export function sourceSize(source: unknown): { width: number; height: number } | null {
  if (source === null || typeof source !== 'object') return null
  const s = source as Record<string, unknown>
  const pick = (w: string, h: string): { width: number; height: number } | null => {
    const width = s[w]
    const height = s[h]
    return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      ? { width, height }
      : null
  }
  // A video and an <img> report their intrinsic size apart from the layout one.
  return (
    pick('videoWidth', 'videoHeight') ??
    pick('naturalWidth', 'naturalHeight') ??
    pick('displayWidth', 'displayHeight') ??
    pick('width', 'height')
  )
}

/**
 * The pixels a `texImage2D` / `texSubImage2D` call uploads, from its arguments
 * (WebGL 1 and 2 overloads), or null for an allocation without data.
 *
 *   texImage2D(target, level, ifmt, width, height, border, format, type, pixels|offset|source)  — 9+
 *   texImage2D(target, level, ifmt, format, type, source)                                       — 6
 *   texSubImage2D(target, level, x, y, width, height, format, type, pixels|offset|source)      — 9+
 *   texSubImage2D(target, level, x, y, format, type, source)                                    — 7
 */
export function texUploadPixels(
  method: 'texImage2D' | 'texSubImage2D',
  args: readonly unknown[],
): number | null {
  const n = (v: unknown): number | null => (typeof v === 'number' && v >= 0 ? v : null)
  if (method === 'texImage2D') {
    if (args.length >= 9) {
      if (args[8] === null || args[8] === undefined) return null
      const w = n(args[3])
      const h = n(args[4])
      return w === null || h === null ? null : w * h
    }
    if (args.length === 6) {
      const size = sourceSize(args[5])
      return size === null ? null : size.width * size.height
    }
    return null
  }
  if (args.length >= 9) {
    const w = n(args[4])
    const h = n(args[5])
    return w === null || h === null ? null : w * h
  }
  if (args.length === 7) {
    const size = sourceSize(args[6])
    return size === null ? null : size.width * size.height
  }
  return null
}

const ID_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{8,}$|^[0-9a-f]{8}-[0-9a-f-]{27}$|^\d+$/

/**
 * A request's route: method-less path with ids replaced by `:id`
 * (`/api/media/abc123XYZ_/url` → `/api/media/:id/url`); hashed build assets
 * become `/assets/*`; other origins keep their host.
 */
export function routeOf(url: string, pageOrigin: string): string {
  let u: URL
  try {
    u = new URL(url, pageOrigin)
  } catch {
    return url
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return `${u.protocol}…`
  const prefix = u.origin === pageOrigin ? '' : u.host
  if (u.pathname.startsWith('/assets/')) return `${prefix}/assets/*`
  // Vite dev serves sources under /src, /node_modules and /@…: one bucket.
  if (/^\/(src|node_modules|@vite|@id|@fs|@react-refresh)\b/.test(u.pathname))
    return `${prefix}/(dev module)`
  const path = u.pathname
    .split('/')
    .map((seg) => (ID_SEGMENT.test(seg) ? ':id' : seg))
    .join('/')
  return `${prefix}${path}`
}

/** The counter a request adds to (`net.api`, `net.imgproxy`, …); every request also counts in `net.requests`. */
export function netBucket(route: string): string {
  if (route.startsWith('/api/media/') && route.endsWith('/url')) return 'net.mediaUrl'
  if (route.startsWith('/api/')) return 'net.api'
  if (route.startsWith('/imgproxy/')) return 'net.imgproxy'
  if (route.startsWith('/storage/')) return 'net.storage'
  if (route === '/assets/*' || route === '/(dev module)') return 'net.code'
  if (route.startsWith('data:') || route.startsWith('blob:')) return 'net.inline'
  return 'net.other'
}

/** One input event waiting for the frame that shows it. */
export interface PendingInput {
  type: string
  /** `event.timeStamp`, ms on the page's clock. */
  at: number
}

export interface InputLatency {
  type: string
  ms: number
  /** `canvas`: a fenced editor render showed it; `dom`: the next painted frame (no canvas render followed). */
  via: 'canvas' | 'dom'
}

/**
 * Settle the inputs a frame shows: every pending input that happened before
 * `frameStart` is resolved at `paintedAt`. Returns the resolved latencies and
 * the inputs still waiting (those that came in during the frame).
 */
export function settleInputs(
  pending: readonly PendingInput[],
  frameStart: number,
  paintedAt: number,
  via: InputLatency['via'],
): { resolved: InputLatency[]; waiting: PendingInput[] } {
  const resolved: InputLatency[] = []
  const waiting: PendingInput[] = []
  for (const p of pending) {
    if (p.at <= frameStart) resolved.push({ type: p.type, ms: Math.max(0, paintedAt - p.at), via })
    else waiting.push(p)
  }
  return { resolved, waiting }
}

/** Percentile of a sample (nearest rank on the sorted copy); 0 for an empty one. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!
}
