/**
 * services/mediaCopyBudget.ts — how often one person may have the server copy
 * media.
 *
 * Promoting objects to a component, stamping a component, pasting objects
 * from another deck or master, inserting or duplicating slides: each copies
 * every picture and video involved (a deck and a master each own their
 * media), without a single upload byte crossing the wire. A loop of stamps
 * would multiply storage unchecked, so every copy that has media to copy
 * spends one unit of its caller's budget — the same budget whether the
 * editor or an agent asked, since both reach the copy through these
 * services (deckInsert.ts `copyMedia`). In process, like the rest of the
 * rate limiting (http/rateLimit.ts): the API runs as one instance.
 */

import { createFixedWindowLimiter, type FixedWindowLimiter } from '../http/fixedWindowLimiter.js'
import { ServiceError } from './errors.js'

/** Copies with media per user per window. A person stamping by hand never gets near it. */
export const MEDIA_COPY_RATE_LIMIT = { max: 60, timeWindowMs: 60_000 } as const

let shared: FixedWindowLimiter | null = null

/** The process's budget (tests pass their own through `spendMediaCopyBudget`). */
function sharedLimiter(): FixedWindowLimiter {
  shared ??= createFixedWindowLimiter({
    max: MEDIA_COPY_RATE_LIMIT.max,
    windowMs: MEDIA_COPY_RATE_LIMIT.timeWindowMs,
  })
  return shared
}

/**
 * Spend one copy for `userId`, or refuse with 429 before anything is copied.
 */
export function spendMediaCopyBudget(
  userId: string,
  limiter: FixedWindowLimiter = sharedLimiter(),
): void {
  const decision = limiter.hit(`user:${userId}`)
  if (!decision.allowed) {
    const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
    throw new ServiceError(
      'conflict',
      429,
      `Too many media copies (at most ${MEDIA_COPY_RATE_LIMIT.max} a minute); try again in ${seconds} s`,
    )
  }
}
