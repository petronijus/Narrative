/**
 * hocuspocus/awarenessRedaction.test.ts — what read-only and share-link
 * connections receive of other peers' awareness.
 *
 *   - unit: the state / update / message rewriters on bytes produced by the
 *     real encoders (y-protocols `encodeAwarenessUpdate`, Hocuspocus'
 *     `OutgoingMessage` layout written with lib0);
 *   - end to end: real WebSocket clients on a real Hocuspocus server (the
 *     agent test world, which registers the production extensions) — an
 *     editor publishing a state with a sub and an email, a viewer that must
 *     not see either, and a fellow editor that sees the state unchanged.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { Document, type Connection } from '@hocuspocus/server'
import type { PeerAwarenessState } from '@narrative/shared'
import {
  HOCUSPOCUS_AWARENESS_MESSAGE,
  REDACTED_PEER_NAME,
  looksLikeEmail,
  needsAwarenessRedaction,
  redactAwarenessState,
  redactOutgoingMessage,
  trackAwarenessRedaction,
} from './awarenessRedaction.js'
import { createAgentWorld, eventually, type AgentWorld } from '../test-support/agentWorld.js'

const LEAKY_STATE = {
  user: { id: '108234567890123456789', name: 'petr@example.com', color: 'hsl(1, 70%, 55%)' },
  selectedObjectIds: ['o1', 'someone@example.org'],
  cursor: { x: 1, y: 2, slideId: 's1' },
  activeSlideId: 's1',
  contact: 'mail me: petr@example.com',
  nested: { deep: { email: 'x@y.cz', keep: 'fine' } },
}

/** An outgoing Hocuspocus message: varString document, varUint type, varUint8Array payload. */
function hocuspocusMessage(documentName: string, type: number, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarString(encoder, documentName)
  encoding.writeVarUint(encoder, type)
  encoding.writeVarUint8Array(encoder, payload)
  return encoding.toUint8Array(encoder)
}

function decodeAwarenessMessage(message: Uint8Array): {
  documentName: string
  type: number
  states: Array<{ clientId: number; clock: number; state: unknown }>
} {
  const decoder = decoding.createDecoder(message)
  const documentName = decoding.readVarString(decoder)
  const type = decoding.readVarUint(decoder)
  const update = decoding.createDecoder(decoding.readVarUint8Array(decoder))
  const count = decoding.readVarUint(update)
  const states = []
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(update)
    const clock = decoding.readVarUint(update)
    states.push({ clientId, clock, state: JSON.parse(decoding.readVarString(update)) })
  }
  return { documentName, type, states }
}

describe('looksLikeEmail', () => {
  it('spots addresses, also inside longer strings', () => {
    expect(looksLikeEmail('petr@example.com')).toBe(true)
    expect(looksLikeEmail('Contact: a.b+c@sub.example.co.uk.')).toBe(true)
    expect(looksLikeEmail('Petr Janda')).toBe(false)
    expect(looksLikeEmail('Petr @ Woodgrove')).toBe(false)
    expect(looksLikeEmail('agent:run_1')).toBe(false)
  })
})

describe('redactAwarenessState', () => {
  it('replaces user.id, neutralises an email name and drops email-looking values', () => {
    expect(redactAwarenessState(42, LEAKY_STATE)).toEqual({
      user: { id: 'peer:42', name: REDACTED_PEER_NAME, color: 'hsl(1, 70%, 55%)' },
      selectedObjectIds: ['o1'],
      cursor: { x: 1, y: 2, slideId: 's1' },
      activeSlideId: 's1',
      nested: { deep: { keep: 'fine' } },
    })
  })

  it('keeps a display name and the agent field (its key is opaque)', () => {
    const agent = {
      runId: 'run_1',
      surface: 'mcp',
      principalName: 'Petr',
      principalKey: 'suMEL2lykgqwQ5l03rNxzW',
      onBehalfOf: 'suMEL2lykgqwQ5l03rNxzW',
    }
    expect(
      redactAwarenessState(7, {
        user: { id: 'agent:run_1', name: 'Claude (MCP)', color: 'c' },
        selectedObjectIds: [],
        cursor: null,
        agent,
      }),
    ).toEqual({
      user: { id: 'peer:7', name: 'Claude (MCP)', color: 'c' },
      selectedObjectIds: [],
      cursor: null,
      agent,
    })
  })
})

describe('redactOutgoingMessage', () => {
  it('rewrites awareness messages produced by the real encoder', () => {
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    awareness.setLocalState(LEAKY_STATE)
    const update = encodeAwarenessUpdate(awareness, [doc.clientID])
    const out = decodeAwarenessMessage(
      redactOutgoingMessage(hocuspocusMessage('deck1', HOCUSPOCUS_AWARENESS_MESSAGE, update)),
    )
    expect(out.documentName).toBe('deck1')
    expect(out.type).toBe(HOCUSPOCUS_AWARENESS_MESSAGE)
    expect(out.states).toHaveLength(1)
    expect(out.states[0]!.clientId).toBe(doc.clientID)
    expect(out.states[0]!.clock).toBe(awareness.meta.get(doc.clientID)!.clock)
    const text = JSON.stringify(out.states[0]!.state)
    expect(text).not.toContain('108234567890123456789')
    expect(text).not.toContain('@')
    expect((out.states[0]!.state as PeerAwarenessState).user.id).toBe(`peer:${doc.clientID}`)
    awareness.destroy()
    doc.destroy()
  })

  it('passes removals (null states) through', () => {
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    awareness.setLocalState(null)
    const update = encodeAwarenessUpdate(awareness, [doc.clientID])
    const out = decodeAwarenessMessage(
      redactOutgoingMessage(hocuspocusMessage('d', HOCUSPOCUS_AWARENESS_MESSAGE, update)),
    )
    expect(out.states[0]!.state).toBeNull()
    awareness.destroy()
    doc.destroy()
  })

  it('leaves every other message byte-identical (the same array)', () => {
    const sync = hocuspocusMessage('deck1', 0, Uint8Array.from([1, 2, 3]))
    expect(redactOutgoingMessage(sync)).toBe(sync)
    const stateless = hocuspocusMessage('deck1', 5, new TextEncoder().encode('{"a":"x@y.cz"}'))
    expect(redactOutgoingMessage(stateless)).toBe(stateless)
  })

  it('throws on a malformed awareness payload (the caller drops it)', () => {
    const broken = hocuspocusMessage('d', HOCUSPOCUS_AWARENESS_MESSAGE, Uint8Array.from([5, 1]))
    expect(() => redactOutgoingMessage(broken)).toThrow()
  })
})

