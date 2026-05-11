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
import cors from '@fastify/cors'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { fileURLToPath } from 'url'
import path from 'path'
import { db, pool } from './db/client.js'
import { createHocuspocusServer } from './hocuspocus/index.js'
import { registerDeckRoutes } from './routes/decks.js'
import { registerFolderRoutes } from './routes/folders.js'
import { registerComponentRoutes } from './routes/components.js'
import { registerTokenUsageRoutes } from './routes/tokenUsages.js'
import { registerSharingRoutes } from './routes/sharing.js'
import { registerAuthProxyRoutes } from './routes/authProxy.js'
import { registerTusPlugin } from './media/tus.js'
import { registerMediaRoutes } from './media/routes.js'
import { closeQueueConnection } from './media/enqueue.js'
import { registerMetricsEndpoint } from './metrics/index.js'
import { initSentry } from './observability/sentry.js'
import { createJwtVerifier } from './auth/jwt.js'
import { registerAuthPlugin } from './auth/fastifyAuth.js'

const API_PORT = Number(process.env['API_PORT'] ?? process.env['PORT'] ?? 3001)
const HOCUSPOCUS_PORT = Number(process.env['HOCUSPOCUS_PORT'] ?? 3002)
const HOST = process.env['HOST'] ?? '0.0.0.0'
const isDev = process.env['NODE_ENV'] !== 'production'

// ---------------------------------------------------------------------------
// Auth config
// ---------------------------------------------------------------------------

const bypassAuth = process.env['BYPASS_AUTH'] === 'true'

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
      allowedEmails,
      ...(allowedDomain ? { allowedDomain } : {}),
    })

if (!bypassAuth && allowedEmails.length === 0 && !allowedDomain) {
  console.warn(
    '[server] OIDC_ALLOWED_EMAILS and OIDC_ALLOWED_DOMAIN are both empty — ' +
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

  try {
    await migrate(db, { migrationsFolder })
    console.log('[server] Dev migrations applied')
  } catch (err) {
    console.error('[server] Migration error (continuing anyway):', err)
  }
}

// ---------------------------------------------------------------------------
// Fastify HTTP API
// ---------------------------------------------------------------------------

const app = Fastify({
  logger: isDev
    ? {
        level: process.env['LOG_LEVEL'] ?? 'info',
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }
    : {
        level: process.env['LOG_LEVEL'] ?? 'info',
      },
  // Default is 1 MB. Deck-thumbnail uploads (JSON-wrapped base64 of the
  // first-slide preview) can land in the 800 KB – 2 MB range for slides
  // with image/video content; widening the global limit keeps the
  // request from being rejected before our route's per-payload check
  // (MAX_THUMBNAIL_BYTES on decoded bytes) can run.
  bodyLimit: 4 * 1024 * 1024,
})

// CORS_ORIGIN may be a single origin or a comma-separated allowlist.
// fastify/cors accepts string[] for the allowlist case.
const corsOriginEnv = (process.env['CORS_ORIGIN'] ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
await app.register(cors, {
  origin: corsOriginEnv.length === 1 ? corsOriginEnv[0]! : corsOriginEnv,
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
    'X-Narrative-Width',
    'X-Narrative-Height',
  ],
})

// Sentry — init before routes, dev-gated (silent without SENTRY_DSN)
await initSentry(app)

// Auth plugin — must be registered before routes that use authPreHandler
if (bypassAuth) {
  app.log.warn('BYPASS_AUTH=true — all requests run as dev-user. DO NOT USE IN PRODUCTION.')
}
registerAuthPlugin(app, { verifier, bypass: bypassAuth, db })

// Health endpoint
app.get('/health', async (_request, _reply) => {
  return { status: 'ok' }
})

// Prometheus metrics endpoint
// TODO(M29): add Bearer token auth or IP allowlist
await registerMetricsEndpoint(app)

// Deck routes
await registerDeckRoutes(app, db)

// Folder routes (M16 P1)
await registerFolderRoutes(app, db)

// Component routes (M16 P5)
await registerComponentRoutes(app, db)

// Token usage scanning (M16 P4)
await registerTokenUsageRoutes(app, db)

// Sharing routes (permissions + share links)
await registerSharingRoutes(app, db)

// OAuth token-exchange proxy — server-side code → tokens (keeps Google
// client_secret out of the SPA bundle). Public endpoint by design.
registerAuthProxyRoutes(app)

// Media routes: tus upload + signed URL + delete
registerTusPlugin(app, { db })
await registerMediaRoutes(app, { db })

// ---------------------------------------------------------------------------
// Hocuspocus WebSocket server
// ---------------------------------------------------------------------------

const hocuspocus = createHocuspocusServer({
  port: HOCUSPOCUS_PORT,
  db,
  verifier,
  bypass: bypassAuth,
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal: string) => {
  console.log(`[server] Received ${signal}, shutting down...`)

  try {
    await app.close()
    console.log('[server] Fastify closed')
  } catch (err) {
    console.error('[server] Error closing Fastify:', err)
  }

  try {
    await hocuspocus.destroy()
    console.log('[server] Hocuspocus closed')
  } catch (err) {
    console.error('[server] Error closing Hocuspocus:', err)
  }

  try {
    await pool.end()
    console.log('[server] Postgres pool closed')
  } catch (err) {
    console.error('[server] Error closing pg pool:', err)
  }

  try {
    await closeQueueConnection()
    console.log('[server] BullMQ queue connection closed')
  } catch (err) {
    console.error('[server] Error closing BullMQ queue connection:', err)
  }

  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// ---------------------------------------------------------------------------
// Start both servers in parallel
// ---------------------------------------------------------------------------

await Promise.all([
  app.listen({ port: API_PORT, host: HOST }).then(() => {
    console.log(`[server] Fastify API running on http://${HOST}:${API_PORT}`)
  }),
  hocuspocus.listen().then(() => {
    console.log(`[server] Hocuspocus WS running on ws://${HOST}:${HOCUSPOCUS_PORT}`)
  }),
])
