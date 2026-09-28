/**
 * routes/accessTokens.ts
 *
 * Personal access token management for the signed-in user (agentic layer A1).
 *
 * Endpoints (public as /api/access-tokens…, Caddy strips the /api prefix):
 *   GET    /access-tokens      → the caller's tokens (never the secret or its hash)
 *   POST   /access-tokens      → { name, scopes, expiresInDays? } → 201 { token, accessToken }
 *                                 `token` is the raw secret, returned exactly once
 *   DELETE /access-tokens/:id  → revoke one of the caller's tokens; 204, or 404.
 *                                 Also ends the token's open MCP sessions at once
 *                                 (auth/agentSessions.ts).
 *
 * Named "access tokens", not "tokens", because tokens in Narrative's API and
 * command vocabulary are design tokens (/folders/:id/tokens/…, `token.*`).
 *
 * Auth: SESSION COOKIE ONLY. Every route uses `authPreHandler`, which rejects
 * a personal access token with 403 — a PAT must never mint, list or revoke
 * PATs, so a leaked agent token cannot create a successor for itself or hide
 * from revocation. Claimed in AGENT_ALLOWLIST (packages/commands) for the
 * same reason: credential management is not an agent capability.
 *
 * Creation is rate limited per user (http/rateLimit.ts,
 * TOKEN_CREATE_RATE_LIMIT) on top of the per-user active-token cap
 * (MAX_ACTIVE_PATS_PER_USER in auth/personalAccessTokens.ts).
 */

import type { FastifyInstance } from 'fastify'
import { closeAgentSessionsForCredential, credentialKeyForToken } from '../auth/agentSessions.js'
import { authPreHandler, getAuthOpts } from '../auth/fastifyAuth.js'
import { PatError, parseCreatePatInput } from '../auth/personalAccessTokens.js'
import { tokenCreateRouteRateLimit } from '../http/rateLimit.js'
import { revokeUploadSessionsForCredential } from '../media/uploadSessions.js'

export interface AccessTokenRouteOpts {
  /**
   * Remove what a revoked token opened besides MCP sessions — its upload
   * sessions (default: the Postgres delete). Resolves to how many.
   */
  revokeUploadSessions?: (credentialKey: string) => Promise<number>
}

export function registerAccessTokenRoutes(
  app: FastifyInstance,
  opts: AccessTokenRouteOpts = {},
): void {
  const pats = () => getAuthOpts(app).pats
  const revokeUploadSessions =
    opts.revokeUploadSessions ??
    ((key: string) => revokeUploadSessionsForCredential(getAuthOpts(app).db, key))

  app.get('/access-tokens', { preHandler: [authPreHandler] }, async (req) => {
    const tokens = await pats().list(req.user!.sub)
    return { tokens }
  })

  app.post(
    '/access-tokens',
    { preHandler: [authPreHandler], config: tokenCreateRouteRateLimit },
    async (req, reply) => {
      let input
      try {
        input = parseCreatePatInput(req.body)
      } catch (err) {
        if (err instanceof PatError) {
          return reply.status(400).send({ error: err.code, message: err.message })
        }
        throw err
      }

      try {
        const { token, summary } = await pats().create(req.user!.sub, input)
        req.log.info(
          { tokenId: summary.id, scopes: summary.scopes },
          'personal access token created',
        )
        // The body carries a live secret: keep it out of every cache.
        return reply
          .status(201)
          .header('cache-control', 'no-store')
          .send({ token, accessToken: summary })
      } catch (err) {
        if (err instanceof PatError && err.code === 'token_limit_reached') {
          return reply.status(409).send({ error: err.code, message: err.message })
        }
        throw err
      }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/access-tokens/:id',
    { preHandler: [authPreHandler] },
    async (req, reply) => {
      const revoked = await pats().revoke(req.user!.sub, req.params.id)
      if (!revoked) return reply.status(404).send({ error: 'not_found' })
      // Every token-authenticated call (HTTP, tus, MCP) re-verifies the token,
      // and tokens are never accepted on the Hocuspocus WebSocket
      // (hocuspocus/authenticate.ts). What would outlive the revocation is an
      // open MCP session with its server→client stream: end those now.
      const key = credentialKeyForToken(req.params.id)
      const closedSessions = await closeAgentSessionsForCredential(key)
      // Upload sessions the token opened (media.uploadSession) go with it.
      const uploadSessions = await revokeUploadSessions(key)
      req.log.info(
        { tokenId: req.params.id, closedSessions, uploadSessions },
        'personal access token revoked',
      )
      return reply.status(204).send()
    },
  )
}
