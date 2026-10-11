/**
 * http/rateLimit.ts
 *
 * Request rate limits (@fastify/rate-limit), agentic layer A1 (ADR 0011).
 *
 * Buckets are per IDENTITY, not per IP, whenever the request carries a
 * credential that verifies:
 *   - `pat:<tokenId>`   a personal access token (each token its own bucket,
 *                       so one runaway agent cannot starve its owner's
 *                       browser or their other tokens);
 *   - `user:<sub>`      a browser session;
 *   - `dev:<sub>`       BYPASS_AUTH's synthetic identities (dev only,
 *                       auth/devIdentity.ts), with a budget of their own:
 *                       the e2e suite runs as one identity in several
 *                       parallel browsers, far above what one person does;
 *   - `render:<sub>`    the render worker's page (a valid render token in
 *                       `?share_token=`, auth/renderTokens.ts): each render
 *                       counts against the person who asked for it, not
 *                       against the one address every render arrives from;
 *   - `ip:<address>`    everything else — anonymous requests, share-link
 *                       viewers, and requests whose credential did NOT verify.
 *                       Falling back to the IP for a bad credential matters:
 *                       keying on the presented value would hand every random
 *                       token in a spray its own fresh bucket.
 * The identity comes from auth/identity.ts and is memoised per request, so
 * the route's own `authPreHandler` reuses the lookup made here.
 *
 * Pre-limit, before identity (IP_PRE_LIMIT, 3000 / minute per bucket)
 * ------------------------------------------------------------------
 * The bucket key above costs a credential lookup (a database query for a
 * session or a token) before the request is counted, so a flood of requests
 * with random cookies or tokens would still reach the database at full
 * speed. An `onRequest` hook therefore counts every request in memory FIRST
 * (http/fixedWindowLimiter.ts) and answers 429 without any lookup once its
 * bucket exceeds IP_PRE_LIMIT. The number sits well above the identified
 * per-caller limit so a few colleagues behind one office NAT never meet it
 * in normal use; it bounds floods, not people.
 *
 * Shared egress: the pre-limit bucket of an agent token is the TOKEN
 * ------------------------------------------------------------------
 * Keying the pre-limit on the client IP alone breaks for clients that share
 * their egress: every claude.ai user reaches /api/mcp from Anthropic's range
 * (160.79.104.0/21), so they would all share one IP budget, and junk traffic
 * from that range could exhaust it for everyone. So the hook keys a request
 * that carries a WELL-FORMED agent bearer (`Authorization: Bearer nmo_…` —
 * an MCP OAuth access token — or `nrt_…`, a personal access token; exact
 * shapes in http/bearerCache.ts) on a SHA-256 of that token, `tok:<hash>`,
 * with the same budget. Pure memory, still no lookup. Two defences keep
 * that from becoming a way around the limit:
 *   - Negative cache. A bearer whose verification FAILED within the last
 *     minute (http/bearerCache.ts; recorded by the credential resolvers,
 *     auth/identity.ts and mcp/auth.ts, which then refuse it without a
 *     lookup) is keyed on the IP again: repeating a junk token earns no
 *     private budget and costs no database work.
 *   - New-bearer limit (NEW_BEARER_PRE_LIMIT, 300 / minute per client IP).
 *     A well-formed bearer the pre-limit has not admitted within the last
 *     10 minutes is a NEW bearer: minting random values is free, and each
 *     costs one lookup. New bearers are counted per client IP before they
 *     get a token bucket; over the limit the request is refused (429) before
 *     any lookup. Admitted and successfully verified tokens stay "seen"
 *     (sliding), so a working client never meets this limit again.
 * Net effect: a valid user behind shared egress is throttled only by their
 * own token's budget, never by other users' traffic from the same range,
 * and a spray of fresh tokens costs at most NEW_BEARER_PRE_LIMIT lookups per
 * minute per address. Everything else — cookies, anonymous requests,
 * malformed or known-bad bearers — keeps the per-IP bucket.
 *
 * Limits (fixed one-minute / one-hour windows, in-process store — the API
 * runs as a single instance; a second instance would need the Redis store):
 *   - global, identified caller ...... 1200 / minute   (GLOBAL_RATE_LIMIT)
 *   - global, BYPASS_AUTH identity .. 12 000 / minute   (dev only; a bound for
 *       runaway loops, not a shape for a suite of parallel browsers)
 *   - global, anonymous (per IP) ....... 600 / minute
 *   - share by email (decks, folders) .... 60 / hour     (INVITE_RATE_LIMIT)
 *   - POST /access-tokens ................ 10 / hour     (TOKEN_CREATE_RATE_LIMIT;
 *       none under BYPASS_AUTH, tokenCreateRouteConfig)
 *   - agent endpoints ................... 240 / minute   (AGENT_RATE_LIMIT) —
 *       /api/commands and /api/mcp, mounted by the agent host; they opt in
 *       with `config: agentRouteRateLimit`.
 *   - per client IP / agent token, before identity .... 3000 / minute (IP_PRE_LIMIT)
 *   - new agent bearers per client IP, before identity .. 300 / minute (NEW_BEARER_PRE_LIMIT)
 *   - /health and /metrics are exempt (Docker healthcheck, Prometheus).
 * The global numbers sit far above what the editor does (opening a large
 * deck signs one media URL per asset; tus uploads stream 5 MB chunks) and
 * exist to stop floods, not to shape normal use.
 *
 * Client IP and `trustProxy`
 * --------------------------
 * Production is Cloudflare edge → cloudflared → Caddy → Fastify. Fastify's
 * `trustProxy` stays OFF, deliberately:
 *   - Caddy (≥ 2.5) replaces an untrusted incoming `X-Forwarded-For` with
 *     the address of its own peer, which is cloudflared. Trusting the proxy
 *     chain would make `req.ip` cloudflared's address for every visitor —
 *     one shared bucket — unless Caddy were also told to trust cloudflared.
 *   - `trustProxy` also rewires `req.ip` for the /metrics loopback gate
 *     (metrics/index.ts): a client could then claim `X-Forwarded-For:
 *     127.0.0.1` wherever the chain is not exactly as configured.
 * Instead the rate limiter alone reads the client address from the header
 * named by `CLIENT_IP_HEADER` (production: `cf-connecting-ip`, which the
 * Cloudflare edge sets on every request and overwrites if a client sent
 * one). Unset (dev, tests) → the socket address. Only anonymous buckets
 * and the IP-keyed pre-limit depend on it; identified callers and
 * token-keyed pre-limit buckets never do. A host that
 * reaches Caddy directly (the shared-tunnel overlay publishes Caddy's port
 * 80 on the LAN) cannot pick its bucket by sending the header itself: Caddy
 * replaces `CF-Connecting-IP` with the peer address unless the request comes
 * from the cloudflared address range (infra/caddy/Caddyfile, docs/deploy.md).
 */

