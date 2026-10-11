/**
 * auth/sessionCookie.ts
 *
 * The `narrative_session` cookie and the post-sign-in target, shared by the
 * browser sign-in (routes/auth.ts) and the desktop app's ticket redeem
 * (routes/desktopAuth.ts, ADR 0014) — both must set exactly the same cookie.
 */

import type { FastifyReply } from 'fastify'
import { SESSION_COOKIE_NAME, SESSION_LIFETIME_MS } from './session.js'

/**
 * Only same-origin relative paths, to prevent an open redirect into
 * attacker-controlled hosts: no protocol-relative (`//evil.com`), no absolute
 * URL of any scheme, no backslash (browsers read `/\evil.com` as `//evil.com`)
 * and no control character (a header Node would refuse after the session
 * cookie was set).
 */
export function isSafeReturnTo(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    value.length < 500 &&
    !/[\x00-\x1f\x7f\\]/.test(value)
  )
}

export function setSessionCookie(
  reply: FastifyReply,
  rawId: string,
  expiresAt: Date,
  isProd: boolean,
): void {
  reply.setCookie(SESSION_COOKIE_NAME, rawId, {
    httpOnly: true,
    secure: isProd,
    // 'lax' is correct: cookie is sent on top-level navigations from any
    // site (so the OAuth redirect from accounts.google.com lands with the
    // cookie absent — Google's redirect IS the initial Set-Cookie, not a
    // pre-existing one being sent), AND on same-origin / same-site fetches
    // including dev's localhost:5173 ↔ localhost:3001 cross-origin path.
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_LIFETIME_MS / 1000),
    expires: expiresAt,
  })
}

export function clearSessionCookie(reply: FastifyReply, isProd: boolean): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  })
}
