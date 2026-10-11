/**
 * services/runs.test.ts — agent runs, per-run revert and the agent's
 * presence peer, against a real Hocuspocus instance with real WebSocket
 * clients playing the people editing alongside the agent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { getSlideObjectsCtx } from '@narrative/slide-model'
import type { PeerAwarenessState } from '@narrative/shared'
import {
  createAgentWorld,
  eventually,
  settle,
  type AgentWorld,
  type AgentWorldOptions,
  type TestClient,
} from '../test-support/agentWorld.js'
import type { HostRequest, HostResult } from '../agent/serverHost.js'
import {
  agentPeerInfo,
  agentPeerName,
  createAgentPrincipalKeys,
  sanitizePeerLabel,
} from '../agent/presence.js'
import { sweepAgentRunRetention, AGENT_RUN_RETENTION_MS } from '../agent/runtime.js'
import { createMemoryRunStore } from '../agent/runStore.js'

let world: AgentWorld

async function setup(opts: AgentWorldOptions = {}): Promise<void> {
  world = await createAgentWorld(opts)
  world.createDeck('deck1')
  world.grant('deck1', 'ed', 'editor')
  world.grant('deck1', 'human', 'editor')
}

afterEach(async () => {
  await world.destroy()
})

function exec(req: Partial<HostRequest>): Promise<HostResult> {
  return world.runtime.host.execute({
    actor: { userId: 'ed' },
    surface: 'mcp',
    sessionKey: 'mcp:s1',
    clientName: 'claude-code',
    target: { deckId: 'deck1' },
    ...req,
  })
}

async function must(req: Partial<HostRequest>): Promise<HostResult & { ok: true }> {
  const out = await exec(req)
  if (!out.ok) throw new Error(`${out.command} failed: ${out.error.code} ${out.error.message}`)
  return out
}

function objectsOf(doc: Y.Doc, slideId = 's1'): Y.Map<unknown>[] {
  return getSlideObjectsCtx({ doc, slides: doc.getArray('slides') }, slideId)!.objects.toArray()
}

function prop(doc: Y.Doc, objectId: string, key: string): unknown {
  return objectsOf(doc)
    .find((m) => m.get('id') === objectId)
    ?.get(key)
}

/** A person's edit, made in their own editor and synced over the socket. */
function humanEdit(client: TestClient, objectId: string, key: string, value: unknown): void {
  const m = objectsOf(client.doc).find((o) => o.get('id') === objectId)!
  client.doc.transact(() => m.set(key, value), 'human')
}

const update = (object: string, patch: Record<string, unknown>) => ({
  command: 'object.update',
  input: { slide: 's1', object, patch },
})

