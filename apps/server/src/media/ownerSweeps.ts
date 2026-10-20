/**
 * media/ownerSweeps.ts — the second storage sweep of a deleted owner, kept
 * in the database.
 *
 * Deleting a deck, a component master or a folder sweeps the owner's prefix
 * at once (media/bucketCleanup.ts), and that sweep keeps every object
 * younger than the grace window: a copy or a transcode may still be writing
 * there. What it kept has to go once the window has passed. That second
 * sweep was an in-process timer, forgotten by every restart — a dev server
 * restarting on each edit left whole decks behind (5.8 GiB of 26 deleted
 * decks in the dev bucket, 2026-10-20), and a production deploy forgot the
 * sweeps of the last quarter of an hour.
 *
 * Now the delete writes a `media_owner_sweeps` row in its own transaction
 * (`scheduleOwnerSweeps`), due a minute after the window, and every server
 * process runs the due rows (`startOwnerSweeps`): a row is taken by moving
 * its `due_at` forward (`FOR UPDATE SKIP LOCKED`, so two processes never
 * take the same one), swept, and removed once the sweep ended without an
 * error; a failed sweep comes back later, a few times, then is given up
 * with a warning. A row whose owner exists is dropped unswept: the sweep
 * deletes whatever no media row names, a live deck's thumbnail included,
 * and an owner the database still has is not this process's to sweep.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { components, decks, mediaOwnerSweeps } from '../db/schema.js'
import { purgeComponentBucketPrefix, purgeDeckBucketPrefix, sweepGraceMs } from './bucketCleanup.js'
import { isStorageSafeId, type MediaOwner } from './mediaOwner.js'

interface MinimalLogger {
  warn: (obj: Record<string, unknown>, msg?: string) => void
  info?: (obj: Record<string, unknown>, msg?: string) => void
}

type OwnerKind = 'deck' | 'component'
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** The row of one owner. */
function rowIs(kind: OwnerKind, id: string) {
  return and(eq(mediaOwnerSweeps.ownerKind, kind), eq(mediaOwnerSweeps.ownerId, id))
}

/** How often a process looks for due sweeps. */
export const OWNER_SWEEP_INTERVAL_MS = 60_000
/** Sweeps a process takes per look. */
export const OWNER_SWEEP_BATCH = 20
/** How long a taken row stays out of other processes' reach. */
export const OWNER_SWEEP_LEASE_MS = 10 * 60_000
/** Failed sweeps after which a row is given up (its orphans are logged). */
export const OWNER_SWEEP_MAX_ATTEMPTS = 8

/** After the delete: the grace window and a minute. */
export function ownerSweepDelayMs(): number {
  return sweepGraceMs() + 60_000
}

/** The wait before the next try of a sweep that failed `attempts` times: 5 min doubling, 6 h at most. */
export function ownerSweepBackoffMs(attempts: number): number {
  return Math.min(5 * 60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000)
}

function rowOf(owner: MediaOwner): { ownerKind: OwnerKind; ownerId: string } {
  return 'componentId' in owner
    ? { ownerKind: 'component', ownerId: owner.componentId }
    : { ownerKind: 'deck', ownerId: owner.deckId }
}

/**
 * Schedule the second sweep of `owners`, due `ownerSweepDelayMs()` from
 * `now`. Call it in the transaction that deletes them, so the delete and its
 * sweep commit together. An owner scheduled already is due again from now.
 */
export async function scheduleOwnerSweeps(
  exec: Database | DbTransaction,
  owners: readonly MediaOwner[],
  now: number = Date.now(),
): Promise<void> {
  const dueAt = new Date(now + ownerSweepDelayMs())
  const unique = new Map<string, { ownerKind: OwnerKind; ownerId: string; dueAt: Date }>()
  for (const owner of owners) {
    const row = rowOf(owner)
    unique.set(`${row.ownerKind}:${row.ownerId}`, { ...row, dueAt })
  }
  if (unique.size === 0) return
  await exec
    .insert(mediaOwnerSweeps)
    .values([...unique.values()])
    .onConflictDoUpdate({
      target: [mediaOwnerSweeps.ownerKind, mediaOwnerSweeps.ownerId],
      set: { dueAt, attempts: 0 },
    })
}

export interface OwnerSweepReport {
  /** Swept without an error; the row is gone. */
  swept: number
  /** Dropped unswept: the owner exists, or its id cannot name storage keys. */
  dropped: number
  /** Failed; due again later. */
  retried: number
  /** Failed for the last time; the row is gone, its orphans stay. */
  gaveUp: number
}

