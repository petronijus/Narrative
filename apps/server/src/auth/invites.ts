/**
 * auth/invites.ts
 *
 * Pending deck and folder invites by email. Used when an owner invites
 * someone who hasn't logged into Narrative yet (so we don't know their
 * Google `sub`). Folder invites (`folder_invites`, folder sharing step 3)
 * follow the same lifecycle and become `folder_permissions` rows.
 *
 * Lifecycle
 * ---------
 *   1. Owner calls `POST /decks/:id/permissions { email, role }`.
 *   2. Server calls `getUserByEmail`:
 *      - Hit → call `grantPermission` directly (this module is not used).
 *      - Miss → call `createInvite()` (this module). Row persists for 30 days.
 *   3. Invitee receives the invite URL: `https://<DOMAIN>/i/<invite-token>`.
 *      (URL handling is in the SPA + apps/server/src/routes/auth.ts.)
 *   4. Invitee logs in via Google with that address VERIFIED. The
 *      /auth/callback handler calls
 *      `consumePendingInvitesForEmail(db, { email, sub, emailVerified })` which:
 *        - finds every pending deck and folder invite for that email,
 *        - inserts a `deck_permissions` / `folder_permissions` row for each,
 *        - marks the invite `accepted_at = now()`, `accepted_by_sub = sub`.
 *
 * Re-inviting the same email replaces the role on the pending row
 * (idempotent — the partial unique indexes enforce "one pending invite per
 * (deck, email)" and per (folder, email)).
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '../db/client.js'
import {
  deckInvites,
  deckPermissions,
  folderInvites,
  folderPermissions,
  type DeckInvite,
  type FolderInvite,
} from '../db/schema.js'
import type { DeckRole } from './permissions.js'
import { subsystemLogger } from '../observability/logger.js'

const log = subsystemLogger('invites')

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
  /**
   * Whether to email the invitee: a new invite, a changed role, or a
   * repeat after RESEND_AFTER_MS. Inviting the same address again and again
   * sends nothing more (security review M2, 2026-10-04): the invite's
   * `invitedAt` records the last email.
   */
  emailDue: boolean
}

/** A repeated invitation with the same role emails again only after this long. */
export const RESEND_AFTER_MS = 24 * 60 * 60 * 1000

/** Postgres unique_violation: a concurrent first invite to the same address won the insert. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Object; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true
  }
  return false
}

/**
 * Create or upsert a pending invite. If a non-accepted invite already exists
 * for (deck, lower(email)), it keeps its id (a link already sent stays
 * valid) and gets the new role, inviter and expiry; `emailDue` says whether
 * to email again. Two first invites at once meet the partial unique index:
 * the loser retries and updates the winner's row.
 */
export async function createInvite(
  db: Database,
  input: CreateInviteInput,
  retried = false,
): Promise<CreateInviteResult> {
  const emailLower = input.email.toLowerCase()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + INVITE_LIFETIME_MS)

  const [existing] = await db
    .select({ id: deckInvites.id, role: deckInvites.role, invitedAt: deckInvites.invitedAt })
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
    const emailDue =
      existing.role !== input.role ||
      now.getTime() - existing.invitedAt.getTime() >= RESEND_AFTER_MS
    await db
      .update(deckInvites)
      .set({
        role: input.role,
        invitedBySub: input.invitedBySub,
        expiresAt,
        ...(emailDue ? { invitedAt: now } : {}),
      })
      .where(eq(deckInvites.id, existing.id))
    return { id: existing.id, expiresAt, replaced: true, emailDue }
  }

  const id = nanoid(12)
  try {
    await db.insert(deckInvites).values({
      id,
      deckId: input.deckId,
      email: emailLower,
      role: input.role,
      invitedBySub: input.invitedBySub,
      invitedAt: now,
      expiresAt,
    })
  } catch (err) {
    if (!retried && isUniqueViolation(err)) return createInvite(db, input, true)
    throw err
  }
  return { id, expiresAt, replaced: false, emailDue: true }
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

// ---------------------------------------------------------------------------
// Folder invites (folder sharing, step 3)
// ---------------------------------------------------------------------------

export interface CreateFolderInviteInput {
  folderId: string
  email: string
  role: DeckRole
  invitedBySub: string
}

/**
 * Create or upsert a pending folder invite — `createInvite` for a folder,
 * with the same id, resend and race rules.
 */