import { createHash } from 'node:crypto'
import { isRenderToken, resolveRenderToken, type RenderTokenGrant } from '../auth/renderTokens.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import rateLimit, { normalizeIP, type RateLimitOptions } from '@fastify/rate-limit'
import { getAuthOpts, getIdentityDeps } from '../auth/fastifyAuth.js'
import { resolveRequestIdentity } from '../auth/identity.js'
import { agentBearer, bearerFromHeader, type BearerCache } from './bearerCache.js'
import { clientIpFromHeaders } from './clientIp.js'
import {
  createFixedWindowLimiter,
  type FixedWindowLimiter,
  type LimiterDecision,
} from './fixedWindowLimiter.js'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

export const GLOBAL_RATE_LIMIT = {
  /** Requests per window for a caller with a verified session or token. */
  identifiedMax: 1200,
  /** Requests per window per client IP for everyone else. */
  anonymousMax: 600,
  /** Requests per window for a BYPASS_AUTH identity (dev only: parallel e2e browsers share one). */
  devMax: 12_000,
  timeWindowMs: MINUTE_MS,
} as const

/**
 * Sharing by email (per user): POST /decks/:id/permissions and POST
 * /folders/:id/members — each can send an invitation email, so a loop must
 * not turn Narrative's sender into a spam relay (security review M2,
 * 2026-10-04; a repeated invitation to one address is not emailed again,
 * auth/invites.ts). Agents share through commands, each confirmed by the
 * user.
 */