/** Take up to `limit` due rows: their `due_at` moves a lease forward, so no other process takes them. */
async function takeDue(
  db: Database,
  now: number,
  limit: number,
): Promise<Array<{ kind: OwnerKind; id: string; attempts: number }>> {
  const result = await db.execute<{
    owner_kind: OwnerKind
    owner_id: string
    attempts: number
  }>(sql`
    UPDATE ${mediaOwnerSweeps}
    SET due_at = ${new Date(now + OWNER_SWEEP_LEASE_MS)}
    WHERE (owner_kind, owner_id) IN (
      SELECT owner_kind, owner_id FROM ${mediaOwnerSweeps}
      WHERE due_at <= ${new Date(now)}
      ORDER BY due_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING owner_kind, owner_id, attempts`)
  return result.rows.map((r) => ({ kind: r.owner_kind, id: r.owner_id, attempts: r.attempts }))
}

async function ownerExists(db: Database, kind: OwnerKind, id: string): Promise<boolean> {
  const rows =
    kind === 'deck'
      ? await db.select({ id: decks.id }).from(decks).where(eq(decks.id, id)).limit(1)
      : await db
          .select({ id: components.id })
          .from(components)
          .where(eq(components.id, id))
          .limit(1)
  return rows.length > 0
}

async function forget(db: Database, kind: OwnerKind, id: string): Promise<void> {
  await db.delete(mediaOwnerSweeps).where(rowIs(kind, id))
}

/**
 * Run the sweeps due at `now`, at most `limit` of them. Never throws: a row
 * whose sweep could not run stays (or is due again), and the failure is
 * logged.
 */
export async function runDueOwnerSweeps(
  db: Database,
  log: MinimalLogger,
  opts: { now?: number; limit?: number } = {},
): Promise<OwnerSweepReport> {
  const report: OwnerSweepReport = { swept: 0, dropped: 0, retried: 0, gaveUp: 0 }
  const now = opts.now ?? Date.now()
  let due: Awaited<ReturnType<typeof takeDue>>
  try {
    due = await takeDue(db, now, opts.limit ?? OWNER_SWEEP_BATCH)
  } catch (err) {
    log.warn({ err }, 'owner sweeps: reading the due sweeps failed')
    return report
  }
  for (const { kind, id, attempts } of due) {
    const what = kind === 'deck' ? { deckId: id } : { componentId: id }
    try {
      if (!isStorageSafeId(id) || (await ownerExists(db, kind, id))) {
        await forget(db, kind, id)
        report.dropped++
        log.warn(what, 'owner sweep dropped: the owner exists, or its id cannot name storage keys')
        continue
      }
      const result =
        kind === 'deck'
          ? await purgeDeckBucketPrefix(db, id, log)
          : await purgeComponentBucketPrefix(db, id, log)
      if (result.errors === 0) {
        await forget(db, kind, id)
        report.swept++
        continue
      }
      const failed = attempts + 1
      if (failed >= OWNER_SWEEP_MAX_ATTEMPTS) {
        await forget(db, kind, id)
        report.gaveUp++
        log.warn({ ...what, attempts: failed }, 'owner sweep given up (orphans left)')
        continue
      }
      await db
        .update(mediaOwnerSweeps)
        .set({ attempts: failed, dueAt: new Date(now + ownerSweepBackoffMs(failed)) })
        .where(rowIs(kind, id))
      report.retried++
    } catch (err) {
      // The row keeps its lease and is due again once it runs out.
      log.warn({ err, ...what }, 'owner sweep failed')
      report.retried++
    }
  }
  if (log.info && due.length > 0) log.info({ ...report }, 'owner sweeps ran')
  return report
}

/**
 * Run the due sweeps every `intervalMs` (the first look after
 * `firstDelayMs`), one run at a time. `stop` ends the timers; a run in
 * progress finishes on its own.
 */
export function startOwnerSweeps(
  db: Database,
  log: MinimalLogger,
  opts: { intervalMs?: number; firstDelayMs?: number } = {},
): { stop(): void } {
  let running = false
  let stopped = false
  const tick = (): void => {
    if (running || stopped) return
    running = true
    void runDueOwnerSweeps(db, log).finally(() => {
      running = false
    })
  }
  const first = setTimeout(tick, opts.firstDelayMs ?? 10_000)
  first.unref()
  const every = setInterval(tick, opts.intervalMs ?? OWNER_SWEEP_INTERVAL_MS)
  every.unref()
  return {
    stop() {
      stopped = true
      clearTimeout(first)
      clearInterval(every)
    },
  }
}
