/**
 * agent/serverHost.test.ts — the ServerHost against a real Hocuspocus
 * instance and real WebSocket clients (test-support/agentWorld.ts):
 *   - authorisation happens before any document is opened (no IDOR through
 *     the direct connection, which skips onAuthenticate);
 *   - viewers read, only editors write — and a refused write loads nothing;
 *   - each command, and each batch, reaches connected editors as exactly ONE
 *     update, attributed on the server to the run's origin;
 *   - every op of a run is logged, failures included.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { agentOrigin, isAgentOrigin, getSlideObjectsCtx } from '@narrative/slide-model'
import {
  createAgentWorld,
  eventually,
  settle,
  type AgentWorld,
} from '../test-support/agentWorld.js'
import type { HostRequest, HostResult } from './serverHost.js'

let world: AgentWorld

beforeEach(async () => {
  world = await createAgentWorld()
  world.createDeck('deck1')
  world.grant('deck1', 'ed', 'editor')
  world.grant('deck1', 'vi', 'viewer')
})

afterEach(async () => {
  await world.destroy()
})

function exec(req: Partial<HostRequest> & Pick<HostRequest, 'actor'>): Promise<HostResult> {
  return world.runtime.host.execute({
    surface: 'mcp',
    sessionKey: `mcp:${req.actor.userId}`,
    target: { deckId: 'deck1' },
    ...req,
  })
}

const recolour = (fill: string, object = 'r1') => ({
  command: 'object.update',
  input: { slide: 's1', object, patch: { fill } },
})

function fillOf(doc: Y.Doc, objectId: string): unknown {
  const objects = getSlideObjectsCtx({ doc, slides: doc.getArray('slides') }, 's1')!
  return objects.objects
    .toArray()
    .find((m) => m.get('id') === objectId)
    ?.get('fill')
}

describe('authorisation comes first', () => {
  it('refuses a user without access before opening the document or opening a run', async () => {
    const out = await exec({ actor: { userId: 'stranger' }, invocation: recolour('#ff0000') })
    expect(out).toMatchObject({ ok: false, error: { code: 'forbidden' }, runId: null })
    expect(world.hocuspocus.getDocumentsCount()).toBe(0)
    expect(world.store.runs.size).toBe(0)
    expect(world.store.ops).toHaveLength(0)
  })

  it('lets a viewer read but refuses a viewer write without loading the document', async () => {
    const write = await exec({ actor: { userId: 'vi' }, invocation: recolour('#ff0000') })
    expect(write).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(world.hocuspocus.getDocumentsCount()).toBe(0)
    expect(world.store.runs.size).toBe(0)

    const read = await exec({
      actor: { userId: 'vi' },
      invocation: { command: 'query.deck', input: {} },
    })
    expect(read.ok).toBe(true)
    // A read opens no run, so nothing is logged.
    expect(world.store.runs.size).toBe(0)
  })

  it('never applies share links or other decks: access is per deck and per user', async () => {
    world.createDeck('deck2')
    const out = await exec({
      actor: { userId: 'ed' },
      target: { deckId: 'deck2' },
      invocation: recolour('#ff0000'),
    })
    expect(out).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('authorises component masters through the component, not a deck', async () => {
    world.createDeck('component:c1')
    const refused = await exec({
      actor: { userId: 'ed' },
      target: { componentId: 'c1' },
      invocation: { command: 'query.deck', input: {} },
    })
    expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(world.hocuspocus.getDocumentsCount()).toBe(0)

    world.grant('component:c1', 'ed', 'owner')
    const edited = await exec({
      actor: { userId: 'ed' },
      target: { componentId: 'c1' },
      invocation: recolour('#00ff00'),
    })
    expect(edited.ok).toBe(true)
    expect(world.store.runs.get(edited.runId!)).toMatchObject({ componentId: 'c1', deckId: null })
  })

  it('refuses a component master for a command that works on decks only, before any access check', async () => {
    world.createDeck('component:c1')
    world.grant('component:c1', 'ed', 'owner')
    const out = await exec({
      actor: { userId: 'ed' },
      target: { componentId: 'c1' },
      invocation: { command: 'share.links.list', input: {} },
    })
    expect(out).toMatchObject({
      ok: false,
      error: {
        code: 'no_target',
        message: expect.stringMatching(/decks only, not on a component master/),
      },
    })
    expect(world.hocuspocus.getDocumentsCount()).toBe(0)
  })

  it('rejects a target that does not fit the command scope', async () => {
    const out = await exec({
      actor: { userId: 'ed' },
      target: { deckId: 'deck1', folderId: 'f1' },
      invocation: recolour('#ff0000'),
    })
    expect(out).toMatchObject({ ok: false, error: { code: 'no_target' } })
  })

  it('reports unknown commands without opening anything', async () => {
    const out = await exec({
      actor: { userId: 'ed' },
      invocation: { command: 'object.teleport', input: {} },
    })
    expect(out).toMatchObject({ ok: false, error: { code: 'unknown_command' } })
    expect(world.hocuspocus.getDocumentsCount()).toBe(0)
  })
})

describe('single-transaction delivery', () => {
  it('sends connected editors exactly one update per command, attributed to the run', async () => {
    const human = await world.connect('deck1', 'ed')
    const serverDoc = world.hocuspocus.documents.get('deck1')!
    const origins: unknown[] = []
    serverDoc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin))

    const out = await exec({ actor: { userId: 'ed' }, invocation: recolour('#ff0000') })
    expect(out.ok).toBe(true)
    await eventually(() => fillOf(human.doc, 'r1') === 0xff0000)
    await settle()

    expect(human.remoteUpdates).toHaveLength(1)
    expect(origins).toHaveLength(1)
    expect(isAgentOrigin(origins[0])).toBe(true)
    expect(origins[0]).toBe(agentOrigin(out.runId!))
  })

  it('sends one update for a whole batch', async () => {
    const human = await world.connect('deck1', 'ed')
    const out = await exec({
      actor: { userId: 'ed' },
      batch: {
        ops: [
          recolour('#111111', 'r1'),
          recolour('#222222', 'r2'),
          { command: 'slide.add', input: {} },
          { command: 'slide.rename', input: { slide: { index: 2 }, name: 'Summary' } },
        ],
      },
    })
    expect(out.ok).toBe(true)
    await eventually(() => human.doc.getArray('slides').length === 3)
    await settle()
    expect(human.remoteUpdates).toHaveLength(1)
    expect(fillOf(human.doc, 'r2')).toBe(0x222222)
    // The batch is one op of the run.
    expect(world.store.ops.map((o) => o.command)).toEqual(['ops.apply'])
  })

  it('leaves the document untouched when an atomic batch fails', async () => {
    const human = await world.connect('deck1', 'ed')
    const out = await exec({
      actor: { userId: 'ed' },
      batch: { ops: [recolour('#111111', 'r1'), recolour('#222222', 'missing')] },
    })
    expect(out).toMatchObject({ ok: false, error: { code: 'not_found', opIndex: 1 } })
    await settle()
    expect(human.remoteUpdates).toHaveLength(0)
    expect(fillOf(human.doc, 'r1')).toBe(0x4060e0)
  })

  it('reports a write as done when only the store after it fails (no duplicate retries)', async () => {
    const human = await world.connect('deck1', 'ed')
    world.persistence.failStores = 1
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args) // Hocuspocus logs the hook failure
    try {
      const out = await exec({ actor: { userId: 'ed' }, invocation: recolour('#ff0000') })
      expect(out.ok).toBe(true)
    } finally {
      console.error = original
    }
    await eventually(() => fillOf(human.doc, 'r1') === 0xff0000)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('persists agent writes to the store as they happen', async () => {
    const before = world.persistence.stores
    await exec({ actor: { userId: 'ed' }, invocation: recolour('#ff0000') })
    expect(world.persistence.stores).toBeGreaterThan(before)
    const stored = new Y.Doc()
    Y.applyUpdate(stored, world.persistence.snapshots.get('deck1')!)
    expect(fillOf(stored, 'r1')).toBe(0xff0000)
  })
})

describe('op log', () => {
  it('logs every op of a run in order — reads after the first write and failures included', async () => {
    // A read before any write belongs to no run.
    await exec({ actor: { userId: 'ed' }, invocation: { command: 'query.deck', input: {} } })
    expect(world.store.runs.size).toBe(0)

    const first = await exec({ actor: { userId: 'ed' }, invocation: recolour('#ff0000') })
    const read = await exec({
      actor: { userId: 'ed' },
      invocation: { command: 'query.slide', input: { slide: 's1' } },
    })
    const failed = await exec({ actor: { userId: 'ed' }, invocation: recolour('#00ff00', 'nope') })

    expect(read.runId).toBe(first.runId)
    expect(failed).toMatchObject({ ok: false, error: { code: 'not_found' }, runId: first.runId })
    const ops = world.store.ops.filter((o) => o.runId === first.runId)
    expect(ops.map((o) => [o.seq, o.command, o.error?.code ?? 'ok'])).toEqual([
      [1, 'object.update', 'ok'],
      [2, 'query.slide', 'ok'],
      [3, 'object.update', 'not_found'],
    ])
    expect(ops[0]).toMatchObject({
      input: { slide: 's1', object: 'r1', patch: { fill: '#ff0000' } },
      target: { deckId: 'deck1' },
      result: { updated: ['r1'] },
    })
    expect(world.store.runs.get(first.runId!)).toMatchObject({
      userSub: 'ed',
      surface: 'mcp',
      status: 'open',
    })
  })

  it('logs a refused op in the run the session already has on the deck', async () => {
    world.grant('deck1', 'ed', 'editor')
    const run = await exec({ actor: { userId: 'ed' }, invocation: recolour('#ff0000') })
    // A command above the caller's role: refused before anything runs, but audited.
    world.roles.set('deck1|ed', 'viewer')
    const refused = await exec({ actor: { userId: 'ed' }, invocation: recolour('#00ff00') })
    expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden' }, runId: run.runId })
    expect(world.store.ops.map((o) => [o.seq, o.error?.code ?? 'ok'])).toEqual([
      [1, 'ok'],
      [2, 'forbidden'],
    ])
  })

  it('keeps separate sessions in separate runs', async () => {
    const a = await exec({
      actor: { userId: 'ed' },
      sessionKey: 'mcp:a',
      invocation: recolour('#ff0000'),
    })
    const b = await exec({
      actor: { userId: 'ed' },
      sessionKey: 'mcp:b',
      invocation: recolour('#00ff00'),
    })
    expect(a.runId).not.toBe(b.runId)
  })

  it('refuses to attach to a run that is not open', async () => {
    const out = await exec({
      actor: { userId: 'ed' },
      runId: 'run_nope',
      invocation: recolour('#ff0000'),
    })
    expect(out).toMatchObject({ ok: false, error: { code: 'conflict' } })
  })
})

describe('people through command routes', () => {
  it('cannot write documents through the host (the editor is their host)', async () => {
    const out = await exec({
      actor: { userId: 'ed', kind: 'human' },
      invocation: recolour('#ff0000'),
    })
    expect(out).toMatchObject({ ok: false, error: { code: 'wrong_host' } })
  })
})
