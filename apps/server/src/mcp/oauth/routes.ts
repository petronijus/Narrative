/**
 * mcp/oauth/routes.ts — the HTTP side of the MCP OAuth authorization server
 * (service.ts has the rules). Paths as Fastify registers them; Caddy strips
 * one `/api`, so `/oauth/token` is public at `https://<domain>/api/oauth/token`.
 *
 *   GET  /.well-known/oauth-protected-resource[/*]   RFC 9728 metadata of /mcp
 *   GET  /.well-known/oauth-authorization-server[/*] RFC 8414 metadata
 *        (the `/*` forms answer the path-inserted URLs clients build, e.g.
 *        /.well-known/oauth-authorization-server/api for issuer …/api —
 *        reachable at the domain root through Caddy's unstripped
 *        `/.well-known/oauth-*` route, infra/caddy/Caddyfile)
 *        Both metadata documents are built in memory: no database or network
 *        work stands between a discovery request and its answer.
 *   POST /oauth/register                  RFC 7591 dynamic client registration
 *                                         (JSON only); 404 unless
 *                                         MCP_OAUTH_DCR_ENABLED=true
 *   GET  /oauth/authorize                 validates, stores the request, → consent
 *   GET  /oauth/authorize/consent         consent page (sign-in first if needed)
 *   POST /oauth/authorize/decision        approve / deny (form)
 *   POST /oauth/token                     code → tokens, refresh
 *                                         (application/x-www-form-urlencoded);
 *                                         the caller's IP (CLIENT_IP_HEADER) and
 *                                         User-Agent fingerprint a rotation, for
 *                                         refresh replay detection (service.ts)
 *   POST /oauth/revoke                    RFC 7009 (form)
 *   GET  /oauth/connections               the signed-in user's connected clients
 *   DELETE /oauth/connections/:id         disconnect one (revokes its tokens)
 *
 * All of it is protocol plumbing, not a user capability: the route guard
 * claims these routes in AGENT_ALLOWLIST (packages/commands), like the
 * browser sign-in routes. The connection routes are session-only, like
 * access-token management: an agent must not manage credentials.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authPreHandler, resolveFastifyIdentity } from '../../auth/fastifyAuth.js'
import { clientIpFromHeaders } from '../../http/clientIp.js'
import { htmlHeaders, noStore } from '../../http/htmlHeaders.js'
import { pathWithoutLeadingSlash } from '../config.js'
import { consentPage, errorPage, signInPage } from './pages.js'
import {
  McpOAuthService,
  OAuthError,
  type ClientCredentials,
  type TokenRequestInfo,
} from './service.js'

const MINUTE_MS = 60_000
const FORM_BODY_LIMIT = 16 * 1024

/**
 * Parse an OAuth form body. Parameters must not repeat (RFC 6749 §3.1):
 * a request that sends one twice is refused rather than silently resolved.
 */
export function parseOAuthForm(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(body)) {
    if (Object.hasOwn(out, key)) {
      const err = new Error(`parameter ${key} is repeated`) as Error & { statusCode: number }
      err.statusCode = 400
      throw err
    }
    out[key] = value
  }
  return out
}

/** Per-IP limits of the anonymous OAuth endpoints (a client's servers call them, not a browser). */
export const OAUTH_RATE_LIMITS = {
  register: { max: 30, timeWindow: 60 * MINUTE_MS },
  authorize: { max: 120, timeWindow: MINUTE_MS },
  token: { max: 300, timeWindow: MINUTE_MS },
  revoke: { max: 120, timeWindow: MINUTE_MS },
} as const

function sendOAuthError(reply: FastifyReply, e: OAuthError, basicChallenge = false): FastifyReply {
  noStore(reply).status(e.status)
  if (e.status === 401 && basicChallenge)
    reply.header('www-authenticate', 'Basic realm="narrative-oauth"')
  return reply.send({ error: e.error, error_description: e.description })
}

