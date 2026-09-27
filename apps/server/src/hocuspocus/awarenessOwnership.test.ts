/**
 * hocuspocus/awarenessOwnership.test.ts — client-id ownership on a real
 * Hocuspocus `Document`, with awareness updates applied exactly as
 * Hocuspocus applies a connection's message (`applyAwarenessUpdate` with the
 * connection's socket as origin). The end-to-end path through real
 * WebSocket clients and `editor.context` is in services/editor.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Document, type Connection } from '@hocuspocus/server'
import { trackAwarenessOwnership, trustedAwarenessClientIds } from './awarenessOwnership.js'

/** y-protocols awareness update: varuint count, then (clientID, clock, JSON state) per entry. */
function awarenessUpdate(
  entries: Array<{ clientId: number; clock: number; state: unknown }>,
): Uint8Array {
  const bytes: number[] = []
  const varUint = (n: number): void => {
    let v = n
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    bytes.push(v)
  }
  varUint(entries.length)
  for (const e of entries) {
    varUint(e.clientId)
    varUint(e.clock)
    const json = new TextEncoder().encode(JSON.stringify(e.state))
    varUint(json.length)
    bytes.push(...json)
  }
  return Uint8Array.from(bytes)
}

interface FakeConnection {
  webSocket: object
  context: Record<string, unknown>
  send: () => void
}

let documents: Document[] = []

function setup() {
  const document = new Document('deck1')
  documents.push(document)
  const log = { warn: vi.fn() }
  trackAwarenessOwnership(document, log)
  const connect = (userId: string): FakeConnection => {
    const connection: FakeConnection = { webSocket: {}, context: { userId }, send: () => undefined }
    document.addConnection(connection as unknown as Connection)
    return connection
  }
  const send = (
    from: FakeConnection,
    clientId: number,
    clock: number,
    state: Record<string, unknown> | null,
  ): void => {
    document.applyAwarenessUpdate(
      from as unknown as Connection,
      awarenessUpdate([{ clientId, clock, state }]),
    )
  }
  const disconnect = (connection: FakeConnection): void => {
    document.removeConnection(connection as unknown as Connection)
  }
  return { document, log, connect, send, disconnect }
}

afterEach(() => {
  for (const d of documents) d.destroy()
  documents = []
})

describe('awareness client-id ownership', () => {
  it('trusts the state of the principal that announced an id', () => {
    const { document, connect, send } = setup()
    const alice = connect('alice')
    const bob = connect('bob')
    send(alice, 101, 1, { user: { id: 'alice' }, selectedObjectIds: ['a'] })
    send(bob, 202, 1, { user: { id: 'bob' }, selectedObjectIds: ['b'] })
    expect(trustedAwarenessClientIds(document, 'alice')).toEqual([101])
    expect(trustedAwarenessClientIds(document, 'bob')).toEqual([202])
  })

  it("ignores an id's state once another principal overwrote it, until the owner republishes", () => {
    const { document, log, connect, send } = setup()
    const alice = connect('alice')
    const mallory = connect('mallory')
    send(alice, 101, 1, { selectedObjectIds: ['a'] })

    // Forgery: mallory writes alice's client id with a higher clock.
    send(mallory, 101, 2, { selectedObjectIds: ['forged'], activeSlideId: 's9' })
    expect(document.awareness.getStates().get(101)).toMatchObject({ activeSlideId: 's9' })
    expect(trustedAwarenessClientIds(document, 'alice')).toEqual([])
    expect(trustedAwarenessClientIds(document, 'mallory')).toEqual([])
    expect(log.warn).toHaveBeenCalledTimes(1)

    // Alice's next update (her heartbeat) restores trust.
    send(alice, 101, 3, { selectedObjectIds: ['a2'] })
    expect(trustedAwarenessClientIds(document, 'alice')).toEqual([101])
  })

  it('does not hand an id over through "remove, then re-add" by another principal', () => {
    const { document, connect, send } = setup()
    const alice = connect('alice')
    const mallory = connect('mallory')
    send(alice, 101, 1, { selectedObjectIds: ['a'] })
    send(mallory, 101, 2, null)
    send(mallory, 101, 3, { selectedObjectIds: ['forged'] })
    expect(trustedAwarenessClientIds(document, 'mallory')).toEqual([])
    expect(trustedAwarenessClientIds(document, 'alice')).toEqual([])
  })

  it("accepts the same user's other tab relaying the state (BroadcastChannel)", () => {
    const { document, connect, send, disconnect } = setup()
    const tab1 = connect('alice')
    const tab2 = connect('alice')
    // tab2's relay of tab1's state reaches the server first.
    send(tab2, 101, 1, { selectedObjectIds: ['a'] })
    send(tab1, 101, 2, { selectedObjectIds: ['a', 'b'] })
    expect(trustedAwarenessClientIds(document, 'alice')).toEqual([101])
    // Hocuspocus drops the id's state with the socket that first ADDED it
    // (tab2); tab1's next heartbeat claims it again.
    disconnect(tab2)
    expect(trustedAwarenessClientIds(document, 'alice')).toEqual([])
    send(tab1, 101, 3, { selectedObjectIds: ['a', 'b'] })
    expect(trustedAwarenessClientIds(document, 'alice')).toEqual([101])
  })

  it('releases an id when its owner leaves, so a later owner can claim it', () => {
    const { document, connect, send, disconnect } = setup()
    const alice = connect('alice')
    send(alice, 101, 1, { selectedObjectIds: ['a'] })
    disconnect(alice) // Hocuspocus removes the connection's states (origin null)
    expect(trustedAwarenessClientIds(document, 'alice')).toEqual([])
    const bob = connect('bob')
    send(bob, 101, 5, { selectedObjectIds: ['b'] })
    expect(trustedAwarenessClientIds(document, 'bob')).toEqual([101])
  })

  it('never binds the document’s own client id (the agent presence peer)', () => {
    const { document, connect, send } = setup()
    const mallory = connect('mallory')
    document.awareness.setLocalState({ selectedObjectIds: ['agent'] })
    send(mallory, document.awareness.clientID, 99, { selectedObjectIds: ['forged'] })
    expect(trustedAwarenessClientIds(document, 'mallory')).toEqual([])
  })

  it('trusts nothing on a document it does not track', () => {
    const document = new Document('untracked')
    documents.push(document)
    const connection = { webSocket: {}, context: { userId: 'alice' }, send: () => undefined }
    document.addConnection(connection as unknown as Connection)
    document.applyAwarenessUpdate(
      connection as unknown as Connection,
      awarenessUpdate([{ clientId: 7, clock: 1, state: { selectedObjectIds: [] } }]),
    )
    expect(trustedAwarenessClientIds(document, 'alice')).toEqual([])
  })
})
