/**
 * auth/fastifyAuth.ts
 *
 * Fastify auth plugin + pre-handler hooks for session-cookie validation and
 * deck access enforcement.
 *
 * Usage in index.ts:
 *   registerAuthPlugin(app, { bypass: bypassAuth, db })
 *
 * Usage on routes:
 *   { preHandler: [authPreHandler, requireDeckRole('owner')] }
 *
 * In BYPASS_AUTH=true mode the plugin synthesizes a 'dev-user' principal.
 * This mode must NEVER be enabled in production.
 *
 * Auth mechanism (post-2026-05):
 *   - HTTP API: the SPA carries a `narrative_session` HttpOnly cookie set
 *     by /auth/callback after a successful Google OAuth exchange. The
 *     cookie value is opaque and resolved via auth/session.ts → DB row.
 *   - The previous Bearer-id_token path is gone — id_tokens never leave
 *     the server now.
 *
 * Personal access tokens (agentic layer A1, ADR 0011):
 *   - `Authorization: Bearer nrt_…` resolves to the token's user
 *     (auth/identity.ts, auth/personalAccessTokens.ts).
 *   - `authPreHandler` stays SESSION-ONLY: it rejects a valid PAT with 403.
 *     Every route that exists today is a browser route, and the agent
 *     surface has exactly one door (ADR 0010/0011): the command registry
 *     behind /api/mcp and /api/commands. A PAT that worked on every legacy
 *     route would open a second door that bypasses command validation,
 *     confirmation (`confirm: 'always'`), run attribution and the audit log.
 *   - `requireTokenScope(scope)` is the pre-handler for agent routes: it
 *     authenticates the request itself (use it INSTEAD of authPreHandler)
 *     and requires a PAT carrying `scope`.
 *   - Either way `request.auth` says how the caller authenticated
 *     (`kind: 'session' | 'token'`, the token's scopes and id).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { JwtPayload } from './jwt.js'
import { resolveDeckAccess, roleAtLeast, type DeckRole } from './permissions.js'
import { isShareTokenShape } from './shareLinks.js'
import type { Database } from '../db/client.js'
import { BearerCache } from '../http/bearerCache.js'
import {
  createDrizzlePatStore,
  createPatService,
  refuseAllPatOwners,
  type PatScope,
  type PatService,
} from './personalAccessTokens.js'
import {
  resolveRequestIdentity,
  type Identity,
  type IdentityDeps,
  type IdentityResult,
  type RequestAuth,
} from './identity.js'

// ---------------------------------------------------------------------------
// FastifyRequest augmentation
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload
    /** How `user` authenticated — set together with `user`. */
    auth?: RequestAuth
    deckAccess?: { role: DeckRole; reason: string }
  }
}

// ---------------------------------------------------------------------------
// Boot-time safety guard
// ---------------------------------------------------------------------------

/**
 * Fail-fast guard against shipping a dev auth bypass to production.
 *
 * BYPASS_AUTH=true synthesizes a `dev-user` principal for EVERY request — a
 * total auth bypass. `isDev = NODE_ENV !== 'production'` also means an UNSET
 * NODE_ENV is treated as dev, so a prod deploy that forgets NODE_ENV silently
 * runs in dev-auth mode.
 *
 * Call this at boot (before the server starts listening):
 *   - throws if BYPASS_AUTH is truthy AND NODE_ENV === 'production'
 *   - returns `{ nodeEnvUnset }` so the caller can log a loud warning when
 *     NODE_ENV is unset (= dev-mode auth in effect)
 *
 * Kept as a pure function (no process.env / console reads) so it is unit
 * testable without booting the whole server.
 */
