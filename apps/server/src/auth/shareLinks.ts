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
 */

import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '../db/client.js'
import { shareLinks } from '../db/schema.js'
import type { DeckRole } from './permissions.js'

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
  const id = nanoid(21)

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
 * Sets revoked = true on a share link. Subsequent findShareLink calls
 * will return null. No-op if the link does not exist.
 */
export async function revokeShareLink(db: Database, shareLinkId: string): Promise<void> {
  await db.update(shareLinks).set({ revoked: true }).where(eq(shareLinks.id, shareLinkId))
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
