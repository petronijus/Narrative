/**
 * db/migrate.ts
 *
 * Applies the migrations in apps/server/drizzle/ (db/runMigrations.ts).
 * Usage: `pnpm --filter @narrative/server db:migrate`; production runs the
 * compiled file as a deploy step (infra/scripts/deploy.sh). The dev server
 * runs the same migrator on start (src/index.ts).
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
import { runMigrations } from './runMigrations.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const migrationsFolder =
  process.env['MIGRATIONS_FOLDER'] ?? path.resolve(__dirname, '../../drizzle')

console.log('[migrate] Running migrations from:', migrationsFolder)

try {
  const report = await runMigrations(pool, migrationsFolder, (line) =>
    console.log(`[migrate] ${line}`),
  )
  console.log(
    `[migrate] Migrations applied successfully (${report.applied.length} applied, ${report.skipped} already applied)`,
  )
} catch (err) {
  console.error('[migrate] Migration failed:', err)
  process.exit(1)
} finally {
  await pool.end()
}
