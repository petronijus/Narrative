/**
 * services/downloadSlots.ts
 *
 * At most `MAX_URL_DOWNLOADS_PER_USER` (2) URL downloads in flight per user.
 *
 * A URL source makes the server fetch a file on the caller's behalf — up to
 * 200 MB, for up to a few minutes, holding a socket and a temporary file the
 * whole time. Without a per-user bound, one agent (or one leaked token)
 * could start dozens at once and fill the disk and the network for everyone.
 * Two is enough for an agent that fetches an image while a deck imports.
 *
 * It is a try-acquire, not a queue: a third download is refused at once with
 * a `conflict` ("another download is in progress"), so the caller retries
 * when one finishes instead of piling up waiting requests. The count lives in
 * this process only — correct for Narrative's single API process; several
 * API replicas would each allow two.
 */

import { conflict } from './errors.js'

export const MAX_URL_DOWNLOADS_PER_USER = 2

const inFlight = new Map<string, number>()

/**
 * Take one of the user's download slots, or throw `conflict` when both are
 * taken. The slot is freed when the returned handle is disposed — hold it
 * with `using`, so it is freed however the scope exits. Disposal is
 * idempotent: disposing a handle twice does not free someone else's slot.
 */
export function acquireDownloadSlot(userId: string): Disposable {
  const current = inFlight.get(userId) ?? 0
  if (current >= MAX_URL_DOWNLOADS_PER_USER) {
    throw conflict(
      `another download is in progress — at most ${MAX_URL_DOWNLOADS_PER_USER} URL downloads ` +
        'run at once per user; retry when one has finished',
    )
  }
  inFlight.set(userId, current + 1)
  let released = false
  return {
    [Symbol.dispose]() {
      if (released) return
      released = true
      const n = (inFlight.get(userId) ?? 1) - 1
      if (n <= 0) inFlight.delete(userId)
      else inFlight.set(userId, n)
    },
  }
}

/** Downloads the user has in flight (tests, diagnostics). */
export function downloadsInFlight(userId: string): number {
  return inFlight.get(userId) ?? 0
}
