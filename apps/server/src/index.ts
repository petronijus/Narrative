/**
 * apps/server/src/index.ts
 *
 * Entry point — starts Fastify HTTP API + Hocuspocus WebSocket server in parallel.
 *
 * Ports:
 *   API_PORT        (default 3001) — Fastify HTTP
 *   HOCUSPOCUS_PORT (default 3002) — Hocuspocus WebSocket
 *
 * Auth (M10 phase 2 — Google OIDC since 2026-05):
 *   OIDC_ISSUER, OIDC_JWKS_URL, OIDC_CLIENT_ID must be set in production.
 *   OIDC_ALLOWED_EMAILS (comma-separated) and/or OIDC_ALLOWED_DOMAIN gate
 *   which Google accounts can sign in. Set at least one — without an
 *   allowlist, anyone with a Google account would gain access.
 *   BYPASS_AUTH=true skips OIDC validation and synthesizes 'dev-user' for all requests.
 *   A loud warning is logged when bypass is active. NEVER use in production.
 *
 * In dev: Drizzle migrations are applied automatically on start (NODE_ENV !== 'production').
 * In prod: migrations are a manual step before deploy.
 *
 * Graceful shutdown: SIGTERM/SIGINT → close both servers + pg pool.
 */

import Fastify from 'fastify'
import { notFoundWithRedactedUrl, serializeRequestForLog } from './http/requestLogSerializer.js'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { fileURLToPath } from 'url'
import path from 'path'
import { db, pool } from './db/client.js'
import { runMigrations } from './db/runMigrations.js'
import { runDataMigrations } from './services/dataMigrations.js'
import { checkMovedMediaAfterStore } from './services/localiseMedia.js'
import { createHocuspocusServer } from './hocuspocus/index.js'
import { createDeckThumbnailScheduler } from './services/deckThumbnails.js'
import { startOwnerSweeps } from './media/ownerSweeps.js'
import { registerHttpRoutes } from './http/registerRoutes.js'
import {
  createDrizzleUploadSessionStore,
  createUploadSessionService,
  revokeUploadSessionsForCredential,
} from './media/uploadSessions.js'
import { createAgentRuntime, parseUrlFetchAllowedHosts } from './agent/runtime.js'
import { createAgentPrincipalKeys } from './agent/presence.js'
import { agentPrincipalKeySecretFromEnv } from './agent/principalKeySecret.js'
import { closeQueueConnection } from './media/enqueue.js'
import { startVideoStillsWarming } from './media/videoStillsWarm.js'
import { closeRenderQueue, dropStaleRenderJobs } from './render/queue.js'
import { startPdfExportWorker } from './render/pdfExportQueue.js'
import { shutdownServer } from './shutdown.js'
import { createRenderService } from './services/render.js'
import { metricsRegistrationDecision } from './metrics/index.js'
import { initSentry } from './observability/sentry.js'
import { createJwtVerifier } from './auth/jwt.js'
import { parseAdminEmails } from './auth/admin.js'
import { registerAuthPlugin, assertAuthBootSafety } from './auth/fastifyAuth.js'
import { ensureDevUserAtBoot } from './auth/devIdentity.js'
import {
  createDrizzlePatStore,
  createPatOwnerPolicy,
  createPatService,
} from './auth/personalAccessTokens.js'
import { registerBodylessRequestCompat } from './http/bodylessCompat.js'
import { registerRateLimit } from './http/rateLimit.js'
import { registerSameOriginPolicy } from './http/sameOrigin.js'
import { mcpPublicConfigFromEnv } from './mcp/config.js'
import { createMcpRuntime } from './mcp/runtime.js'
import { createDrizzleOAuthStore } from './mcp/oauth/store.js'
import { readServerVersion } from './mcp/version.js'

const API_PORT = Number(process.env['API_PORT'] ?? process.env['PORT'] ?? 3001)
const HOCUSPOCUS_PORT = Number(process.env['HOCUSPOCUS_PORT'] ?? 3002)
const HOST = process.env['HOST'] ?? '0.0.0.0'
const nodeEnv = process.env['NODE_ENV']
const isProd = nodeEnv === 'production'
const isDev = !isProd

// ---------------------------------------------------------------------------
// Auth config
// ---------------------------------------------------------------------------

const bypassAuth = process.env['BYPASS_AUTH'] === 'true'

