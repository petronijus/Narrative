/**
 * hocuspocus/instanceGeneration.ts — the instance's restore generation
 * (ADR 0017, migration 0042).
 *
 * Browsers keep local copies of documents, stamped `<generation>.<docEpoch>`
 * (./documentEpoch.ts). Restoring the database from a backup rolls every
 * `doc_epoch` back with the rows, so a copy confirmed after the backup would
 * claim a current document epoch and merge the content the restore removed
 * back in. The generation catches that:
 *
 *   - `infra/scripts/backup.sh` advances it right after each dump (to
 *     max(generation + 1, now)) and writes the new value to a marker file
 *     outside Postgres (`backups/marker/generation` on the VM, mounted
 *     read-only into the server as `INSTANCE_MARKER_PATH`). A dump therefore
 *     always holds a generation BELOW the marker written after it, and every
 *     copy confirmed after the dump claims the advanced generation or later.
 *   - At boot, before the sync server listens, {@link checkForRestore}
 *     compares: a database whose generation is below the marker was
 *     restored. Generation and floor jump to max(marker + 1, now); the sync
 *     server refuses every claim below the floor, so every copy issued
 *     before the restore is refused (and dropped by the browser), whichever
 *     dump it came from.
 *   - Daily backups move only the generation, never the floor: copies stamped
 *     with an older generation stay valid, and are re-stamped as they sync.
 *
 * Without a marker (development, a VM restored somewhere else, a lost
 * marker) nothing can be detected; the restore runbook (docs/deploy.md →
 * Restoring the database) then advances both by hand to "now" — unix
 * seconds, so "now" is above everything ever issued.
 */

import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { instanceGeneration } from '../db/schema.js'

type Db = Pick<Database, 'select' | 'update' | 'insert'>

interface Log {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface GenerationRow {
  generation: number
  floor: number
}

/** Unix seconds — the unit of generations. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/** The marker's generation, or null when there is none (or it is unreadable). */
export async function readRestoreMarker(path: string | undefined): Promise<number | null> {
  if (path === undefined || path === '') return null
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) && value >= 1 ? value : null
}

/**
 * What a boot must do with the row it found and the marker it read: null —
 * nothing (no marker, or the database is not behind it); otherwise the row
 * to write. Pure, for the tests.
 */
export function restoredRow(
  row: GenerationRow,
  marker: number | null,
  now: number,
): GenerationRow | null {
  if (marker === null || row.generation >= marker) return null
  const next = Math.max(marker + 1, now)
  return { generation: next, floor: next }
}

/**
 * Detect a restore of the database (see the module comment) and, if there
 * was one, move generation and floor past everything ever issued. Run at
 * boot, before the sync server accepts connections.
 */
export async function checkForRestore(deps: {
  db: Db
  log: Log
  markerPath: string | undefined
  now?: () => number
}): Promise<{ restored: boolean; row: GenerationRow }> {
  const { db, log } = deps
  const marker = await readRestoreMarker(deps.markerPath)
  const rows = await db
    .select({ generation: instanceGeneration.generation, floor: instanceGeneration.floor })
    .from(instanceGeneration)
    .where(eq(instanceGeneration.id, 1))
  let row: GenerationRow
  if (rows[0] === undefined) {
    // Migration 0042 inserts the row; a database without it was restored
    // from a dump older than the migration: nothing issued before counts.
    const next = Math.max((marker ?? 0) + 1, (deps.now ?? nowSeconds)())
    await db
      .insert(instanceGeneration)
      .values({ id: 1, generation: next, floor: next })
      .onConflictDoNothing()
    row = { generation: next, floor: next }
    log.warn(
      { marker, row },
      'instance generation was missing: every local document copy is refused',
    )
    return { restored: true, row }
  }
  row = { generation: Number(rows[0].generation), floor: Number(rows[0].floor) }
  if (marker === null) {
    log.info(
      { markerPath: deps.markerPath ?? null, row },
      'no restore marker: a database restore cannot be detected (docs/deploy.md → Restoring the database)',
    )
    return { restored: false, row }
  }
  const next = restoredRow(row, marker, (deps.now ?? nowSeconds)())
  if (next === null) return { restored: false, row }
  await db
    .update(instanceGeneration)
    .set({ generation: next.generation, floor: next.floor })
    .where(eq(instanceGeneration.id, 1))
  log.warn(
    { marker, before: row, after: next },
    'the database is behind its restore marker (restored from a backup): every local document copy is refused',
  )
  return { restored: true, row: next }
}

/**
 * Advance the generation (not the floor) — what backup.sh does in SQL after
 * each dump; here for scripts and tests. Returns the new generation.
 */
export async function advanceGeneration(db: Db, now = nowSeconds()): Promise<number> {
  const rows = await db
    .update(instanceGeneration)
    .set({ generation: sql`greatest(${instanceGeneration.generation} + 1, ${now})` })
    .where(eq(instanceGeneration.id, 1))
    .returning({ generation: instanceGeneration.generation })
  const value = rows[0]?.generation
  if (value === undefined) throw new Error('instance_generation has no row (migration 0042)')
  return Number(value)
}
