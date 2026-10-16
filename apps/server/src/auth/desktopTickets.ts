/**
 * auth/desktopTickets.ts
 *
 * One-time sign-in tickets of the desktop app (ADR 0015,
 * docs/plans/desktop-d0-spec.md §4). Google refuses OAuth inside an Electron
 * window, so the desktop shell signs in through the system browser:
 *
 *   1. the shell makes a PKCE verifier and opens
 *      `/api/auth/start?client=desktop&code_challenge=…` in the browser;
 *   2. after Google, the callback mints a ticket here — bound to that
 *      challenge — and hands it to the shell through its custom scheme;
 *   3. the shell redeems ticket + verifier with `POST /auth/desktop/redeem`
 *      from inside its own session, which creates the ordinary session and
 *      sets the `narrative_session` cookie where the editor reads it.
 *
 * A ticket (`ndt_` + 43 base64url chars, 256 bits):
 *   - carries who signed in and where to go next, nothing else — the session
 *     row is created only on redeem, so a ticket that is never redeemed
 *     leaves no session behind;
 *   - is valid for 60 s and for one redeem: it is deleted before anything is
 *     checked, so even a redeem with a wrong verifier burns it;
 *   - is worthless without the verifier, which never left the shell — an app
 *     that intercepts the custom-scheme link gets nothing it can redeem;
 *   - lives in this process's memory only (its SHA-256, never the ticket),
 *     like render tokens: the API runs as one process, and a restart within
 *     the 60 s just means signing in again.
 */

import { createHash, randomBytes } from 'node:crypto'
import { PKCE_CHALLENGE, PKCE_VERIFIER, s256Matches } from './pkce.js'

export const DESKTOP_TICKET_PREFIX = 'ndt_'
export const DESKTOP_TICKET_TTL_MS = 60_000
/** Tickets held at once; beyond it the oldest is dropped (a flood cannot grow memory). */
export const DESKTOP_TICKET_CAP = 10_000

const SECRET_BYTES = 32
const RAW_TICKET_RE = /^ndt_[A-Za-z0-9_-]{43}$/

/** The custom schemes a desktop build registers: the release build and the dev build. */
export type DesktopScheme = 'narrative' | 'narrative-dev'

export interface DesktopTicketGrant {
  user: { sub: string; email: string; name: string | null }
  /** A relative path inside the app, already checked by the start route. */
  returnTo: string
}

interface HeldTicket {
  grant: DesktopTicketGrant
  challenge: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

// Insertion-ordered, so the first key is the oldest ticket.
const tickets = new Map<string, HeldTicket>()

const hashTicket = (ticket: string): string =>
  createHash('sha256').update(ticket, 'utf8').digest('hex')

function drop(hash: string): void {
  const held = tickets.get(hash)
  if (!held) return
  clearTimeout(held.timer)
  tickets.delete(hash)
}

/** Whether a value has a desktop ticket's shape (says nothing about validity). */
export function isDesktopTicket(value: unknown): value is string {
  return typeof value === 'string' && RAW_TICKET_RE.test(value)
}

/**
 * Mint a ticket for `grant`, redeemable once within 60 s by whoever holds
 * the verifier of `challenge` (an S256 PKCE challenge).
 */
export function mintDesktopTicket(
  grant: DesktopTicketGrant,
  challenge: string,
  now: number = Date.now(),
): string {
  if (!PKCE_CHALLENGE.test(challenge)) throw new Error('desktop ticket: malformed PKCE challenge')
  while (tickets.size >= DESKTOP_TICKET_CAP) {
    const oldest = tickets.keys().next().value
    if (oldest === undefined) break
    drop(oldest)
  }
  const ticket = DESKTOP_TICKET_PREFIX + randomBytes(SECRET_BYTES).toString('base64url')
  const hash = hashTicket(ticket)
  const timer = setTimeout(() => drop(hash), DESKTOP_TICKET_TTL_MS)
  timer.unref()
  tickets.set(hash, { grant, challenge, expiresAt: now + DESKTOP_TICKET_TTL_MS, timer })
  return ticket
}

/**
 * Redeem a ticket with the verifier of the challenge it was minted for. The
 * grant on success; null for a malformed, unknown, used or expired ticket or
 * a wrong verifier. A known ticket is gone after this call whatever the
 * outcome.
 */
export function redeemDesktopTicket(
  ticket: unknown,
  verifier: unknown,
  now: number = Date.now(),
): DesktopTicketGrant | null {
  if (!isDesktopTicket(ticket)) return null
  if (typeof verifier !== 'string' || !PKCE_VERIFIER.test(verifier)) return null
  const hash = hashTicket(ticket)
  const held = tickets.get(hash)
  if (!held) return null
  drop(hash)
  if (held.expiresAt <= now) return null
  if (!s256Matches(verifier, held.challenge)) return null
  return held.grant
}

/** Tests only: forget every ticket. */
export function clearDesktopTicketsForTests(): void {
  for (const hash of [...tickets.keys()]) drop(hash)
}

/** Tests only: how many tickets are held. */
export function desktopTicketCountForTests(): number {
  return tickets.size
}