// Boot-time safety guard. Throws (refuses to start) if BYPASS_AUTH leaks into
// a production deploy — that would grant unauthenticated full access to every
// request. Also tells us when NODE_ENV is unset so we can warn loudly that
// dev-mode auth fallbacks are silently active.
const { nodeEnvUnset } = assertAuthBootSafety({ bypassAuth, nodeEnv })
if (nodeEnvUnset) {
  console.warn(
    '[server] NODE_ENV is not set — running in DEV mode (dev-mode auth ' +
      'fallbacks active). Set NODE_ENV=production for production deployments.',
  )
}

const allowedEmails = (process.env['OIDC_ALLOWED_EMAILS'] ?? '')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean)
const allowedDomain = process.env['OIDC_ALLOWED_DOMAIN']?.trim() || undefined

const verifier = bypassAuth
  ? null
  : createJwtVerifier({
      issuer: process.env['OIDC_ISSUER']!,
      jwksUrl: process.env['OIDC_JWKS_URL']!,
      audience: process.env['OIDC_CLIENT_ID']!,
    })

// Allowlist config — applied in /auth/callback alongside the DB-based
// implicit-allowlist check (pending invite or existing permission).
const adminEmails = parseAdminEmails(process.env['ADMIN_EMAILS'])
const allowlistConfig = { allowedEmails, allowedDomain, adminEmails }

if (!bypassAuth && allowedEmails.length === 0 && !allowedDomain && adminEmails.length === 0) {
  // Every Google account could sign in, and the admins' allowed list would
  // gate nothing (docs/adr/0014). Production needs an explicit opt-in.
  if (isProd && process.env['OIDC_ALLOW_ANY_ACCOUNT'] !== 'true') {
    throw new Error(
      '[server] OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_DOMAIN and ADMIN_EMAILS are all empty: any ' +
        'Google account could sign in. Set one of them, or OIDC_ALLOW_ANY_ACCOUNT=true.',
    )
  }
  console.warn(
    '[server] OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_DOMAIN and ADMIN_EMAILS are all empty — ' +
      'ANY Google account will be allowed to sign in. Set one of them in production.',
  )
}

// ---------------------------------------------------------------------------
// Dev migrations
// ---------------------------------------------------------------------------

if (isDev) {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const migrationsFolder = path.resolve(__dirname, '../drizzle')

  // The production migrator (db/runMigrations.ts): drizzle's own
  // `migrate()` cannot bring a fresh database past the enum migrations.
  try {
    const report = await runMigrations(pool, migrationsFolder, (line) =>
      console.log(`[server] migration: ${line}`),
    )
    console.log(`[server] Dev migrations applied (${report.applied.length} new)`)
  } catch (err) {
    console.error('[server] Migration error (continuing anyway):', err)
  }
}

// ---------------------------------------------------------------------------
// Fastify HTTP API
// ---------------------------------------------------------------------------

const app = Fastify({
  // The request serializer masks credentials a URL can carry (share links,
  // render tokens): http/requestLogSerializer.ts.
  logger: isDev
    ? {
        level: process.env['LOG_LEVEL'] ?? 'info',
        transport: { target: 'pino-pretty', options: { colorize: true } },
        serializers: { req: serializeRequestForLog },
      }
    : {
        level: process.env['LOG_LEVEL'] ?? 'info',
        serializers: { req: serializeRequestForLog },
      },
  // Default is 1 MB. Deck-thumbnail uploads (JSON-wrapped base64 of the
  // first-slide preview) can land in the 800 KB – 2 MB range for slides
  // with image/video content; widening the global limit keeps the
  // request from being rejected before our route's per-payload check
  // (MAX_THUMBNAIL_BYTES on decoded bytes) can run. PPTX uploads bypass
  // this global limit two ways: tus-based uploads stream 5 MB chunks
  // (each chunk well below any limit), and the legacy synchronous
  // endpoint sets its own per-content-type bodyLimit on the addContentTypeParser
  // call — Fastify's content-type parser bodyLimit overrides the global.
  bodyLimit: 4 * 1024 * 1024,
})

// Cloudflare Tunnel re-frames bodyless POSTs (Content-Length: 0 → chunked),
// which makes Fastify demand a parser for the absent Content-Type and answer
// 415 before the route runs. Registered first so every route inherits it.
registerBodylessRequestCompat(app)

// Fastify's own 404 writes the raw URL into the log message and the reply; a
// URL can carry a share link or a render token (http/requestLogSerializer.ts).
app.setNotFoundHandler(notFoundWithRedactedUrl)

