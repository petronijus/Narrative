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
import { Hocuspocus } from '@hocuspocus/server'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { Database } from '../db/client.js'
import { createOnAuthenticate } from './authenticate.js'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** resolveDeckAccess reads one deck_permissions row — answered slowly. */
function slowDb(role: 'editor' | 'viewer'): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      await delay(40)
      return [{ role }]
    },
  }
  return { select: () => chain } as unknown as Database
}

let server: Hocuspocus | null = null
let provider: HocuspocusProvider | null = null

afterEach(async () => {
  provider?.destroy()
  provider = null
  await server?.destroy()
  server = null
})

describe('onAuthenticate context', () => {
  it('reaches the connection even when onConnect finishes while the hook awaits the database', async () => {
    server = new Hocuspocus({
      quiet: true,
      stopOnSignals: false,
      onAuthenticate: createOnAuthenticate({ db: slowDb('editor'), bypass: true }),
      async onConnect() {
        await delay(10)
      },
    })
    await server.listen(0)
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

    const connections = server.documents.get('deck-ctx')!.getConnections()
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
      requestHeaders: {},
      connection: { readOnly: false },
      context: { preset: 'kept' } as Record<string, unknown>,
    }
    const additions = await hook(data)
    expect(additions).toEqual({
      userId: 'dev-user',
      deckId: 'deck:d1',
      deckIdResolved: 'd1',
      role: 'viewer',
    })
    expect(data.connection.readOnly).toBe(true)
  })
})
