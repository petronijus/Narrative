/**
 * agent/runStore.ts
 *
 * Durable record of agent runs and their ops (`agent_runs`, `agent_ops`,
 * migrations 0016/0017): the audit trail and the replay record — not the
 * undo mechanism, which is the in-memory per-run `Y.UndoManager` in
 * services/runs.ts (ADR 0011 point 4).
 *
 * An interface with a Drizzle implementation for the server and an
 * in-memory one for tests; the Drizzle one is exercised against a real
 * Postgres by runStore.integration.test.ts.
 */

import { and, count, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { agentOps, agentRuns, users } from '../db/schema.js'
import type { RunDocument } from '@narrative/commands'

export type RunStatus = 'open' | 'closed' | 'reverted'

export interface RunRecord {
  id: string
  userSub: string
  deckId: string | null
  componentId: string | null
  surface: 'mcp' | 'api'
  clientName: string | null
  request: string | null
  status: RunStatus
  createdAt: Date
  lastActivityAt: Date
  closedAt: Date | null
  revertedAt: Date | null
  revertedBySub: string | null
}

export interface NewRunRecord {
  id: string
  userSub: string
  deckId: string | null
  componentId: string | null
  surface: 'mcp' | 'api'
  clientName: string | null
  request: string | null
  createdAt: Date
}

export interface OpRecord {
  runId: string
  seq: number
  command: string
  input: unknown
  target: Record<string, string>
  result?: unknown
  error?: { code: string; message: string; issues?: unknown; opIndex?: number }
  createdAt: Date
  /** How an irreversible op was confirmed (migration 0019), set after insertion by the host. */
  confirmation?: OpConfirmation
  /** Every host the op's downloads contacted, redirects included (migration 0023); absent = none. */
  fetchedHosts?: string[]
}

/**
 * `agent_ops.confirmation` (migration 0019): who confirmed an op that needed
 * the user's confirmation, how, and why it needed one.
 *   via `elicitation`  the MCP client showed Narrative's question and the user accepted;
 *       `out_of_band`  the user approved it on Narrative's confirmation page
 *                      (`confirmationId`, `approvedAt`);
 *       `explicit`     the command API's `confirm` list (a script the user runs).
 * Rows written before the security review of 2026-09-27 carry only `via`
 * (`elicitation` | `explicit` — the latter then also meant the removed
 * `confirmed: true` argument), `by`, `surface` and `at`.
 */
export interface OpConfirmation {
  via: 'elicitation' | 'explicit' | 'out_of_band'
  /** The user the confirmation is attributed to (the run's user). */
  by: string
  surface: 'mcp' | 'api'
  /** ISO time the host accepted the confirmation. */
  at: string
  /** Why it needed confirming: `irreversible` (confirm: 'always'), `url_fetch` (confirmWhen). */
  reasons?: Array<'irreversible' | 'url_fetch'>
  /** url_fetch: the hosts the user approved. */
  hosts?: string[]
  /** out_of_band: the confirmation's id and when the user approved it. */
  confirmationId?: string
  approvedAt?: string
}

/** Per run and command: how many ops ran and how many succeeded. */
export interface OpCount {
  command: string
  total: number
  succeeded: number
}

export interface ListedRun extends RunRecord {
  userName: string | null
  opCounts: OpCount[]
}

export interface RunStore {
  insertRun(run: NewRunRecord): Promise<void>
  getRun(runId: string): Promise<RunRecord | null>
  /** Record activity on an open run. */
  touchRun(runId: string, at: Date): Promise<void>
  /** open → closed. A reverted run stays reverted. */
  closeRun(runId: string, at: Date): Promise<void>
  markReverted(runId: string, bySub: string, at: Date): Promise<void>
  /** Close every run still `open` — at startup, those belong to a process that is gone. */
  closeAllOpen(at: Date): Promise<number>
  insertOp(op: OpRecord): Promise<void>
  /** Attach the confirmation of an irreversible op to its logged row. No-op when the row is missing. */
  setOpConfirmation(runId: string, seq: number, confirmation: OpConfirmation): Promise<void>
  /**
   * The runs on one document (a deck or a component master), newest first,
   * with the requesting user's name and op counts.
   */
  listRuns(target: RunDocument, limit: number): Promise<ListedRun[]>
  /** The user's display name (`users.name`), or null when there is none. Never the email or sub. */
  userDisplayName(userSub: string): Promise<string | null>
  /**
   * Retention: delete runs (their ops cascade) whose last activity is before
   * `cutoff` and that are not `open`, at most `batchSize` per statement,
   * repeating until none is left. Returns how many runs were deleted.
   */
  deleteRunsInactiveBefore(cutoff: Date, batchSize?: number): Promise<number>
}

/** Rows deleted per retention statement (keeps each DELETE's lock and WAL burst small). */
export const RUN_RETENTION_BATCH = 500

// ---------------------------------------------------------------------------
// Drizzle
// ---------------------------------------------------------------------------

function toRecord(row: typeof agentRuns.$inferSelect): RunRecord {
  return {
    id: row.id,
    userSub: row.userSub,
    deckId: row.deckId,
    componentId: row.componentId,
    surface: row.surface === 'api' ? 'api' : 'mcp',
    clientName: row.clientName,
    request: row.request,
    status: row.status === 'reverted' ? 'reverted' : row.status === 'closed' ? 'closed' : 'open',
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    closedAt: row.closedAt,
    revertedAt: row.revertedAt,
    revertedBySub: row.revertedBySub,
  }
}

export function createDrizzleRunStore(db: Database): RunStore {
  return {
    async insertRun(run) {
      await db.insert(agentRuns).values({
        id: run.id,
        userSub: run.userSub,
        deckId: run.deckId,
        componentId: run.componentId,
        surface: run.surface,
        clientName: run.clientName,
        request: run.request,
        status: 'open',
        createdAt: run.createdAt,
        lastActivityAt: run.createdAt,
      })
    },

    async getRun(runId) {
      const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
      return row === undefined ? null : toRecord(row)
    },

    async touchRun(runId, at) {
      await db.update(agentRuns).set({ lastActivityAt: at }).where(eq(agentRuns.id, runId))
    },

    async closeRun(runId, at) {
      await db
        .update(agentRuns)
        .set({ status: 'closed', closedAt: at })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'open')))
    },

    async markReverted(runId, bySub, at) {
      await db
        .update(agentRuns)
        .set({
          status: 'reverted',
          revertedAt: at,
          revertedBySub: bySub,
          closedAt: sql`coalesce(${agentRuns.closedAt}, ${at})`,
        })
        .where(eq(agentRuns.id, runId))
    },

    async closeAllOpen(at) {
      const closed = await db
        .update(agentRuns)
        .set({ status: 'closed', closedAt: at })
        .where(eq(agentRuns.status, 'open'))
        .returning({ id: agentRuns.id })
      return closed.length
    },

    async insertOp(op) {
      await db.insert(agentOps).values({
        runId: op.runId,
        seq: op.seq,
        command: op.command,
        input: op.input ?? null,
        target: op.target,
        result: op.result === undefined ? null : op.result,
        error: op.error ?? null,
        fetchedHosts: op.fetchedHosts ?? null,
        createdAt: op.createdAt,
      })
    },

    async setOpConfirmation(runId, seq, confirmation) {
      await db
        .update(agentOps)
        .set({ confirmation })
        .where(and(eq(agentOps.runId, runId), eq(agentOps.seq, seq)))
    },

    async listRuns(target, limit) {
      const rows = await db
        .select({ run: agentRuns, userName: users.name, userEmail: users.email })
        .from(agentRuns)
        .leftJoin(users, eq(users.sub, agentRuns.userSub))
        .where(
          target.kind === 'deck'
            ? eq(agentRuns.deckId, target.deckId)
            : eq(agentRuns.componentId, target.componentId),
        )
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .limit(limit)
      if (rows.length === 0) return []
      const ids = rows.map((r) => r.run.id)
      const counts = await db
        .select({
          runId: agentOps.runId,
          command: agentOps.command,
          total: count(),
          succeeded: sql<number>`count(*) filter (where ${agentOps.error} is null)`.mapWith(Number),
        })
        .from(agentOps)
        .where(inArray(agentOps.runId, ids))
        .groupBy(agentOps.runId, agentOps.command)
      const byRun = new Map<string, OpCount[]>()
      for (const c of counts) {
        const list = byRun.get(c.runId) ?? []
        list.push({ command: c.command, total: Number(c.total), succeeded: Number(c.succeeded) })
        byRun.set(c.runId, list)
      }
      return rows.map((r) => ({
        ...toRecord(r.run),
        userName: r.userName ?? r.userEmail ?? null,
        opCounts: byRun.get(r.run.id) ?? [],
      }))
    },

    async userDisplayName(userSub) {
      const [row] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.sub, userSub))
        .limit(1)
      return row?.name ?? null
    },

    async deleteRunsInactiveBefore(cutoff, batchSize = RUN_RETENTION_BATCH) {
      let total = 0
      for (;;) {
        const batch = db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(and(lt(agentRuns.lastActivityAt, cutoff), ne(agentRuns.status, 'open')))
          .limit(batchSize)
        const deleted = await db
          .delete(agentRuns)
          .where(inArray(agentRuns.id, batch))
          .returning({ id: agentRuns.id })
        total += deleted.length
        if (deleted.length < batchSize) return total
      }
    },
  }
}

