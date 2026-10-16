/**
 * services/admin.ts — instance admins (docs/adr/0014). The /admin/* routes
 * call these functions. There are deliberately no `admin.*` agent commands
 * (parity/allowlist.ts): an instruction hidden in a deck must not be able to
 * let a stranger in or promote one.
 *
 * Every function needs the caller to be an admin (403 otherwise). The admin
 * role itself — owner of every folder and deck but other people's Drafts —
 * lives in the access resolvers (auth/permissions.ts); this service manages
 * the people: who may sign in (`allowed_emails`) and who is an admin.
 *
 * Promoting and demoting lock the admin rows (`SELECT … FOR UPDATE`) and
 * re-check the caller's role inside the transaction. Nobody changes their own
 * role, so a demotion always leaves its caller: the instance keeps an admin,
 * and two admins demoting each other at once serialise — the second finds
 * itself no longer an admin (403).
 */

import { asc, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { allowedEmails, users, type User } from '../db/schema.js'
import { isInstanceAdmin } from '../auth/admin.js'
import { getUserByEmail, getUserBySub } from '../auth/users.js'
import type { AllowlistConfig } from '../auth/jwt.js'
import { revokeAllSessionsForUser } from '../auth/session.js'
import { signInGrant } from '../auth/signInPolicy.js'
import { closeUserConnections } from '../hocuspocus/connections.js'
import { endRenderSessions } from '../render/sessions.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, conflict, forbidden, notFound } from './errors.js'
import { iso } from './shared.js'

export interface AdminUser {
  userId: string
  email: string
  name: string | null
  isAdmin: boolean
  /** ISO 8601 */
  firstSeenAt: string
  /** ISO 8601 */
  lastSeenAt: string
}

export interface AllowedEmail {
  email: string
  /** Email of the admin who allowed it, or null when that admin is gone. */
  addedBy: string | null
  /** ISO 8601 */
  addedAt: string
  /** Whether someone with this address has signed in yet. */
  signedIn: boolean
}

export interface AdminService {
  /** Everyone who has signed in, admins first, then by last activity. */
  listUsers(args: { userId: string }): Promise<AdminUser[]>
  /** The addresses an admin allowed to sign in (not the operator's env lists). */
  listAllowedEmails(args: { userId: string }): Promise<AllowedEmail[]>
  /** Allow an address to sign in. Idempotent. */
  allowEmail(args: { userId: string; email: string }): Promise<AllowedEmail>
  /**
   * Take an address off the allowed list. When nothing else admits that
   * person any more (the env lists, an invite, a share), their sessions and
   * agent credentials are revoked and their live connections closed; access an
   * invite or a share still gives them stays. Returns whether they were signed out.
   */
  removeAllowedEmail(args: { userId: string; email: string }): Promise<{ signedOut: boolean }>
  /** Make a user an admin or take the role away — never your own, so an admin always remains. */
  setAdmin(args: { userId: string; targetUserId: string; isAdmin: boolean }): Promise<AdminUser>
}

// RFC-5322-lite, as routes/sharing.ts; an address is checked once, here.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function requireAllowableEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (email.length > 320 || !EMAIL.test(email)) throw badRequest('That is not an email address')
  return email
}

function adminUser(u: User): AdminUser {
  return {
    userId: u.sub,
    email: u.email,
    name: u.name,
    isAdmin: u.isAdmin,
    firstSeenAt: iso(u.firstSeenAt),
    lastSeenAt: iso(u.lastSeenAt),
  }
}

export interface AdminServiceOptions {
  /** The env allowlist: removing an address re-checks whether anything still admits it. */
  allowlist: AllowlistConfig
}

