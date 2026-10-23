/**
 * auth/shareLinks.ts
 *
 * CRUD helpers for share_links — public-token-based deck access.
 *
 * Tokens are nanoid(21) strings — 126 bits of randomness, safe against
 * brute-force guessing at any realistic scale.
 *
 * A share link is considered invalid (findShareLink returns null) if:
 *   - The record does not exist
 *   - revoked = true
 *   - expires_at is set and is in the past
 *
 * The render worker's short-lived tokens (`nrr_…`, auth/renderTokens.ts) are
 * share links too: findShareLink resolves one, from memory, to viewer access
 * to its deck — while the person who asked for the render can still read the
 * deck — so they reach exactly what a viewer's share link reaches.
 */

import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '../db/client.js'
import { shareLinks } from '../db/schema.js'
import { resolveDeckAccess, type DeckRole } from './permissions.js'
import { closeShareTokenConnections } from '../hocuspocus/connections.js'
import { isRenderToken, resolveRenderToken } from './renderTokens.js'
import { looksLikeNarrativeCredential } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateShareLinkArgs {
  deckId: string
  role: DeckRole // typically 'viewer'; 'editor' for public-edit links
  createdBy: string
  expiresAt?: Date | null // null / undefined = never expires
}

export interface ShareLinkRow {
  id: string
  role: DeckRole
  createdAt: Date
  expiresAt: Date | null
  createdBy: string
  revoked: boolean
}

/**
 * Every token a `share_token` can carry: a share-link id (nanoid(21),
 * `createShareLink` below) or a render token (`nrr_` and 43 base64url
 * characters, auth/renderTokens.ts) — both base64url, at most 47 characters.
 * Anything else is no token of ours and is refused before any lookup: a NUL
 * byte or a repeated parameter (an array) reached Postgres and answered 500
 * for an existing asset but 404 for an unknown one (performance.md → F6).
 */
export const SHARE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,64}$/

/** Whether `value` has the shape of a share token (SHARE_TOKEN_SHAPE): one string, nothing else. */
export function isShareTokenShape(value: unknown): value is string {
  return typeof value === 'string' && SHARE_TOKEN_SHAPE.test(value)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new share link for a deck. Returns the generated token and a
 * stub URL (the caller / phase-2 route layer will know the base URL).
 */
export async function createShareLink(
  db: Database,
  args: CreateShareLinkArgs,
): Promise<{ id: string; deckId: string; role: DeckRole }> {
  // An id shaped like a Narrative credential would be taken for one (and,
  // for a render token's shape, never looked up here): draw again.
  let id = nanoid(21)
  while (looksLikeNarrativeCredential(id)) id = nanoid(21)

  await db.insert(shareLinks).values({
    id,
    deckId: args.deckId,
    role: args.role,
    createdBy: args.createdBy,
    expiresAt: args.expiresAt ?? null,
    revoked: false,
  })

  return { id, deckId: args.deckId, role: args.role }
}

/**
 * Sets revoked = true on a share link, scoped to a specific deck so callers
 * cannot revoke links they don't own (IDOR guard — caller must already pass
 * ownerGuard for the deck). No-op if the link does not exist or belongs to a
 * different deck.
 */
export async function revokeShareLink(
  db: Database,
  shareLinkId: string,
  deckId: string,
): Promise<void> {
  await db
    .update(shareLinks)
    .set({ revoked: true })
    .where(and(eq(shareLinks.id, shareLinkId), eq(shareLinks.deckId, deckId)))

  // CONN-1: tear down any live WebSocket connections that authorised
  // themselves with THIS share token — on the deck and on its folder's token
  // document. Without this they'd keep their open session (full read-write
  // for editor links) until they happen to disconnect. Targeted by the full
  // token so co-editors / the owner are untouched.
  closeShareTokenConnections(shareLinkId)
}

/**
 * Looks up a share link by token. Returns null if:
 *   - Token not found
 *   - revoked = true
 *   - expires_at is set and is before now
 */
export async function findShareLink(
  db: Database,
  shareToken: string,
): Promise<{ deckId: string; role: DeckRole } | null> {
  // The routes refuse a malformed token at the boundary (fastifyAuth.ts
  // readShareToken); this keeps every other caller from handing one to Postgres.
  if (!isShareTokenShape(shareToken)) return null
  if (isRenderToken(shareToken)) {
    const grant = resolveRenderToken(shareToken)
    // A component master's render token is no share link of any deck.
    if (!grant || grant.target.kind !== 'deck') return null
    const deckId = grant.target.id
    // The requester must still read the deck (and the deck must still
    // exist): a render never outlives the access that asked for it.
    const requester = await resolveDeckAccess(db, { deckId, userId: grant.requestedBy })
    return requester ? { deckId, role: 'viewer' } : null
  }
  const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareToken)).limit(1)

  if (!row) return null
  if (row.revoked) return null
  if (row.expiresAt !== null && row.expiresAt <= new Date()) return null

  return { deckId: row.deckId, role: row.role as DeckRole }
}

/**
 * Lists all share links for a deck, including revoked ones.
 * Callers can filter by revoked = false if they only want active links.
 */
export async function listShareLinks(db: Database, deckId: string): Promise<ShareLinkRow[]> {
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.deckId, deckId))

  return rows.map((r) => ({
    id: r.id,
    role: r.role as DeckRole,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    revoked: r.revoked,
  }))
}