// ---------------------------------------------------------------------------
// In memory (tests)
// ---------------------------------------------------------------------------

export interface MemoryRunStore extends RunStore {
  readonly runs: Map<string, RunRecord>
  readonly ops: OpRecord[]
  /** Display names for listRuns. */
  readonly userNames: Map<string, string>
}

export function createMemoryRunStore(): MemoryRunStore {
  const runs = new Map<string, RunRecord>()
  const ops: OpRecord[] = []
  const userNames = new Map<string, string>()
  return {
    runs,
    ops,
    userNames,
    async insertRun(run) {
      if (runs.has(run.id)) throw new Error(`duplicate run id ${run.id}`)
      runs.set(run.id, {
        ...run,
        status: 'open',
        lastActivityAt: run.createdAt,
        closedAt: null,
        revertedAt: null,
        revertedBySub: null,
      })
    },
    async getRun(runId) {
      const run = runs.get(runId)
      return run === undefined ? null : { ...run }
    },
    async touchRun(runId, at) {
      const run = runs.get(runId)
      if (run !== undefined) run.lastActivityAt = at
    },
    async closeRun(runId, at) {
      const run = runs.get(runId)
      if (run !== undefined && run.status === 'open') {
        run.status = 'closed'
        run.closedAt = at
      }
    },
    async markReverted(runId, bySub, at) {
      const run = runs.get(runId)
      if (run === undefined) return
      run.status = 'reverted'
      run.revertedAt = at
      run.revertedBySub = bySub
      run.closedAt ??= at
    },
    async closeAllOpen(at) {
      let n = 0
      for (const run of runs.values()) {
        if (run.status === 'open') {
          run.status = 'closed'
          run.closedAt = at
          n++
        }
      }
      return n
    },
    async insertOp(op) {
      if (!runs.has(op.runId)) throw new Error(`op for unknown run ${op.runId}`)
      if (ops.some((o) => o.runId === op.runId && o.seq === op.seq)) {
        throw new Error(`duplicate op ${op.runId}#${op.seq}`)
      }
      ops.push(structuredClone(op))
    },
    async setOpConfirmation(runId, seq, confirmation) {
      const op = ops.find((o) => o.runId === runId && o.seq === seq)
      if (op !== undefined) op.confirmation = { ...confirmation }
    },
    async listRuns(target, limit) {
      return [...runs.values()]
        .filter((r) =>
          target.kind === 'deck'
            ? r.deckId === target.deckId
            : r.componentId === target.componentId,
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )
        .slice(0, limit)
        .map((r) => {
          const counts = new Map<string, OpCount>()
          for (const op of ops) {
            if (op.runId !== r.id) continue
            const c = counts.get(op.command) ?? { command: op.command, total: 0, succeeded: 0 }
            c.total++
            if (op.error === undefined) c.succeeded++
            counts.set(op.command, c)
          }
          return {
            ...r,
            userName: userNames.get(r.userSub) ?? null,
            opCounts: [...counts.values()],
          }
        })
    },
    async userDisplayName(userSub) {
      return userNames.get(userSub) ?? null
    },
    async deleteRunsInactiveBefore(cutoff) {
      let n = 0
      for (const [id, run] of [...runs]) {
        if (run.status === 'open' || run.lastActivityAt.getTime() >= cutoff.getTime()) continue
        runs.delete(id)
        n++
        // ON DELETE CASCADE
        for (let i = ops.length - 1; i >= 0; i--) if (ops[i]!.runId === id) ops.splice(i, 1)
      }
      return n
    },
  }
}