export function createAdminService(deps: ServiceDeps, opts: AdminServiceOptions): AdminService {
  const { db, log } = deps

  /** Admin actions are logged (ADR 0014): who did what to whom. */
  const audit = (event: string, fields: Record<string, unknown>) =>
    log.info({ audit: 'admin', event, ...fields }, `[admin] ${event}`)

  /** End everything a user holds open: sockets (they reconnect with their new role) and render pages. */
  const disconnect = (sub: string) => {
    closeUserConnections(sub)
    endRenderSessions({ userId: sub })
  }

  async function requireAdmin(userId: string): Promise<void> {
    if (!(await isInstanceAdmin(db, userId))) throw forbidden('Forbidden: only admins may do this')
  }

  async function allowedEmail(email: string): Promise<AllowedEmail> {
    const [row] = await db
      .select({
        email: allowedEmails.email,
        addedAt: allowedEmails.addedAt,
        addedBy: users.email,
        signedIn: sql<boolean>`EXISTS (SELECT 1 FROM ${users} u WHERE LOWER(u.email) = ${allowedEmails.email})`,
      })
      .from(allowedEmails)
      .leftJoin(users, eq(users.sub, allowedEmails.addedBySub))
      .where(eq(allowedEmails.email, email))
      .limit(1)
    if (!row) throw notFound('That address is not on the allowed list')
    return { ...row, addedAt: iso(row.addedAt) }
  }

  return {
    async listUsers({ userId }) {
      await requireAdmin(userId)
      const rows = await db
        .select()
        .from(users)
        .orderBy(desc(users.isAdmin), desc(users.lastSeenAt), asc(users.sub))
      return rows.map(adminUser)
    },

    async listAllowedEmails({ userId }) {
      await requireAdmin(userId)
      const rows = await db
        .select({
          email: allowedEmails.email,
          addedAt: allowedEmails.addedAt,
          addedBy: users.email,
          signedIn: sql<boolean>`EXISTS (SELECT 1 FROM ${users} u WHERE LOWER(u.email) = ${allowedEmails.email})`,
        })
        .from(allowedEmails)
        .leftJoin(users, eq(users.sub, allowedEmails.addedBySub))
        .orderBy(desc(allowedEmails.addedAt), asc(allowedEmails.email))
      return rows.map((r) => ({ ...r, addedAt: iso(r.addedAt) }))
    },

    async allowEmail({ userId, email: raw }) {
      await requireAdmin(userId)
      const email = requireAllowableEmail(raw)
      await db
        .insert(allowedEmails)
        .values({ email, addedBySub: userId })
        .onConflictDoNothing({ target: allowedEmails.email })
      audit('allow-email', { by: userId, email })
      return allowedEmail(email)
    },

    async removeAllowedEmail({ userId, email: raw }) {
      await requireAdmin(userId)
      const email = requireAllowableEmail(raw)
      const removed = await db
        .delete(allowedEmails)
        .where(eq(allowedEmails.email, email))
        .returning({ email: allowedEmails.email })
      if (removed.length === 0) throw notFound('That address is not on the allowed list')
      // Sessions slide on use: without this an active person would keep
      // access indefinitely. Only when nothing else admits them.
      const person = await getUserByEmail(db, email)
      let signedOut = false
      if (person !== null) {
        const still = await signInGrant(db, opts.allowlist, {
          email: person.email,
          emailVerified: person.emailVerified === true,
        })
        if (still === null) {
          await revokeAllSessionsForUser(db, person.sub)
          disconnect(person.sub)
          signedOut = true
        }
      }
      audit('remove-allowed-email', { by: userId, email, signedOut })
      return { signedOut }
    },

    async setAdmin({ userId, targetUserId, isAdmin }) {
      if (userId === targetUserId) {
        throw conflict('You cannot change your own admin role. Ask another admin.')
      }
      const result = await db.transaction(async (tx) => {
        // Lock every admin row: the caller's role is re-read under the lock.
        const admins = await tx
          .select({ sub: users.sub })
          .from(users)
          .where(eq(users.isAdmin, true))
          .for('update')
        if (!admins.some((a) => a.sub === userId)) {
          throw forbidden('Forbidden: only admins may do this')
        }
        const target = await getUserBySub(tx as unknown as Database, targetUserId)
        if (!target) throw notFound('No such user. They have not signed in yet.')
        // An admin is owner of almost everything: only an address Google verified.
        if (isAdmin && target.emailVerified !== true) {
          throw conflict(
            'Only a person whose Google email is verified can be an admin. Ask them to sign in again.',
          )
        }
        const [updated] = await tx
          .update(users)
          .set({ isAdmin })
          .where(eq(users.sub, targetUserId))
          .returning()
        return { user: adminUser(updated!), demoted: target.isAdmin && !isAdmin }
      })
      // A demoted admin's open sockets still carry the owner role they
      // authenticated with (CONN-1): close them, they reconnect with their own.
      if (result.demoted) disconnect(targetUserId)
      audit(isAdmin ? 'make-admin' : 'remove-admin', { by: userId, target: targetUserId })
      return result.user
    },
  }
}
