/**
 * auth/devIdentity.ts — who a request is under BYPASS_AUTH (dev only).
 *
 * BYPASS_AUTH=true makes every request the synthetic `dev-user`; the server
 * refuses to boot with it in production (assertAuthBootSafety). For tests
 * that need two people — folder and deck sharing, collaboration — a request
 * may name another synthetic identity in the `narrative_dev_as` cookie:
 * `dev-<lowercase letters, digits, dashes>`. The prefix keeps it from ever
 * naming a real Google `sub` in a database copied from somewhere else. Such
 * an identity gets a `users` row (`<sub>@dev.narrative.test`; `dev-user`'s
 * is `dev-user@dev.narrative.test`) the first time it is seen, so it can be invited by
 * email like a person who signed in.
 *
 * Read by every place bypass mode synthesises its principal: request
 * identity (auth/identity.ts), the sync server's WebSocket authentication
 * (hocuspocus/authenticate.ts) and GET /decks/:id (routes/decks.ts). The web
 * app reads the same cookie (state/AuthContext.tsx) so the signed-in user it
 * shows matches. Without bypass the cookie means nothing.
 */

import type { Database } from '../db/client.js'
import { readCookieFromHeader } from './session.js'
import { upsertUser } from './users.js'

/** The synthetic BYPASS_AUTH principal. */
export const DEV_USER_SUB = 'dev-user'

/** The cookie that switches a bypass-mode request to another synthetic identity. */
export const DEV_AS_COOKIE = 'narrative_dev_as'

const DEV_AS_PATTERN = /^dev-[a-z0-9-]{1,60}$/

/** The synthetic identity a bypass-mode request names: the cookie's, else `dev-user`. */
export function devSubFromCookieHeader(cookieHeader: string | string[] | undefined): string {
  const named = readCookieFromHeader(cookieHeader, DEV_AS_COOKIE)
  return named !== undefined && DEV_AS_PATTERN.test(named) ? named : DEV_USER_SUB
}

/** The claims of a synthetic identity. */
export function devUserClaims(sub: string): { sub: string; email: string; name: string } {
  // An address the invite schemas accept (a TLD); `dev-user`'s follows the same form.
  return { sub, email: `${sub}@dev.narrative.test`, name: sub === DEV_USER_SUB ? 'Dev User' : sub }
}

/** Identities whose `users` row this process has already written. */
const known = new Set<string>()

/**
 * Give a switched identity its `users` row, once per process: sharing looks
 * people up by email, and member lists show names from the directory.
 * `dev-user`'s row is written once at boot (`ensureDevUserAtBoot`), not on
 * its requests.
 */
export async function ensureDevUser(db: Database, sub: string): Promise<void> {
  if (sub === DEV_USER_SUB || known.has(sub)) return
  const claims = devUserClaims(sub)
  await upsertUser(db, {
    sub,
    email: claims.email,
    emailVerified: true,
    name: claims.name,
  })
  known.add(sub)
}

/**
 * Under BYPASS_AUTH, at server start: `dev-user`'s directory row, so it too
 * can be invited to someone else's folder or deck (`dev-user@dev.narrative.test`).
 */
export async function ensureDevUserAtBoot(db: Database): Promise<void> {
  const claims = devUserClaims(DEV_USER_SUB)
  await upsertUser(db, {
    sub: DEV_USER_SUB,
    email: claims.email,
    emailVerified: true,
    name: claims.name,
  })
}