/** Client credentials from HTTP Basic (RFC 6749 §2.3.1) or the form body. */
export function clientCredentials(
  req: FastifyRequest,
  form: Readonly<Record<string, unknown>>,
): ClientCredentials {
  const header = req.headers['authorization']
  if (typeof header === 'string' && /^Basic\s+/i.test(header)) {
    try {
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8')
      const i = decoded.indexOf(':')
      if (i > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, i)),
          clientSecret: decodeURIComponent(decoded.slice(i + 1)),
          via: 'basic',
        }
      }
    } catch {
      // fall through: malformed Basic credentials authenticate nobody
    }
    return { clientId: null, clientSecret: null, via: 'basic' }
  }
  const clientId = typeof form['client_id'] === 'string' ? form['client_id'] : null
  const secret = typeof form['client_secret'] === 'string' ? form['client_secret'] : null
  return { clientId, clientSecret: secret, via: secret === null ? null : 'post' }
}

function formOf(req: FastifyRequest): Record<string, unknown> {
  const body = req.body
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

export interface OAuthRouteDeps {
  /**
   * The OAuth service. Read when a request arrives, never at registration:
   * the route guard registers every route against stubs
   * (routes/agentParity.test.ts), like the agent host.
   */
  oauth: () => McpOAuthService
  /** Header carrying the real client IP behind the proxy (CLIENT_IP_HEADER; http/clientIp.ts). */
  clientIpHeader?: string | undefined
}

/** Who is calling the token endpoint, for the refresh replay fingerprint. */
function tokenRequestInfo(
  req: FastifyRequest,
  clientIpHeader: string | undefined,
): TokenRequestInfo {
  const ua = req.headers['user-agent']
  return {
    ip: clientIpFromHeaders(req.headers, req.ip, clientIpHeader) || null,
    userAgent: typeof ua === 'string' && ua !== '' ? ua.slice(0, 512) : null,
  }
}

export async function registerMcpOAuthRoutes(
  app: FastifyInstance,
  deps: OAuthRouteDeps,
): Promise<void> {
  // Per-request views of the configuration (cheap; see OAuthRouteDeps).
  const service = (): McpOAuthService => deps.oauth()
  const config = () => service().publicConfig
  const apiOrigin = (): string => new URL(config().apiBaseUrl).origin
  const resourcePaths = (): Set<string> =>
    new Set(['', pathWithoutLeadingSlash(config().resource), 'mcp'])
  const issuerPaths = (): Set<string> => new Set(['', pathWithoutLeadingSlash(config().issuer)])

  // Well-known metadata. The `*` param is whatever follows the well-known
  // name; only the paths that denote our resource / issuer answer.
  const resourceMetadata = async (
    req: FastifyRequest<{ Params: { '*'?: string } }>,
    reply: FastifyReply,
  ) => {
    const suffix = (req.params['*'] ?? '').replace(/^\/+|\/+$/g, '')
    if (!resourcePaths().has(suffix)) return reply.status(404).send({ error: 'not_found' })
    return reply
      .header('cache-control', 'public, max-age=300')
      .send(service().protectedResourceMetadata())
  }
  const serverMetadata = async (
    req: FastifyRequest<{ Params: { '*'?: string } }>,
    reply: FastifyReply,
  ) => {
    const suffix = (req.params['*'] ?? '').replace(/^\/+|\/+$/g, '')
    if (!issuerPaths().has(suffix)) return reply.status(404).send({ error: 'not_found' })
    return reply
      .header('cache-control', 'public, max-age=300')
      .send(service().authorizationServerMetadata())
  }
  app.get('/.well-known/oauth-protected-resource', resourceMetadata)
  app.get('/.well-known/oauth-protected-resource/*', resourceMetadata)
  app.get('/.well-known/oauth-authorization-server', serverMetadata)
  app.get('/.well-known/oauth-authorization-server/*', serverMetadata)

  // Session-only management of the user's connections (for account settings).
  app.get('/oauth/connections', { preHandler: [authPreHandler] }, async (req) => {
    const rows = await service().listConnections(req.user!.sub)
    return {
      connections: rows.map((r) => ({
        id: r.grant.id,
        clientName: r.clientName,
        redirectHosts: [...new Set(r.redirectUris.map((u) => new URL(u).host))],
        kind: r.kind,
        scopes: r.grant.scopes,
        createdAt: r.grant.createdAt.toISOString(),
        lastUsedAt: r.grant.lastUsedAt?.toISOString() ?? null,
        // A refresh token of this connection was replayed (service.ts).
        flaggedAt: r.grant.flaggedAt?.toISOString() ?? null,
        flagReason: r.grant.flagReason,
      })),
    }
  })
  app.delete<{ Params: { id: string } }>(
    '/oauth/connections/:id',
    { preHandler: [authPreHandler] },
    async (req, reply) => {
      const revoked = await service().revokeConnection(req.user!.sub, req.params.id)
      if (!revoked) return reply.status(404).send({ error: 'not_found' })
      req.log.info({ grantId: req.params.id }, 'MCP OAuth connection revoked')
      return reply.status(204).send()
    },
  )

  // Form-encoded endpoints live in their own scope with their own parser: the
  // root instance maps application/x-www-form-urlencoded to a passthrough
  // stream for tus (media/tus.ts); this scope replaces it with a real one.
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/x-www-form-urlencoded')
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT },
      (_req, body, done) => {
        try {
          done(null, parseOAuthForm(body as string))
        } catch (e) {
          done(e as Error, undefined)
        }
      },
    )
    // A body the parser refuses (repeated parameter, too large, unsupported
    // type) is answered in the OAuth error format, not Fastify's.
    scope.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
      const status = err.statusCode ?? 500
      if (status >= 500) throw err
      return noStore(reply)
        .status(status)
        .send({ error: 'invalid_request', error_description: err.message })
    })

    scope.post(
      '/oauth/register',
      { config: { rateLimit: OAUTH_RATE_LIMITS.register } },
      async (req, reply) => {
        // Off unless MCP_OAUTH_DCR_ENABLED=true; the route stays registered
        // (the route guard enumerates it) and answers as if absent.
        if (!config().dcrEnabled)
          return sendOAuthError(reply, McpOAuthService.registrationDisabled())
        // RFC 7591 §3.1: the registration request is a JSON document.
        const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
        if (type !== 'application/json') {
          return sendOAuthError(
            reply,
            new OAuthError('invalid_client_metadata', 'the registration request must be JSON'),
          )
        }
        try {
          const client = await service().registerClient(req.body)
          req.log.info(
            { clientId: client.client_id, clientName: client.client_name },
            'MCP OAuth client registered',
          )
          return noStore(reply).status(201).send(client)
        } catch (e) {
          if (e instanceof OAuthError) return sendOAuthError(reply, e)
          throw e
        }
      },
    )

    scope.get<{ Querystring: Record<string, unknown> }>(
      '/oauth/authorize',
      { config: { rateLimit: OAUTH_RATE_LIMITS.authorize } },
      async (req, reply) => {
        const v = await service().validateAuthorizationRequest(req.query)
        if (v.kind === 'error-page')
          return htmlHeaders(reply, []).status(400).send(errorPage(v.message))
        if (v.kind === 'redirect-error')
          return noStore(reply).redirect(service().errorRedirect(v), 302)
        const { id } = await service().createAuthorization(v.params)
        return noStore(reply).redirect(
          `${config().apiBaseUrl}/oauth/authorize/consent?request=${encodeURIComponent(id)}`,
          302,
        )
      },
    )

    scope.get<{ Querystring: { request?: string } }>(
      '/oauth/authorize/consent',
      { config: { rateLimit: OAUTH_RATE_LIMITS.authorize } },
      async (req, reply) => {
        const id = typeof req.query.request === 'string' ? req.query.request : ''
        const identity = await resolveFastifyIdentity(req)
        if (identity.status !== 'ok' || identity.identity.auth.kind !== 'session') {
          // Sign in through the normal Google login, then come back here. The
          // login returns to `<spaOrigin><returnTo>`, so this works when the
          // API lives under the SPA's origin (production: /api).
          const here = `${config().apiBaseUrl}/oauth/authorize/consent?request=${encodeURIComponent(id)}`
          if (here.startsWith(`${config().spaOrigin}/`)) {
            const returnTo = here.slice(config().spaOrigin.length)
            return noStore(reply).redirect(
              `${config().apiBaseUrl}/auth/start?returnTo=${encodeURIComponent(returnTo)}`,
              302,
            )
          }
          return htmlHeaders(reply, []).status(401).send(signInPage(null))
        }
        const user = identity.identity.user
        const opened = await service().openAuthorizationForUser(id, user.sub)
        if (opened === null) {
          return htmlHeaders(reply, [])
            .status(400)
            .send(
              errorPage(
                'This connection request has expired or was already answered. Start connecting again from the application.',
              ),
            )
        }
        return htmlHeaders(reply, [apiOrigin(), new URL(opened.view.redirectUri).origin]).send(
          consentPage({
            view: opened.view,
            csrfToken: opened.csrfToken,
            action: `${config().apiBaseUrl}/oauth/authorize/decision`,
            userLabel: user.email ?? user.name ?? user.sub,
          }),
        )
      },
    )

    scope.post(
      '/oauth/authorize/decision',
      { config: { rateLimit: OAUTH_RATE_LIMITS.authorize } },
      async (req, reply) => {
        // Defence in depth next to the CSRF token and the SameSite=Lax session
        // cookie: a browser form post from another origin is refused outright.
        const origin = req.headers['origin']
        // (`Origin: null` — a sandboxed or privacy-redirected form — is refused too.)
        if (typeof origin === 'string' && origin !== apiOrigin()) {
          req.log.warn(
            { origin, expected: apiOrigin() },
            'MCP OAuth consent: refused a decision posted from another origin',
          )
          return htmlHeaders(reply, [])
            .status(403)
            .send(errorPage('This request did not come from Narrative.'))
        }
        const identity = await resolveFastifyIdentity(req)
        if (identity.status !== 'ok' || identity.identity.auth.kind !== 'session') {
          return htmlHeaders(reply, []).status(401).send(signInPage(null))
        }
        const form = formOf(req)
        const decision = form['decision']
        if (decision !== 'approve' && decision !== 'deny') {
          return htmlHeaders(reply, []).status(400).send(errorPage('Choose Allow or Deny.'))
        }
        try {
          const { redirectTo } = await service().decide(
            typeof form['request'] === 'string' ? form['request'] : '',
            identity.identity.user.sub,
            typeof form['csrf'] === 'string' ? form['csrf'] : '',
            decision === 'approve',
          )
          req.log.info({ user: identity.identity.user.sub, decision }, 'MCP OAuth consent decided')
          return noStore(reply).redirect(redirectTo, 303)
        } catch (e) {
          if (e instanceof OAuthError)
            return htmlHeaders(reply, []).status(e.status).send(errorPage(e.description))
          throw e
        }
      },
    )

    scope.post(
      '/oauth/token',
      { config: { rateLimit: OAUTH_RATE_LIMITS.token } },
      async (req, reply) => {
        const form = formOf(req)
        const creds = clientCredentials(req, form)
        try {
          return noStore(reply).send(
            await service().token(form, creds, tokenRequestInfo(req, deps.clientIpHeader)),
          )
        } catch (e) {
          if (e instanceof OAuthError) return sendOAuthError(reply, e, creds.via === 'basic')
          throw e
        }
      },
    )

    scope.post(
      '/oauth/revoke',
      { config: { rateLimit: OAUTH_RATE_LIMITS.revoke } },
      async (req, reply) => {
        const form = formOf(req)
        const creds = clientCredentials(req, form)
        try {
          await service().revoke(form, creds)
          return noStore(reply).status(200).send({})
        } catch (e) {
          if (e instanceof OAuthError) return sendOAuthError(reply, e, creds.via === 'basic')
          throw e
        }
      },
    )
  })
}