describe('revert', () => {
  beforeEach(() => setup())

  it("undoes only the run's changes and keeps what a person edited in between", async () => {
    const human = await world.connect('deck1', 'human')
    const serverDoc = world.hocuspocus.documents.get('deck1')!

    const first = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    // The person edits the same object (another property) and another object.
    humanEdit(human, 'r1', 'y', 555)
    humanEdit(human, 'r2', 'x', 999)
    await eventually(() => prop(serverDoc, 'r2', 'x') === 999 && prop(serverDoc, 'r1', 'y') === 555)
    const created = await must({
      invocation: {
        command: 'object.create',
        input: { slide: 's1', object: { type: 'rectangle', x: 5 } },
      },
    })
    const newId = (created.result as { objectId: string }).objectId
    await must({ invocation: update('r3', { opacity: 0.5 }) })
    await eventually(
      () => objectsOf(human.doc).length === 4 && prop(human.doc, 'r3', 'opacity') === 0.5,
    )

    const updatesBefore = human.remoteUpdates.length
    const reverted = await world.runtime.runs.revertRun({
      userId: 'human',
      target: { kind: 'deck', deckId: 'deck1' },
      runId: first.runId!,
    })
    expect(reverted).toEqual({
      runId: first.runId,
      revertedChanges: 3,
      remainingChanges: 0,
      status: 'reverted',
    })

    await eventually(() => objectsOf(human.doc).length === 3)
    await settle()
    // One transaction for the whole revert: one update for editors.
    expect(human.remoteUpdates.length - updatesBefore).toBe(1)
    // The agent's changes are gone…
    expect(prop(human.doc, 'r1', 'fill')).toBe(0x4060e0)
    expect(prop(human.doc, 'r3', 'opacity')).toBe(1)
    expect(objectsOf(human.doc).some((m) => m.get('id') === newId)).toBe(false)
    // …the person's edits stay.
    expect(prop(human.doc, 'r1', 'y')).toBe(555)
    expect(prop(human.doc, 'r2', 'x')).toBe(999)

    expect(world.store.runs.get(first.runId!)).toMatchObject({
      status: 'reverted',
      revertedBySub: 'human',
    })
  })

  it('does not restore a value a person overwrote after the agent', async () => {
    const human = await world.connect('deck1', 'human')
    const serverDoc = world.hocuspocus.documents.get('deck1')!
    const run = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    await eventually(() => prop(human.doc, 'r1', 'fill') === 0xff0000)
    humanEdit(human, 'r1', 'fill', 0x00ff00)
    await eventually(() => prop(serverDoc, 'r1', 'fill') === 0x00ff00)
    await world.runtime.runs.revertRun({
      userId: 'ed',
      target: { kind: 'deck', deckId: 'deck1' },
      runId: run.runId!,
    })
    await settle()
    expect(prop(serverDoc, 'r1', 'fill')).toBe(0x00ff00)
  })

  it('reverts only the last N changes of a run', async () => {
    const run = await must({ invocation: update('r1', { fill: '#111111' }) })
    await must({ invocation: update('r2', { fill: '#222222' }) })
    await must({ invocation: { command: 'query.deck', input: {} } }) // a read: not a change
    await must({ invocation: update('r3', { fill: '#333333' }) })
    const doc = world.hocuspocus.documents.get('deck1')!

    const out = await world.runtime.runs.revertRun({
      userId: 'ed',
      target: { kind: 'deck', deckId: 'deck1' },
      runId: run.runId!,
      lastOps: 2,
    })
    expect(out).toEqual({
      runId: run.runId,
      revertedChanges: 2,
      remainingChanges: 1,
      status: 'open',
    })
    expect(prop(doc, 'r1', 'fill')).toBe(0x111111)
    expect(prop(doc, 'r2', 'fill')).toBe(0x4060e0)
    expect(prop(doc, 'r3', 'fill')).toBe(0x4060e0)

    const [summary] = await world.runtime.runs.listRuns({
      userId: 'ed',
      target: { kind: 'deck', deckId: 'deck1' },
      limit: 10,
    })
    expect(summary).toMatchObject({
      id: run.runId,
      opCount: 4,
      changeCount: 3,
      revertibleChanges: 1,
      revertible: true,
    })
  })

  it('reverts one request without touching the next (agent.startRun splits runs)', async () => {
    const r1 = await must({
      invocation: { command: 'agent.startRun', input: { request: 'Make r1 red' } },
    })
    const firstRun = (r1.result as { runId: string }).runId
    expect(r1.runId).toBe(firstRun) // startRun is logged in the run it opened
    await must({ invocation: update('r1', { fill: '#ff0000' }) })
    const r2 = await must({
      invocation: { command: 'agent.startRun', input: { request: 'Make r2 green' } },
    })
    const secondRun = (r2.result as { runId: string }).runId
    const g = await must({ invocation: update('r2', { fill: '#00ff00' }) })
    expect(g.runId).toBe(secondRun)

    const doc = world.hocuspocus.documents.get('deck1')!
    await must({ invocation: { command: 'agent.revert', input: { runId: firstRun } } })
    expect(prop(doc, 'r1', 'fill')).toBe(0x4060e0)
    expect(prop(doc, 'r2', 'fill')).toBe(0x00ff00)

    const runs = await world.runtime.runs.listRuns({
      userId: 'ed',
      target: { kind: 'deck', deckId: 'deck1' },
      limit: 10,
    })
    expect(runs.map((r) => [r.request, r.status, r.revertible])).toEqual([
      ['Make r2 green', 'open', true],
      ['Make r1 red', 'reverted', false],
    ])
    expect(runs[1]!.notRevertibleReason).toBe('reverted')
  })

  it('refuses a second revert, a run of another deck, and an unknown run', async () => {
    world.createDeck('deck2')
    world.grant('deck2', 'ed', 'editor')
    const run = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    await must({ invocation: { command: 'agent.revert', input: { runId: run.runId } } })
    const again = await exec({
      invocation: { command: 'agent.revert', input: { runId: run.runId } },
    })
    expect(again).toMatchObject({ ok: false, error: { code: 'conflict' } })
    const otherDeck = await exec({
      target: { deckId: 'deck2' },
      invocation: { command: 'agent.revert', input: { runId: run.runId } },
    })
    expect(otherDeck).toMatchObject({ ok: false, error: { code: 'not_found' } })
    const unknown = await exec({
      invocation: { command: 'agent.revert', input: { runId: 'run_nope' } },
    })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('needs the editor role', async () => {
    world.grant('deck1', 'vi', 'viewer')
    const run = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    const out = await exec({
      actor: { userId: 'vi', kind: 'human' },
      invocation: { command: 'agent.revert', input: { runId: run.runId } },
    })
    expect(out).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })
})

describe('the state before a run (query.render compare)', () => {
  beforeEach(() => setup())

  it('is the document as it was just before the run first wrote it, kept with the history', async () => {
    // The fixture's r1 is 0x4060e0 (the revert tests restore it).
    const first = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    await must({ invocation: update('r2', { opacity: 0.5 }) })
    const before = world.runtime.runs.stateBefore(first.runId!)
    expect(before?.document).toEqual({ kind: 'deck', deckId: 'deck1' })
    const doc = new Y.Doc()
    Y.applyUpdate(doc, before!.update)
    // Neither of the run's writes: the first one's state, not the second's.
    expect(prop(doc, 'r1', 'fill')).toBe(0x4060e0)
    expect(prop(doc, 'r2', 'opacity')).toBe(1)
    // A run that wrote nothing, or an unknown one, has none.
    expect(world.runtime.runs.stateBefore('no-such-run')).toBeNull()
  })

  it('is let go when the run closes (only the current run is compared with)', async () => {
    const first = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    expect(world.runtime.runs.stateBefore(first.runId!)).not.toBeNull()
    await must({ invocation: { command: 'agent.startRun', input: { request: 'next' } } })
    expect(world.runtime.runs.stateBefore(first.runId!)).toBeNull()
  })

  it('lets the oldest go past the process-wide budget, and keeps none over 8 MB', async () => {
    await world.destroy()
    await setup({ beforeStatesBudgetBytes: 1 })
    world.createDeck('deck2')
    world.grant('deck2', 'ed', 'editor')
    const first = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    expect(world.runtime.runs.stateBefore(first.runId!)).not.toBeNull()
    // A second deck's run: within a 1-byte budget only the newest is kept.
    const second = await must({
      target: { deckId: 'deck2' },
      invocation: update('r1', { fill: '#00ff00' }),
    })
    expect(world.runtime.runs.stateBefore(second.runId!)).not.toBeNull()
    expect(world.runtime.runs.stateBefore(first.runId!)).toBeNull()
  })

  it('goes with the history when the run is reverted', async () => {
    const first = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    await world.runtime.runs.revertRun({
      userId: 'ed',
      target: { kind: 'deck', deckId: 'deck1' },
      runId: first.runId!,
    })
    expect(world.runtime.runs.stateBefore(first.runId!)).toBeNull()
  })
})

describe('after a revert of a deck', () => {
  it('catches up old folder media once the revert changed the deck; a failure leaves the revert standing', async () => {
    // A revert can bring back pictures of a folder the deck has left since
    // the run (services/localiseMedia.ts): the hook copies them into it.
    const afterDeckRevert = vi.fn(async (_deckId: string) => undefined)
    await setup({ afterDeckRevert })
    const run = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    await must({ invocation: { command: 'agent.revert', input: { runId: run.runId } } })
    expect(afterDeckRevert).toHaveBeenCalledExactlyOnceWith('deck1')

    afterDeckRevert.mockRejectedValueOnce(new Error('storage down'))
    const second = await must({ invocation: update('r2', { fill: '#00ff00' }) })
    const out = await world.runtime.runs.revertRun({
      userId: 'ed',
      target: { kind: 'deck', deckId: 'deck1' },
      runId: second.runId!,
    })
    expect(out).toMatchObject({ revertedChanges: 1, status: 'reverted' })
    expect(prop(world.hocuspocus.documents.get('deck1')!, 'r2', 'fill')).toBe(0x4060e0)
  })
})

describe('the known limit: revert needs the loaded document', () => {
  beforeEach(() => setup({ documentLingerMs: 0 }))

  it('keeps the document loaded while the run is open, and reports "unloaded" honestly after', async () => {
    const run = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    // Nobody has the deck open, but the open run holds it.
    expect(world.hocuspocus.documents.has('deck1')).toBe(true)

    await world.runtime.host.endSession('mcp:s1')
    await eventually(() => !world.hocuspocus.documents.has('deck1'))

    const [summary] = await world.runtime.runs.listRuns({
      userId: 'ed',
      target: { kind: 'deck', deckId: 'deck1' },
      limit: 10,
    })
    expect(summary).toMatchObject({
      status: 'closed',
      revertible: false,
      notRevertibleReason: 'unloaded',
      changeCount: 1,
    })

    const out = await exec({ invocation: { command: 'agent.revert', input: { runId: run.runId } } })
    expect(out).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(out.ok ? '' : out.error.message).toContain('document was unloaded')
    // The change itself persisted.
    const stored = new Y.Doc()
    Y.applyUpdate(stored, world.persistence.snapshots.get('deck1')!)
    expect(prop(stored, 'r1', 'fill')).toBe(0xff0000)
  })

  it('stays revertible after the run closes while a person keeps the deck open', async () => {
    const human = await world.connect('deck1', 'human')
    const run = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    await world.runtime.host.endSession('mcp:s1')
    await settle(50)
    const out = await world.runtime.runs.revertRun({
      userId: 'human',
      target: { kind: 'deck', deckId: 'deck1' },
      runId: run.runId!,
    })
    expect(out.status).toBe('reverted')
    await eventually(() => prop(human.doc, 'r1', 'fill') === 0x4060e0)
  })
})

describe('run lifecycle', () => {
  it('splits a run after the idle timeout', async () => {
    await setup({ runIdleMs: 40 })
    const a = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    await settle(80)
    expect(world.store.runs.get(a.runId!)?.status).toBe('closed')
    const b = await must({ invocation: update('r1', { fill: '#00ff00' }) })
    expect(b.runId).not.toBe(a.runId)
  })

  it("caps a user's open runs, closing the least recently active", async () => {
    await setup({ maxOpenRunsPerUser: 2 })
    const a = await must({ sessionKey: 'mcp:a', invocation: update('r1', { fill: '#111111' }) })
    const b = await must({ sessionKey: 'mcp:b', invocation: update('r1', { fill: '#222222' }) })
    const c = await must({ sessionKey: 'mcp:c', invocation: update('r1', { fill: '#333333' }) })
    expect(world.runtime.runs.openRunCount()).toBe(2)
    expect(world.store.runs.get(a.runId!)?.status).toBe('closed')
    expect(world.store.runs.get(b.runId!)?.status).toBe('open')
    expect(world.store.runs.get(c.runId!)?.status).toBe('open')
  })

  it("refuses to attach another session to a run, even the same user's", async () => {
    await setup()
    const run = await must({ sessionKey: 'mcp:a', invocation: update('r1', { fill: '#111111' }) })
    const other = await exec({
      sessionKey: 'mcp:b',
      runId: run.runId!,
      invocation: update('r1', { fill: '#222222' }),
    })
    expect(other).toMatchObject({ ok: false, error: { code: 'conflict' } })
    // The same session still can.
    const same = await exec({
      sessionKey: 'mcp:a',
      runId: run.runId!,
      invocation: update('r1', { fill: '#333333' }),
    })
    expect(same).toMatchObject({ ok: true, runId: run.runId })
  })

  it('logs op inputs and results with file bytes and URL secrets redacted', async () => {
    await setup()
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    await exec({
      invocation: {
        command: 'object.update',
        input: {
          slide: 's1',
          object: 'r1',
          patch: { hyperlink: 'https://example.com/p?token=s3cr3t#x' },
          file: { base64: png },
        },
      },
    })
    const op = world.store.ops.at(-1)!
    const logged = JSON.stringify(op.input)
    expect(logged).not.toContain('s3cr3t')
    expect(logged).not.toContain(png)
    expect(op.input).toMatchObject({
      patch: { hyperlink: 'https://example.com/p' },
      file: { base64: { redacted: 'base64', bytes: 8 } },
    })
  })

  it('closes runs left open by a previous process at startup', async () => {
    await setup()
    const run = await must({ invocation: update('r1', { fill: '#ff0000' }) })
    const closed = await world.store.closeAllOpen(new Date())
    expect(closed).toBe(1)
    expect(world.store.runs.get(run.runId!)?.status).toBe('closed')
  })
})

describe('presence', () => {
  beforeEach(() => setup({ presenceIdleMs: 60 }))

  function agentPeer(client: TestClient): PeerAwarenessState | undefined {
    for (const state of client.provider.awareness!.getStates().values()) {
      const s = state as PeerAwarenessState
      if (s.agent !== undefined) return s
    }
    return undefined
  }

  it('shows the agent as "Claude (MCP)" selecting what its last command touched, then clears it', async () => {
    world.store.userNames.set('ed', 'Ed Example')
    const human = await world.connect('deck1', 'human')
    const run = await must({ invocation: update('r2', { fill: '#ff0000' }) })
    await eventually(() => agentPeer(human) !== undefined)
    const key = world.principalKeys.keyFor('deck1', 'ed')
    expect(agentPeer(human)).toMatchObject({
      user: { name: 'Claude (MCP)' },
      selectedObjectIds: ['r2'],
      activeSlideId: 's1',
      agent: {
        runId: run.runId,
        surface: 'mcp',
        principalName: 'Ed Example',
        principalKey: key,
        // Rollout alias for older editors: the opaque key, never the sub.
        onBehalfOf: key,
      },
    })
    // Awareness reaches share-link viewers: the user's account id is nowhere in it.
    expect(JSON.stringify(agentPeer(human))).not.toContain('"ed"')

    await must({
      invocation: { command: 'object.create', input: { slide: 's2', object: { type: 'ellipse' } } },
    })
    await eventually(() => agentPeer(human)?.activeSlideId === 's2')
    expect(agentPeer(human)!.selectedObjectIds).toHaveLength(1)

    // Idle → gone.
    await eventually(() => agentPeer(human) === undefined, 1_000)
  })

  it("names an API peer after the user's display name and a sanitised client, never the sub", async () => {
    world.store.userNames.set('ed', 'Ed Example')
    const human = await world.connect('deck1', 'human')
    await must({
      surface: 'api',
      sessionKey: 'api:ed:token:t1',
      clientName: 'deploy\u202E-bot <b>\n' + 'x'.repeat(80),
      invocation: update('r2', { fill: '#ff0000' }),
    })
    await eventually(() => agentPeer(human) !== undefined)
    const name = agentPeer(human)!.user.name
    expect(name.startsWith("Ed Example's agent (deploy-bot b ")).toBe(true)
    expect(name).not.toMatch(/[\u202E<>\n]/)
  })

  it('removes the peer when the run is reverted', async () => {
    const human = await world.connect('deck1', 'human')
    const run = await must({ invocation: update('r2', { fill: '#ff0000' }) })
    await eventually(() => agentPeer(human) !== undefined)
    await world.runtime.runs.revertRun({
      userId: 'human',
      target: { kind: 'deck', deckId: 'deck1' },
      runId: run.runId!,
    })
    await eventually(() => agentPeer(human) === undefined)
  })
})

/** HMAC-SHA256 test vector, computed independently with node:crypto. */
const PINNED_KEY = 'suMEL2lykgqwQ5l03rNxzW'

describe('agent principal', () => {
  const secret = 'unit-test-secret-for-agent-principal-keys'
  const keys = createAgentPrincipalKeys(secret)

  it('is an HMAC-SHA256 of the shared key input with the server secret (pinned vector)', () => {
    // base64url(HMAC-SHA256(secret, "narrative:agent-principal:v2\ndeck_abc\n1082…"))[:22]
    expect(keys.keyFor('deck_abc', '108234567890123456789')).toBe(PINNED_KEY)
    expect(keys.keyFor('deck_abc', '108234567890123456789')).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('depends on the secret, so knowing a sub is not enough to compute it', () => {
    const other = createAgentPrincipalKeys('another-secret-of-at-least-32-characters')
    expect(other.keyFor('deck_abc', '108234567890123456789')).not.toBe(PINNED_KEY)
  })

  it('refuses a short secret', () => {
    expect(() => createAgentPrincipalKeys('too-short')).toThrow(/at least 32/)
  })

  it('is scoped to the document, so one person is not linkable across decks', () => {
    expect(keys.keyFor('deck_a', 'u1')).not.toBe(keys.keyFor('deck_b', 'u1'))
    expect(keys.keyFor('deck_a', 'u1')).not.toBe(keys.keyFor('deck_a', 'u2'))
  })

  it('carries the sanitised display name, null (not the email) without one, and never the sub', () => {
    const sub = '108234567890123456789'
    const info = agentPeerInfo(keys, 'deck_abc', {
      runId: 'run_1',
      userId: sub,
      userName: ' Petr\u202E <Janda> ',
      surface: 'api',
    })
    expect(info).toEqual({
      runId: 'run_1',
      surface: 'api',
      principalName: 'Petr Janda',
      principalKey: PINNED_KEY,
      onBehalfOf: PINNED_KEY,
    })
    expect(JSON.stringify(info)).not.toContain(sub)
    expect(
      agentPeerInfo(keys, 'd', { runId: 'r', userId: sub, userName: null, surface: 'mcp' })
        .principalName,
    ).toBeNull()
  })
})

describe('agent peer names', () => {
  it('sanitises and truncates caller-supplied labels', () => {
    expect(sanitizePeerLabel('  a\u0000b\u200Bc\u202Ed  <x>`y`  ', 40)).toBe('abcd xy')
    expect(sanitizePeerLabel('tab\tand\nnewline', 40)).toBe('tab and newline')
    expect(sanitizePeerLabel('\u202E\u200B', 40)).toBeNull()
    expect(sanitizePeerLabel(null, 40)).toBeNull()
    const long = sanitizePeerLabel('é'.repeat(50), 40)!
    expect(Array.from(long)).toHaveLength(40)
    expect(long.endsWith('…')).toBe(true)
  })

  it('uses the display name for API peers, with fallbacks, and keeps "Claude (MCP)"', () => {
    expect(agentPeerName({ surface: 'mcp', clientName: 'claude-code', userName: 'Petr' })).toBe(
      'Claude (MCP)',
    )
    expect(agentPeerName({ surface: 'api', clientName: 'curl', userName: 'Petr' })).toBe(
      "Petr's agent (curl)",
    )
    expect(agentPeerName({ surface: 'api', clientName: null, userName: null })).toBe(
      "Someone's agent (API)",
    )
  })
})

describe('run retention', () => {
  const DAY = 24 * 60 * 60 * 1000
  const quiet = { info: () => undefined, error: () => undefined }

  it('deletes closed runs idle past the window with their ops, keeping open and recent ones', async () => {
    const store = createMemoryRunStore()
    const now = new Date('2026-09-27T00:00:00Z')
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY)
    const add = async (id: string, daysAgo: number, status: 'open' | 'closed' | 'reverted') => {
      await store.insertRun({
        id,
        userSub: 'u',
        deckId: 'd',
        componentId: null,
        surface: 'mcp',
        clientName: null,
        request: null,
        createdAt: at(daysAgo),
      })
      if (status === 'closed') await store.closeRun(id, at(daysAgo))
      if (status === 'reverted') await store.markReverted(id, 'u', at(daysAgo))
      await store.insertOp({
        runId: id,
        seq: 1,
        command: 'query.deck',
        input: {},
        target: {},
        createdAt: at(daysAgo),
      })
    }
    await add('old-closed', 91, 'closed')
    await add('old-reverted', 120, 'reverted')
    await add('old-open', 200, 'open')
    await add('recent', 89, 'closed')

    const deleted = await sweepAgentRunRetention(store, now, quiet)
    expect(deleted).toBe(2)
    expect([...store.runs.keys()].sort()).toEqual(['old-open', 'recent'])
    expect(store.ops.map((o) => o.runId).sort()).toEqual(['old-open', 'recent'])
    expect(AGENT_RUN_RETENTION_MS).toBe(90 * DAY)
  })

  it('never throws when the store fails', async () => {
    const error = vi.fn()
    const failing = { deleteRunsInactiveBefore: () => Promise.reject(new Error('db down')) }
    await expect(
      sweepAgentRunRetention(failing, new Date(), { info: () => undefined, error }),
    ).resolves.toBe(0)
    expect(error).toHaveBeenCalled()
  })
})
