/**
 * db/migrate.ts
 *
 * Spouští migrace z apps/server/drizzle/ adresáře.
 * Použití: `pnpm --filter @narrative/server db:migrate`
 *
 * V dev: voláno automaticky ze src/index.ts při startu.
 * V prod: voláno manuálně jako deploy krok (infra agent fáze 2).
 *
 * Why a custom migrator (not drizzle's built-in `migrate()`):
 *   drizzle's migrator wraps ALL pending migrations in a SINGLE outer
 *   transaction. Postgres rejects `ALTER TYPE ... ADD VALUE 'x'` followed
 *   by a query that USES 'x' within the same transaction
 *   (`unsafe use of new value … of enum type`, error 55P04 — see
 *   migration 0004 vs 0009 here). Our custom loop runs each file in its
 *   OWN transaction so `ADD VALUE` commits before subsequent migrations
 *   reference it. Migration tracking schema (`drizzle.__drizzle_migrations`)
 *   matches drizzle's so the built-in migrator could resume if ever needed.
 */

import { pool } from './client.js'
import { fileURLToPath } from 'url'
import path from 'path'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const migrationsFolder =
  process.env['MIGRATIONS_FOLDER'] ?? path.resolve(__dirname, '../../drizzle')

console.log('[migrate] Running migrations from:', migrationsFolder)

async function main(): Promise<void> {
  // Ensure tracking table exists (same schema/table name as drizzle's migrator).
  await pool.query('CREATE SCHEMA IF NOT EXISTS drizzle')
  await pool.query(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  )

  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when?: number }>
  }
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx)

  // Which migrations are already applied (by hash, matching drizzle's logic
  // — sha256 of the migration SQL with statement-breakpoints stripped).
  const applied = await pool.query<{ hash: string }>(
    'SELECT hash FROM drizzle.__drizzle_migrations',
  )
  const appliedHashes = new Set(applied.rows.map((r) => r.hash))

  for (const entry of entries) {
    const file = path.join(migrationsFolder, entry.tag + '.sql')
    const raw = readFileSync(file, 'utf8')
    // Drizzle uses --> statement-breakpoint as an advisory split marker.
    // We strip them and let the single multi-statement query handle splitting.
    const cleaned = raw.replace(/-->\s*statement-breakpoint\s*\n?/g, '')
    const hash = createHash('sha256').update(cleaned).digest('hex')

    if (appliedHashes.has(hash)) {
      console.log(`[migrate] skip ${entry.tag} (already applied)`)
      continue
    }

    console.log(`[migrate] apply ${entry.tag}`)
    // node-postgres uses the SIMPLE query protocol for `pool.query(string)`
    // when there are no parameter bindings. The simple protocol allows
    // multiple semicolon-separated statements AND treats each as its own
    // implicit transaction (no surrounding BEGIN/COMMIT). This is exactly
    // what we need — every ALTER auto-commits before the next ALTER runs.
    await pool.query(cleaned)
    await pool.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [hash, Date.now()],
    )
  }

  console.log('[migrate] Migrations applied successfully')
}

try {
  await main()
} catch (err) {
  console.error('[migrate] Migration failed:', err)
  process.exit(1)
} finally {
  await pool.end()
}