export async function createFolderInvite(
  db: Database,
  input: CreateFolderInviteInput,
  retried = false,
): Promise<CreateInviteResult> {
  const emailLower = input.email.toLowerCase()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + INVITE_LIFETIME_MS)

  const [existing] = await db
    .select({
      id: folderInvites.id,
      role: folderInvites.role,
      invitedAt: folderInvites.invitedAt,
    })
    .from(folderInvites)
    .where(
      and(
        eq(folderInvites.folderId, input.folderId),
        sql`LOWER(${folderInvites.email}) = ${emailLower}`,
        isNull(folderInvites.acceptedAt),
      ),
    )
    .limit(1)

  if (existing) {
    const emailDue =
      existing.role !== input.role ||
      now.getTime() - existing.invitedAt.getTime() >= RESEND_AFTER_MS
    await db
      .update(folderInvites)
      .set({
        role: input.role,
        invitedBySub: input.invitedBySub,
        expiresAt,
        ...(emailDue ? { invitedAt: now } : {}),
      })
      .where(eq(folderInvites.id, existing.id))
    return { id: existing.id, expiresAt, replaced: true, emailDue }
  }

  const id = nanoid(12)
  try {
    await db.insert(folderInvites).values({
      id,
      folderId: input.folderId,
      email: emailLower,
      role: input.role,
      invitedBySub: input.invitedBySub,
      invitedAt: now,
      expiresAt,
    })
  } catch (err) {
    if (!retried && isUniqueViolation(err)) return createFolderInvite(db, input, true)
    throw err
  }
  return { id, expiresAt, replaced: false, emailDue: true }
}

/** Lists pending (non-accepted, non-expired) invites to a folder. */
export async function listPendingInvitesForFolder(
  db: Database,
  folderId: string,
): Promise<FolderInvite[]> {
  return await db
    .select()
    .from(folderInvites)
    .where(
      and(
        eq(folderInvites.folderId, folderId),
        isNull(folderInvites.acceptedAt),
        gt(folderInvites.expiresAt, new Date()),
      ),
    )
}

/** Cancels a pending folder invite. Returns whether one was removed. */
export async function revokeFolderInvite(
  db: Database,
  { folderId, inviteId }: { folderId: string; inviteId: string },
): Promise<boolean> {
  const removed = await db
    .delete(folderInvites)
    .where(
      and(
        eq(folderInvites.id, inviteId),
        eq(folderInvites.folderId, folderId),
        isNull(folderInvites.acceptedAt),
      ),
    )
    .returning({ id: folderInvites.id })
  return removed.length > 0
}

/**
 * Called on every successful /auth/callback. Converts every pending deck and
 * folder invite matching the user's email into a real `deck_permissions` /
 * `folder_permissions` row, marks the invite accepted, and returns the decks
 * and folders the user just joined.
 *
 * Idempotent under retries: the conflict on (deckId | folderId, userId)
 * means a second call is a no-op for anything the user already has a role
 * on — an invite never lowers a role the user holds.
 */
export async function consumePendingInvitesForEmail(
  db: Database,
  { email, sub, emailVerified }: { email: string; sub: string; emailVerified: boolean },
): Promise<ConsumedInvites> {
  // An invite is addressed to an inbox: only a verified claim to it takes it.
  if (!emailVerified) return { joinedDeckIds: [], joinedFolderIds: [], accepted: [] }
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

  const joinedDeckIds: string[] = []
  const accepted: AcceptedInvite[] = []

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
      accepted.push({ kind: 'deck', id: invite.deckId, invitedBySub: invite.invitedBySub })
    } catch (err) {
      // Non-fatal — log and continue with the next invite. The user can
      // re-trigger by signing in again if any rows remain pending.
      log.warn({ id: invite.id, err }, 'failed to consume invite')
    }
  }

  // 3) The same for folder invites: a folder_permissions row each.
  const pendingFolders = await db
    .select()
    .from(folderInvites)
    .where(
      and(
        sql`LOWER(${folderInvites.email}) = ${emailLower}`,
        isNull(folderInvites.acceptedAt),
        gt(folderInvites.expiresAt, now),
      ),
    )

  const joinedFolderIds: string[] = []
  for (const invite of pendingFolders) {
    try {
      await db
        .insert(folderPermissions)
        .values({
          folderId: invite.folderId,
          userId: sub,
          role: invite.role,
          grantedBy: invite.invitedBySub,
        })
        .onConflictDoNothing({ target: [folderPermissions.folderId, folderPermissions.userId] })

      await db
        .update(folderInvites)
        .set({ acceptedAt: now, acceptedBySub: sub })
        .where(eq(folderInvites.id, invite.id))

      joinedFolderIds.push(invite.folderId)
      accepted.push({ kind: 'folder', id: invite.folderId, invitedBySub: invite.invitedBySub })
    } catch (err) {
      log.warn({ id: invite.id, err }, 'failed to consume folder invite')
    }
  }

  return { joinedDeckIds, joinedFolderIds, accepted }
}

/** An invite turned into a role at sign-in, and who sent it. */
export interface AcceptedInvite {
  kind: 'deck' | 'folder'
  id: string
  invitedBySub: string
}

export interface ConsumedInvites {
  joinedDeckIds: string[]
  joinedFolderIds: string[]
  accepted: AcceptedInvite[]
}
