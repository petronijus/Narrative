/**
 * hocuspocus/lifecycle.test.ts
 *
 * Regression guard for the Y.Doc lifecycle settings we set in
 * `createHocuspocusServer` (Tier 2-B):
 *
 *   - unloadImmediately: false  (debounced flush completes before unload)
 *   - debounce: 2_000
 *   - maxDebounce: 10_000
 *
 * Symptom this catches: a future refactor flips `unloadImmediately` back
 * to true, or the Hocuspocus version bumps and the option name changes,
 * or someone forgets to call `connection.disconnect()` somewhere — the
 * doc cache (`server.hocuspocus.documents`) keeps growing across opens/closes.
 *
 * Why this exists separately from persistence.test.ts: persistence tests
 * mock the DB and run hooks in isolation. This test exercises the real
 * lifecycle pipeline (onAuthenticate → onLoadDocument → connection
 * established → disconnect → unload-debounce → onStoreDocument →
 * afterUnloadDocument) by spinning up an actual Hocuspocus instance and
 * driving it through `openDirectConnection` (Hocuspocus's in-process
 * test API — no real WebSocket, no port binding).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHocuspocusServer } from './index.js'
import { createAgentPrincipalKeys } from '../agent/presence.js'
import { DEV_AGENT_PRINCIPAL_KEY_SECRET } from '../agent/principalKeySecret.js'
import type { Database } from '../db/client.js'

// ---------------------------------------------------------------------------
// Minimal mock DB — onLoadDocument returns no rows, onStoreDocument is a
// no-op. The lifecycle test cares about server-side cache eviction, not
// actual persistence.
// ---------------------------------------------------------------------------

function makeMockDb() {
  const insertCalls: unknown[] = []
  // Minimal fluent fake that satisfies the PERF-2 store path:
  //   db.transaction(tx => tx.insert(...).values(...).returning() ;
  //                        tx.delete(...).where(...))
  // and the load path: db.select(...).from(...).where(...).orderBy(...).
  // onLoadDocument returns no rows; onStoreDocument's insert/delete are no-ops
  // (returning() yields a synthetic id so compaction's delete stays bounded).
  let nextId = 1
  // SELECT chain: select().from().where().orderBy() → []
  function selectChain() {
    const c: Record<string, unknown> = {}
    c['from'] = vi.fn(() => c)
    c['where'] = vi.fn(() => c)
    c['orderBy'] = vi.fn().mockResolvedValue([])
    return c
  }
  // INSERT chain: insert().values().returning() → [{ id }]
  function insertChain() {
    const c: Record<string, unknown> = {}
    c['values'] = vi.fn((vals: unknown) => {
      insertCalls.push(vals)
      return c
    })
    c['returning'] = vi.fn(() => Promise.resolve([{ id: nextId++ }]))
    return c
  }
  // DELETE chain: delete().where() → { rowCount }
  function deleteChain() {
    const c: Record<string, unknown> = {}
    c['where'] = vi.fn(() => Promise.resolve({ rowCount: 0 }))
    return c
  }
  function makeRunner() {
    return {
      select: vi.fn(() => selectChain()),
      insert: vi.fn(() => insertChain()),
      delete: vi.fn(() => deleteChain()),
    }
  }
  const db = {
    ...makeRunner(),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(makeRunner())),
    _insertCalls: insertCalls,
  }
  return db as unknown as Database & { _insertCalls: unknown[] }
}

describe('Hocuspocus lifecycle', () => {
  let server: ReturnType<typeof createHocuspocusServer>

  beforeEach(() => {
    server = createHocuspocusServer({
      port: 0, // not used — we only exercise direct connections
      db: makeMockDb(),
      bypass: true, // dev-mode auth path; dev-user is auto-authenticated
      principalKeys: createAgentPrincipalKeys(DEV_AGENT_PRINCIPAL_KEY_SECRET),
    })
  })

  it('document cache returns to zero after all connections close', async () => {
    // Sanity: fresh server has no docs.
    expect(server.hocuspocus.getDocumentsCount()).toBe(0)

    // Open three direct connections to distinct docs.
    const conn1 = await server.hocuspocus.openDirectConnection('deck:lifecycle-a', {
      role: 'owner',
      userId: 'dev-user',
    })
    const conn2 = await server.hocuspocus.openDirectConnection('deck:lifecycle-b', {
      role: 'owner',
      userId: 'dev-user',
    })
    const conn3 = await server.hocuspocus.openDirectConnection('deck:lifecycle-c', {
      role: 'owner',
      userId: 'dev-user',
    })

    expect(server.hocuspocus.getDocumentsCount()).toBe(3)

    // Close them all.
    await conn1.disconnect()
    await conn2.disconnect()
    await conn3.disconnect()

    // unloadImmediately:false means the doc lingers for `debounce` (2s)
    // so the persistence flush can complete before unload. Wait it out.
    await new Promise((r) => setTimeout(r, 2_500))

    expect(server.hocuspocus.getDocumentsCount()).toBe(0)
  })

  it('opening + closing 50 docs in sequence keeps the cache bounded', async () => {
    // Open one, close it, repeat 50× — no doc should linger past its
    // debounce window. We close + wait between iterations so the cache
    // can drain; without the unloadImmediately:false / debounce settings
    // a regression here would show as either a stuck cache (count > 0
    // permanently) or a runaway cache (count climbing past 1).
    let maxObserved = 0
    for (let i = 0; i < 50; i++) {
      const conn = await server.hocuspocus.openDirectConnection(`deck:loop-${i}`, {
        role: 'owner',
        userId: 'dev-user',
      })
      maxObserved = Math.max(maxObserved, server.hocuspocus.getDocumentsCount())
      await conn.disconnect()
      // Don't wait full debounce per-iteration (that'd take 100s);
      // just let the unload macrotask fire if it's going to.
      await new Promise((r) => setTimeout(r, 5))
    }

    // Wait for the final batch of debounces to drain.
    await new Promise((r) => setTimeout(r, 2_500))

    // Cache should be empty after all closes.
    expect(server.hocuspocus.getDocumentsCount()).toBe(0)
    // And we never accidentally accumulated an unbounded number of
    // simultaneously-open docs (they were all open one-at-a-time).
    expect(maxObserved).toBeLessThanOrEqual(2)
  }, 30_000)

  it('reopening the same doc reuses the cached entry while a connection is live', async () => {
    const conn1 = await server.hocuspocus.openDirectConnection('deck:dedupe', {
      role: 'owner',
      userId: 'dev-user',
    })
    expect(server.hocuspocus.getDocumentsCount()).toBe(1)

    const conn2 = await server.hocuspocus.openDirectConnection('deck:dedupe', {
      role: 'owner',
      userId: 'dev-user',
    })
    // Same doc name → still one entry in the cache, both connections
    // share the underlying Y.Doc.
    expect(server.hocuspocus.getDocumentsCount()).toBe(1)

    await conn1.disconnect()
    // conn2 still alive → doc must NOT unload yet.
    expect(server.hocuspocus.getDocumentsCount()).toBe(1)

    await conn2.disconnect()
    await new Promise((r) => setTimeout(r, 2_500))
    expect(server.hocuspocus.getDocumentsCount()).toBe(0)
  }, 30_000)
})
