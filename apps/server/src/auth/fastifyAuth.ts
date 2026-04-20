/**
 * auth/fastifyAuth.ts
 *
 * Fastify auth plugin + pre-handler hooks for JWT validation and deck access enforcement.
 *
 * Usage in index.ts:
 *   registerAuthPlugin(app, { verifier, bypass: bypassAuth })
 *
 * Usage on routes:
 *   { preHandler: [authPreHandler, requireDeckRole('owner')] }
 *
 * In BYPASS_AUTH=true mode the plugin synthesizes a 'dev-user' principal.
 * This mode must NEVER be enabled in production.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { JwtPayload, JwtVerifier } from './jwt.js'
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
// Plugin registration
// ---------------------------------------------------------------------------

export interface AuthPluginOpts {
  verifier: JwtVerifier | null
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
 * Pre-handler hook: extracts Bearer token, verifies with JwtVerifier, attaches request.user.
 *
 * On failure → 401.
 * In bypass mode → synthesizes { sub: 'dev-user' } without network call.
 *
 * This is the ONLY route that supports unauthenticated access — via share token on
 * GET /decks/:id. Those routes handle auth themselves by calling resolveDeckAccess
 * with share_token from query params. authPreHandler sets request.user = undefined
 * in that case and the route must handle the null user itself.
 */
export async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const opts = getOpts(req)

  if (opts.bypass) {
    req.user = { sub: 'dev-user', email: 'dev@localhost', name: 'Dev User' }
    return
  }

  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    await reply.status(401).send({ error: 'Unauthorized' })
    return
  }

  const token = authHeader.slice(7)

  try {
    req.user = await opts.verifier!.verify(token)
  } catch {
    await reply.status(401).send({ error: 'Unauthorized' })
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

    const access = await resolveDeckAccess(opts.db, { deckId, userId, shareToken })

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
