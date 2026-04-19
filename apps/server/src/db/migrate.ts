/**
 * db/migrate.ts
 *
 * Spouští Drizzle migrace z apps/server/drizzle/ adresáře.
 * Použití: `pnpm --filter @narrative/server db:migrate`
 *
 * V dev: voláno automaticky ze src/index.ts při startu.
 * V prod: voláno manuálně jako deploy krok (infra agent fáze 2).
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db, pool } from './client.js'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Migrace jsou v apps/server/drizzle/ (generované drizzle-kit)
const migrationsFolder = path.resolve(__dirname, '../../drizzle')

console.log('[migrate] Running migrations from:', migrationsFolder)

try {
  await migrate(db, { migrationsFolder })
  console.log('[migrate] Migrations applied successfully')
} catch (err) {
  console.error('[migrate] Migration failed:', err)
  process.exit(1)
} finally {
  await pool.end()
}
