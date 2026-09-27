/**
 * auth/userAccess.ts
 *
 * Revoke everything a user can act with — the core of the
 * `revokeUserAccess` ops script (scripts/revokeUserAccess.ts), kept here so
 * it is unit-testable without a database connection at import time.
 *
 * What it does, for a user named by email or Google `sub`:
 *   1. revokes every session and every agent credential (personal access
 *      tokens, MCP OAuth grants, and whatever else auth/agentCredentials.ts
 *      covers) through `revokeAllSessionsForUser`;
 *   2. reports whether the user could simply sign in again — the env
 *      allowlist, a pending invite or a deck permission still admitting them
 *      (auth/signInPolicy.ts) — because revoking credentials does not remove
 *      that access, and the operator has to act on it (edit
 *      OIDC_ALLOWED_EMAILS / OIDC_ALLOWED_DOMAIN, remove the permissions).
 */

import { and, count, eq, gt, isNull } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { mcpOauthGrants, personalAccessTokens, sessions } from '../db/schema.js'
import type { AllowlistConfig } from './jwt.js'
import { revokeAllSessionsForUser, type RevokedUserAccess } from './session.js'
import { signInGrant, type SignInGrant } from './signInPolicy.js'
import { getUserByEmail, getUserBySub } from './users.js'

export interface ResolvedUser {
  sub: string
  email: string | null
  emailVerified: boolean
}

export interface UserAccessReport {
  user: ResolvedUser
  /** What was revoked; on a dry run, what is live and would be revoked. */
  revoked: RevokedUserAccess
  dryRun: boolean
  /** Why the user could still sign in again, or null when nothing admits them. */
  stillAllowedBy: SignInGrant | null
}

/**
 * Resolve an email (contains `@`) or a Google `sub` to a user. A `sub` with no
 * directory entry still resolves (its credentials are revoked by sub), an
 * unknown email does not.
 */
export async function resolveUser(db: Database, identifier: string): Promise<ResolvedUser | null> {
  const trimmed = identifier.trim()
  if (trimmed.length === 0) return null
  const row = trimmed.includes('@')
    ? await getUserByEmail(db, trimmed)
    : await getUserBySub(db, trimmed)
  if (row) return { sub: row.sub, email: row.email, emailVerified: row.emailVerified === true }
  if (trimmed.includes('@')) return null
  return { sub: trimmed, email: null, emailVerified: false }
}

async function countLiveCredentials(db: Database, userSub: string): Promise<RevokedUserAccess> {
  const now = new Date()
  const [liveSessions] = await db
    .select({ n: count() })
    .from(sessions)
    .where(
      and(eq(sessions.userSub, userSub), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
    )
  const [liveTokens] = await db
    .select({ n: count() })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.userSub, userSub),
        isNull(personalAccessTokens.revokedAt),
        gt(personalAccessTokens.expiresAt, now),
      ),
    )
  const [liveGrants] = await db
    .select({ n: count() })
    .from(mcpOauthGrants)
    .where(and(eq(mcpOauthGrants.userSub, userSub), isNull(mcpOauthGrants.revokedAt)))
  return {
    sessions: liveSessions?.n ?? 0,
    personalAccessTokens: liveTokens?.n ?? 0,
    mcpOAuthGrants: liveGrants?.n ?? 0,
  }
}

export async function revokeUserAccess(
  db: Database,
  user: ResolvedUser,
  opts: { allowlist: AllowlistConfig; dryRun?: boolean },
): Promise<UserAccessReport> {
  const dryRun = opts.dryRun === true
  const revoked = dryRun
    ? await countLiveCredentials(db, user.sub)
    : await revokeAllSessionsForUser(db, user.sub)
  const stillAllowedBy =
    user.email === null
      ? null
      : await signInGrant(db, opts.allowlist, {
          email: user.email,
          emailVerified: user.emailVerified,
        })
  return { user, revoked, dryRun, stillAllowedBy }
}
