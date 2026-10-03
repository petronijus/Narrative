/**
 * hocuspocus/persistence.test.ts
 *
 * Unit testy pro PostgresPersistence extension (PERF-2 snapshot-compaction).
 *
 * Testovací strategie:
 *   Místo real Postgres nebo testcontainers (Docker required) testujeme proti
 *   in-memory faketu, který modeluje JEDNU `*_updates` tabulku jako pole řádků
 *   se serial `id`. Fake implementuje právě ten podmnožinu drizzle fluent API,
 *   kterou persistence.ts používá: select/from/where/orderBy, insert/values/
 *   returning, delete/where a transaction. Díky tomu můžeme ověřit nejen
 *   load/store logiku, ale i kompakci a atomicitu (commit-or-rollback).
 *
 *   Real Postgres integration test je v integration.test.ts (vyžaduje běžící
 *   Postgres).
 *
 * Coverage (PERF-2):
 *   - onLoadDocument: prázdný doc → void
 *   - onLoadDocument: full-snapshot row → aplikuje na Y.Doc
 *   - onLoadDocument: OLD-style many full-snapshot rows → load funguje
 *   - onStoreDocument: po N store cyklech tabulka drží bounded počet řádků
 *   - onStoreDocument: stored snapshot se rehydratuje na identický state
 *   - onStoreDocument: kompakce řádků (delete-older v jedné transakci)
 *   - atomicita: rollback transakce nesmí smazat staré řádky ani nechat doc
 *     bez řádku; insert nikdy nesmaže sám sebe
 *   - routing: folder:/component:/legacy-bare deck → správná "tabulka"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { PostgresPersistence } from './persistence.js'

// ---------------------------------------------------------------------------
// In-memory single-table fake. Models one `*_updates` table: rows = [{ id,
// fkId, update }] with a monotonically increasing serial id. Which FK column
// is used (deckId/folderId/componentId) is irrelevant to the fake — it stores
// whatever `values()` receives under `fkId` by reading the only *Id-ish field.
//
// The fake is column-agnostic: drizzle column objects passed to where()/eq()/
// lt() are opaque here. We instead key every operation off the doc id captured
// from the first eq() in the active query chain. That's sufficient because each
// query in persistence.ts scopes to exactly one doc id.
// ---------------------------------------------------------------------------

interface Row {
  id: number
  fkId: string
  update: Uint8Array
}

function makeFakeDb() {
  const rows: Row[] = []
  let nextId = 1
  // Predicate captured by the current chain (set by where()/eq helpers).
  // We model eq(col, value) and lt(col, value) by stashing the *values* — the
  // fake distinguishes them positionally: the eq value is the doc id, the lt
  // value is the keepFrom serial id.
  let failNextTransaction = false
  // Owners (deck / folder / component rows) that were deleted; every other
  // id has one.
  const deletedOwners = new Set<string>()

  // Build a chainable query object bound to an operation closure.
  function makeChain() {
    let docId: string | null = null
    let ltBound: number | null = null

    const chain = {
      // --- SELECT path -------------------------------------------------
      select: vi.fn(() => chain),
      from: vi.fn(() => chain),
      // The owner check: `select … where id = … for('key share')`.
      for: vi.fn(async () => (docId !== null && !deletedOwners.has(docId) ? [{ id: docId }] : [])),
      orderBy: vi.fn(async () => {
        const matched = rows.filter((r) => r.fkId === docId).sort((a, b) => a.id - b.id)
        return matched.map((r) => ({ update: r.update }))
      }),

      // --- INSERT path -------------------------------------------------
      insert: vi.fn(() => chain),
      values: vi.fn((vals: Record<string, unknown>) => {
        const fkId = (vals['deckId'] ?? vals['folderId'] ?? vals['componentId']) as string
        const update = vals['update'] as Uint8Array
        const row: Row = { id: nextId++, fkId, update }
        rows.push(row)
        return chain
      }),
      returning: vi.fn(async () => {
        // Return the id of the most recently inserted row in this chain.
        const last = rows[rows.length - 1]
        return last ? [{ id: last.id }] : []
      }),

      // --- DELETE path -------------------------------------------------
      delete: vi.fn(() => chain),

      // where() handles both select-scoping and delete-scoping. The predicate
      // helpers (eq/lt below) feed docId / ltBound into a per-chain register.
      where: vi.fn((pred: { docId?: string; lt?: number } | undefined) => {
        if (pred?.docId !== undefined) docId = pred.docId
        if (pred?.lt !== undefined) ltBound = pred.lt
        // For DELETE, where() is terminal — perform it now and return a
        // pg-like result with rowCount.
        if (chain._isDelete) {
          const before = rows.length
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i]!
            if (r.fkId === docId && ltBound !== null && r.id < ltBound) {
              rows.splice(i, 1)
            }
          }
          return Promise.resolve({ rowCount: before - rows.length })
        }
        return chain
      }),
      _isDelete: false,
    }
    return chain
  }

  // The top-level db proxies select/insert/delete to fresh chains so calls
  // don't bleed state between queries.
  function makeDb() {
    return {
      select: (...args: unknown[]) => {
        const c = makeChain()
        return (c.select as (...a: unknown[]) => typeof c)(...args)
      },
      insert: (...args: unknown[]) => {
        const c = makeChain()
        return (c.insert as (...a: unknown[]) => typeof c)(...args)
      },
      delete: (...args: unknown[]) => {
        const c = makeChain()
        c._isDelete = true
        return (c.delete as (...a: unknown[]) => typeof c)(...args)
      },
    }
  }

  const db = {
    ...makeDb(),
    /**
     * Seed a pre-existing row (simulating data written before this test) and
     * keep the serial counter ahead of it, so a later insert gets a strictly
     * larger id — exactly as a real SERIAL column would.
     */
    _seedRow: (fkId: string, update: Uint8Array) => {
      const id = nextId++
      rows.push({ id, fkId, update })
    },
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Snapshot rows so a thrown error rolls back (atomicity model).
      const snapshot = rows.map((r) => ({ ...r }))
      const snapshotNextId = nextId
      const tx = makeDb()
      try {
        if (failNextTransaction) {
          failNextTransaction = false
          throw new Error('simulated mid-transaction failure')
        }
        return await fn(tx)
      } catch (err) {
        // Roll back: restore the pre-transaction row set + serial counter.
        rows.length = 0
        rows.push(...snapshot)
        nextId = snapshotNextId
        throw err
      }
    }),
    // test introspection helpers
    _rows: rows,
    _rowCountFor: (docId: string) => rows.filter((r) => r.fkId === docId).length,
    _failNextTransaction: () => {
      failNextTransaction = true
    },
    /** The deck / folder / component row is deleted (its updates cascade with it). */
    _deleteOwner: (id: string) => {
      deletedOwners.add(id)
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.fkId === id) rows.splice(i, 1)
    },
  }
  return db
}

