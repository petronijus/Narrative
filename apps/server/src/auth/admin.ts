/**
 * auth/admin.ts
 *
 * Instance admins (docs/adr/0014). An admin is owner of every folder and
 * deck except other people's Drafts, and manages who may sign in
 * (services/admin.ts). The flag is `users.is_admin`:
 *   - `ADMIN_EMAILS` (a comma-separated list in the server env) seeds the
 *     first admin — `bootstrapAdmin` sets the flag at sign-in, for a verified
 *     email, while no admin exists;
 *   - an admin promotes and demotes others (services/admin.ts `setAdmin`).
 * The role is never stored per folder: the resolvers in auth/permissions.ts
 * and the list queries read `users.is_admin`, so a new folder is visible to
 * admins at once and demoting one leaves no rows behind.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { users } from '../db/schema.js'

/** `ADMIN_EMAILS` → lower-cased addresses. */
export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

/** Whether the user is an instance admin. False for no user (anonymous share-link visits). */
export async function isInstanceAdmin(db: Database, userId: string | null): Promise<boolean> {
  if (!userId) return false
  const [row] = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.sub, userId))
    .limit(1)
  return row?.isAdmin === true
}

/**
 * `isInstanceAdmin` for the access resolvers (auth/permissions.ts), which run
 * on every request and in many tests. The `adminProbe` key marks the query:
 * test-support/scriptedDb.ts answers it on its own (not an admin, unless the
 * script says `admin: true`) instead of consuming a scripted select, so a
 * test of a resolver's caller need not script it.
 */
export async function adminProbe(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ adminProbe: users.isAdmin })
    .from(users)
    .where(eq(users.sub, userId))
    .limit(1)
  return row?.adminProbe === true
}

/**
 * At sign-in, after `upsertUser`: an address in `ADMIN_EMAILS` with a verified
 * email becomes an admin — only while the instance has NO admin. The env
 * seeds the first admin; from then on admins decide (`setAdmin`), so a demoted
 * env admin stays demoted after signing in again, and an address a workspace
 * later hands to a new person does not make that person an admin.
 */
export async function bootstrapAdmin(
  db: Database,
  user: { sub: string; email: string; emailVerified: boolean },
  adminEmails: readonly string[],
): Promise<boolean> {
  if (!user.emailVerified) return false
  if (!adminEmails.includes(user.email.toLowerCase())) return false
  const promoted = await db
    .update(users)
    .set({ isAdmin: true })
    .where(
      and(eq(users.sub, user.sub), sql`NOT EXISTS (SELECT 1 FROM ${users} AS a WHERE a.is_admin)`),
    )
    .returning({ sub: users.sub })
  return promoted.length > 0
}
