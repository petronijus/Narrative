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
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { JwtPayload } from './jwt.js'
import { lookupSession, SESSION_COOKIE_NAME } from './session.js'
import { resolveDeckAccess, roleAtLeast, type DeckRole } from './permissions.js'
import type { Database } from '../db/client.js'

// ---------------------------------------------------------------------------
// FastifyRequest augmentation
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload
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
}

/**
 * Registers the auth plugin on the Fastify instance.
 * Decorates the request with `user` and `deckAccess` fields.
 * Makes `authPreHandler` and `requireDeckRole` available to route definitions.
 */
export function registerAuthPlugin(app: FastifyInstance, opts: AuthPluginOpts): void {
  // Decorate so Fastify's type system doesn't complain about unknown fields.
  // Using undefined as initial value satisfies strict TypeScript (no null/JwtPayload mismatch).
  app.decorateRequest('user')
  app.decorateRequest('deckAccess')

  // Attach opts to app for route-level access (via closure in factory functions).
  // We store on the app instance so factory functions can close over them.
  ;(app as FastifyInstance & { _authOpts: AuthPluginOpts })._authOpts = opts
}

// ---------------------------------------------------------------------------
// Shared option accessor
// ---------------------------------------------------------------------------

/**
 * Internal helper — retrieves auth opts attached by registerAuthPlugin.
 * Throws if registerAuthPlugin was not called before this route fires.
 */
function getOpts(req: FastifyRequest): AuthPluginOpts {
  const opts = (req.server as FastifyInstance & { _authOpts?: AuthPluginOpts })._authOpts
  if (!opts) {
    throw new Error('[auth] registerAuthPlugin must be called before route handlers')
  }
  return opts
}

// ---------------------------------------------------------------------------
// authPreHandler
// ---------------------------------------------------------------------------

/**
 * Pre-handler hook: reads the `narrative_session` cookie, resolves it to a
 * session row, attaches the user to `request.user`.
 *
 * On failure → 401.
 * In bypass mode → synthesizes { sub: 'dev-user' } without DB lookup.
 *
 * Share-link access is handled by routes themselves via `share_token` query
 * param + resolveDeckAccess; we leave request.user undefined in that case
 * and the route must handle the null user.
 */
export async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const opts = getOpts(req)

  if (opts.bypass) {
    req.user = { sub: 'dev-user', email: 'dev@localhost', name: 'Dev User' }
    return
  }

  const rawId = req.cookies?.[SESSION_COOKIE_NAME]
  if (!rawId) {
    await reply.status(401).send({ error: 'Unauthorized' })
    return
  }

  const session = await lookupSession(opts.db, rawId)
  if (!session) {
    await reply.status(401).send({ error: 'Unauthorized' })
    return
  }

  req.user = {
    sub: session.userSub,
    email: session.userEmail,
    ...(session.userName ? { name: session.userName } : {}),
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
 * Share token is taken from request.query.share_token when user is null/missing.
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

    const query = req.query as Record<string, string>
    const shareToken = query['share_token'] ?? null

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
