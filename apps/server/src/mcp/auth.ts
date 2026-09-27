/**
 * mcp/auth.ts — who may talk to /mcp, and the rate-limit key of each caller.
 *
 * Two credentials, both `Authorization: Bearer …`, never a cookie:
 *   - a personal access token with the `mcp` scope (Claude Code) — checked by
 *     the shared `requireTokenScope('mcp')` (auth/fastifyAuth.ts);
 *   - an MCP OAuth access token (`nmo_…`, claude.ai connectors) — checked
 *     here against the OAuth service. These tokens are audience-bound to the
 *     MCP resource (RFC 8707), so they are accepted on /mcp only: the shared
 *     identity resolver (REST routes, tus, WebSocket) deliberately does not
 *     know them.
 * BYPASS_AUTH's dev-user is admitted by requireTokenScope (dev only).
 *
 * Failures answer 401 (or 403 for a PAT without `mcp`) with a Bearer
 * challenge naming the protected-resource metadata and the scope, which is
 * how an MCP client discovers the OAuth flow (MCP authorization spec,
 * "Protected Resource Metadata Discovery"). The PAT path's challenge is
 * completed by `addResourceMetadataToChallenge` (an onSend hook) rather than
 * by changing the shared pre-handler.
 */

import type { IncomingMessage } from 'node:http'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { credentialKeyForToken } from '../auth/agentSessions.js'
import { requireTokenScope } from '../auth/fastifyAuth.js'
import type { BearerCache } from '../http/bearerCache.js'
import { rateLimitKey } from '../http/rateLimit.js'
import type { McpPublicConfig } from './config.js'
import {
  looksLikeMcpAccessToken,
  MCP_SCOPE,
  type McpOAuthService,
  type VerifiedMcpToken,
} from './oauth/service.js'

export interface McpAuthDeps {
  config: McpPublicConfig
  /** Null when OAuth is not wired (tests of the PAT path). */
  oauth: McpOAuthService | null
  /** Header carrying the real client IP behind the proxy (see http/rateLimit.ts). */
  clientIpHeader?: string | undefined
  /**
   * Recently failed / admitted bearers (http/bearerCache.ts), shared with the
   * rate limiter's pre-limit. An OAuth access token that failed verification
   * within the negative TTL is refused without asking the OAuth service (no
   * database lookup), and every verification outcome is recorded. Optional:
   * without it every token is verified.
   */
  bearers?: BearerCache | undefined
}

function bearerValue(req: IncomingMessage): string | null {
  const header = req.headers['authorization']
  const value = Array.isArray(header) ? header[0] : header
  const match = value ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value) : null
  return match?.[1] ?? null
}

const memo = new WeakMap<IncomingMessage, Promise<VerifiedMcpToken | null>>()

/**
 * The request's OAuth access token, verified once per request (rate limiter +
 * pre-handler). A token in the negative cache is refused without a lookup; a
 * verification that answers "no" is recorded there, one that throws (database
 * down) is not.
 */
function verifiedOAuthToken(
  req: IncomingMessage,
  oauth: McpOAuthService | null,
  bearers: BearerCache | undefined,
): Promise<VerifiedMcpToken | null> | null {
  const raw = bearerValue(req)
  if (!looksLikeMcpAccessToken(raw)) return null
  let pending = memo.get(req)
  if (pending === undefined) {
    if (oauth === null || bearers?.isKnownInvalid(raw) === true) {
      pending = Promise.resolve(null)
    } else {
      pending = oauth.verifyAccessToken(raw).then((verified) => {
        if (verified === null) bearers?.recordInvalid(raw)
        else bearers?.recordValid(raw)
        return verified
      })
    }
    memo.set(req, pending)
    pending.catch(() => memo.delete(req))
  }
  return pending
}

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, '')}"`
}

export function mcpChallenge(config: McpPublicConfig, extra: Record<string, string> = {}): string {
  const params = {
    realm: 'narrative',
    ...extra,
    resource_metadata: config.resourceMetadataUrl,
    scope: MCP_SCOPE,
  }
  return `Bearer ${Object.entries(params)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(', ')}`
}

/** The /mcp pre-handler. On success `req.user` and `req.auth` are set. */
export function mcpAuthPreHandler(
  deps: McpAuthDeps,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const patOrDev = requireTokenScope('mcp')
  return async (req, reply) => {
    const oauthToken = verifiedOAuthToken(req.raw, deps.oauth, deps.bearers)
    if (oauthToken === null) return patOrDev(req, reply)
    const verified = await oauthToken
    if (verified === null) {
      await reply
        .status(401)
        .header(
          'www-authenticate',
          mcpChallenge(deps.config, {
            error: 'invalid_token',
            error_description: 'The access token is invalid, expired or revoked',
          }),
        )
        .send({ error: 'invalid_token' })
      return
    }
    req.user = {
      sub: verified.userSub,
      ...(verified.email ? { email: verified.email } : {}),
      ...(verified.name ? { name: verified.name } : {}),
    }
    req.auth = {
      kind: 'token',
      scopes: ['mcp'],
      tokenId: `oauth:${verified.grantId}`,
      sessionKey: null,
      bypass: false,
    }
  }
}

/**
 * onSend hook for /mcp: make every Bearer challenge (also the ones the
 * shared PAT pre-handler writes) name the resource metadata and scope.
 */
export function addResourceMetadataToChallenge(config: McpPublicConfig) {
  return async (_req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    const challenge = reply.getHeader('www-authenticate')
    if (
      typeof challenge === 'string' &&
      /^Bearer\b/i.test(challenge) &&
      !/resource_metadata=/.test(challenge)
    ) {
      const params = challenge.replace(/^Bearer\s*/i, '').trim()
      const withMetadata = [
        params,
        `resource_metadata=${quote(config.resourceMetadataUrl)}`,
        /\bscope=/.test(params) ? '' : `scope=${quote(MCP_SCOPE)}`,
      ]
        .filter((p) => p !== '')
        .join(', ')
      reply.header('www-authenticate', `Bearer ${withMetadata}`)
    }
    return payload
  }
}

/**
 * Rate-limit key for /mcp: each OAuth grant its own bucket (claude.ai calls
 * from shared Anthropic addresses, so an IP key would lump every user
 * together); everything else keyed exactly as the global limiter keys it. A
 * token that failed verification recently costs no lookup here either (the
 * negative cache in `verifiedOAuthToken`) and falls back to the IP key.
 */
export function mcpRateLimitKey(deps: McpAuthDeps) {
  return async (req: FastifyRequest): Promise<string> => {
    try {
      const pending = verifiedOAuthToken(req.raw, deps.oauth, deps.bearers)
      const verified = pending === null ? null : await pending
      if (verified !== null) return `oauth:${verified.grantId}`
    } catch {
      // fall through to the shared key (IP for an unverifiable credential)
    }
    return rateLimitKey(req, { clientIpHeader: deps.clientIpHeader })
  }
}

/**
 * A stable key for the credential a request used (sessions are bound to it):
 * `token:<patId>`, `token:oauth:<grantId>` (auth/agentSessions.ts), or
 * `session:<sub>` for BYPASS_AUTH's dev-user.
 */
export function credentialKey(req: FastifyRequest): string | null {
  const auth = req.auth
  const user = req.user
  if (auth === undefined || user === undefined) return null
  if (auth.kind === 'token' && auth.tokenId !== null) return credentialKeyForToken(auth.tokenId)
  return `session:${user.sub}`
}