describe('needsAwarenessRedaction', () => {
  it('covers read-only and share-link connections only', () => {
    expect(needsAwarenessRedaction({ readOnly: true, context: { userId: 'u' } })).toBe(true)
    expect(
      needsAwarenessRedaction({
        readOnly: false,
        context: { userId: 'share:ab', shareToken: 't' },
      }),
    ).toBe(true)
    expect(needsAwarenessRedaction({ readOnly: false, context: { userId: 'u' } })).toBe(false)
    expect(needsAwarenessRedaction({ readOnly: false, context: undefined })).toBe(false)
  })
})

describe('trackAwarenessRedaction', () => {
  it('wraps send of redacted connections added to the document, and nobody else', () => {
    const document = new Document('deck1')
    const log = { warn: vi.fn() }
    trackAwarenessRedaction(document, log)
    trackAwarenessRedaction(document, log) // idempotent
    const viewerSent: Uint8Array[] = []
    const editorSent: Uint8Array[] = []
    const viewer = {
      webSocket: {},
      readOnly: true,
      context: { userId: 'share:abcd1234', shareToken: 'tok' },
      send: (m: Uint8Array) => viewerSent.push(m),
    }
    const editor = {
      webSocket: {},
      readOnly: false,
      context: { userId: 'ed' },
      send: (m: Uint8Array) => editorSent.push(m),
    }
    document.addConnection(viewer as unknown as Connection)
    document.addConnection(editor as unknown as Connection)

    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    awareness.setLocalState(LEAKY_STATE)
    const message = hocuspocusMessage(
      'deck1',
      HOCUSPOCUS_AWARENESS_MESSAGE,
      encodeAwarenessUpdate(awareness, [doc.clientID]),
    )
    viewer.send(message)
    editor.send(message)
    expect(JSON.stringify(decodeAwarenessMessage(viewerSent[0]!).states)).not.toContain('@')
    expect(editorSent[0]).toBe(message)

    // Undecodable awareness is dropped, never forwarded unredacted.
    viewer.send(hocuspocusMessage('deck1', HOCUSPOCUS_AWARENESS_MESSAGE, Uint8Array.from([9])))
    expect(viewerSent).toHaveLength(1)
    expect(log.warn).toHaveBeenCalledOnce()

    awareness.destroy()
    doc.destroy()
    document.destroy()
  })
})

describe('end to end over WebSocket', () => {
  let world: AgentWorld
  afterEach(async () => {
    await world.destroy()
  })

  function stateOf(
    client: { provider: { awareness: Awareness | null } },
    clientId: number,
  ): Record<string, unknown> | undefined {
    return client.provider.awareness!.getStates().get(clientId) as
      | Record<string, unknown>
      | undefined
  }

  it('a viewer never receives the sub or email another peer published; an editor does', async () => {
    world = await createAgentWorld()
    world.createDeck('deck1')
    world.grant('deck1', 'ed', 'editor')
    world.grant('deck1', 'ann', 'editor')
    world.grant('deck1', 'share:abcd1234', 'viewer')
    // The viewer joins first, so it gets the state as a broadcast; the late
    // editor gets it through the initial awareness of its connection.
    const viewer = await world.connect('deck1', 'share:abcd1234')
    const leaky = await world.connect('deck1', 'ed')
    leaky.provider.awareness!.setLocalState(LEAKY_STATE)
    const leakyId = leaky.doc.clientID

    await eventually(() => stateOf(viewer, leakyId) !== undefined)
    const seen = stateOf(viewer, leakyId)!
    expect(JSON.stringify(seen)).not.toContain('108234567890123456789')
    expect(JSON.stringify(seen)).not.toContain('@')
    expect(seen['user']).toEqual({
      id: `peer:${leakyId}`,
      name: REDACTED_PEER_NAME,
      color: 'hsl(1, 70%, 55%)',
    })

    // A viewer connecting later gets the current states redacted too.
    const lateViewer = await world.connect('deck1', 'share:abcd1234')
    await eventually(() => stateOf(lateViewer, leakyId) !== undefined)
    expect(JSON.stringify(stateOf(lateViewer, leakyId))).not.toContain('@')

    const editor = await world.connect('deck1', 'ann')
    await eventually(() => stateOf(editor, leakyId) !== undefined)
    expect(stateOf(editor, leakyId)).toEqual(LEAKY_STATE)
  })
})
