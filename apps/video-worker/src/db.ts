/**
 * db.ts — Drizzle DB client factory for video-worker.
 *
 * The Drizzle client (and its underlying `pg.Pool`) is created lazily on the
 * first `createDb()` call and cached for the process lifetime. Previously
 * every job processor and every `failed` event handler called `createDb()`,
 * each of which spun up a fresh Pool that was never closed — over time the
 * worker exhausted Postgres connection slots ("too many connections") on
 * any non-trivial job throughput.
 *
 * `closeDb()` ends the pool cleanly during graceful shutdown.
 *
 * POSTGRES_URL must be set in the environment (same value as apps/server).
 */

import pg from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'

const { Pool } = pg

export type Database = NodePgDatabase<typeof schema>

let cached: { db: Database; pool: pg.Pool } | null = null

export function createDb(): Database {
  if (cached !== null) return cached.db

  const url = process.env['POSTGRES_URL']
  if (!url) {
    throw new Error('POSTGRES_URL environment variable is required for video-worker')
  }
  const pool = new Pool({ connectionString: url })
  const db = drizzle(pool, { schema })
  cached = { db, pool }
  return db
}

/**
 * Closes the cached Postgres pool. Called during graceful shutdown so
 * Postgres slots are released cleanly. Safe to call multiple times.
 */
export async function closeDb(): Promise<void> {
  if (cached === null) return
  const pool = cached.pool
  cached = null
  await pool.end()
}
