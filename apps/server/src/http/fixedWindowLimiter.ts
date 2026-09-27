/**
 * http/fixedWindowLimiter.ts
 *
 * A tiny in-process fixed-window counter keyed by an arbitrary string (a
 * client IP in practice). It exists for the checks that must run BEFORE any
 * database work, where @fastify/rate-limit cannot help because its key
 * generator itself resolves the caller's identity:
 *
 *   - the per-IP pre-limit on every HTTP request (http/rateLimit.ts), which
 *     bounds how many credential lookups one address can cause;
 *   - the failed-authentication throttle on the Hocuspocus WebSocket
 *     (hocuspocus/authenticate.ts), which bounds share-token and cookie
 *     guessing over the socket.
 *
 * Memory is bounded by the number of distinct keys seen within one window:
 * stale entries are pruned lazily, at most once per window, so an idle
 * limiter does no work and a busy one does O(keys) work once a window.
 * Single-process only, like the rest of the rate limiting (the API runs as
 * one instance).
 */

export interface FixedWindowLimiterOptions {
  /** Hits allowed per key per window. */
  max: number
  windowMs: number
  /** Injectable clock (tests). */
  now?: () => number
}

export interface LimiterDecision {
  allowed: boolean
  /** Hits counted in the current window, including this one. */
  count: number
  /** Milliseconds until the key's window resets. */
  retryAfterMs: number
}

export interface FixedWindowLimiter {
  /** Count one hit for `key` and say whether it is within the limit. */
  hit(key: string): LimiterDecision
  /** Would a hit for `key` be refused right now? Does not count anything. */
  isBlocked(key: string): boolean
  /** Forget `key` (e.g. after a successful authentication). */
  reset(key: string): void
  /** Number of keys currently tracked (tests, metrics). */
  size(): number
}

interface Entry {
  windowStart: number
  count: number
}

export function createFixedWindowLimiter(opts: FixedWindowLimiterOptions): FixedWindowLimiter {
  const { max, windowMs } = opts
  if (!Number.isInteger(max) || max < 1) throw new Error('max must be a positive integer')
  if (!(windowMs > 0)) throw new Error('windowMs must be positive')
  const now = opts.now ?? Date.now
  const entries = new Map<string, Entry>()
  let lastPrune = now()

  function prune(at: number): void {
    if (at - lastPrune < windowMs) return
    lastPrune = at
    for (const [key, entry] of entries) {
      if (at - entry.windowStart >= windowMs) entries.delete(key)
    }
  }

  function current(key: string, at: number): Entry | undefined {
    const entry = entries.get(key)
    if (entry && at - entry.windowStart >= windowMs) {
      entries.delete(key)
      return undefined
    }
    return entry
  }

  return {
    hit(key) {
      const at = now()
      prune(at)
      let entry = current(key, at)
      if (!entry) {
        entry = { windowStart: at, count: 0 }
        entries.set(key, entry)
      }
      entry.count++
      return {
        allowed: entry.count <= max,
        count: entry.count,
        retryAfterMs: Math.max(0, entry.windowStart + windowMs - at),
      }
    },

    isBlocked(key) {
      const at = now()
      const entry = current(key, at)
      return entry !== undefined && entry.count >= max
    },

    reset(key) {
      entries.delete(key)
    },

    size() {
      return entries.size
    },
  }
}
