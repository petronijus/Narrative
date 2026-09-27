/**
 * services/editor.test.ts — `editor.context`, `editor.show` and
 * `editor.present.link` through the ServerHost, with real editor
 * connections of two different users on the same deck.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EDITOR_SHOW_MESSAGE_TYPE } from '@narrative/commands'
import type { PeerAwarenessState } from '@narrative/shared'
import {
  createAgentWorld,
  eventually,
  settle,
  type AgentWorld,
  type TestClient,
} from '../test-support/agentWorld.js'
import type { HostRequest, HostResult } from '../agent/serverHost.js'

let world: AgentWorld

beforeEach(async () => {
  world = await createAgentWorld()
  world.createDeck('deck1')
  world.grant('deck1', 'alice', 'editor')
  world.grant('deck1', 'bob', 'editor')
  world.grant('deck1', 'viv', 'viewer')
})

afterEach(async () => {
  await world.destroy()
})

function exec(userId: string, invocation: HostRequest['invocation']): Promise<HostResult> {
  return world.runtime.host.execute({
    actor: { userId },
    surface: 'mcp',
    sessionKey: `mcp:${userId}`,
    target: { deckId: 'deck1' },
    ...(invocation === undefined ? {} : { invocation }),
  })
}

function publish(client: TestClient, state: Partial<PeerAwarenessState>): void {
  client.provider.awareness!.setLocalState({
    user: { id: 'x', name: 'x', color: 'red' },
    selectedObjectIds: [],
    cursor: null,
    ...state,
  })
}

function serverSees(userCount: number): () => boolean {
  return () =>
    (world.hocuspocus.documents.get('deck1')?.awareness.getStates().size ?? 0) >= userCount
}

describe('editor.context', () => {
  it("reads the calling user's own editor, not a collaborator's", async () => {
    const alice = await world.connect('deck1', 'alice')
    const bob = await world.connect('deck1', 'bob')
    publish(alice, { activeSlideId: 's1', selectedObjectIds: ['r1', 'r2'] })
    publish(bob, { activeSlideId: 's2', selectedObjectIds: [] })
    await eventually(serverSees(2))

    const out = await exec('alice', { command: 'editor.context', input: {} })
    expect(out).toMatchObject({
      ok: true,
      result: {
        open: true,
        activeSlideId: 's1',
        activeSlideIndex: 0,
        selectedObjectIds: ['r1', 'r2'],
      },
    })
    const forBob = await exec('bob', { command: 'editor.context', input: {} })
    expect(forBob).toMatchObject({ ok: true, result: { activeSlideId: 's2', activeSlideIndex: 1 } })
  })

  it('lists every tab of the user, most recently active first', async () => {
    const tab1 = await world.connect('deck1', 'alice')
    const tab2 = await world.connect('deck1', 'alice')
    publish(tab1, { activeSlideId: 's1' })
    await eventually(serverSees(1))
    await settle(20)
    publish(tab2, { activeSlideId: 's2', selectedObjectIds: [] })
    await eventually(serverSees(2))
    const out = await exec('alice', { command: 'editor.context', input: {} })
    expect(out.ok && (out.result as { editors: unknown[] }).editors).toHaveLength(2)
    expect(out).toMatchObject({ result: { activeSlideId: 's2' } })
  })

  it('reports no open editor when the user has none (and loads nothing to find out)', async () => {
    const out = await exec('alice', { command: 'editor.context', input: {} })
    expect(out).toMatchObject({
      ok: true,
      result: { open: false, activeSlideId: null, selectedObjectIds: [], editors: [] },
    })
    expect(world.hocuspocus.getDocumentsCount()).toBe(0)
  })

  it("ignores a state another user's connection forged under the caller's client id", async () => {
    const alice = await world.connect('deck1', 'alice')
    const bob = await world.connect('deck1', 'bob')
    publish(alice, { activeSlideId: 's1', selectedObjectIds: ['r1'] })
    publish(bob, { activeSlideId: 's2', selectedObjectIds: [] })
    await eventually(serverSees(2))

    // Bob's client writes alice's client id with a higher clock: the update
    // goes out over bob's socket exactly as a relayed awareness change would.
    const aliceId = alice.provider.awareness!.clientID
    const bobAwareness = bob.provider.awareness!
    const clock = (bobAwareness.meta.get(aliceId)?.clock ?? 0) + 5
    bobAwareness.states.set(aliceId, {
      user: { id: 'alice', name: 'alice', color: 'red' },
      selectedObjectIds: ['r3'],
      cursor: null,
      activeSlideId: 's2',
    })
    bobAwareness.meta.set(aliceId, { clock, lastUpdated: Date.now() })
    bobAwareness.emit('update', [{ added: [], updated: [aliceId], removed: [] }, 'forged'])
    const serverDoc = world.hocuspocus.documents.get('deck1')!
    await eventually(
      () =>
        (serverDoc.awareness.getStates().get(aliceId) as PeerAwarenessState | undefined)
          ?.activeSlideId === 's2',
    )

    // The forged state is on the server, but editor.context does not use it…
    const forged = await exec('alice', { command: 'editor.context', input: {} })
    expect(forged).toMatchObject({
      ok: true,
      result: { open: false, activeSlideId: null, selectedObjectIds: [], editors: [] },
    })
    // …nor does it count as bob's.
    const forBob = await exec('bob', { command: 'editor.context', input: {} })
    expect(forBob.ok && (forBob.result as { editors: unknown[] }).editors).toHaveLength(1)
    expect(forBob).toMatchObject({ result: { activeSlideId: 's2', selectedObjectIds: [] } })

    // Alice's own next update restores her context.
    publish(alice, { activeSlideId: 's1', selectedObjectIds: ['r2'] })
    await eventually(
      () =>
        (serverDoc.awareness.getStates().get(aliceId) as PeerAwarenessState | undefined)
          ?.activeSlideId === 's1',
    )
    const restored = await exec('alice', { command: 'editor.context', input: {} })
    expect(restored).toMatchObject({ result: { activeSlideId: 's1', selectedObjectIds: ['r2'] } })
  })

  it('tolerates editors that do not publish an active slide yet', async () => {
    const alice = await world.connect('deck1', 'alice')
    publish(alice, { selectedObjectIds: ['r3'] })
    await eventually(serverSees(1))
    const out = await exec('alice', { command: 'editor.context', input: {} })
    expect(out).toMatchObject({
      result: { open: true, activeSlideId: null, selectedObjectIds: ['r3'] },
    })
  })
})

describe('editor.show', () => {
  /**
   * The `editor.show` messages a client received. Every signed-in connection
   * also gets its agent principal key as a stateless message on connect
   * (hocuspocus/agentPrincipal.ts); that one is not what these tests count.
   */
  const shows = (client: { stateless: string[] }): string[] =>
    client.stateless.filter(
      (p) => (JSON.parse(p) as { type?: unknown }).type === EDITOR_SHOW_MESSAGE_TYPE,
    )

  it("reaches only the calling user's connections", async () => {
    const alice = await world.connect('deck1', 'alice')
    const bob = await world.connect('deck1', 'bob')
    const out = await exec('alice', {
      command: 'editor.show',
      input: { slide: { index: 0 }, objects: ['r2'] },
    })
    expect(out).toMatchObject({ ok: true, result: { delivered: 1, slideId: 's1' } })
    await eventually(() => shows(alice).length === 1)
    await settle()
    expect(JSON.parse(shows(alice)[0]!)).toEqual({
      type: EDITOR_SHOW_MESSAGE_TYPE,
      slideId: 's1',
      objectIds: ['r2'],
    })
    expect(shows(bob)).toHaveLength(0)
  })

  it('is allowed for viewers (it writes nothing) and delivers 0 when no editor is open', async () => {
    const out = await exec('viv', { command: 'editor.show', input: { slide: 's2' } })
    expect(out).toMatchObject({ ok: true, result: { delivered: 0, slideId: 's2' } })
  })

  it('refuses refs that do not exist instead of pointing the editor at nothing', async () => {
    const alice = await world.connect('deck1', 'alice')
    const out = await exec('alice', {
      command: 'editor.show',
      input: { slide: 's1', objects: ['ghost'] },
    })
    expect(out).toMatchObject({ ok: false, error: { code: 'not_found' } })
    await settle()
    expect(shows(alice)).toHaveLength(0)
  })
})

describe('editor.present.link', () => {
  it('links present mode at the requested slide', async () => {
    const out = await exec('viv', { command: 'editor.present.link', input: { slide: 's2' } })
    expect(out).toMatchObject({
      ok: true,
      result: { url: 'https://narrative.test/deck/deck1/present?slide=2', slideNumber: 2 },
    })
  })
})
