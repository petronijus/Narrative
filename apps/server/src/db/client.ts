/**
 * db/client.ts
 *
 * Drizzle ORM klient nad pg Pool.
 * Exportuje `db` pro použití v celé server aplikaci.
 * Connection string pochází z env proměnné POSTGRES_URL.
 */

import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'

const { Pool } = pg

function getPostgresUrl(): string {
  const url = process.env['POSTGRES_URL']
  if (!url) {
    throw new Error(
      'POSTGRES_URL environment variable is required. ' +
        'Example: postgres://narrative:password@localhost:5432/narrative',
    )
  }
  return url
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Bounded pool. Without an explicit `max`, node-postgres defaults to 10 and
// nothing caps connection acquisition — under load, requests queue on the
// pg client instead of failing fast, and several unbounded pools (this one,
// shared by the Fastify API + Hocuspocus persistence, plus the video-worker's
// own pool) can collectively exceed Postgres `max_connections`. Size these so
// `PG_POOL_MAX` (here) + the worker's pool stay under the server's limit.
export const pool = new Pool({
  connectionString: getPostgresUrl(),
  max: intEnv('PG_POOL_MAX', 10),
  idleTimeoutMillis: intEnv('PG_POOL_IDLE_MS', 30_000),
  connectionTimeoutMillis: intEnv('PG_POOL_CONN_TIMEOUT_MS', 5_000),
})

export const db = drizzle(pool, { schema })

export type Database = typeof db
