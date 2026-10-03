/**
 * db/runMigrations.integration.test.ts — the one migrator brings an EMPTY
 * database to the current schema (drizzle's own migrator could not: the enum
 * migrations need each file in its own transaction) and is idempotent. Runs
 * against a throwaway database created next to the dev Postgres from .env.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { runMigrations } from './runMigrations.js'

const url = new URL(process.env['POSTGRES_URL'] ?? '')
const scratch = `narrative_migrations_${process.pid}`
const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle')
const admin = new pg.Pool({ connectionString: url.toString(), max: 1 })
let pool: pg.Pool

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${scratch}"`)
  const scratchUrl = new URL(url.toString())
  scratchUrl.pathname = `/${scratch}`
  pool = new pg.Pool({ connectionString: scratchUrl.toString(), max: 1 })
})

afterAll(async () => {
  await pool?.end()
  await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`)
  await admin.end()
})

describe('runMigrations', () => {
  it('migrates an empty database, then finds nothing left to apply', async () => {
    const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
      entries: unknown[]
    }
    const first = await runMigrations(pool, folder)
    expect(first.applied).toHaveLength(journal.entries.length)

    const tables = await pool.query<{ n: string }>(
      "select count(*)::text as n from information_schema.tables where table_schema = 'public'",
    )
    expect(Number(tables.rows[0]!.n)).toBeGreaterThan(15)
    // The enum values added by later migrations are usable (0004 / 0009).
    const kinds = await pool.query<{ v: string }>(
      'select unnest(enum_range(NULL::media_asset_kind))::text as v',
    )
    expect(kinds.rows.map((r) => r.v)).toContain('font')
    // 0032: the linked media a deck took along when it moved — gone with the
    // deck; the copy, the folder and the mover go to NULL (no dangling ids).
    const moved = await pool.query<{ column_name: string; is_nullable: string }>(
      "select column_name, is_nullable from information_schema.columns where table_name = 'deck_moved_media' order by column_name",
    )
    expect(moved.rows).toEqual([
      { column_name: 'copy_asset_id', is_nullable: 'YES' },
      { column_name: 'deck_id', is_nullable: 'NO' },
      { column_name: 'from_folder_id', is_nullable: 'YES' },
      { column_name: 'moved_at', is_nullable: 'NO' },
      { column_name: 'moved_by_user_id', is_nullable: 'YES' },
      { column_name: 'recopied_at', is_nullable: 'YES' },
      { column_name: 'source_asset_id', is_nullable: 'NO' },
    ])
    const rules = await pool.query<{ column: string; table: string; rule: string }>(
      `select kcu.column_name as column, ccu.table_name as table, rc.delete_rule as rule
         from information_schema.referential_constraints rc
         join information_schema.key_column_usage kcu on kcu.constraint_name = rc.constraint_name
         join information_schema.constraint_column_usage ccu on ccu.constraint_name = rc.constraint_name
        where kcu.table_name = 'deck_moved_media' order by kcu.column_name`,
    )
    expect(rules.rows).toEqual([
      { column: 'copy_asset_id', table: 'media_assets', rule: 'SET NULL' },
      { column: 'deck_id', table: 'decks', rule: 'CASCADE' },
      { column: 'from_folder_id', table: 'folders', rule: 'SET NULL' },
      { column: 'moved_by_user_id', table: 'users', rule: 'SET NULL' },
    ])

    const second = await runMigrations(pool, folder)
    expect(second).toEqual({ applied: [], skipped: journal.entries.length })
  })
})
