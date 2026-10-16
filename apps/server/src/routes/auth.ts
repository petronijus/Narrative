/**
 * routes/auth.ts
 *
 * Server-driven Google OAuth + session cookie flow.
 *
 *   GET  /auth/start?returnTo=…    → 302 to Google with PKCE
 *   GET  /auth/callback?code=…     → token exchange, verify id_token, mint
 *                                     session row, Set-Cookie, 302 to returnTo
 *   GET  /auth/me                  → { sub, email, name, isAdmin } or 401
 *   POST /auth/logout              → revoke session + clear cookie, 204
 *
 * Why server-driven (not the browser-PKCE flow that lived in oidc-client-ts)
 * ------------------------------------------------------------------------
 *   - The Google id_token never enters the SPA. The browser holds an opaque
 *     session id, immune to XSS theft of long-lived credentials.
 *   - The session row lives in Postgres and slides on every use → 30-day
 *     active sessions instead of 1-hour Google id_tokens.
 *   - No third-party-cookie iframe dance → works on Safari + privacy-
 *     hardened Firefox identically to Chrome.
 *
 * Route paths
 * -----------
 * Routes are mounted WITHOUT the `/api/` prefix because Caddy strips that
 * prefix before forwarding (`handle_path /api/*`). The browser hits
 * `https://narrative.example.com/api/auth/start`; the server sees
 * `/auth/start`. In dev the SPA navigates directly to
 * `http://localhost:3001/auth/start` (skipping Vite proxy for the same
 * reason — it would otherwise rewrite cookies onto port 5173).
 *
 * Google Cloud Console — Authorized redirect URIs
 * -----------------------------------------------
 *   Dev:  http://localhost:3001/auth/callback
 *   Prod: https://narrative.example.com/api/auth/callback
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import type { Database } from '../db/client.js'
import type { AllowlistConfig, JwtVerifier } from '../auth/jwt.js'
import { isAllowedToSignIn } from '../auth/signInPolicy.js'
import {
  createSession,
  lookupSession,
  revokeSession,
  SESSION_COOKIE_NAME,
  SESSION_LIFETIME_MS,
} from '../auth/session.js'
import { upsertUser } from '../auth/users.js'
import { bootstrapAdmin, isInstanceAdmin } from '../auth/admin.js'
import { notifyInvitesAccepted } from '../email/events.js'
import { consumePendingInvitesForEmail } from '../auth/invites.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Short-lived cookie carrying the in-flight PKCE state for one OAuth round-trip. */
const OAUTH_STATE_COOKIE = 'narrative_oauth_state'
const OAUTH_STATE_MAX_AGE_S = 10 * 60 // 10 minutes

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuthRoutesOpts {
  db: Database
  /** Verifies Google id_tokens (signature + iss + aud + sub only). */
  verifier: JwtVerifier | null
  /** Public origin the browser sees (`https://narrative.example.com` or `http://localhost:5173`). Used for post-login redirect. */
  spaOrigin: string
  /** Where the server is reachable from Google for the redirect URI registered in GCP. */
  redirectUri: string
  isProd: boolean
  /** Env-configured allowlist. The DB-based implicit allowlist (pending
   *  invite or existing permission) extends this — see auth/signInPolicy.ts. */
  allowlist: AllowlistConfig
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function randomState(): string {
  return base64url(randomBytes(16))
}

interface OauthStatePayload {
  state: string
  verifier: string
  returnTo: string
}

function isSafeReturnTo(value: unknown): value is string {
  // Only accept same-origin relative paths to prevent open-redirect into
  // attacker-controlled hosts. Disallow protocol-relative ("//evil.com")
  // and absolute URLs entirely.
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    value.length < 500
  )
}

function clientIp(req: FastifyRequest): string {
  // Caddy + cloudflared rewrite `X-Forwarded-For` and Fastify exposes the
  // first hop in `req.ip` via `trustProxy`. Without trustProxy we fall back
  // to the raw socket address which is the gateway in prod (less useful but
  // still non-empty).
  return req.ip ?? req.socket.remoteAddress ?? ''
}

