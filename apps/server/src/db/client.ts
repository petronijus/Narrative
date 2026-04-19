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

export const pool = new Pool({ connectionString: getPostgresUrl() })

export const db = drizzle(pool, { schema })

export type Database = typeof db