export function assertAuthBootSafety(opts: { bypassAuth: boolean; nodeEnv: string | undefined }): {
  nodeEnvUnset: boolean
} {
  const isProd = opts.nodeEnv === 'production'
  if (opts.bypassAuth && isProd) {
    throw new Error(
      'FATAL: BYPASS_AUTH is enabled while NODE_ENV=production. This would ' +
        'grant unauthenticated full access to every request. Refusing to start. ' +
        'Unset BYPASS_AUTH before deploying to production.',
    )
  }
  return { nodeEnvUnset: !opts.nodeEnv }
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export interface AuthPluginOpts {
  bypass?: boolean
  db: Database
  /**
   * Personal access token service. Production passes the one built with the
   * sign-in policy (index.ts); tests inject one over an in-memory store.
   * Without it, tokens are refused (`refuseAllPatOwners`): fail closed.
   */
  pats?: PatService
  /**
   * Recently failed / admitted bearer tokens (http/bearerCache.ts), shared by
   * the credential resolvers and the rate limiter's pre-limit. Default: one
   * instance per app, created here, so every consumer that reads the auth
   * options (`getIdentityDeps`, `registerRateLimit`, the MCP routes) shares it.
   */
  bearers?: BearerCache
}

/** The resolved auth options every pre-handler and hook reads. */
export interface ResolvedAuthOpts extends AuthPluginOpts {
  pats: PatService
  bearers: BearerCache
}

/**
 * Registers the auth plugin on the Fastify instance.
 * Decorates the request with `user`, `auth` and `deckAccess` fields.
 * Makes `authPreHandler`, `requireTokenScope` and `requireDeckRole` available
 * to route definitions.
 */
export function registerAuthPlugin(app: FastifyInstance, opts: AuthPluginOpts): void {
  // Decorate so Fastify's type system doesn't complain about unknown fields.
  // Using undefined as initial value satisfies strict TypeScript (no null/JwtPayload mismatch).
  app.decorateRequest('user')
  app.decorateRequest('auth')
  app.decorateRequest('deckAccess')

  const resolved: ResolvedAuthOpts = {
    ...opts,
    pats:
      opts.pats ??
      createPatService(createDrizzlePatStore(opts.db), { isOwnerAllowed: refuseAllPatOwners }),
    bearers: opts.bearers ?? new BearerCache(),
  }

  // Attach opts to app for route-level access (via closure in factory functions).
  // We store on the app instance so factory functions can close over them.
  ;(app as FastifyInstance & { _authOpts: ResolvedAuthOpts })._authOpts = resolved
}

// ---------------------------------------------------------------------------
// Shared option accessor
// ---------------------------------------------------------------------------

/**
 * Internal helper — retrieves auth opts attached by registerAuthPlugin.
 * Throws if registerAuthPlugin was not called before this route fires.
 */
function getOpts(req: FastifyRequest): ResolvedAuthOpts {
  return getAuthOpts(req.server)
}

/**
 * The auth options registered on `app` (by registerAuthPlugin). For code
 * outside a Fastify pre-handler — the tus hooks, the rate limiter.
 */
export function getAuthOpts(app: FastifyInstance): ResolvedAuthOpts {
  const opts = (app as FastifyInstance & { _authOpts?: ResolvedAuthOpts })._authOpts
  if (!opts) {
    throw new Error('[auth] registerAuthPlugin must be called before route handlers')
  }
  return opts
}

/** The identity-resolution dependencies for requests served by `app`. */
export function getIdentityDeps(app: FastifyInstance): IdentityDeps {
  const opts = getAuthOpts(app)
  return { db: opts.db, bypass: opts.bypass === true, pats: opts.pats, bearers: opts.bearers }
}

/** Resolve (memoised per request) who is calling. */
export function resolveFastifyIdentity(req: FastifyRequest): Promise<IdentityResult> {
  return resolveRequestIdentity(req.raw, getIdentityDeps(req.server))
}

function attachIdentity(req: FastifyRequest, identity: Identity): void {
  req.user = identity.user
  req.auth = identity.auth
}

/** RFC 6750 challenge so token clients (MCP) know how to authenticate. */
function bearerChallenge(extra?: string): string {
  return extra ? `Bearer realm="narrative", ${extra}` : 'Bearer realm="narrative"'
}

// ---------------------------------------------------------------------------
// authPreHandler
// ---------------------------------------------------------------------------

/**
 * Pre-handler hook for browser routes: reads the `narrative_session` cookie,
 * resolves it to a session row, attaches the user to `request.user` (and
 * `request.auth = { kind: 'session' }`).
 *
 * On failure → 401.
 * A valid personal access token → 403: PATs are accepted only on the agent
 * surface (`requireTokenScope`), see the file header.
 * In bypass mode → synthesizes { sub: 'dev-user' } without DB lookup.
 *
 * Share-link access is handled by routes themselves via `share_token` query
 * param + resolveDeckAccess; we leave request.user undefined in that case
 * and the route must handle the null user.
 */
export async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await resolveFastifyIdentity(req)
  if (result.status !== 'ok') {
    await reply.status(401).send({ error: 'Unauthorized' })
    return
  }
  if (result.identity.auth.kind === 'token') {
    await reply.status(403).send({
      error: 'token_not_accepted',
      message:
        'Personal access tokens are accepted only on the agent endpoints (/api/mcp, /api/commands).',
    })
    return
  }
  attachIdentity(req, result.identity)
}

