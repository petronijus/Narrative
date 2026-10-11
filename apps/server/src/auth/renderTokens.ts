/**
 * auth/renderTokens.ts
 *
 * Short-lived credentials for the render worker (agentic A3,
 * docs/plans/a3-render-worker.md). The worker loads the real web app at
 * `/deck/:id/render` in headless Chromium; the page reads the deck the way a
 * share-link visitor does — the live deck document over the WebSocket, the
 * folder's tokens and fonts, the deck's media — so a render token IS a share
 * link: `findShareLink` (auth/shareLinks.ts) resolves one to
 * `{ deckId, role: 'viewer' }`, and every route and document that admits a
 * share link admits it, read-only (`shareReadPreHandler` on the media and
 * font reads, `GET /decks/:id`, the deck and folder documents), and nothing
 * else does.
 *
 * A render token (`nrr_` + 43 base64url chars, 256 bits):
 *   - is minted by the server for one render job, after the job's requester
 *     was authorised for the deck — never by a client;
 *   - names one deck and grants viewer access to it only, for as long as the
 *     person who asked for the render can still read that deck:
 *     `findShareLink` re-checks the requester on every use (every new
 *     connection and every media or font read); a connection already open
 *     ends when the token does, so whatever takes a person's access away
 *     also ends their render sessions (render/sessions.ts,
 *     `endRenderSessions`), and deleting a deck closes all its connections;
 *   - expires at the end of its render session — a few minutes per person
 *     and deck, extended by each job (`extendRenderToken`) so the worker can
 *     keep the page it opened for the next job — or when revoked; the page's
 *     live connections are closed then too;
 *   - lives in this process's memory only (its SHA-256, never the token):
 *     the API and the sync server run in one process, which is the only one
 *     that mints and checks them; a restart invalidates them (the render
 *     queue's waiting jobs are dropped at start, services/render.ts).
 */

import { createHash, randomBytes } from 'node:crypto'
import { closeShareTokenConnections } from '../hocuspocus/connections.js'

export const RENDER_TOKEN_PREFIX = 'nrr_'
/** Long enough for a queued job to start and its page to load; short enough to be worthless in a log. */
export const RENDER_TOKEN_TTL_MS = 5 * 60 * 1000

const SECRET_BYTES = 32
const RAW_TOKEN_RE = /^nrr_[A-Za-z0-9_-]{43}$/

/**
 * Whose render a token serves: a person's (their looks and exports), or the
 * server's own background work done as the deck's owner (its card picture,
 * services/deckThumbnails.ts) — kept apart so that work shares neither the
 * owner's render session nor their request budget (http/rateLimit.ts).
 */
export type RenderLane = 'person' | 'background'

interface RenderGrant {
  deckId: string
  /** Who asked for the render; the token reads the deck only while they can. */
  requestedBy: string
  lane: RenderLane
  expiresAt: number
  expiryTimer: ReturnType<typeof setTimeout> | null
  /** Called once when the token ends (expiry or revocation). */
  onEnd: (() => void) | null
}

export interface RenderTokenGrant {
  deckId: string
  requestedBy: string
  lane: RenderLane
}

const grants = new Map<string, RenderGrant>()

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

function drop(hash: string): void {
  const grant = grants.get(hash)
  if (!grant) return
  if (grant.expiryTimer) clearTimeout(grant.expiryTimer)
  grants.delete(hash)
  grant.onEnd?.()
}

/**
 * Whether a value is a render token by its shape (says nothing about
 * validity). The full shape, not just the prefix: a share link's id is a
 * 21-char nanoid, and one that happened to start with `nrr_` must still be
 * looked up as a share link.
 */
export function isRenderToken(value: string): boolean {
  return RAW_TOKEN_RE.test(value)
}

/**
 * Mint a token that lets the render page read `deckId`. The caller has
 * authorised `requestedBy` for the deck.
 */
export function mintRenderToken(
  deckId: string,
  requestedBy: string,
  now: number = Date.now(),
  ttlMs: number = RENDER_TOKEN_TTL_MS,
  onEnd?: () => void,
  lane: RenderLane = 'person',
): string {
  const token = RENDER_TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('base64url')
  const hash = hashToken(token)
  grants.set(hash, {
    deckId,
    requestedBy,
    lane,
    expiresAt: now + ttlMs,
    expiryTimer: null,
    onEnd: onEnd ?? null,
  })
  armExpiry(token, hash, ttlMs)
  return token
}

/** (Re)start the timer that ends the token in `ttlMs`. */
function armExpiry(token: string, hash: string, ttlMs: number): void {
  const grant = grants.get(hash)
  if (!grant) return
  if (grant.expiryTimer) clearTimeout(grant.expiryTimer)
  // At expiry the page's live connections go too: authentication happens
  // once, when a connection opens, so the TTL alone would only stop new ones.
  grant.expiryTimer = setTimeout(() => {
    drop(hash)
    closeShareTokenConnections(token)
  }, ttlMs)
  grant.expiryTimer.unref()
}

/**
 * Move a live token's expiry to `ttlMs` from now (its render session goes
 * on). False when it has already expired or was revoked: mint another.
 */
export function extendRenderToken(token: string, ttlMs: number, now: number = Date.now()): boolean {
  if (resolveRenderToken(token, now) === null) return false
  const hash = hashToken(token)
  grants.get(hash)!.expiresAt = now + ttlMs
  armExpiry(token, hash, ttlMs)
  return true
}

/** The grant of a valid, unexpired token; null for anything else. */
export function resolveRenderToken(
  token: string,
  now: number = Date.now(),
): RenderTokenGrant | null {
  if (!isRenderToken(token)) return null
  const hash = hashToken(token)
  const grant = grants.get(hash)
  if (!grant) return null
  if (grant.expiresAt <= now) {
    drop(hash)
    return null
  }
  return { deckId: grant.deckId, requestedBy: grant.requestedBy, lane: grant.lane }
}

/** End a token before it expires (the job finished), closing the page's connections. */
export function revokeRenderToken(token: string): void {
  drop(hashToken(token))
  closeShareTokenConnections(token)
}

/** Test helper: forget every grant. */
export function clearRenderTokensForTests(): void {
  for (const hash of [...grants.keys()]) drop(hash)
}
