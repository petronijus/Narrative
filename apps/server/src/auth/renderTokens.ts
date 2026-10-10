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
 *     `findShareLink` re-checks the requester on every use, so a revoked
 *     share, a removed folder member or a deleted deck ends it at once;
 *   - expires when its job's caller stops waiting, plus a margin
 *     (`RENDER_TOKEN_TTL_MS` unless the job asks for its own) — the page's
 *     live connections are closed then too — and is revoked as soon as the
 *     job ends;
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

interface RenderGrant {
  deckId: string
  /** Who asked for the render; the token reads the deck only while they can. */
  requestedBy: string
  expiresAt: number
  expiryTimer: ReturnType<typeof setTimeout> | null
}

export interface RenderTokenGrant {
  deckId: string
  requestedBy: string
}

const grants = new Map<string, RenderGrant>()

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

function drop(hash: string): void {
  const grant = grants.get(hash)
  if (grant?.expiryTimer) clearTimeout(grant.expiryTimer)
  grants.delete(hash)
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
): string {
  const token = RENDER_TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('base64url')
  const hash = hashToken(token)
  // At expiry the page's live connections go too: authentication happens
  // once, when a connection opens, so the TTL alone would only stop new ones.
  const expiryTimer = setTimeout(() => {
    drop(hash)
    closeShareTokenConnections(token)
  }, ttlMs)
  expiryTimer.unref()
  grants.set(hash, { deckId, requestedBy, expiresAt: now + ttlMs, expiryTimer })
  return token
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
  return { deckId: grant.deckId, requestedBy: grant.requestedBy }
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
