/**
 * db/runMigrations.ts — applies the hand-written migrations in
 * apps/server/drizzle/ (see its README), one file per transaction-free
 * simple-protocol query, tracked by the SHA-256 of the file in
 * `drizzle.__drizzle_migrations` (the table drizzle's own migrator uses).
 *
 * The one migrator for every database: production (`db:migrate`, run by
 * infra/scripts/deploy.sh) and the dev server on start (index.ts). Until
 * 2026-09-30 the dev server used drizzle's `migrate()`, which wraps all
 * pending files in ONE transaction — Postgres then refuses `ALTER TYPE …
 * ADD VALUE` followed by a use of the value (migrations 0004 and 0009), so
 * a fresh dev database never got past it — and which decides what is pending
 * by the journal's `when`, not by content, so it silently skipped files
 * `db:migrate` had recorded with a later time.
 *
 * Why simple protocol: node-postgres sends `pool.query(string)` without
 * parameters that way, which allows several statements in one call and
 * runs each as its own implicit transaction, so an ADD VALUE commits before
 * the next statement uses it.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Pool } from 'pg'

export interface MigrationReport {
  applied: string[]
  skipped: number
}

export async function runMigrations(
  pool: Pool,
  migrationsFolder: string,
  log: (line: string) => void = () => undefined,
): Promise<MigrationReport> {
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

  // Applied migrations by hash, matching drizzle's logic — sha256 of the SQL
  // with the statement-breakpoint markers stripped.
  const applied = await pool.query<{ hash: string }>(
    'SELECT hash FROM drizzle.__drizzle_migrations',
  )
  const appliedHashes = new Set(applied.rows.map((r) => r.hash))

  const report: MigrationReport = { applied: [], skipped: 0 }
  for (const entry of entries) {
    const raw = readFileSync(path.join(migrationsFolder, entry.tag + '.sql'), 'utf8')
    const cleaned = raw.replace(/-->\s*statement-breakpoint\s*\n?/g, '')
    const hash = createHash('sha256').update(cleaned).digest('hex')
    if (appliedHashes.has(hash)) {
      report.skipped++
      continue
    }
    log(`apply ${entry.tag}`)
    await pool.query(cleaned)
    await pool.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [hash, Date.now()],
    )
    report.applied.push(entry.tag)
  }
  return report
}
