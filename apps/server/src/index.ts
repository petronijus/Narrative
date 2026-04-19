/**
 * apps/server/src/index.ts
 *
 * Entry point — startuje Fastify HTTP API + Hocuspocus WebSocket server paralelně.
 *
 * Ports:
 *   API_PORT        (default 3001) — Fastify HTTP
 *   HOCUSPOCUS_PORT (default 3002) — Hocuspocus WebSocket
 *
 * V dev: automaticky spouští Drizzle migrace při startu (pokud NODE_ENV !== 'production').
 * V prod: migrace jsou manuální krok před deployem (infra agent fáze 2).
 *
 * Graceful shutdown: SIGTERM/SIGINT → close oba servery + pg pool.
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { fileURLToPath } from 'url'
import path from 'path'
import { db, pool } from './db/client.js'
import { createHocuspocusServer } from './hocuspocus/index.js'
import { registerDeckRoutes } from './routes/decks.js'

const API_PORT = Number(process.env['API_PORT'] ?? process.env['PORT'] ?? 3001)
const HOCUSPOCUS_PORT = Number(process.env['HOCUSPOCUS_PORT'] ?? 3002)
const HOST = process.env['HOST'] ?? '0.0.0.0'
const isDev = process.env['NODE_ENV'] !== 'production'

// Migrace v dev modu
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

// Fastify HTTP API
const app = Fastify({
  logger: isDev
    ? {
        level: process.env['LOG_LEVEL'] ?? 'info',
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }
    : {
        level: process.env['LOG_LEVEL'] ?? 'info',
      },
})

await app.register(cors, {
  origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
})

// Health endpoint
app.get('/health', async (_request, _reply) => {
  return { status: 'ok' }
})

// Deck routes
await registerDeckRoutes(app, db)

// Hocuspocus WebSocket server
const hocuspocus = createHocuspocusServer({ port: HOCUSPOCUS_PORT, db })

// Graceful shutdown
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

  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Start oba servery paralelně
await Promise.all([
  app.listen({ port: API_PORT, host: HOST }).then(() => {
    console.log(`[server] Fastify API running on http://${HOST}:${API_PORT}`)
  }),
  hocuspocus.listen().then(() => {
    console.log(`[server] Hocuspocus WS running on ws://${HOST}:${HOCUSPOCUS_PORT}`)
  }),
])