export const INVITE_RATE_LIMIT = { max: 60, timeWindowMs: HOUR_MS } as const

/** Creating personal access tokens (per user). */
export const TOKEN_CREATE_RATE_LIMIT = { max: 10, timeWindowMs: HOUR_MS } as const

/** The agent endpoints: /api/commands and /api/mcp (per token). */
export const AGENT_RATE_LIMIT = { max: 240, timeWindowMs: MINUTE_MS } as const

/**
 * Requests per client IP per window, counted before any credential lookup.
 * See the header comment for why it exists and why it is this high.
 */
export const IP_PRE_LIMIT = { max: 3000, timeWindowMs: MINUTE_MS } as const

/**
 * Distinct, not-yet-seen agent bearers per client IP per window, counted
 * before any credential lookup (see "Shared egress" in the header comment).
 */
export const NEW_BEARER_PRE_LIMIT = { max: 300, timeWindowMs: MINUTE_MS } as const

/** Routes the limiter never counts. */
export const RATE_LIMIT_EXEMPT_ROUTES: readonly string[] = ['/health', '/metrics']

/**
 * Route `config` for the agent endpoints. Usage (agent host):
 *   app.post(<commands route>, { config: agentRouteRateLimit, preHandler: [requireTokenScope('api')] }, …)
 *   app.route({ url: <mcp route>, config: agentRouteRateLimit, preHandler: [requireTokenScope('mcp')], … })
 * Mind the proxy prefix: Caddy strips `/api`, so a route registered as
 * `/commands` is public at `/api/commands`, while one registered as
 * `/api/commands` is public at `/api/api/commands` (the media-route quirk).
 */
export const agentRouteRateLimit: { rateLimit: RateLimitOptions } = {
  rateLimit: { max: AGENT_RATE_LIMIT.max, timeWindow: AGENT_RATE_LIMIT.timeWindowMs },
}

/**
 * Folder token writes per caller: a change re-styles every deck of the
 * folder (services/tokens.ts queues and merges them per folder, this bounds
 * how many a script can queue). The page sends at most one request in
 * flight per token (state/folderTokenWriter.ts).
 */
export const TOKEN_WRITE_RATE_LIMIT = { max: 120, timeWindowMs: MINUTE_MS } as const

/** Route `config` for POST / PATCH / DELETE /folders/:folderId/tokens/…. */
export const tokenWriteRouteRateLimit: { rateLimit: RateLimitOptions } = {
  rateLimit: { max: TOKEN_WRITE_RATE_LIMIT.max, timeWindow: TOKEN_WRITE_RATE_LIMIT.timeWindowMs },
}

/** Route `config` for the share-by-email routes (INVITE_RATE_LIMIT). */
export const inviteRouteRateLimit: { rateLimit: RateLimitOptions } = {
  rateLimit: { max: INVITE_RATE_LIMIT.max, timeWindow: INVITE_RATE_LIMIT.timeWindowMs },
}

/** Route `config` for POST /access-tokens. */
export const tokenCreateRouteRateLimit: { rateLimit: RateLimitOptions } = {
  rateLimit: { max: TOKEN_CREATE_RATE_LIMIT.max, timeWindow: TOKEN_CREATE_RATE_LIMIT.timeWindowMs },
}

/**
 * The route `config` POST /access-tokens registers with:
 * TOKEN_CREATE_RATE_LIMIT, except under BYPASS_AUTH. The limit keeps a
 * stolen session from minting tokens for a real account. BYPASS_AUTH's
 * `dev-user` is synthetic and never runs in production (the boot guard,
 * auth/fastifyAuth.ts `assertAuthBootSafety`); it is the one identity every
 * e2e spec and every run of the suite shares, so 10 an hour failed the
 * suite's token specs from its sixth run within an hour on.
 */
