/**
 * http/sameOrigin.ts
 *
 * `requireSameOrigin` — a pre-handler for state-changing routes that a
 * browser session cookie can authenticate, when the route must not rely on
 * `SameSite=Lax` alone (security review L6; auth/session.ts explains the
 * cookie's CSRF posture). Intended first for the session-authenticated
 * `POST /commands`, which runs any registry command with the caller's role.
 *
 * Rule: when the request authenticates with the session cookie, its `Origin`
 * header must be one of the configured origins (CORS_ORIGIN). A missing
 * `Origin`, `Origin: null`, or any other origin → 403 `forbidden_origin`.
 * Browsers send `Origin` on every cross-origin request and on same-origin
 * POST / PUT / PATCH / DELETE, so the SPA always passes; a page on another
 * site riding the cookie never does.
 *
 * Not checked:
 *   - personal access tokens (`Authorization: Bearer nrt_…`): a bearer token
 *     is never attached by the browser on its own, so there is nothing to
 *     forge;
 *   - requests without a verified identity: the route's own auth pre-handler
 *     answers them (401), this one stays out of the way;
 *   - BYPASS_AUTH's synthetic dev-user (dev only; no cookie involved).
 *
 * Wiring:
 *   index.ts calls `registerSameOriginPolicy(app, { allowedOrigins })` with
 *   the CORS_ORIGIN list once; a route then adds the pre-handler:
 *     app.post('/commands', { preHandler: [requireSameOrigin, …] }, …)
 *   Order does not matter relative to the auth pre-handler: identity
 *   resolution is memoised per request (auth/identity.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { resolveFastifyIdentity } from '../auth/fastifyAuth.js'

export interface SameOriginPolicy {
  /** Origins allowed to use the session cookie, normalised (scheme://host[:port]). */
  allowedOrigins: ReadonlySet<string>
}

type AppWithPolicy = FastifyInstance & { _sameOriginPolicy?: SameOriginPolicy }

/** `https://Example.com:443/` → `https://example.com`; null when not an http(s) origin. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin.toLowerCase()
  } catch {
    return null
  }
}

/** Register the allowed origins for `requireSameOrigin` on `app`. */
export function registerSameOriginPolicy(
  app: FastifyInstance,
  opts: { allowedOrigins: readonly string[] },
): void {
  const allowed = new Set<string>()
  for (const origin of opts.allowedOrigins) {
    const normalized = normalizeOrigin(origin)
    if (normalized === null) throw new Error(`[sameOrigin] not an http(s) origin: ${origin}`)
    allowed.add(normalized)
  }
  ;(app as AppWithPolicy)._sameOriginPolicy = { allowedOrigins: allowed }
}

function policyOf(app: FastifyInstance): SameOriginPolicy {
  const policy = (app as AppWithPolicy)._sameOriginPolicy
  if (!policy) {
    throw new Error('[sameOrigin] registerSameOriginPolicy must be called before routes use it')
  }
  return policy
}

/** Is `origin` (the raw header) one of the allowed origins? */
export function isAllowedOrigin(policy: SameOriginPolicy, origin: string | undefined): boolean {
  if (origin === undefined) return false
  const normalized = normalizeOrigin(origin)
  return normalized !== null && policy.allowedOrigins.has(normalized)
}

export async function requireSameOrigin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const policy = policyOf(req.server)
  const result = await resolveFastifyIdentity(req)
  if (result.status !== 'ok') return
  const { auth } = result.identity
  if (auth.kind !== 'session' || auth.bypass) return

  const raw = req.headers['origin']
  const origin = Array.isArray(raw) ? raw[0] : raw
  if (isAllowedOrigin(policy, origin)) return

  req.log.warn(
    { origin: origin ?? null, route: req.routeOptions.url },
    'refused a session-authenticated request from a foreign origin',
  )
  await reply.status(403).send({
    error: 'forbidden_origin',
    message: 'This request must come from the Narrative web app.',
  })
}