// CORS_ORIGIN may be a single origin or a comma-separated allowlist.
// fastify/cors accepts string[] for the allowlist case.
const corsOriginEnv = (process.env['CORS_ORIGIN'] ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
await app.register(cors, {
  origin: corsOriginEnv.length === 1 ? corsOriginEnv[0]! : corsOriginEnv,
  // credentials:true tells the browser to send cookies on cross-origin XHR
  // (dev: localhost:5173 → localhost:3001). In prod everything is same-origin
  // through Caddy so this is a no-op there.
  credentials: true,
  // PATCH is required by the tus protocol for upload resumption.
  // HEAD is required by tus for upload status checks.
  // PUT is used by deck-thumbnail uploads (idempotent replace).
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'],
  // Browser silently strips non-safelisted response headers from cross-origin
  // reads unless they are listed here. tus and our upload finalize flow need them.
  exposedHeaders: [
    'Location',
    'Upload-Offset',
    'Upload-Length',
    'Upload-Metadata',
    'Tus-Version',
    'Tus-Resumable',
    'Tus-Max-Size',
    'Tus-Extension',
    'X-Narrative-Asset-Id',
    'X-Narrative-Deck-Id',
    'X-Narrative-Width',
    'X-Narrative-Height',
    // The download name of an export (.pptx, slide .png) the app saves itself.
    'Content-Disposition',
  ],
})

// The origins allowed to use the session cookie on routes that opt into
// `requireSameOrigin` (http/sameOrigin.ts) — the same list CORS allows.
registerSameOriginPolicy(app, { allowedOrigins: corsOriginEnv })

// Cookie parser. The secret is used to sign the short-lived OAuth state
// cookie that carries the PKCE verifier between /auth/start and /auth/callback.
// In dev a default keeps things working; prod MUST set SESSION_COOKIE_SECRET.
const cookieSecret = process.env['SESSION_COOKIE_SECRET']
if (!cookieSecret && !isDev) {
  throw new Error('SESSION_COOKIE_SECRET must be set in production')
}
await app.register(cookie, {
  secret: cookieSecret ?? 'dev-only-do-not-deploy-this-cookie-secret',
})

// Sentry — init before routes, dev-gated (silent without SENTRY_DSN)
await initSentry()

// Auth plugin — must be registered before routes that use authPreHandler
if (bypassAuth) {
  app.log.warn('BYPASS_AUTH=true — all requests run as dev-user. DO NOT USE IN PRODUCTION.')
  // dev-user's directory row, so it can be invited like a person (auth/devIdentity.ts).
  await ensureDevUserAtBoot(db)
}
// One personal access token service for HTTP routes and tus uploads, so they
// share its `last_used_at` write throttle. (The Hocuspocus WebSocket does not
// accept tokens at all — hocuspocus/authenticate.ts.)
// Every verification re-applies the sign-in allowlist to the token's owner
// (auth/signInPolicy.ts); BYPASS_AUTH has no allowlist to apply.
const pats = createPatService(createDrizzlePatStore(db), {
  isOwnerAllowed: bypassAuth ? async () => true : createPatOwnerPolicy(db, allowlistConfig),
})
registerAuthPlugin(app, { bypass: bypassAuth, db, pats })

// Rate limits (http/rateLimit.ts): per identity, IP fallback. After the auth
// plugin (the key reads the caller's identity), before any route (the plugin
// hooks routes as they are registered). CLIENT_IP_HEADER names the header
// carrying the real client IP behind the proxy chain (prod:
// cf-connecting-ip); see http/rateLimit.ts for why trustProxy stays off.
await registerRateLimit(app, { clientIpHeader: process.env['CLIENT_IP_HEADER'] || undefined })

// Metrics: /metrics leaks connection counts / doc sizes. In production it
// MUST be gated by METRICS_TOKEN. If the token is unset/empty in prod we
// refuse to register the route at all (rather than exposing it or
// boot-failing) — the server keeps running, metrics are simply not reachable
// until a token is configured. Dev keeps the loopback-only fallback (handled
// inside the endpoint) so local scraping still works without a token.
const metricsDecision = metricsRegistrationDecision({
  nodeEnv,
  metricsToken: process.env['METRICS_TOKEN'],
})
if (!metricsDecision.register) app.log.warn(metricsDecision.reason)

// ---------------------------------------------------------------------------
// Hocuspocus WebSocket server
// ---------------------------------------------------------------------------

// Whom an agent peer works for is an HMAC keyed with AGENT_PRINCIPAL_KEY_SECRET
// (required in production; agent/principalKeySecret.ts). One instance for the
// agent presence and the WebSocket server that tells each editor its own key.
const principalKeys = createAgentPrincipalKeys(
  agentPrincipalKeySecretFromEnv(process.env, { isProd }),
)

// A deck or a component master nobody has open keeps a current card: after
// its changes are stored, the render worker draws it (services/deckThumbnails.ts).
const deckThumbnails = createDeckThumbnailScheduler({
  db,
  log: app.log,
  bypass: bypassAuth,
  hocuspocus: () => hocuspocus,
})

// The second storage sweep of deleted decks and components, due a minute
// after the grace window; kept in the database, so a restart forgets none
// (media/ownerSweeps.ts).
const ownerSweeps = startOwnerSweeps(db, app.log)

const hocuspocusServer = createHocuspocusServer({
  port: HOCUSPOCUS_PORT,
  db,
  bypass: bypassAuth,
  clientIpHeader: process.env['CLIENT_IP_HEADER'] || undefined,
  principalKeys,
  // An undo in an editor can bring back references to media of a folder the
  // deck has left: pointed at the deck's copies again after the store.
  onDeckStored: (deckId) => {
    checkMovedMediaAfterStore(
      { db, log: app.log, bypass: bypassAuth, hocuspocus: () => hocuspocus },
      deckId,
    )
    deckThumbnails.cardChanged({ kind: 'deck', id: deckId })
  },
  onComponentStored: (componentId) => {
    deckThumbnails.cardChanged({ kind: 'component', id: componentId })
  },
})
// The document engine (documents, connections, direct connections) every
// service works with; the WebSocket server around it only listens and closes.
const hocuspocus = hocuspocusServer.hocuspocus

// The web app's public origin: OAuth redirects back to it, and agents hand
// users links into it (editor.present.link).
const spaOrigin =
  process.env['SPA_ORIGIN'] ??
  (isDev ? 'http://localhost:5173' : `https://${process.env['DOMAIN'] ?? 'localhost'}`)

// ---------------------------------------------------------------------------
// Agent host (agentic A1, ADR 0011) — runs commands for MCP and the command
// API against the live Hocuspocus documents. Created before the routes that
// call it; configured (not listening) Hocuspocus is enough.
// ---------------------------------------------------------------------------

// One-time upload credentials for agents with a shell (media.uploadSession):
// issued by the agent host, accepted by the tus server, the sign-in policy
// re-applied on every use like personal access tokens.
const uploadSessions = createUploadSessionService(createDrizzleUploadSessionStore(db), {
  isOwnerAllowed: bypassAuth ? async () => true : createPatOwnerPolicy(db, allowlistConfig),
})

// The public addresses (mcp/config.ts): the MCP resource, and the API base
// upload sessions point agents at.
const mcpConfig = mcpPublicConfigFromEnv(process.env, { apiPort: API_PORT, isProd, spaOrigin })

const agent = await createAgentRuntime({
  db,
  log: app.log,
  hocuspocus,
  appOrigin: spaOrigin,
  apiBaseUrl: mcpConfig.apiBaseUrl,
  uploadSessions,
  principalKeys,
  bypass: bypassAuth,
  // Hosts agent URL downloads may reach without the user confirming the host
  // (empty by default: every download is confirmed). See docs/mcp.md.
  urlFetchAllowedHosts: parseUrlFetchAllowedHosts(process.env['AGENT_URL_FETCH_ALLOWED_HOSTS']),
})

// ---------------------------------------------------------------------------
// MCP server (agentic A1, ADR 0011): /api/mcp for Claude Code (personal access
// token) and claude.ai connectors (OAuth, Narrative as the authorization
// server). PUBLIC_API_URL is the API's public base (mcp/config.ts); it names
// the MCP resource every OAuth token is bound to. MCP_OAUTH_REDIRECT_URIS adds
// https callbacks besides claude.ai's. See docs/mcp.md.
// ---------------------------------------------------------------------------

const mcp = createMcpRuntime({
  agent,
  config: mcpConfig,
  oauthStore: createDrizzleOAuthStore(db),
  // The same sign-in policy personal access tokens re-check on every use.
  isOwnerAllowed: bypassAuth ? async () => true : createPatOwnerPolicy(db, allowlistConfig),
  // The session sweep re-checks each open session's token (mcp/sessions.ts).
  pats,
  // A revoked OAuth connection's upload sessions go with it.
  onCredentialRevoked: (key) => revokeUploadSessionsForCredential(db, key),
  version: readServerVersion(),
  log: app.log,
})
app.log.info(
  { resource: mcp.config.resource, tools: mcp.catalog.entries().length },
  'MCP server ready',
)

// Every HTTP route, in one place (http/registerRoutes.ts) so the agent-parity
// route guard enumerates exactly what production serves.
{
  const redirectUri =
    process.env['OIDC_REDIRECT_URI'] ??
    (isDev
      ? `http://localhost:${API_PORT}/auth/callback`
      : `https://${process.env['DOMAIN'] ?? 'localhost'}/api/auth/callback`)

  await registerHttpRoutes(app, {
    db,
    metrics: metricsDecision.register,
    auth: {
      verifier,
      spaOrigin,
      redirectUri,
      isProd,
      allowlist: allowlistConfig,
      clientIpHeader: process.env['CLIENT_IP_HEADER'] || undefined,
    },
    agent,
    mcp: {
      mcp,
      clientIpHeader: process.env['CLIENT_IP_HEADER'] || undefined,
      allowedOrigins: corsOriginEnv,
    },
    uploadSessions,
    devRoutes: bypassAuth,
  })
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let stopPdfExports: (() => Promise<void>) | null = null
let stopVideoStillsWarming: (() => Promise<void>) | null = null

// The order is shutdown.ts's: Hocuspocus stores its documents before anything
// that may take long (in-flight requests, a running PDF export) is waited for.
const shutdown = async (signal: string) => {
  console.log(`[server] Received ${signal}, shutting down...`)
  await shutdownServer({
    stopBackground: () => {
      deckThumbnails.stop()
      ownerSweeps.stop()
    },
    stopPdfExports: async () => stopPdfExports?.(),
    closeHttp: () => app.close(),
    // Before Hocuspocus: close open agent runs (recorded as closed) and let go
    // of the documents the agent host holds, so they store and unload cleanly.
    closeAgent: () => agent.shutdown(),
    closeHocuspocus: () => hocuspocusServer.destroy(),
    closePostgres: () => pool.end(),
    closeQueues: async () => {
      await closeQueueConnection()
      await closeRenderQueue()
      await stopVideoStillsWarming?.()
    },
    log: {
      info: (message) => console.log(`[server] ${message}`),
      error: (message, err) => console.error(`[server] ${message}`, err),
    },
  })
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Last-resort process guards. A stray unhandled rejection (e.g. a floated
// async write that rejects) or uncaught exception would otherwise—on recent
// Node defaults—terminate the API + Hocuspocus process, dropping every live
// editing connection. We log loudly via pino and keep serving; per-request
// errors are already handled by Fastify's error handler, so reaching here
// means a background task, not a request. (Mirrors the video-worker guards.)
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandledRejection')
})
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaughtException')
})

