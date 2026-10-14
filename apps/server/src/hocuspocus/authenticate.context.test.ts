/**
 * hocuspocus/authenticate.context.test.ts — the context `onAuthenticate`
 * establishes must survive on the live connection.
 *
 * Regression: Hocuspocus 2.15 replaces `hookPayload.context` with a merged
 * copy after every hook, and a connection's `onConnect` (async in
 * production) can finish while `onAuthenticate` is still awaiting the
 * database. Writes the hook made only to `data.context` were then lost, and
 * the connection ran with an empty context: no `userId` for CONN-1
 * revocation, the active-editor bubbles or the agent's `editor.context` /
 * `editor.show`. This drives the real hook through a real WebSocket with a
 * slow database and an async `onConnect`, the production shape.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Server } from '@hocuspocus/server'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { getTableName, type Table } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { createOnAuthenticate } from './authenticate.js'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * resolveDeckAccess's read, answered slowly: the deck left-joined to the
 * user's deck_permissions row with `role` and no role in the deck's folder —
 * so the deck grant alone decides.
 */
function slowDb(role: 'editor' | 'viewer'): Database {
  const rowsFor = (table: string): unknown[] => {
    if (table === 'decks') return [{ deckRole: role, folderRole: null }]
    return []
  }
  const select = () => {
    let table = ''
    const answer = async () => {
      await delay(40)
      return rowsFor(table)
    }
    const chain = {
      from: (t: Table) => {
        table = getTableName(t)
        return chain
      },
      leftJoin: () => chain,
      where: () => chain,
      limit: answer,
      // A query awaited without a limit.
      then: (ok: (rows: unknown[]) => unknown, err?: (e: unknown) => unknown) =>
        answer().then(ok, err),
    }
    return chain
  }
  return { select } as unknown as Database
}

let server: Server | null = null
let provider: HocuspocusProvider | null = null

afterEach(async () => {
  provider?.destroy()
  provider = null
  await server?.destroy()
  server = null
})

describe('onAuthenticate context', () => {
  it('reaches the connection even when onConnect finishes while the hook awaits the database', async () => {
    server = new Server({
      // A free port: `listen(0)` would fall back to the configured default
      // (Hocuspocus 4 reads a falsy port argument as "none").
      port: 0,
      quiet: true,
      stopOnSignals: false,
      onAuthenticate: createOnAuthenticate({ db: slowDb('editor'), bypass: true }),
      async onConnect() {
        await delay(10)
      },
    })
    await server.listen()
    let synced!: () => void
    const whenSynced = new Promise<void>((r) => (synced = r))
    provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${server.address.port}`,
      name: 'deck-ctx',
      document: new Y.Doc(),
      token: 'cookie',
      onSynced: () => synced(),
    })
    await whenSynced

    const connections = server.hocuspocus.documents.get('deck-ctx')!.getConnections()
    expect(connections).toHaveLength(1)
    expect(connections[0]!.context).toMatchObject({
      userId: 'dev-user',
      deckId: 'deck-ctx',
      deckIdResolved: 'deck-ctx',
      role: 'editor',
    })
  })

  it('returns exactly what it wrote, for Hocuspocus to merge', async () => {
    const hook = createOnAuthenticate({ db: slowDb('viewer'), bypass: true })
    const data = {
      documentName: 'deck:d1',
      token: 'cookie',
      requestParameters: new URLSearchParams(),
      requestHeaders: new Headers({}),
      connectionConfig: { readOnly: false },
      context: { preset: 'kept' } as Record<string, unknown>,
    }
    const additions = await hook(data)
    expect(additions).toEqual({
      userId: 'dev-user',
      deckId: 'deck:d1',
      deckIdResolved: 'd1',
      role: 'viewer',
    })
    expect(data.connectionConfig.readOnly).toBe(true)
  })
})
