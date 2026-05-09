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
 * doc cache (`server.documents`) keeps growing across opens/closes.
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
import type { Database } from '../db/client.js'

// ---------------------------------------------------------------------------
// Minimal mock DB — onLoadDocument returns no rows, onStoreDocument is a
// no-op. The lifecycle test cares about server-side cache eviction, not
// actual persistence.
// ---------------------------------------------------------------------------

function makeMockDb() {
  const insertCalls: unknown[] = []
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: unknown) => {
        insertCalls.push(vals)
        return Promise.resolve()
      }),
    }),
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
      verifier: null,
      bypass: true, // dev-mode auth path; dev-user is auto-authenticated
    })
  })

  it('document cache returns to zero after all connections close', async () => {
    // Sanity: fresh server has no docs.
    expect(server.getDocumentsCount()).toBe(0)

    // Open three direct connections to distinct docs.
    const conn1 = await server.openDirectConnection('deck:lifecycle-a', {
      role: 'owner',
      userId: 'dev-user',
    })
    const conn2 = await server.openDirectConnection('deck:lifecycle-b', {
      role: 'owner',
      userId: 'dev-user',
    })
    const conn3 = await server.openDirectConnection('deck:lifecycle-c', {
      role: 'owner',
      userId: 'dev-user',
    })

    expect(server.getDocumentsCount()).toBe(3)

    // Close them all.
    await conn1.disconnect()
    await conn2.disconnect()
    await conn3.disconnect()

    // unloadImmediately:false means the doc lingers for `debounce` (2s)
    // so the persistence flush can complete before unload. Wait it out.
    await new Promise((r) => setTimeout(r, 2_500))

    expect(server.getDocumentsCount()).toBe(0)
  })

  it('opening + closing 50 docs in sequence keeps the cache bounded', async () => {
    // Open one, close it, repeat 50× — no doc should linger past its
    // debounce window. We close + wait between iterations so the cache
    // can drain; without the unloadImmediately:false / debounce settings
    // a regression here would show as either a stuck cache (count > 0
    // permanently) or a runaway cache (count climbing past 1).
    let maxObserved = 0
    for (let i = 0; i < 50; i++) {
      const conn = await server.openDirectConnection(`deck:loop-${i}`, {
        role: 'owner',
        userId: 'dev-user',
      })
      maxObserved = Math.max(maxObserved, server.getDocumentsCount())
      await conn.disconnect()
      // Don't wait full debounce per-iteration (that'd take 100s);
      // just let the unload macrotask fire if it's going to.
      await new Promise((r) => setTimeout(r, 5))
    }

    // Wait for the final batch of debounces to drain.
    await new Promise((r) => setTimeout(r, 2_500))

    // Cache should be empty after all closes.
    expect(server.getDocumentsCount()).toBe(0)
    // And we never accidentally accumulated an unbounded number of
    // simultaneously-open docs (they were all open one-at-a-time).
    expect(maxObserved).toBeLessThanOrEqual(2)
  }, 30_000)

  it('reopening the same doc reuses the cached entry while a connection is live', async () => {
    const conn1 = await server.openDirectConnection('deck:dedupe', {
      role: 'owner',
      userId: 'dev-user',
    })
    expect(server.getDocumentsCount()).toBe(1)

    const conn2 = await server.openDirectConnection('deck:dedupe', {
      role: 'owner',
      userId: 'dev-user',
    })
    // Same doc name → still one entry in the cache, both connections
    // share the underlying Y.Doc.
    expect(server.getDocumentsCount()).toBe(1)

    await conn1.disconnect()
    // conn2 still alive → doc must NOT unload yet.
    expect(server.getDocumentsCount()).toBe(1)

    await conn2.disconnect()
    await new Promise((r) => setTimeout(r, 2_500))
    expect(server.getDocumentsCount()).toBe(0)
  }, 30_000)
})
