/**
 * services/dataMigrations.ts — one-time changes to DOCUMENTS the server makes
 * after it starts, once per migration id (table `app_data_migrations`,
 * migration 0026).
 *
 * Schema changes are SQL migrations (drizzle/). A change to documents cannot
 * be one: it must go through the sync server, like every other edit
 * (services/liveDocs.ts), or a document someone has open would never see it
 * and the next compacting store would drop it. So these run in the server
 * process, after it is listening, in the background, one after another: one
 * that completes records its report and never runs again; one that fails is
 * logged with its error and tried again on the next start — at most
 * {@link MAX_ATTEMPTS} times, so a document that can never be migrated does
 * not make every restart sweep every folder for ever. Migrations are
 * idempotent (a re-run changes only what is still out of date).
 */

import { eq, sql } from 'drizzle-orm'
import { appDataMigrations, folders } from '../db/schema.js'
import type { ServiceDeps } from './deps.js'
import { ensureFolderTokens, queuePropagation } from './tokens.js'

type Deps = Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>

export interface DataMigration {
  /** Stable id; a completed one is recorded under it. */
  id: string
  description: string
  run(deps: Deps): Promise<Record<string, unknown>>
}

/**
 * A2.12: every folder gets its tokens on the server. Until then the browser
 * seeded a folder, migrated its default styles and carried text-style values
 * into a deck only when someone opened them — folders made by agents (or
 * never opened since) have no tokens, and decks may lag their styles. For
 * every folder: seed the defaults when it has no colours and no text styles,
 * bring an older seed up to date, then carry every text style into the
 * folder's decks and component masters (only documents that differ are
 * written).
 */
export const folderTokensOnServer: DataMigration = {
  id: '2026-09-30-folder-tokens-on-server',
  description: 'seed and migrate folder tokens, then re-style linked text, on the server',
  async run(deps) {
    const rows = await deps.db.select({ id: folders.id }).from(folders)
    const report = {
      folders: rows.length,
      seeded: 0,
      migrated: 0,
      decks: 0,
      components: 0,
      objects: 0,
      failed: [] as string[],
    }
    for (const { id } of rows) {
      try {
        const { seeded, migrated, tokens } = await ensureFolderTokens(deps, id)
        if (seeded) report.seeded++
        if (migrated) report.migrated++
        const styleIds = new Set(Object.keys(tokens.textStyles))
        const reached = await queuePropagation(deps, id, styleIds)
        report.decks += reached.decks
        report.components += reached.components
        report.objects += reached.objects
        report.failed.push(...reached.failed)
      } catch (err) {
        deps.log.warn({ err, folderId: id }, 'folder tokens data migration: folder failed')
        report.failed.push(`folder:${id}`)
      }
    }
    // A folder that could not be handled keeps the migration open for the
    // next start (the others are idempotent: re-running changes nothing).
    if (report.failed.length > 0) {
      throw Object.assign(new Error('some documents could not be migrated'), { report })
    }
    return report
  },
}

export const DATA_MIGRATIONS: readonly DataMigration[] = [folderTokensOnServer]

/** Tries before a failing migration is left alone (it then needs a person: see its `last_error`). */
export const MAX_ATTEMPTS = 3

/** Run every data migration not completed yet, in order; each try and its outcome are recorded. */
export async function runDataMigrations(
  deps: Deps,
  migrations: readonly DataMigration[] = DATA_MIGRATIONS,
): Promise<void> {
  for (const migration of migrations) {
    const [row] = await deps.db
      .select({ attempts: appDataMigrations.attempts, completedAt: appDataMigrations.completedAt })
      .from(appDataMigrations)
      .where(eq(appDataMigrations.id, migration.id))
      .limit(1)
    if (row?.completedAt != null) continue
    if (row !== undefined && row.attempts >= MAX_ATTEMPTS) {
      deps.log.error(
        { migration: migration.id, attempts: row.attempts },
        'data migration: gave up after repeated failures; see app_data_migrations.last_error',
      )
      continue
    }
    await deps.db
      .insert(appDataMigrations)
      .values({ id: migration.id, attempts: 1 })
      .onConflictDoUpdate({
        target: appDataMigrations.id,
        set: { attempts: sql`${appDataMigrations.attempts} + 1` },
      })
    deps.log.info({ migration: migration.id }, 'data migration: starting')
    try {
      const report = await migration.run(deps)
      await deps.db
        .update(appDataMigrations)
        .set({ completedAt: new Date(), report, lastError: null })
        .where(eq(appDataMigrations.id, migration.id))
      deps.log.info({ migration: migration.id, report }, 'data migration: completed')
    } catch (err) {
      const report = (err as { report?: Record<string, unknown> }).report ?? null
      await deps.db
        .update(appDataMigrations)
        .set({ lastError: err instanceof Error ? err.message : String(err), report })
        .where(eq(appDataMigrations.id, migration.id))
      deps.log.error(
        { err, migration: migration.id },
        'data migration: failed; tried again on the next start',
      )
    }
  }
}
