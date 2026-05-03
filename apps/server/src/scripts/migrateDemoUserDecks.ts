/**
 * scripts/migrateDemoUserDecks.ts
 *
 * One-off migration script: reassign all 'demo-user' decks to a real OIDC user (sub claim).
 *
 * Usage (after deploying with real OIDC auth):
 *   pnpm --filter @narrative/server db:migrate-demo <oidc-user-sub>
 *
 * What it does:
 *   For each deck where owner_user_id = 'demo-user':
 *     1. UPDATE decks.owner_user_id → targetUserId
 *     2. Upsert deck_permissions row (deck, targetUserId, 'owner', 'system-migration')
 *
 * Idempotent: safe to run multiple times. Already-migrated decks are skipped
 * (the UPDATE is a no-op when owner_user_id already equals targetUserId, and the
 * INSERT uses ON CONFLICT DO UPDATE to overwrite any partial state).
 *
 * The existing 'demo-user' deck_permissions rows are NOT removed automatically —
 * run manually if needed: DELETE FROM deck_permissions WHERE user_id = 'demo-user';
 */

import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema.js'

const { Pool } = pg

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const _rawArg = process.argv[2]

if (!_rawArg || _rawArg.trim() === '') {
  console.error('Usage: pnpm --filter @narrative/server db:migrate-demo <oidc-user-sub>')
  process.exit(1)
}

// After the guard above process.exit() never returns, so the assertion is safe.
const targetUserId: string = _rawArg

const postgresUrl =
  process.env['POSTGRES_URL'] ?? 'postgres://narrative:password@localhost:5432/narrative'

const pool = new Pool({ connectionString: postgresUrl })
const db = drizzle(pool, { schema })

async function run(): Promise<void> {
  console.log(`[migrate-demo] Migrating demo-user decks → ${targetUserId}`)

  // Find all demo-user decks
  const demoDecks = await db
    .select({ id: schema.decks.id, title: schema.decks.title })
    .from(schema.decks)
    .where(eq(schema.decks.ownerUserId, 'demo-user'))

  if (demoDecks.length === 0) {
    console.log('[migrate-demo] No demo-user decks found. Nothing to migrate.')
    return
  }

  console.log(`[migrate-demo] Found ${demoDecks.length} deck(s) to migrate.`)

  const now = new Date()

  for (const deck of demoDecks) {
    await db.transaction(async (tx) => {
      // 1. Update owner on the decks table
      await tx
        .update(schema.decks)
        .set({ ownerUserId: targetUserId })
        .where(eq(schema.decks.id, deck.id))

      // 2. Upsert permission row for the new owner
      await tx
        .insert(schema.deckPermissions)
        .values({
          deckId: deck.id,
          userId: targetUserId,
          role: 'owner',
          grantedAt: now,
          grantedBy: 'system-migration',
        })
        .onConflictDoUpdate({
          target: [schema.deckPermissions.deckId, schema.deckPermissions.userId],
          set: {
            role: 'owner',
            grantedBy: 'system-migration',
            grantedAt: now,
          },
        })

      console.log(`[migrate-demo]   ✓ ${deck.id} — "${deck.title}"`)
    })
  }

  console.log('[migrate-demo] Done.')
}

run()
  .catch((err) => {
    console.error('[migrate-demo] Error:', err)
    process.exit(1)
  })
  .finally(() => pool.end())
