/**
 * auth/session.ts
 *
 * Server-side opaque sessions (post-2026-05 replacement for the browser-PKCE
 * flow where the SPA held the Google id_token in localStorage).
 *
 * Flow
 * ----
 *   1. GET /auth/start → 302 to Google with PKCE.
 *   2. GET /auth/callback → exchange code for id_token, verify, then
 *      `createSession()` here. Sets `narrative_session=<rawId>` cookie.
 *   3. Every subsequent HTTP request and WS upgrade carries the cookie.
 *      `lookupSession()` resolves it to a user; the row is also touched so
 *      active users effectively never expire.
 *   4. POST /auth/logout → `revokeSession()` + clear cookie.
 *
 * Security notes
 * --------------
 * - The cookie value is 32 bytes of `crypto.randomBytes` (≈190 bits) so
 *   guessing is infeasible.
 * - The DB stores SHA-256(rawId), not the raw id. A read-only DB compromise
 *   doesn't yield active session cookies.
 * - Lifetime: 30 days sliding. Every `lookupSession()` bumps `last_used_at`
 *   AND `expires_at` to `now() + 30 days` so heavy users never need to log
 *   in again until they explicitly log out or stay away for 30 days.
 * - Cookie is HttpOnly + SameSite=Lax + Secure (in prod). CSRF is handled
 *   separately by a paired `narrative_csrf` token (see csrf.ts).
 */

import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { sessions, type Session } from '../db/schema.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sliding expiry — touched on every lookup. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export const SESSION_COOKIE_NAME = 'narrative_session'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cryptographic SHA-256 hex of the raw cookie value. */
function hashId(rawId: string): string {
  return createHash('sha256').update(rawId, 'utf8').digest('hex')
}

/** 32 bytes of CSPRNG, base64url-encoded — opaque to the client. */
function mintRawId(): string {
  return randomBytes(32).toString('base64url')
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface SessionUser {
  sub: string
  email: string
  name: string | null
}

export interface CreateSessionInput {
  user: SessionUser
  userAgent?: string | undefined
  ip?: string | undefined
}

export interface CreateSessionResult {
  /** Raw session id — goes into the `narrative_session` cookie. NEVER log. */
  rawId: string
  /** Absolute expiry — drives the cookie's Max-Age. */
  expiresAt: Date
}

/**
 * Mint a new session row and return the raw id (cookie value).
 * The raw id is only available here; the DB stores SHA-256(rawId).
 */
export async function createSession(
  db: Database,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const rawId = mintRawId()
  const idHash = hashId(rawId)
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS)

  await db.insert(sessions).values({
    idHash,
    userSub: input.user.sub,
    userEmail: input.user.email,
    userName: input.user.name,
    expiresAt,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  })

  return { rawId, expiresAt }
}

/**
 * Look up a session by raw cookie value. Returns null if missing, expired,
 * or revoked. Touches `last_used_at` and slides `expires_at` forward on hit.
 *
 * Called on every authenticated request — keep it cheap. The PK lookup is
 * a single index probe and the UPDATE is fire-and-forget (we don't wait on
 * it from the request hot path; callers should treat the returned Session
 * as authoritative).
 */
export async function lookupSession(db: Database, rawId: string): Promise<Session | null> {
  if (!rawId) return null
  const idHash = hashId(rawId)
  const now = new Date()
  const newExpiry = new Date(now.getTime() + SESSION_LIFETIME_MS)

  // Single round-trip: fetch + slide expiry. Drizzle's RETURNING gives us
  // back the row as it stands after the UPDATE.
  const rows = await db
    .update(sessions)
    .set({ lastUsedAt: now, expiresAt: newExpiry })
    .where(
      and(eq(sessions.idHash, idHash), gt(sessions.expiresAt, now), isNull(sessions.revokedAt)),
    )
    .returning()

  return rows[0] ?? null
}

/** Mark a session revoked (logout). Idempotent. */
export async function revokeSession(db: Database, rawId: string): Promise<void> {
  if (!rawId) return
  const idHash = hashId(rawId)
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.idHash, idHash))
}

/** Revoke every active session for a given user (e.g. on allowlist removal). */
export async function revokeAllSessionsForUser(db: Database, userSub: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userSub, userSub), isNull(sessions.revokedAt)))
}

/**
 * Delete expired/revoked rows. Idempotent. Call from a daily cron or on
 * server startup — leaving rows around is harmless, this is just cleanup.
 */
export async function sweepExpiredSessions(db: Database): Promise<number> {
  const now = new Date()
  const result = await db
    .delete(sessions)
    .where(
      or(lt(sessions.expiresAt, now), and(isNull(sessions.revokedAt), lt(sessions.expiresAt, now))),
    )
    .returning({ idHash: sessions.idHash })
  return result.length
}
