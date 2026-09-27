/**
 * auth/identity.ts
 *
 * One place that turns an incoming request's credentials into an identity,
 * shared by every entry point: Fastify routes (`authPreHandler`,
 * `requireTokenScope`), the rate limiter's key and the tus upload hooks. The
 * Hocuspocus WebSocket does NOT use it: it accepts only the session cookie
 * and share links, and refuses tokens (hocuspocus/authenticate.ts).
 *
 * Credentials, in precedence order:
 *   1. `Authorization: Bearer nrt_…` — a personal access token
 *      (auth/personalAccessTokens.ts). A PAT claim is authoritative: when it
 *      does not verify, the request is unauthenticated, even if it also
 *      carries a cookie and even under BYPASS_AUTH (so scope handling can be
 *      exercised in dev). Bearer values without the `nrt_` prefix (the
 *      /metrics token) are not PAT claims and are ignored here.
 *   2. BYPASS_AUTH=true → the synthetic `dev-user` (unchanged dev behaviour).
 *   3. The `narrative_session` cookie (ADR 0005).
 *
 * Resolution is memoised per raw Node request, so the rate limiter
 * (onRequest), `authPreHandler` (preHandler) and the tus hooks — which all
 * see the same `IncomingMessage` — look the credential up once. That matters
 * beyond cost: `lookupSession` slides the session expiry with a write.
 */

import { createHash } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { Database } from '../db/client.js'
import type { BearerCache } from '../http/bearerCache.js'
import type { JwtPayload } from './jwt.js'
import { lookupSession, readCookieFromHeader, SESSION_COOKIE_NAME } from './session.js'
import {
  looksLikePersonalAccessToken,
  type PatScope,
  type PatService,
} from './personalAccessTokens.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthKind = 'session' | 'token'

/**
 * How a request authenticated. Attached as `request.auth` next to
 * `request.user` by the pre-handlers in fastifyAuth.ts.
 */
export interface RequestAuth {
  kind: AuthKind
  /** The token's scopes. Always empty for a session. */
  scopes: readonly PatScope[]
  /** Id of the personal access token (kind `token`), else null. */
  tokenId: string | null
  /**
   * An opaque, stable key of the browser session this request rides on
   * (kind `session`, not bypass): a domain-separated SHA-256 of the session
   * id, so it is neither the cookie nor the hash the sessions table is
   * looked up by. Per-session state keys on it (routes/agent.ts: one command
   * API session per browser session, so a run started in one browser session
   * cannot be attached from another). Null otherwise.
   */
  sessionKey: string | null
  /** The synthetic BYPASS_AUTH principal (dev only). */
  bypass: boolean
}

export interface Identity {
  user: JwtPayload
  auth: RequestAuth
}

export type IdentityResult =
  /** No credential at all. */
  | { status: 'none' }
  /** A credential was presented but did not verify. */
  | { status: 'invalid'; presented: AuthKind }
  | { status: 'ok'; identity: Identity }

export interface IdentityDeps {
  db: Database
  bypass: boolean
  pats: PatService
  /**
   * Recently failed / admitted bearers (http/bearerCache.ts). A PAT that
   * failed verification within the negative TTL is answered `invalid`
   * without a database lookup; every verification outcome is recorded.
   * Optional: without it every PAT is looked up.
   */
  bearers?: BearerCache
}

/** The synthetic BYPASS_AUTH principal; a fresh object per request. */
function devIdentity(): Identity {
  return {
    user: { sub: 'dev-user', email: 'dev@localhost', name: 'Dev User' },
    auth: { kind: 'session', scopes: [], tokenId: null, sessionKey: null, bypass: true },
  }
}

// ---------------------------------------------------------------------------
// Credential extraction
// ---------------------------------------------------------------------------

/**
 * The PAT in an `Authorization` header, or null when the header is absent or
 * carries something that is not a PAT claim.
 */
export function readBearerPat(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value)
  const credential = match?.[1]
  return looksLikePersonalAccessToken(credential) ? credential : null
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a PAT to an identity. With `bearers`, a token that failed
 * verification recently is refused without a lookup, a refusal is recorded
 * (a thrown error — database down — is not: it says nothing about the
 * token), and a success refreshes the token's "seen" entry.
 */
export async function resolvePatIdentity(
  raw: string,
  pats: PatService,
  bearers?: BearerCache,
): Promise<IdentityResult> {
  if (bearers?.isKnownInvalid(raw)) return { status: 'invalid', presented: 'token' }
  const verified = await pats.verify(raw)
  if (!verified) {
    bearers?.recordInvalid(raw)
    return { status: 'invalid', presented: 'token' }
  }
  bearers?.recordValid(raw)
  return {
    status: 'ok',
    identity: {
      user: {
        sub: verified.userSub,
        ...(verified.email ? { email: verified.email } : {}),
        ...(verified.name ? { name: verified.name } : {}),
      },
      auth: {
        kind: 'token',
        scopes: verified.scopes,
        tokenId: verified.tokenId,
        sessionKey: null,
        bypass: false,
      },
    },
  }
}

/** Resolve the credentials in a set of request headers (no memoisation). */
export async function resolveIdentityFromHeaders(
  headers: IncomingHttpHeaders,
  deps: IdentityDeps,
): Promise<IdentityResult> {
  const pat = readBearerPat(headers['authorization'])
  if (pat) return resolvePatIdentity(pat, deps.pats, deps.bearers)

  if (deps.bypass) return { status: 'ok', identity: devIdentity() }

  const rawId = readCookieFromHeader(headers['cookie'], SESSION_COOKIE_NAME)
  if (!rawId) return { status: 'none' }
  const session = await lookupSession(deps.db, rawId)
  if (!session) return { status: 'invalid', presented: 'session' }
  return {
    status: 'ok',
    identity: {
      user: {
        sub: session.userSub,
        email: session.userEmail,
        ...(session.userName ? { name: session.userName } : {}),
      },
      auth: {
        kind: 'session',
        scopes: [],
        tokenId: null,
        sessionKey: sessionKeyOf(rawId),
        bypass: false,
      },
    },
  }
}

/** See `RequestAuth.sessionKey`. */
export function sessionKeyOf(rawSessionId: string): string {
  return createHash('sha256')
    .update('narrative:session-key:v1\n', 'utf8')
    .update(rawSessionId, 'utf8')
    .digest('base64url')
}

const memo = new WeakMap<IncomingMessage, Promise<IdentityResult>>()

/**
 * Resolve (once per request) the identity of a raw Node request. Fastify
 * callers pass `request.raw`; tus hooks pass the request they are handed,
 * which is the same object.
 */
export function resolveRequestIdentity(
  req: IncomingMessage,
  deps: IdentityDeps,
): Promise<IdentityResult> {
  let pending = memo.get(req)
  if (!pending) {
    pending = resolveIdentityFromHeaders(req.headers, deps)
    memo.set(req, pending)
    // A failed lookup (database down) must not be cached as the answer for
    // a later caller on the same request; let that caller retry.
    pending.catch(() => memo.delete(req))
  }
  return pending
}

/** Does this identity carry at least one of `scopes`? Sessions carry none. */
export function hasAnyScope(auth: RequestAuth, scopes: readonly PatScope[]): boolean {
  return auth.kind === 'token' && auth.scopes.some((s) => scopes.includes(s))
}