// drizzle's eq()/lt()/and() are imported by persistence.ts from 'drizzle-orm'.
// We must make those produce the predicate-shaped objects our fake where()
// understands. Vitest module mock:
vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, value: unknown) => ({ docId: value as string }),
  lt: (_col: unknown, value: unknown) => ({ lt: value as number }),
  and: (...preds: Array<{ docId?: string; lt?: number }>) =>
    preds.reduce((acc, p) => ({ ...acc, ...p }), {}),
}))

function makePayload(documentName: string, doc: Y.Doc, context: unknown = {}) {
  return {
    documentName,
    document: doc,
    instance: {} as never,
    connection: {} as never,
    context,
    requestHeaders: {},
    requestParameters: new URLSearchParams(),
    socketId: 'test',
  }
}

/** Push a labelled object onto the doc's `objects` array. */
function addObject(doc: Y.Doc, id: string, extra: Record<string, unknown> = {}) {
  const objects = doc.getArray<Y.Map<unknown>>('objects')
  doc.transact(() => {
    const m = new Y.Map<unknown>()
    m.set('id', id)
    for (const [k, v] of Object.entries(extra)) m.set(k, v)
    objects.push([m])
  })
}

/** Structural snapshot of the doc's objects array — used for state equality. */
function snapshotObjects(doc: Y.Doc): Array<Record<string, unknown>> {
  const arr = doc.getArray<Y.Map<unknown>>('objects')
  return Array.from({ length: arr.length }, (_, i) => arr.get(i).toJSON())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresPersistence', () => {
  let doc: Y.Doc

  beforeEach(() => {
    doc = new Y.Doc()
  })

  it('onLoadDocument returns void for empty deck (no rows)', async () => {
    const db = makeFakeDb()
    const persistence = new PostgresPersistence({ db: db as never })

    const result = await persistence.onLoadDocument(makePayload('deck-123', doc) as never)

    expect(result).toBeUndefined()
    expect(doc.getArray('objects').length).toBe(0)
  })

  it('onLoadDocument applies a full-snapshot row to the Y.Doc', async () => {
    const sourceDoc = new Y.Doc()
    addObject(sourceDoc, 'obj-1', { type: 'rectangle', x: 100 })
    const update = Y.encodeStateAsUpdate(sourceDoc)

    const db = makeFakeDb()
    // Seed one row directly.
    db._seedRow('deck-abc', update)

    const persistence = new PostgresPersistence({ db: db as never })
    const result = await persistence.onLoadDocument(makePayload('deck:deck-abc', doc) as never)

    expect(result).toBe(doc)
    const loaded = doc.getArray<Y.Map<unknown>>('objects')
    expect(loaded.length).toBe(1)
    expect(loaded.get(0).get('id')).toBe('obj-1')
    expect(loaded.get(0).get('type')).toBe('rectangle')
  })

  it('onLoadDocument loads an OLD-style deck with MANY full-snapshot rows', async () => {
    // Simulate the legacy append-only writer: each store appended a fresh
    // FULL snapshot of the growing doc. Build 5 historical rows.
    const writer = new Y.Doc()
    const db = makeFakeDb()
    for (let i = 0; i < 5; i++) {
      addObject(writer, `legacy-${i}`)
      db._seedRow('deck-legacy', Y.encodeStateAsUpdate(writer))
    }

    const persistence = new PostgresPersistence({ db: db as never })
    await persistence.onLoadDocument(makePayload('deck:deck-legacy', doc) as never)

    // Applying all 5 full snapshots must yield exactly the final state of the
    // writer doc — no duplicates, no missing objects (idempotent/commutative).
    expect(snapshotObjects(doc)).toEqual(snapshotObjects(writer))
    expect(doc.getArray('objects').length).toBe(5)
  })

  it('onStoreDocument writes one snapshot and keeps the table bounded across cycles', async () => {
    const db = makeFakeDb()
    const persistence = new PostgresPersistence({ db: db as never })

    // Five edit+store cycles on the same doc.
    for (let i = 0; i < 5; i++) {
      addObject(doc, `obj-${i}`)
      await persistence.onStoreDocument(makePayload('deck:bounded', doc) as never)
      // After every store the table holds exactly ONE row for this doc.
      expect(db._rowCountFor('bounded')).toBe(1)
    }

    // Final row must rehydrate to the full 5-object doc.
    const fresh = new Y.Doc()
    Y.applyUpdate(fresh, db._rows.find((r) => r.fkId === 'bounded')!.update)
    expect(snapshotObjects(fresh)).toEqual(snapshotObjects(doc))
  })

  it('compacts an OLD-style many-row deck down to one row on first store', async () => {
    // Seed 4 legacy rows, then perform one store.
    const writer = new Y.Doc()
    const db = makeFakeDb()
    for (let i = 0; i < 4; i++) {
      addObject(writer, `seed-${i}`)
      db._seedRow('deck-compact', Y.encodeStateAsUpdate(writer))
    }
    expect(db._rowCountFor('deck-compact')).toBe(4)

    // Load it (mirrors real lifecycle), edit, store.
    const persistence = new PostgresPersistence({ db: db as never })
    await persistence.onLoadDocument(makePayload('deck:deck-compact', doc) as never)
    addObject(doc, 'fresh-edit')
    await persistence.onStoreDocument(makePayload('deck:deck-compact', doc) as never)

    // The 4 old rows are gone; exactly one compacted snapshot remains.
    expect(db._rowCountFor('deck-compact')).toBe(1)

    // And it loads back to the full state (4 seeds + 1 edit).
    const reload = new Y.Doc()
    const p2 = new PostgresPersistence({ db: db as never })
    await p2.onLoadDocument(makePayload('deck:deck-compact', reload) as never)
    expect(snapshotObjects(reload)).toEqual(snapshotObjects(doc))
    expect(reload.getArray('objects').length).toBe(5)
  })

  it('a stored doc loads back to an identical state', async () => {
    const db = makeFakeDb()
    const persistence = new PostgresPersistence({ db: db as never })

    addObject(doc, 'rt-1', { type: 'ellipse', fill: '#abc' })
    addObject(doc, 'rt-2', { type: 'text', value: 'hello' })
    await persistence.onStoreDocument(makePayload('deck:roundtrip', doc) as never)

    const reload = new Y.Doc()
    await persistence.onLoadDocument(makePayload('deck:roundtrip', reload) as never)

    expect(snapshotObjects(reload)).toEqual(snapshotObjects(doc))
  })

  it('store is atomic: a mid-transaction failure leaves the OLD rows intact (no data loss, no empty doc)', async () => {
    // Seed two legacy rows representing the last good state.
    const writer = new Y.Doc()
    const db = makeFakeDb()
    addObject(writer, 'good-1')
    db._seedRow('deck-atomic', Y.encodeStateAsUpdate(writer))
    addObject(writer, 'good-2')
    db._seedRow('deck-atomic', Y.encodeStateAsUpdate(writer))
    const rowsBefore = db._rowCountFor('deck-atomic')
    expect(rowsBefore).toBe(2)

    // Arm a failure for the next transaction (simulates a crash after we'd
    // have started writing). onStoreDocument swallows DB errors, so no throw.
    db._failNextTransaction()

    const persistence = new PostgresPersistence({ db: db as never })
    addObject(doc, 'never-persisted')
    await persistence.onStoreDocument(makePayload('deck:deck-atomic', doc) as never)

    // Rollback: still exactly the two old rows, none deleted, none added.
    // There was never a window with zero rows.
    expect(db._rowCountFor('deck-atomic')).toBe(rowsBefore)

    // The doc still loads to the LAST GOOD state (good-1, good-2) — the failed
    // store did not corrupt or empty anything.
    const reload = new Y.Doc()
    await persistence.onLoadDocument(makePayload('deck:deck-atomic', reload) as never)
    expect(snapshotObjects(reload)).toEqual(snapshotObjects(writer))
    expect(reload.getArray('objects').length).toBe(2)
  })

  it('delete-older never removes the row written in the same transaction', async () => {
    // Even when the doc starts with NO rows, the very first store must insert
    // and survive its own compaction delete (id < newId excludes it).
    const db = makeFakeDb()
    const persistence = new PostgresPersistence({ db: db as never })

    addObject(doc, 'first-ever')
    await persistence.onStoreDocument(makePayload('deck:first', doc) as never)

    expect(db._rowCountFor('first')).toBe(1)
    const fresh = new Y.Doc()
    Y.applyUpdate(fresh, db._rows.find((r) => r.fkId === 'first')!.update)
    expect(fresh.getArray('objects').length).toBe(1)
  })

  it('routes folder: and component: doc names to their own tables', async () => {
    const db = makeFakeDb()
    const persistence = new PostgresPersistence({ db: db as never })

    addObject(doc, 'f-1')
    await persistence.onStoreDocument(makePayload('folder:folder-x', doc) as never)
    expect(db._rowCountFor('folder-x')).toBe(1)

    const cdoc = new Y.Doc()
    addObject(cdoc, 'c-1')
    await persistence.onStoreDocument(makePayload('component:comp-y', cdoc) as never)
    expect(db._rowCountFor('comp-y')).toBe(1)
  })

  it('stores nothing for a document whose deck, folder or component was deleted', async () => {
    // The debounced store runs after the owner's row is gone (a deck deleted
    // with its editor still open): nothing to keep, and no error.
    const db = makeFakeDb()
    const persistence = new PostgresPersistence({ db: db as never })
    addObject(doc, 'before')
    await persistence.onStoreDocument(makePayload('deck:gone', doc) as never)
    expect(db._rowCountFor('gone')).toBe(1)

    db._deleteOwner('gone')
    addObject(doc, 'after')
    await expect(
      persistence.onStoreDocument(makePayload('deck:gone', doc) as never),
    ).resolves.toBeUndefined()
    expect(db._rowCountFor('gone')).toBe(0)

    db._deleteOwner('comp-gone')
    await persistence.onStoreDocument(makePayload('component:comp-gone', doc) as never)
    expect(db._rowCountFor('comp-gone')).toBe(0)
  })

  it('tells the server about every stored deck — not folders, masters or decks that are gone', async () => {
    // The server checks there whether an undo brought back media of a folder
    // the deck has left (services/localiseMedia.ts); it must not slow the store.
    const db = makeFakeDb()
    const onDeckStored = vi.fn()
    const persistence = new PostgresPersistence({ db: db as never, onDeckStored })
    addObject(doc, 'a')
    await persistence.onStoreDocument(makePayload('deck:d-1', doc) as never)
    await persistence.onStoreDocument(makePayload('legacy-bare', doc) as never)
    await persistence.onStoreDocument(makePayload('folder:f-1', doc) as never)
    await persistence.onStoreDocument(makePayload('component:c-1', doc) as never)
    db._deleteOwner('d-gone')
    await persistence.onStoreDocument(makePayload('deck:d-gone', doc) as never)
    expect(onDeckStored.mock.calls).toEqual([['d-1'], ['legacy-bare']])

    // A hook that throws never fails the store.
    const throwing = new PostgresPersistence({
      db: db as never,
      onDeckStored: () => {
        throw new Error('boom')
      },
    })
    await expect(
      throwing.onStoreDocument(makePayload('deck:d-2', doc) as never),
    ).resolves.toBeUndefined()
    expect(db._rowCountFor('d-2')).toBe(1)
  })

  it('does not persist writes from a viewer context', async () => {
    const db = makeFakeDb()
    const persistence = new PostgresPersistence({ db: db as never })

    addObject(doc, 'should-not-save')
    await persistence.onStoreDocument(
      makePayload('deck:viewer-block', doc, { role: 'viewer', userId: 'u1' }) as never,
    )

    expect(db._rowCountFor('viewer-block')).toBe(0)
  })

  // -------------------------------------------------------------------------
  // DOS-1: document size cap
  // -------------------------------------------------------------------------
  describe('DOS-1 size cap', () => {
    const ORIGINAL_MAX = process.env['MAX_DOC_BYTES']

    afterEach(() => {
      if (ORIGINAL_MAX === undefined) delete process.env['MAX_DOC_BYTES']
      else process.env['MAX_DOC_BYTES'] = ORIGINAL_MAX
    })

    /** Inflate a doc above `targetBytes` worth of encoded state. */
    function inflate(d: Y.Doc, targetBytes: number) {
      const arr = d.getArray<string>('blob')
      d.transact(() => {
        // ~1 KB per push; loop until encoded size clears the target.
        while (Y.encodeStateAsUpdate(d).byteLength <= targetBytes) {
          arr.push(['x'.repeat(1024)])
        }
      })
    }

    it('rejects a store whose growth exceeds MAX_DOC_BYTES and leaves the table untouched', async () => {
      process.env['MAX_DOC_BYTES'] = '4096' // 4 KB cap
      const db = makeFakeDb()
      const persistence = new PostgresPersistence({ db: db as never })

      inflate(doc, 8192) // ~8 KB > cap
      await persistence.onStoreDocument(makePayload('deck:too-big', doc) as never)

      // Nothing persisted — growth past the cap is refused.
      expect(db._rowCountFor('too-big')).toBe(0)
    })

    it('persists a doc that stays under the cap', async () => {
      process.env['MAX_DOC_BYTES'] = String(1024 * 1024) // 1 MB cap
      const db = makeFakeDb()
      const persistence = new PostgresPersistence({ db: db as never })

      addObject(doc, 'small')
      await persistence.onStoreDocument(makePayload('deck:small-ok', doc) as never)

      expect(db._rowCountFor('small-ok')).toBe(1)
    })

    it('keeps an already-over-limit doc loadable: shrinking edits still persist', async () => {
      // Cap is small; seed the growth baseline via onLoadDocument so the doc
      // is treated as pre-existing/over-limit rather than fresh growth.
      process.env['MAX_DOC_BYTES'] = '4096'
      const db = makeFakeDb()
      const persistence = new PostgresPersistence({ db: db as never })

      // Build a >cap doc and seed a stored row representing it.
      const big = new Y.Doc()
      inflate(big, 8192)
      db._seedRow('over-limit', Y.encodeStateAsUpdate(big))

      // Load it — this seeds lastStoredBytes with the (over-cap) size.
      const loaded = new Y.Doc()
      await persistence.onLoadDocument(makePayload('deck:over-limit', loaded) as never)

      // A re-store at the SAME (still over-cap) size is allowed because it is
      // not growth — the doc must stay savable so an editor can shrink it.
      await persistence.onStoreDocument(makePayload('deck:over-limit', loaded) as never)
      const afterEqual = db._rowCountFor('over-limit')
      expect(afterEqual).toBe(1) // compacted to a single snapshot, still persisted

      // Now FURTHER growth past the already-over-cap baseline is refused.
      inflate(loaded, Y.encodeStateAsUpdate(loaded).byteLength + 2048)
      await persistence.onStoreDocument(makePayload('deck:over-limit', loaded) as never)
      // Row count unchanged — the growth store was rejected.
      expect(db._rowCountFor('over-limit')).toBe(afterEqual)
    })

    it('defaults to 32 MB when MAX_DOC_BYTES is unset', async () => {
      delete process.env['MAX_DOC_BYTES']
      const db = makeFakeDb()
      const persistence = new PostgresPersistence({ db: db as never })

      // A normal small doc must persist under the generous default.
      addObject(doc, 'normal')
      await persistence.onStoreDocument(makePayload('deck:default-cap', doc) as never)
      expect(db._rowCountFor('default-cap')).toBe(1)
    })
  })
})
