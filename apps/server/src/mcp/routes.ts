/**
 * mcp/routes.ts — the MCP endpoint and its OAuth routes.
 *
 *   GET | POST | DELETE /mcp   (public: /api/mcp — Caddy strips one /api)
 *     Streamable HTTP (MCP 2025-11-25): POST carries JSON-RPC (answered as
 *     JSON or an SSE stream — confirmations are elicited on the tool call's
 *     own stream), GET opens the server→client SSE stream, DELETE ends the
 *     session. Auth: mcp/auth.ts (PAT with `mcp`, or an MCP OAuth access
 *     token; never a cookie). Rate limit: AGENT_RATE_LIMIT per PAT / OAuth
 *     grant. Requests with an `Origin` header from anywhere but Narrative's
 *     own origins are refused (the transport spec's DNS-rebinding rule).
 *
 * Registration reads nothing from `deps.mcp`; handlers do, when a request
 * arrives (the route guard registers routes against stubs).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getAuthOpts } from '../auth/fastifyAuth.js'
import { AGENT_RATE_LIMIT } from '../http/rateLimit.js'
import {
  addResourceMetadataToChallenge,
  mcpAuthPreHandler,
  mcpRateLimitKey,
  type McpAuthDeps,
} from './auth.js'
import { registerMcpOAuthRoutes } from './oauth/routes.js'
import type { McpRuntime } from './runtime.js'

export interface McpRouteDeps {
  mcp: McpRuntime
  /** Header with the real client IP behind the proxy (http/rateLimit.ts). */
  clientIpHeader?: string | undefined
  /** Browser origins allowed to call /mcp (the SPA; CORS_ORIGIN). */
  allowedOrigins: readonly string[]
}

export async function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): Promise<void> {
  // Lazily built on the first request — see the file header.
  let auth: McpAuthDeps | null = null
  const authDeps = (): McpAuthDeps =>
    (auth ??= {
      config: deps.mcp.config,
      oauth: deps.mcp.oauth,
      clientIpHeader: deps.clientIpHeader,
      // The auth plugin's instance, shared with the pre-limit (http/bearerCache.ts).
      bearers: getAuthOpts(app).bearers,
    })
  let preHandler: ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | null = null
  const lazyKey = (req: FastifyRequest) => mcpRateLimitKey(authDeps())(req)

  const originGuard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = req.headers['origin']
    if (typeof origin !== 'string') return
    const allowed = new Set([
      new URL(deps.mcp.config.apiBaseUrl).origin,
      deps.mcp.config.spaOrigin,
      ...deps.allowedOrigins,
    ])
    if (!allowed.has(origin)) {
      await reply
        .status(403)
        .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin' }, id: null })
    }
  }

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    config: {
      rateLimit: {
        max: AGENT_RATE_LIMIT.max,
        timeWindow: AGENT_RATE_LIMIT.timeWindowMs,
        keyGenerator: lazyKey,
      },
    },
    preHandler: [
      originGuard,
      async (req, reply) => {
        preHandler ??= mcpAuthPreHandler(authDeps())
        await preHandler(req, reply)
      },
    ],
    onSend: async (req, reply, payload) =>
      addResourceMetadataToChallenge(deps.mcp.config)(req, reply, payload),
    handler: async (req, reply) => {
      await deps.mcp.sessions.handle(req, reply)
    },
  })

  await registerMcpOAuthRoutes(app, {
    oauth: () => deps.mcp.oauth,
    clientIpHeader: deps.clientIpHeader,
  })

  // Open SSE streams would keep app.close() waiting forever.
  app.addHook('preClose', async () => {
    if (typeof deps.mcp.shutdown === 'function') await deps.mcp.shutdown()
  })
}
