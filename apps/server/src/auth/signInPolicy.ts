/**
 * auth/signInPolicy.ts
 *
 * Who is allowed to use Narrative at all — the one rule shared by Google
 * sign-in (`/auth/callback`, routes/auth.ts) and by every personal access
 * token verification (auth/personalAccessTokens.ts), so a token can never
 * outlive its owner's removal from the allowlist.
 *
 * An account is allowed when EITHER
 *   (1) the env allowlist admits it (`OIDC_ALLOWED_EMAILS` /
 *       `OIDC_ALLOWED_DOMAIN`, `isAllowedByEnv` — the domain rule requires a
 *       verified email), OR
 *   (2) the database implicitly admits it (`allowedByDb`), for a VERIFIED
 *       email only (an invite is addressed to an inbox; an unverified claim
 *       to that address proves nothing):
 *       (a) a non-expired, non-accepted invite in `deck_invites` or
 *           `folder_invites`, or an address an instance admin allowed
 *           (`allowed_emails`, docs/adr/0014), or
 *       (b) a `deck_permissions` row on a deck somebody else created, or a
 *           `folder_permissions` row in a folder somebody else created (via
 *           `users.email`).
 *
 * Case (2a) is the new-collaborator flow — owner sends invite, invitee signs
 * in, /auth/callback consumes the invite into a permission. Case (2b) is the
 * returning-collaborator flow — already accepted, has ongoing access. Without
 * it they'd be locked out the first time their session cookie expired if
 * they aren't on the env allowlist. Only what someone else shared counts:
 * every deck gets its creator's owner row and everyone owns their Drafts,
 * and those must not keep an account removed from the allowlist signing in
 * (security review H2, M3; Petr 2026-10-04).
 */

import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import {
  allowedEmails,
  deckInvites,
  deckPermissions,
  decks,
  folderInvites,
  folderPermissions,
  folders,
  users,
} from '../db/schema.js'
import { isAllowedByEnv, type AllowlistConfig } from './jwt.js'

/** What the policy needs to know about an account. */
export interface SignInSubject {
  email: string
  /** Whether the IdP verified the email (Google's `email_verified`). */
  emailVerified: boolean
}

/** Why an account is allowed, or `null` when it is not. */
export type SignInGrant = 'env' | 'admin' | 'allowlist' | 'invite' | 'permission'

/**
 * Is the account implicitly allowed by a pending invite, or by a deck or a
 * folder someone else shared with it? Never for an unverified email.
 */
export async function allowedByDb(
  db: Database,
  subject: SignInSubject,
): Promise<Exclude<SignInGrant, 'env'> | null> {
  if (!subject.emailVerified) return null
  const lower = subject.email.toLowerCase()

  const [listed] = await db
    .select({ email: allowedEmails.email })
    .from(allowedEmails)
    .where(eq(allowedEmails.email, lower))
    .limit(1)
  if (listed) return 'allowlist'

  const [pending] = await db
    .select({ id: deckInvites.id })
    .from(deckInvites)
    .where(
      and(
        sql`LOWER(${deckInvites.email}) = ${lower}`,
        isNull(deckInvites.acceptedAt),
        gt(deckInvites.expiresAt, new Date()),
      ),
    )
    .limit(1)
  if (pending) return 'invite'

  const [pendingFolder] = await db
    .select({ id: folderInvites.id })
    .from(folderInvites)
    .where(
      and(
        sql`LOWER(${folderInvites.email}) = ${lower}`,
        isNull(folderInvites.acceptedAt),
        gt(folderInvites.expiresAt, new Date()),
      ),
    )
    .limit(1)
  if (pendingFolder) return 'invite'

  const [perm] = await db
    .select({ deckId: deckPermissions.deckId })
    .from(deckPermissions)
    .innerJoin(users, eq(users.sub, deckPermissions.userId))
    .innerJoin(decks, eq(decks.id, deckPermissions.deckId))
    .where(and(sql`LOWER(${users.email}) = ${lower}`, ne(decks.ownerUserId, users.sub)))
    .limit(1)
  if (perm) return 'permission'

  const [member] = await db
    .select({ folderId: folderPermissions.folderId })
    .from(folderPermissions)
    .innerJoin(users, eq(users.sub, folderPermissions.userId))
    .innerJoin(folders, eq(folders.id, folderPermissions.folderId))
    .where(and(sql`LOWER(${users.email}) = ${lower}`, ne(folders.ownerUserId, users.sub)))
    .limit(1)
  if (member) return 'permission'

  return null
}

export async function isAllowedByDb(db: Database, subject: SignInSubject): Promise<boolean> {
  return (await allowedByDb(db, subject)) !== null
}

/**
 * The full rule: env allowlist first (no database work), then the implicit
 * database allowlist. Returns the first grant that applies, or `null`.
 */
export async function signInGrant(
  db: Database,
  allowlist: AllowlistConfig,
  subject: SignInSubject,
): Promise<SignInGrant | null> {
  const envOk = isAllowedByEnv(
    { sub: '', email: subject.email, emailVerified: subject.emailVerified },
    allowlist,
  )
  if (envOk) return 'env'
  // ADMIN_EMAILS lists people, so it admits only a verified address.
  if (
    subject.emailVerified &&
    (allowlist.adminEmails ?? []).some(
      (e) => e.trim().toLowerCase() === subject.email.toLowerCase(),
    )
  )
    return 'admin'
  return allowedByDb(db, subject)
}

export async function isAllowedToSignIn(
  db: Database,
  allowlist: AllowlistConfig,
  subject: SignInSubject,
): Promise<boolean> {
  return (await signInGrant(db, allowlist, subject)) !== null
}
