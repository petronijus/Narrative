/**
 * state/authBroadcast.ts — telling the other tabs of this browser that the
 * session changed (ADR 0017, security review M3).
 *
 * One session cookie serves every tab. When a tab signs out, or signs in as
 * someone else, the other tabs still run with the previous user: their open
 * documents would keep writing local copies under that user, after the
 * signing-out tab cleared them. Each tab announces the user it runs for on
 * the `narrative-auth` BroadcastChannel; a tab that hears another user (or
 * none) stops every local-copy write at once and reloads, so it comes back
 * as whoever the cookie now says.
 */

import { setLocalCopyUser, stopAllLocalCopyWrites } from './localDocCopy.js'

export const AUTH_CHANNEL = 'narrative-auth'

interface SessionMessage {
  type: 'session'
  /** The user the announcing tab runs for; null: signed out. */
  sub: string | null
}

let channel: BroadcastChannel | null = null
let onChange: () => void = () => window.location.reload()
/**
 * The user this tab announced (undefined: it does not know yet — still
 * loading, or `/auth/me` failed). Only a tab that knows reacts: two tabs
 * loading at once must not reload each other.
 */
let announced: string | null | undefined = undefined

function isSessionMessage(data: unknown): data is SessionMessage {
  if (data === null || typeof data !== 'object') return false
  const m = data as Record<string, unknown>
  return m['type'] === 'session' && (m['sub'] === null || typeof m['sub'] === 'string')
}

function open(): BroadcastChannel | null {
  if (channel !== null) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    channel = new BroadcastChannel(AUTH_CHANNEL)
  } catch {
    return null
  }
  channel.onmessage = (event: MessageEvent) => {
    if (!isSessionMessage(event.data)) return
    if (announced === undefined) return
    // Another tab runs for the same user (or is signed out as this one is):
    // nothing changed for this one.
    if (event.data.sub === announced) return
    // Nothing of this tab's sessions may be written for a user who is not
    // signed in here any more.
    stopAllLocalCopyWrites()
    setLocalCopyUser(null)
    onChange()
  }
  return channel
}

/** Announce the user this tab runs for (null: it signed out). */
export function announceSession(sub: string | null): void {
  announced = sub
  open()?.postMessage({ type: 'session', sub } satisfies SessionMessage)
}

/** Listen without announcing (a tab that does not know its user yet). */
export function listenForSessionChanges(): void {
  open()
}

/** @internal Tests: what to do on a change instead of reloading; close the channel. */
export function __setSessionChangeHandlerForTests(handler: (() => void) | null): void {
  onChange = handler ?? (() => window.location.reload())
  if (handler === null) {
    channel?.close()
    channel = null
    announced = undefined
  }
}
