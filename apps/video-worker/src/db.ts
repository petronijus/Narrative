/**
 * db.ts — Drizzle DB client factory for video-worker.
 *
 * Each call to createDb() returns a new client tied to the pool.
 * In practice the worker creates one client per process startup.
 * POSTGRES_URL must be set in the environment (same value as apps/server).
 */

import pg from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'

const { Pool } = pg

export type Database = NodePgDatabase<typeof schema>

export function createDb(): Database {
  const url = process.env['POSTGRES_URL']
  if (!url) {
    throw new Error('POSTGRES_URL environment variable is required for video-worker')
  }
  const pool = new Pool({ connectionString: url })
  return drizzle(pool, { schema })
}
