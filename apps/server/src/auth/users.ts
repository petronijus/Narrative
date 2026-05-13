/**
 * auth/users.ts
 *
 * Directory of every Google account that has ever signed in. Kept fresh by
 * the `/auth/callback` handler via `upsertUser()`. The rest of the app
 * (sharing, active-editors badge, audit displays) joins on `users.sub` to
 * resolve an opaque sub like `106635599393307737914` to a human-readable
 * email + name.
 *
 * Why this is separate from `sessions`
 * ------------------------------------
 * `sessions` is a credential store: rows are sweep-deleted on expiry and on
 * revocation, so it can't be the source of truth for "did this user ever
 * exist?". `users` is the directory — append-only on first sign-in, touched
 * (last_seen_at + email/name refresh) on every subsequent sign-in.
 *
 * Email semantics
 * ---------------
 * Google `sub` is the authoritative identity. `email` is a display value
 * that Google may change (rare, but possible). We keep it case-insensitive
 * unique so two distinct subs can't share an inbox in our directory; if
 * Google legitimately re-issues an email between subs, the second sign-in
 * will conflict and the user will see an auth_error — which is the safe
 * outcome.
 */

import { eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { users, type User } from '../db/schema.js'

export interface UpsertUserInput {
  sub: string
  email: string
  name: string | null
  pictureUrl?: string | null
}

/**
 * Insert-or-update on `sub`. Idempotent; safe to call on every login.
 * Returns nothing — caller already knows the identity.
 */
export async function upsertUser(db: Database, input: UpsertUserInput): Promise<void> {
  const emailLower = input.email.toLowerCase()
  await db
    .insert(users)
    .values({
      sub: input.sub,
      email: emailLower,
      name: input.name,
      pictureUrl: input.pictureUrl ?? null,
    })
    .onConflictDoUpdate({
      target: users.sub,
      set: {
        email: emailLower,
        name: input.name,
        pictureUrl: input.pictureUrl ?? null,
        lastSeenAt: sql`now()`,
      },
    })
}

/** Lookup by Google sub. Returns null if the user has never signed in. */
export async function getUserBySub(db: Database, sub: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.sub, sub)).limit(1)
  return row ?? null
}

/**
 * Case-insensitive email lookup. Returns null when no Google account with
 * that email has ever signed in to Narrative.
 */
export async function getUserByEmail(db: Database, email: string): Promise<User | null> {
  const lower = email.toLowerCase()
  const [row] = await db
    .select()
    .from(users)
    .where(sql`LOWER(${users.email}) = ${lower}`)
    .limit(1)
  return row ?? null
}

/**
 * Batch lookup by sub. Returns rows in arbitrary order; callers should map
 * by sub. Used by `listPermissions` to enrich each row in one round-trip
 * instead of N+1 lookups.
 */
export async function listUsersBySubs(db: Database, subs: string[]): Promise<User[]> {
  if (subs.length === 0) return []
  return await db.select().from(users).where(inArray(users.sub, subs))
}
