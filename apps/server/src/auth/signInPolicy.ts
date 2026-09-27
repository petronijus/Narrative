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
 *   (2) the database implicitly admits it (`isAllowedByDb`):
 *       (a) a non-expired, non-accepted invite in `deck_invites`, or
 *       (b) an existing `deck_permissions` row (via `users.email`).
 *
 * Case (2a) is the new-collaborator flow — owner sends invite, invitee signs
 * in, /auth/callback consumes the invite into a permission. Case (2b) is the
 * returning-collaborator flow — already accepted, has ongoing access. Without
 * it they'd be locked out the first time their session cookie expired if
 * they aren't on the env allowlist.
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { deckInvites, deckPermissions, users } from '../db/schema.js'
import { isAllowedByEnv, type AllowlistConfig } from './jwt.js'

/** What the policy needs to know about an account. */
export interface SignInSubject {
  email: string
  /** Whether the IdP verified the email (Google's `email_verified`). */
  emailVerified: boolean
}

/** Why an account is allowed, or `null` when it is not. */
export type SignInGrant = 'env' | 'invite' | 'permission'

/** Is `email` implicitly allowed by a pending invite or a deck permission? */
export async function allowedByDb(
  db: Database,
  email: string,
): Promise<Exclude<SignInGrant, 'env'> | null> {
  const lower = email.toLowerCase()

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

  const [perm] = await db
    .select({ deckId: deckPermissions.deckId })
    .from(deckPermissions)
    .innerJoin(users, eq(users.sub, deckPermissions.userId))
    .where(sql`LOWER(${users.email}) = ${lower}`)
    .limit(1)
  if (perm) return 'permission'

  return null
}

export async function isAllowedByDb(db: Database, email: string): Promise<boolean> {
  return (await allowedByDb(db, email)) !== null
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
  return allowedByDb(db, subject.email)
}

export async function isAllowedToSignIn(
  db: Database,
  allowlist: AllowlistConfig,
  subject: SignInSubject,
): Promise<boolean> {
  return (await signInGrant(db, allowlist, subject)) !== null
}
