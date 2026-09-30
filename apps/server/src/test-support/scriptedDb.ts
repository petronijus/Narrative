/**
 * test-support/scriptedDb.ts — a stand-in for the Drizzle client in service
 * tests: every query chain (`select().from().where().limit()`, `insert().
 * values().returning()`, `update().set().where().returning()`, `delete()…`)
 * is accepted as written, and resolves to the next scripted result for its
 * kind. Inserts, updates and deletes are recorded with their table name, so
 * a test can assert what a service wrote. `transaction(fn)` runs `fn` with
 * the same client plus `rollback()`, which throws drizzle's
 * `TransactionRollbackError` as the real one does; when `fn` throws, the
 * writes it made leave `writes` for `rolledBack`, as Postgres discards them.
 *
 * Excluded from the build (tsconfig.build.json: src/test-support/**).
 */

import { getTableName, TransactionRollbackError, type Table } from 'drizzle-orm'
import type { Database } from '../db/client.js'

export interface ScriptedWrite {
  kind: 'insert' | 'update' | 'delete'
  table: string
  values?: unknown
}

export interface ScriptedDb {
  db: Database
  writes: ScriptedWrite[]
  /** Writes made inside a transaction that threw (rolled back), in order. */
  rolledBack: ScriptedWrite[]
  /** Scripted results still unconsumed, per kind. */
  remaining(): { selects: number; updates: number; deletes: number }
}

export interface Script {
  /** Results of successive awaited selects, in order. */
  selects?: unknown[][]
  /** Results of successive updates' `.returning()` (default: `[values]`). */
  updates?: unknown[][]
  /** Results of successive deletes' `.returning()` (default: `[]`). */
  deletes?: unknown[][]
}

const CHAIN_METHODS = [
  'from',
  'where',
  'limit',
  'orderBy',
  'groupBy',
  'leftJoin',
  'innerJoin',
  'as',
  'onConflictDoUpdate',
  'onConflictDoNothing',
]

export function scriptedDb(script: Script = {}): ScriptedDb {
  const selects = [...(script.selects ?? [])]
  const updates = [...(script.updates ?? [])]
  const deletes = [...(script.deletes ?? [])]
  const writes: ScriptedWrite[] = []
  const rolledBack: ScriptedWrite[] = []

  /** A chainable, awaitable query whose result is computed when awaited. */
  const query = (resolve: () => unknown, extra: Record<string, unknown> = {}): unknown => {
    const q: Record<string, unknown> = {}
    for (const m of CHAIN_METHODS) q[m] = () => q
    Object.assign(q, extra)
    q['then'] = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(resolve()).then(onOk, onErr)
      } catch (e) {
        return Promise.reject(e).then(onOk, onErr)
      }
    }
    return q
  }

  const db = {
    select: () =>
      query(() => {
        if (selects.length === 0)
          throw new Error('scriptedDb: no scripted result left for a select')
        return selects.shift()
      }),
    insert: (table: Table) => ({
      values: (values: unknown) => {
        writes.push({ kind: 'insert', table: getTableName(table), values })
        const rows = Array.isArray(values) ? values : [values]
        return query(() => [], { returning: () => query(() => rows) })
      },
    }),
    update: (table: Table) => ({
      set: (values: unknown) => {
        writes.push({ kind: 'update', table: getTableName(table), values })
        const result = () => (updates.length > 0 ? updates.shift() : [values])
        return query(() => [], {
          where: () => query(() => [], { returning: () => query(result) }),
        })
      },
    }),
    delete: (table: Table) => {
      writes.push({ kind: 'delete', table: getTableName(table) })
      const result = () => (deletes.length > 0 ? deletes.shift() : [])
      return {
        where: () => query(() => [], { returning: () => query(result) }),
      }
    },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const mark = writes.length
      const tx = {
        ...db,
        rollback: (): never => {
          throw new TransactionRollbackError()
        },
      }
      try {
        return await fn(tx)
      } catch (err) {
        rolledBack.push(...writes.splice(mark))
        throw err
      }
    },
  }

  return {
    db: db as unknown as Database,
    writes,
    rolledBack,
    remaining: () => ({
      selects: selects.length,
      updates: updates.length,
      deletes: deletes.length,
    }),
  }
}
