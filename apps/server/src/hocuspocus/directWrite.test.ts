/**
 * hocuspocus/directWrite.test.ts — an agent's write is stored by the sync
 * server's debounce, not only by the store at the end of its run.
 *
 * `writeDirect` leaves persistence to Hocuspocus: the write's update reaches
 * `handleDocumentUpdate`, which schedules `onStoreDocument` with the context
 * of the write's transaction origin. `PostgresPersistence.onStoreDocument`
 * skips a store whose context says `viewer`; this proves the agent's origin
 * (a run origin, no Hocuspocus origin) yields a context it does not skip, so
 * the debounced store really writes the snapshot — through the real server
 * (createHocuspocusServer: its debounce, its persistence extension) and the
 * real agent host (agent/documents.ts), against an in-memory database.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { onStoreDocumentPayload } from '@hocuspocus/server'
import { agentOrigin } from '@narrative/slide-model'
import { createHocuspocusServer } from './index.js'
import { PostgresPersistence } from './persistence.js'
import { createAgentDocuments } from '../agent/documents.js'
import { createAgentPrincipalKeys } from '../agent/presence.js'
import { DEV_AGENT_PRINCIPAL_KEY_SECRET } from '../agent/principalKeySecret.js'
import type { Database } from '../db/client.js'

/** The persistence path's slice of drizzle: no rows to load, every insert kept. */
function makeRecordingDb() {
  const inserted: Uint8Array[] = []
  let nextId = 1
  const runner = () => ({
    select: () => {
      const c = {
        from: () => c,
        where: () => c,
        orderBy: async () => [],
        // The owner lock: the deck exists.
        for: async () => [{ id: 'owner' }],
      }
      return c
    },
    insert: () => {
      const c = {
        values: (v: { update: Uint8Array }) => {
          inserted.push(v.update)
          return c
        },
        returning: async () => [{ id: nextId++ }],
      }
      return c
    },
    delete: () => ({ where: async () => ({ rowCount: 0 }) }),
  })
  const db = {
    ...runner(),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(runner()),
  }
  return { db: db as unknown as Database, inserted }
}

function textOf(update: Uint8Array): string {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  return doc.getText('probe').toString()
}

describe('writeDirect persistence', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function setUp() {
    const { db, inserted } = makeRecordingDb()
    const stored: string[] = []
    const server = createHocuspocusServer({
      port: 0,
      db,
      principalKeys: createAgentPrincipalKeys(DEV_AGENT_PRINCIPAL_KEY_SECRET),
      onDeckStored: (id) => stored.push(id),
    })
    const store = vi.spyOn(PostgresPersistence.prototype, 'onStoreDocument')
    const agents = createAgentDocuments(server.hocuspocus, { lingerMs: 60_000 })
    return { server, agents, inserted, stored, store }
  }

  it("stores an agent's write on the debounce, under a context the viewer guard lets through", async () => {
    const { server, agents, inserted, stored, store } = await setUp()
    const lease = await agents.acquire('deck:direct-write')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await lease.transact((doc) => {
      doc.transact(() => doc.getText('probe').insert(0, 'agent wrote this'), agentOrigin('run-1'))
    })
    // Debounced, not stored per write.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store).not.toHaveBeenCalled()

    // The debounce fires without the run-close store (`persist`) being called.
    await vi.advanceTimersByTimeAsync(1_500)
    expect(store).toHaveBeenCalledTimes(1)
    const payload = store.mock.calls[0]![0] as onStoreDocumentPayload
    expect((payload.lastContext as { role?: string }).role).not.toBe('viewer')
    expect(stored).toEqual(['direct-write'])
    expect(inserted).toHaveLength(1)
    expect(textOf(inserted[0]!)).toBe('agent wrote this')

    vi.useRealTimers()
    lease.release()
    await agents.closeAll()
    await server.hocuspocus.closeConnections()
  })

  it('the guard is real: a write under a viewer context is not stored by the same debounce', async () => {
    const { server, inserted, stored, store } = await setUp()
    const viewer = await server.hocuspocus.openDirectConnection('deck:viewer-write', {
      role: 'viewer',
      userId: 'someone',
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Hocuspocus's own transact: origin { source: 'local', context: viewer }.
    await viewer.transact((doc) => doc.getText('probe').insert(0, 'viewer wrote this'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(store).toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
    expect(stored).toEqual([])
    vi.useRealTimers()
    await viewer.disconnect()
  })
})