// ---------------------------------------------------------------------------
// readShareToken
// ---------------------------------------------------------------------------

/** What a request's `?share_token=` holds: nothing, one well-formed token, or something no token of ours. */
export type ShareTokenParam = { valid: true; token: string | null } | { valid: false }

/**
 * The request's `?share_token=`, checked once at the boundary, before any
 * lookup: absent → `{ valid: true, token: null }`; one string of a share
 * token's shape (auth/shareLinks.ts SHARE_TOKEN_SHAPE) → that token; anything
 * else — empty, a NUL byte, a repeated parameter (an array), the wrong
 * characters — `{ valid: false }`, which the pre-handlers answer 401 with one
 * body whatever the route would have looked up.
 */
export function readShareToken(req: FastifyRequest): ShareTokenParam {
  const raw = (req.query as Record<string, unknown> | undefined)?.['share_token']
  if (raw === undefined) return { valid: true, token: null }
  return isShareTokenShape(raw) ? { valid: true, token: raw } : { valid: false }
}

/** The request's well-formed share token, or null (none, or malformed: the pre-handlers refused those). */
export function shareTokenOf(req: FastifyRequest): string | null {
  const param = readShareToken(req)
  return param.valid ? param.token : null
}

// ---------------------------------------------------------------------------
// shareReadPreHandler
// ---------------------------------------------------------------------------

/**
 * Pre-handler for the reads a share-link visitor makes too — the media URLs,
 * video info and fonts a shared deck renders with (and the render worker's
 * page, whose render token is a share link: auth/renderTokens.ts):
 *   - a session (or BYPASS_AUTH) is attached exactly as by `authPreHandler`;
 *   - NO credential at all passes through anonymously — the route must then
 *     authorise from `share_token` (resolveDeckAccess /
 *     resolveFolderContentAccess) and refuse without one;
 *   - a credential that does not verify is still 401, never downgraded to
 *     anonymous, and a personal access token is 403 as on every browser route;
 *   - a malformed `share_token` (readShareToken) is 401 before anything is
 *     looked up, so it tells nothing about what the route would have found.
 */
export async function shareReadPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!readShareToken(req).valid) {
    await reply.status(401).send({ error: 'Unauthorized' })
    return
  }
  const result = await resolveFastifyIdentity(req)
  if (result.status === 'none') return
  if (result.status !== 'ok') {
    await reply.status(401).send({ error: 'Unauthorized' })
    return
  }
  if (result.identity.auth.kind === 'token') {
    await reply.status(403).send({
      error: 'token_not_accepted',
      message:
        'Personal access tokens are accepted only on the agent endpoints (/api/mcp, /api/commands).',
    })
    return
  }
  attachIdentity(req, result.identity)
}

// ---------------------------------------------------------------------------
// requireTokenScope
// ---------------------------------------------------------------------------

export interface RequireTokenScopeOpts {
  /**
   * Also admit a signed-in browser session (default false: the route is a
   * token door). Sessions carry no scopes; admitting one means "a person
   * signed in to the web app may use this route as themselves".
   */
  allowSession?: boolean
}