// ---------------------------------------------------------------------------
// Start both servers in parallel
// ---------------------------------------------------------------------------

await Promise.all([
  app.listen({ port: API_PORT, host: HOST }).then(() => {
    console.log(`[server] Fastify API running on http://${HOST}:${API_PORT}`)
  }),
  hocuspocusServer.listen().then(() => {
    console.log(`[server] Hocuspocus WS running on ws://${HOST}:${HOCUSPOCUS_PORT}`)
  }),
])

// One-time data migrations (services/dataMigrations.ts): in the background,
// through the running sync server, so documents people have open get them
// as ordinary edits. A failure is logged and retried on the next start.
void runDataMigrations({ db, log: app.log, hocuspocus: () => hocuspocus }).catch((err: unknown) => {
  app.log.error({ err }, 'data migrations could not run')
})

// Render jobs a previous server process left waiting carry render tokens that
// lived in its memory: a page opened with one would only be refused. Drop
// them (render/queue.ts); their callers were that process's requests. Only
// jobs queued before this process started: this one already takes requests.
void dropStaleRenderJobs(Date.now() - process.uptime() * 1000).then(
  (dropped) => {
    if (dropped > 0) app.log.info({ dropped }, 'render: dropped jobs left by the previous process')
  },
  (err: unknown) => app.log.warn({ err }, 'render: could not check the render queue at start'),
)

// A new video's poster and thumbnail encoded by imgproxy as soon as the
// video worker stored them (media/videoStillsWarm.ts; off without
// IMGPROXY_WARM_ENDPOINT).
stopVideoStillsWarming = startVideoStillsWarming(db)

// Deck PDFs are jobs (render/pdfExportQueue.ts): this process runs them, as
// it is the one that queues their slide renders and holds their render
// sessions. Started once the server takes requests.
stopPdfExports = startPdfExportWorker((data, progress) =>
  createRenderService({
    db,
    log: app.log,
    bypass: bypassAuth,
    hocuspocus: () => hocuspocus,
  }).runPdfExport(data, progress),
)