export function tokenCreateRouteConfig(bypass: boolean): {
  rateLimit: RateLimitOptions | false
} {
  return bypass ? { rateLimit: false } : tokenCreateRouteRateLimit
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface RateLimitSettings {
  /**
   * Lower-case name of a header carrying the real client IP, set by a proxy
   * that overwrites any client-supplied value (production:
   * `cf-connecting-ip`). Unset → the socket address.
   */
  clientIpHeader?: string | undefined
  /** Override the per-IP pre-limit (tests); `false` disables it. */
  ipPreLimit?: { max: number; timeWindowMs: number } | false
  /** Override the new-bearer pre-limit (tests). */
  newBearerPreLimit?: { max: number; timeWindowMs: number }
  /**
   * The bearer cache the pre-limit consults. Default: the auth plugin's
   * (`registerAuthPlugin`), so the credential resolvers that record
   * verification outcomes and the pre-limit share one instance.
   */
  bearers?: BearerCache
}

/** The client address used for anonymous buckets. */
export function clientIp(req: FastifyRequest, clientIpHeader?: string): string {
  return clientIpFromHeaders(req.headers, req.ip, clientIpHeader)
}

/**
 * The bucket key for a request: `pat:<id>`, `user:<sub>` or `ip:<addr>`.
 * Never throws — an identity lookup failure (database down) degrades to the
 * IP bucket, and the route's own auth reports the failure.
 */
export async function rateLimitKey(
  req: FastifyRequest,
  settings: RateLimitSettings = {},
): Promise<string> {
  try {
    const result = await resolveRequestIdentity(req.raw, getIdentityDeps(req.server))
    if (result.status === 'ok') {
      const { user, auth } = result.identity
      if (auth.kind === 'token' && auth.tokenId) return `pat:${auth.tokenId}`
      if (auth.bypass) return `dev:${user.sub}`
      return `user:${user.sub}`
    }
  } catch {
    // fall through to the IP bucket
  }
  const render = renderTokenOf(req)
  if (render !== null) {
    // The server's background renders as an owner have a budget of their own.
    const lane = render.grant.lane === 'background' ? 'bg:' : ''
    return `render:${lane}${render.grant.requestedBy}`
  }
  return `ip:${normalizeIP(clientIp(req, settings.clientIpHeader))}`
}

/**
 * A valid render token in the request's `?share_token=` — an in-memory
 * lookup, no database: the render worker's page, whose every request arrives
 * from the worker's one address. Null for anything else.
 */
export function renderTokenOf(req: FastifyRequest): {
  hash: string
  grant: RenderTokenGrant
} | null {
  const token = (req.query as Record<string, unknown> | undefined)?.['share_token']
  if (typeof token !== 'string' || !isRenderToken(token)) return null
  const grant = resolveRenderToken(token)
  if (grant === null) return null
  return { hash: createHash('sha256').update(token).digest('hex'), grant }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function rateLimitPluginOptions(settings: RateLimitSettings = {}) {
  return {
    global: true,
    timeWindow: GLOBAL_RATE_LIMIT.timeWindowMs,
    max: (_req: FastifyRequest, key: string): number =>
      key.startsWith('ip:')
        ? GLOBAL_RATE_LIMIT.anonymousMax
        : key.startsWith('dev:')
          ? GLOBAL_RATE_LIMIT.devMax
          : GLOBAL_RATE_LIMIT.identifiedMax,
    keyGenerator: (req: FastifyRequest) => rateLimitKey(req, settings),
    allowList: (req: FastifyRequest): boolean =>
      RATE_LIMIT_EXEMPT_ROUTES.includes(req.routeOptions.url ?? ''),
  }
}

/** What the pre-limit needs: the request bucket limiter, and optionally the bearer handling. */
export interface PreLimitParts {
  /** Requests per bucket (`ip:<addr>` or `tok:<hash>`). */
  limiter: FixedWindowLimiter
  /**
   * With both set, well-formed agent bearers get a token bucket (see
   * "Shared egress" in the header comment); without them every request is
   * keyed on its IP.
   */
  bearers?: BearerCache
  /** Distinct new bearers per client IP. */
  newBearers?: FixedWindowLimiter
}

/**
 * The pre-limit bucket of a request: `tok:<sha256>` for a well-formed agent
 * bearer that is not in the negative cache (counting it against the
 * new-bearer limit first when it has not been seen recently), else
 * `ip:<addr>`. Null when the new-bearer limit refuses the request; the
 * decision is returned so the caller can answer 429 with its retry time.
 */
function preLimitBucket(
  req: FastifyRequest,
  parts: PreLimitParts,
  settings: RateLimitSettings,
): { bucket: string } | { refused: LimiterDecision } {
  // The render worker's page: a bucket per render, not the worker's address.
  const render = renderTokenOf(req)
  if (render !== null) return { bucket: `render:${render.hash}` }
  const ip = `ip:${normalizeIP(clientIpFromHeaders(req.headers, req.ip, settings.clientIpHeader))}`
  const { bearers, newBearers } = parts
  if (bearers === undefined || newBearers === undefined) return { bucket: ip }
  const bearer = agentBearer(bearerFromHeader(req.headers['authorization']))
  if (bearer === null || bearers.isKnownInvalidHash(bearer.hash)) return { bucket: ip }
  if (!bearers.hasSeenHash(bearer.hash)) {
    const decision = newBearers.hit(ip)
    if (!decision.allowed) return { refused: decision }
    bearers.markSeenHash(bearer.hash)
  }
  return { bucket: `tok:${bearer.hash}` }
}

async function tooManyRequests(reply: FastifyReply, decision: LimiterDecision): Promise<void> {
  const retryAfterS = Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
  await reply
    .status(429)
    .header('retry-after', String(retryAfterS))
    .send({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded, retry in ${retryAfterS} seconds`,
    })
}

/**
 * The `onRequest` hook enforcing the pre-limit. Pure in-memory work: it must
 * never touch the database, that is its whole point. Pass a bare limiter for
 * a plain per-IP pre-limit (the original behaviour), or `PreLimitParts` with
 * a bearer cache and a new-bearer limiter for token-keyed buckets.
 */
export function createIpPreLimitHook(
  limiterOrParts: FixedWindowLimiter | PreLimitParts,
  settings: RateLimitSettings = {},
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const parts: PreLimitParts =
    'hit' in limiterOrParts ? { limiter: limiterOrParts } : limiterOrParts
  return async function ipPreLimit(req, reply) {
    if (RATE_LIMIT_EXEMPT_ROUTES.includes(req.routeOptions.url ?? '')) return
    const bucket = preLimitBucket(req, parts, settings)
    if ('refused' in bucket) {
      await tooManyRequests(reply, bucket.refused)
      return
    }
    const decision = parts.limiter.hit(bucket.bucket)
    if (decision.allowed) return
    await tooManyRequests(reply, decision)
  }
}

/**
 * Register the limiter. Must run after `registerAuthPlugin` (the key reads
 * the identity) and BEFORE any route is registered (the plugin attaches its
 * hook to routes as they are added). The per-IP pre-limit is a root
 * `onRequest` hook, so it runs before the plugin's per-route hook and
 * therefore before any identity lookup. It uses the auth plugin's bearer
 * cache (unless `settings.bearers` overrides it), the same instance the
 * credential resolvers record verification outcomes in.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  settings: RateLimitSettings = {},
): Promise<void> {
  const pre = settings.ipPreLimit === undefined ? IP_PRE_LIMIT : settings.ipPreLimit
  if (pre !== false) {
    const limiter = createFixedWindowLimiter({ max: pre.max, windowMs: pre.timeWindowMs })
    const fresh = settings.newBearerPreLimit ?? NEW_BEARER_PRE_LIMIT
    const newBearers = createFixedWindowLimiter({ max: fresh.max, windowMs: fresh.timeWindowMs })
    const bearers = settings.bearers ?? getAuthOpts(app).bearers
    app.addHook('onRequest', createIpPreLimitHook({ limiter, bearers, newBearers }, settings))
  }
  await app.register(rateLimit, rateLimitPluginOptions(settings))
}