/**
 * Authentication pre-handler for the agent surface (`/api/mcp` with `'mcp'`,
 * `/api/commands` with `'api'`). Use it INSTEAD of `authPreHandler`; it can
 * be followed by `requireDeckRole`.
 *
 *   - no credential / invalid credential → 401 with a Bearer challenge;
 *   - a PAT without `scope`              → 403 `insufficient_scope`;
 *   - a session                          → 401 unless `allowSession`;
 *   - BYPASS_AUTH's dev-user             → admitted (dev only).
 *
 * On success `request.user` and `request.auth` are set.
 */
export function requireTokenScope(
  scope: PatScope,
  opts: RequireTokenScopeOpts = {},
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = await resolveFastifyIdentity(req)
    if (result.status !== 'ok') {
      await reply
        .status(401)
        .header(
          'www-authenticate',
          bearerChallenge(result.status === 'invalid' ? 'error="invalid_token"' : undefined),
        )
        .send({ error: 'Unauthorized' })
      return
    }
    const { auth } = result.identity
    if (auth.kind === 'token') {
      if (!auth.scopes.includes(scope)) {
        await reply
          .status(403)
          .header(
            'www-authenticate',
            bearerChallenge(`error="insufficient_scope", scope="${scope}"`),
          )
          .send({
            error: 'insufficient_scope',
            message: `This token lacks the "${scope}" scope.`,
            scope,
          })
        return
      }
    } else if (!auth.bypass && opts.allowSession !== true) {
      await reply
        .status(401)
        .header('www-authenticate', bearerChallenge())
        .send({
          error: 'token_required',
          message: `This endpoint needs a personal access token with the "${scope}" scope.`,
        })
      return
    }
    attachIdentity(req, result.identity)
  }
}

// ---------------------------------------------------------------------------
// requireDeckRole
// ---------------------------------------------------------------------------

/**
 * Route-level pre-handler factory. Must run AFTER authPreHandler.
 *
 * Resolves the requesting user's role on the deck (from deck_permissions or share link),
 * attaches it to request.deckAccess, and rejects with 403 if the role is insufficient.
 *
 * Deck id is taken from request.params.id — standard convention for /decks/:id routes.
 * Share token is taken from request.query.share_token when user is null/missing
 * (readShareToken: a malformed one is 401 before the lookup).
 *
 * @param required  Minimum role required to proceed (inclusive — e.g. 'editor' allows 'owner' too).
 */
export function requireDeckRole(
  required: DeckRole,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const opts = getOpts(req)

    const params = req.params as Record<string, string>
    const deckId = params['id']
    if (!deckId) {
      await reply.status(400).send({ error: 'Missing deck id' })
      return
    }

    const userId = req.user?.sub ?? null

    const share = readShareToken(req)
    if (!share.valid) {
      await reply.status(401).send({ error: 'Unauthorized' })
      return
    }
    const shareToken = share.token

    let access = await resolveDeckAccess(opts.db, { deckId, userId, shareToken })

    // BYPASS_AUTH=true dev fallback: legacy decks created with
    // ownerUserId='demo-user' (M4-era) lack a permissions row for the
    // synthesised 'dev-user' principal, so resolveDeckAccess returns
    // null and every role-gated mutation 404/403s. Mirror the list
    // endpoint's "treat dev-user and demo-user as the same identity"
    // workaround so PUT /decks/:id/thumbnail and friends work on
    // those legacy decks.
    // TODO(post-M10): remove once production migration script runs.
    if (!access && opts.bypass === true && userId === 'dev-user') {
      const legacyAccess = await resolveDeckAccess(opts.db, {
        deckId,
        userId: 'demo-user',
        shareToken,
      })
      if (legacyAccess) {
        access = legacyAccess
      }
    }

    if (!access) {
      await reply.status(403).send({ error: 'Forbidden' })
      return
    }

    if (!roleAtLeast(access.role, required)) {
      await reply.status(403).send({ error: 'Forbidden' })
      return
    }

    req.deckAccess = access
  }
}
