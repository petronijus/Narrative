/**
 * auth/invites.ts
 *
 * Pending deck invites by email. Used when the owner invites someone who
 * hasn't logged into Narrative yet (so we don't know their Google `sub`).
 *
 * Lifecycle
 * ---------
 *   1. Owner calls `POST /decks/:id/permissions { email, role }`.
 *   2. Server calls `getUserByEmail`:
 *      - Hit → call `grantPermission` directly (this module is not used).
 *      - Miss → call `createInvite()` (this module). Row persists for 30 days.
 *   3. Invitee receives the invite URL: `https://<DOMAIN>/i/<invite-token>`.
 *      (URL handling is in the SPA + apps/server/src/routes/auth.ts.)
 *   4. Invitee logs in via Google. The /auth/callback handler calls
 *      `consumePendingInvitesForEmail(db, { email, sub })` which:
 *        - finds every pending invite for that email,
 *        - inserts a `deck_permissions` row for each,
 *        - marks the invite `accepted_at = now()`, `accepted_by_sub = sub`.
 *
 * Re-inviting the same email replaces the role on the pending row
 * (idempotent — the partial unique index enforces "one pending invite per
 * (deck, email)").
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '../db/client.js'
import { deckInvites, deckPermissions, type DeckInvite } from '../db/schema.js'
import type { DeckRole } from './permissions.js'

/** 30 days — matches `SESSION_LIFETIME_MS`. */
const INVITE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateInviteInput {
  deckId: string
  email: string
  role: DeckRole
  invitedBySub: string
}

export interface CreateInviteResult {
  /** The invite id, which is also the URL-safe token. NEVER log. */
  id: string
  expiresAt: Date
  /** True if this overwrote an existing pending invite (same deck+email). */
  replaced: boolean
}

/**
 * Create or upsert a pending invite. If a non-accepted invite already exists
 * for (deck, lower(email)), the role is updated and a fresh token + expiry
 * are issued (callers should send the new URL to the invitee).
 */
export async function createInvite(
  db: Database,
  input: CreateInviteInput,
): Promise<CreateInviteResult> {
  const emailLower = input.email.toLowerCase()
  const id = nanoid(12)
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS)

  // Find an existing pending row to know if we're replacing.
  const [existing] = await db
    .select({ id: deckInvites.id })
    .from(deckInvites)
    .where(
      and(
        eq(deckInvites.deckId, input.deckId),
        sql`LOWER(${deckInvites.email}) = ${emailLower}`,
        isNull(deckInvites.acceptedAt),
      ),
    )
    .limit(1)

  if (existing) {
    await db
      .update(deckInvites)
      .set({
        // Keep the existing id (so any URL already shared still works) but
        // refresh role + expiry.
        role: input.role,
        invitedBySub: input.invitedBySub,
        invitedAt: new Date(),
        expiresAt,
      })
      .where(eq(deckInvites.id, existing.id))
    return { id: existing.id, expiresAt, replaced: true }
  }

  await db.insert(deckInvites).values({
    id,
    deckId: input.deckId,
    email: emailLower,
    role: input.role,
    invitedBySub: input.invitedBySub,
    expiresAt,
  })

  return { id, expiresAt, replaced: false }
}

/** Lists pending (non-accepted, non-expired) invites for a deck. */
export async function listPendingInvitesForDeck(
  db: Database,
  deckId: string,
): Promise<DeckInvite[]> {
  return await db
    .select()
    .from(deckInvites)
    .where(
      and(
        eq(deckInvites.deckId, deckId),
        isNull(deckInvites.acceptedAt),
        gt(deckInvites.expiresAt, new Date()),
      ),
    )
}

/** Cancels a pending invite. Idempotent. */
export async function revokeInvite(
  db: Database,
  { deckId, inviteId }: { deckId: string; inviteId: string },
): Promise<void> {
  await db
    .delete(deckInvites)
    .where(
      and(
        eq(deckInvites.id, inviteId),
        eq(deckInvites.deckId, deckId),
        isNull(deckInvites.acceptedAt),
      ),
    )
}

/**
 * Called on every successful /auth/callback. Converts every pending invite
 * matching the user's email into a real `deck_permissions` row, marks the
 * invite accepted, and returns the count of decks the user just joined.
 *
 * Idempotent under retries: the conflict on (deckId, userId) means a second
 * call is a no-op for any decks the user already has permissions on.
 */
export async function consumePendingInvitesForEmail(
  db: Database,
  { email, sub }: { email: string; sub: string },
): Promise<{ joinedDeckIds: string[] }> {
  const emailLower = email.toLowerCase()
  const now = new Date()

  // 1) Find every pending invite for this email.
  const pending = await db
    .select()
    .from(deckInvites)
    .where(
      and(
        sql`LOWER(${deckInvites.email}) = ${emailLower}`,
        isNull(deckInvites.acceptedAt),
        gt(deckInvites.expiresAt, now),
      ),
    )

  if (pending.length === 0) {
    return { joinedDeckIds: [] }
  }

  const joinedDeckIds: string[] = []

  // 2) For each invite, upsert a deck_permissions row and mark the invite
  // accepted. Done one row at a time so a partial failure (e.g. one deck
  // already deleted) doesn't block the others.
  for (const invite of pending) {
    try {
      await db
        .insert(deckPermissions)
        .values({
          deckId: invite.deckId,
          userId: sub,
          role: invite.role,
          grantedBy: invite.invitedBySub,
        })
        .onConflictDoNothing({ target: [deckPermissions.deckId, deckPermissions.userId] })

      await db
        .update(deckInvites)
        .set({ acceptedAt: now, acceptedBySub: sub })
        .where(eq(deckInvites.id, invite.id))

      joinedDeckIds.push(invite.deckId)
    } catch (err) {
      // Non-fatal — log and continue with the next invite. The user can
      // re-trigger by signing in again if any rows remain pending.
      console.warn('[invites] failed to consume invite', { id: invite.id, err })
    }
  }

  return { joinedDeckIds }
}