function setSessionCookie(
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

function clearSessionCookie(reply: FastifyReply, isProd: boolean): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  })
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export function registerAuthRoutes(app: FastifyInstance, opts: AuthRoutesOpts): void {
  const { db, verifier, spaOrigin, redirectUri, isProd, allowlist } = opts
  const clientId = process.env['OIDC_CLIENT_ID']
  const clientSecret = process.env['OIDC_CLIENT_SECRET']

  if (!clientId || !clientSecret) {
    app.log.warn('[auth] OIDC_CLIENT_ID or OIDC_CLIENT_SECRET missing — /auth/start will 500')
  }

  // ─── GET /auth/start ─────────────────────────────────────────────────────
  app.get('/auth/start', async (request, reply) => {
    if (!clientId || !clientSecret || !verifier) {
      await reply.status(500).send({ error: 'auth_not_configured' })
      return
    }

    const rawReturnTo = (request.query as Record<string, string>)['returnTo'] ?? '/'
    const returnTo = isSafeReturnTo(rawReturnTo) ? rawReturnTo : '/'

    const state = randomState()
    const { verifier: codeVerifier, challenge } = pkcePair()

    const statePayload: OauthStatePayload = { state, verifier: codeVerifier, returnTo }
    // Path=/ is intentional. In prod the browser sees the routes as
    // /api/auth/start and /api/auth/callback (Caddy adds the /api/ prefix
    // from the browser's perspective; the server side only sees /auth/*).
    // Scoping to /auth or /api/auth would mismatch one of the two and the
    // browser would drop the cookie on the callback. The cookie is HttpOnly,
    // Secure, signed, and lives 10 min — Path=/ adds no risk.
    reply.setCookie(OAUTH_STATE_COOKIE, JSON.stringify(statePayload), {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: OAUTH_STATE_MAX_AGE_S,
      signed: true,
    })

    const googleUrl = new URL(GOOGLE_AUTH_URL)
    googleUrl.searchParams.set('client_id', clientId)
    googleUrl.searchParams.set('redirect_uri', redirectUri)
    googleUrl.searchParams.set('response_type', 'code')
    googleUrl.searchParams.set('scope', 'openid profile email')
    googleUrl.searchParams.set('code_challenge', challenge)
    googleUrl.searchParams.set('code_challenge_method', 'S256')
    googleUrl.searchParams.set('state', state)
    // `select_account` shows the account chooser even if the user is already
    // logged into a single Google account — useful for "switch user" UX and
    // for debugging multi-account browsers.
    googleUrl.searchParams.set('prompt', 'select_account')

    await reply.redirect(googleUrl.toString(), 302)
  })

  // ─── GET /auth/callback ──────────────────────────────────────────────────
  app.get('/auth/callback', async (request, reply) => {
    if (!clientId || !clientSecret || !verifier) {
      await reply.status(500).send({ error: 'auth_not_configured' })
      return
    }

    const query = request.query as Record<string, string>
    const code = query['code']
    const state = query['state']
    const googleError = query['error']

    if (googleError) {
      await redirectWithError(reply, spaOrigin, `google_${googleError}`)
      return
    }
    if (!code || !state) {
      await redirectWithError(reply, spaOrigin, 'invalid_callback')
      return
    }

    // Read + verify in-flight state cookie
    const rawStateCookie = request.cookies[OAUTH_STATE_COOKIE]
    if (!rawStateCookie) {
      await redirectWithError(reply, spaOrigin, 'missing_state_cookie')
      return
    }
    const unsigned = request.unsignCookie(rawStateCookie)
    if (!unsigned.valid || unsigned.value === null) {
      await redirectWithError(reply, spaOrigin, 'bad_state_signature')
      return
    }
    let statePayload: OauthStatePayload
    try {
      statePayload = JSON.parse(unsigned.value) as OauthStatePayload
    } catch {
      await redirectWithError(reply, spaOrigin, 'bad_state_json')
      return
    }
    if (statePayload.state !== state) {
      await redirectWithError(reply, spaOrigin, 'state_mismatch')
      return
    }

    // Clear the one-shot state cookie. Path must match what setCookie used
    // above or the browser will ignore the clear.
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' })

    // Exchange code → tokens
    let tokenResponse: Response
    try {
      tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: statePayload.verifier,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      })
    } catch (err) {
      request.log.error({ err }, '[auth] token endpoint fetch failed')
      await redirectWithError(reply, spaOrigin, 'token_endpoint_unreachable')
      return
    }

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text().catch(() => '')
      request.log.warn({ status: tokenResponse.status, body }, '[auth] token exchange rejected')
      await redirectWithError(reply, spaOrigin, 'token_exchange_failed')
      return
    }

    const tokenJson = (await tokenResponse.json().catch(() => null)) as { id_token?: string } | null
    if (!tokenJson?.id_token) {
      await redirectWithError(reply, spaOrigin, 'no_id_token')
      return
    }

    // Verify id_token signature + claims (NOT allowlist — that's separate).
    let userPayload
    try {
      userPayload = await verifier.verify(tokenJson.id_token)
    } catch {
      await redirectWithError(reply, spaOrigin, 'not_allowed')
      return
    }

    if (!userPayload.email) {
      // We require an email to populate the session row + the SPA's user chip
      await redirectWithError(reply, spaOrigin, 'no_email_claim')
      return
    }

    // Authorization — env-configured allowlist OR DB-based implicit
    // allowlist (pending invite or existing deck permission). This is the
    // gate that lets an `bela@example.com` log in when she was
    // invited to a deck, even though she's not in OIDC_ALLOWED_EMAILS.
    // The same rule re-runs on every personal access token verification
    // (auth/signInPolicy.ts), so tokens die with the account's access.
    const allowed = await isAllowedToSignIn(db, allowlist, {
      email: userPayload.email,
      emailVerified: userPayload.emailVerified === true,
    })
    if (!allowed) {
      request.log.info(
        { email: userPayload.email },
        '[auth] sign-in denied — not on env allowlist and no invite/permission',
      )
      await redirectWithError(reply, spaOrigin, 'not_allowed')
      return
    }

    // Directory upsert — must run BEFORE invite consumption (the invitee's
    // permissions row references their sub, which is established here).
    await upsertUser(db, {
      sub: userPayload.sub,
      email: userPayload.email,
      emailVerified: userPayload.emailVerified === true,
      name: userPayload.name ?? null,
    })
    await bootstrapAdmin(
      db,
      {
        sub: userPayload.sub,
        email: userPayload.email,
        emailVerified: userPayload.emailVerified === true,
      },
      (allowlist.adminEmails ?? []).map((e) => e.toLowerCase()),
    )

    // Convert any pending deck invites for this email into real permissions.
    // Non-fatal — failure here doesn't block login.
    try {
      const consumed = await consumePendingInvitesForEmail(db, {
        email: userPayload.email,
        sub: userPayload.sub,
        emailVerified: userPayload.emailVerified === true,
      })
      notifyInvitesAccepted(
        { db, log: request.log },
        { whoSub: userPayload.sub, accepted: consumed.accepted },
      )
    } catch (err) {
      request.log.warn({ err }, '[auth] invite consumption failed')
    }

    // Create session
    const { rawId, expiresAt } = await createSession(db, {
      user: {
        sub: userPayload.sub,
        email: userPayload.email,
        name: userPayload.name ?? null,
      },
      userAgent: request.headers['user-agent']?.slice(0, 512),
      ip: clientIp(request) || undefined,
    })

    setSessionCookie(reply, rawId, expiresAt, isProd)

    const returnPath = isSafeReturnTo(statePayload.returnTo) ? statePayload.returnTo : '/'
    await reply.redirect(`${spaOrigin}${returnPath}`, 302)
  })

  // ─── GET /auth/me ─────────────────────────────────────────────────────────
  app.get('/auth/me', async (request, reply) => {
    const rawId = request.cookies[SESSION_COOKIE_NAME]
    if (!rawId) {
      await reply.status(401).send({ error: 'unauthenticated' })
      return
    }
    const session = await lookupSession(db, rawId)
    if (!session) {
      clearSessionCookie(reply, isProd)
      await reply.status(401).send({ error: 'unauthenticated' })
      return
    }
    return {
      sub: session.userSub,
      email: session.userEmail,
      name: session.userName,
      // The web app shows the admin screen only to an instance admin (ADR 0014).
      isAdmin: await isInstanceAdmin(db, session.userSub),
    }
  })

  // ─── POST /auth/logout ────────────────────────────────────────────────────
  app.post('/auth/logout', async (request, reply) => {
    const rawId = request.cookies[SESSION_COOKIE_NAME]
    if (rawId) await revokeSession(db, rawId)
    clearSessionCookie(reply, isProd)
    await reply.status(204).send()
  })
}

// ---------------------------------------------------------------------------
// Helpers — error redirect
// ---------------------------------------------------------------------------

async function redirectWithError(
  reply: FastifyReply,
  spaOrigin: string,
  code: string,
): Promise<void> {
  const url = new URL('/auth/error', spaOrigin)
  url.searchParams.set('reason', code)
  await reply.redirect(url.toString(), 302)
}
