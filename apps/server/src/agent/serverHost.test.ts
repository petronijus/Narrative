/**
 * agent/serverHost.test.ts — the ServerHost against a real Hocuspocus
 * instance and real WebSocket clients (test-support/agentWorld.ts):
 *   - authorisation happens before any document is opened (no IDOR through
 *     the direct connection, which skips onAuthenticate);
 *   - viewers read, only editors write — and a refused write loads nothing;
 *   - each command, and each batch, reaches connected editors as exactly ONE
 *     update, attributed on the server to the run's origin;
 *   - every op of a run is logged, failures included;
 *   - what a command's `load` staged outside the document is released when
 *     the write never runs, and left to the handler once it did; and it is
 *     settled once after a committed write, never after a refused one;
 *   - a deck command that also takes a folder (`acceptsFolder`) is
 *     authorised on that folder with the role it names for it (`roleOn`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { z } from 'zod'
import { CommandError, createDefaultRegistry, defineCommand } from '@narrative/commands'
import { addSlide, agentOrigin, isAgentOrigin, getSlideObjectsCtx } from '@narrative/slide-model'
import {
  createAgentWorld,
  eventually,
  settle,
  type AgentWorld,
} from '../test-support/agentWorld.js'
import { exampleStylePack } from '@narrative/shared'
import { DECK_BUILDS_PER_MINUTE, type HostRequest, type HostResult } from './serverHost.js'

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

describe('folder tokens', () => {
  const tokens = {
    colors: { ink: { name: 'Ink', value: '#222222' } },
    textStyles: {
      pages: {
        name: 'Footnotes and pages',
        family: 'Inter',
        size: 14,
        color: { $token: 'colors.ink' },
      },
    },
  }

  function objectOf(doc: Y.Doc, objectId: string): Y.Map<unknown> | undefined {
    const objects = getSlideObjectsCtx({ doc, slides: doc.getArray('slides') }, 's1')!
    return objects.objects.toArray().find((m) => m.get('id') === objectId)
  }

  it("give a command the target folder's tokens, also inside a batch", async () => {
    world.setFolder('deck1', 'f1', tokens)
    const human = await world.connect('deck1', 'ed')
    await exec({
      actor: { userId: 'ed' },
      invocation: {
        command: 'object.update',
        input: { slide: 's1', object: 'r1', patch: { fill: { $token: 'colors.ink' } } },
      },
    })
    const out = await exec({
      actor: { userId: 'ed' },
      batch: {
        ops: [
          { command: 'object.move', input: { slide: 's1', objects: ['r2'], dx: 10, dy: 0 } },
          {
            command: 'object.fill.gradient',
            input: { slide: 's1', objects: ['r1'], kind: 'linear' },
          },
        ],
      },
    })
    expect(out.ok).toBe(true)
    // The token fill was resolved and unlinked (0x222222), then seeded from.
    await eventually(() => objectOf(human.doc, 'r1')?.get('fill') === 0x222222)
    expect(objectOf(human.doc, 'r1')?.get('fillStyle')).toMatchObject({ kind: 'linearGradient' })
  })

  it('report a folder without tokens as none, and a deck without a folder too', async () => {
    const out = await exec({
      actor: { userId: 'ed' },
      invocation: {
        command: 'object.fill.gradient',
        input: { slide: 's1', objects: ['r1'], kind: 'radial' },
      },
    })
    expect(out.ok).toBe(true)
    world.setFolder('deck1', 'f-empty')
    await exec({
      actor: { userId: 'ed' },
      invocation: {
        command: 'object.update',
        input: { slide: 's1', object: 'r2', patch: { fill: { $token: 'colors.ink' } } },
      },
    })
    const refused = await exec({
      actor: { userId: 'ed' },
      invocation: {
        command: 'object.fill.gradient',
        input: { slide: 's1', objects: ['r2'], kind: 'radial' },
      },
    })
    // Tokens were looked for and there are none: the colour cannot be resolved.
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })
})

describe('folder fonts', () => {
  function objectOf(doc: Y.Doc, objectId: string): Y.Map<unknown> | undefined {
    const objects = getSlideObjectsCtx({ doc, slides: doc.getArray('slides') }, 's1')!
    return objects.objects.toArray().find((m) => m.get('id') === objectId)
  }

  async function textBox(): Promise<string> {
    const out = await exec({
      actor: { userId: 'ed' },
      invocation: {
        command: 'object.create',
        input: {
          slide: 's1',
          object: { type: 'text', x: 0, y: 0, width: 400, height: 80, text: 'Hi', fontWeight: 400 },
        },
      },
    })
    expect(out.ok).toBe(true)
    return (out as { result: { objectId: string } }).result.objectId
  }

  it("give a command the target folder's font faces, also inside a batch", async () => {
    world.setFolder('deck1', 'f1')
    world.setFolderFonts('f1', [
      { family: 'Brand Sans', weight: 300 },
      { family: 'Brand Sans', weight: 600 },
    ])
    const human = await world.connect('deck1', 'ed')
    const id = await textBox()
    const out = await exec({
      actor: { userId: 'ed' },
      batch: {
        ops: [
          {
            command: 'text.setBoxTypography',
            input: { slide: 's1', objects: [id], style: { fontFamily: 'Brand Sans' } },
          },
        ],
      },
    })
    expect(out.ok).toBe(true)
    // 400 is not a cut of Brand Sans; the browser would show 300, so that is stored.
    await eventually(() => objectOf(human.doc, id)?.get('fontWeight') === 300)
  })

  it('report a folder without fonts as none: any weight is kept', async () => {
    world.setFolder('deck1', 'f-plain')
    const human = await world.connect('deck1', 'ed')
    const id = await textBox()
    const out = await exec({
      actor: { userId: 'ed' },
      invocation: {
        command: 'text.setBoxTypography',
        input: { slide: 's1', objects: [id], style: { fontFamily: 'Brand Sans' } },
      },
    })
    expect(out.ok).toBe(true)
    await eventually(() => objectOf(human.doc, id)?.get('fontFamily') === 'Brand Sans')
    expect(objectOf(human.doc, id)?.get('fontWeight')).toBe(400)
  })
})

describe("what a command's load staged", () => {
  /** What the probe's `load` staged, handed to `release` / the handler. */
  interface Staged {
    token: string
  }
  const release = vi.fn(async (_staged: Staged) => undefined)
  const settleStaged = vi.fn(async (_staged: Staged) => undefined)
  const handled: string[] = []
  /** Runs inside `load`, after the staging (what goes wrong before the write). */
  let afterStaging: (() => Promise<void>) | null = null
  let failHandler = false

  // A document command with a server side, like object.insertFromDeck: its
  // `load` stages media outside the document, its `release` gives it back.
  const probe = defineCommand({
    id: 'object.fakeStage',
    domain: 'object',
    title: 'Stage and insert',
    description: 'Test-only command: stages a token in load, adds a slide in the handler.',
    input: z.strictObject({}),
    output: z.object({ staged: z.string() }),
    role: 'editor',
    scope: 'deck',
    effects: ['doc', 'server'],
    undo: 'undoable',
    confirm: 'never',
    hosts: ['server'],
    implementedWith: [],
    examples: [{ title: 'Stage', input: {} }],
    async load(): Promise<Staged> {
      const staged = { token: 'staged-media' }
      if (afterStaging !== null) await afterStaging()
      return staged
    },
    release,
    settle: settleStaged,
    handler(ctx, _input, staged) {
      if (failHandler) throw new CommandError('not_found', 'no such slide')
      handled.push(staged.token)
      addSlide(ctx.deck!)
      return { staged: staged.token }
    },
  })

  const stage = (): Promise<HostResult> =>
    exec({ actor: { userId: 'ed' }, invocation: { command: 'object.fakeStage', input: {} } })

  beforeEach(async () => {
    release.mockClear()
    settleStaged.mockClear()
    handled.length = 0
    afterStaging = null
    failHandler = false
    await world.destroy()
    world = await createAgentWorld({ registry: createDefaultRegistry().register(probe) })
    world.createDeck('deck1')
    world.grant('deck1', 'ed', 'editor')
  })

  it('is released once when the direct connection closes between load and the write', async () => {
    // The server shuts down while the command loads: its runs close and the
    // direct connection to the document is gone before the transaction.
    afterStaging = () => world.runtime.shutdown()
    const out = await stage()
    expect(out).toMatchObject({ ok: false, error: { code: 'failed' } })
    expect(handled).toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith({ token: 'staged-media' })
    expect(settleStaged).not.toHaveBeenCalled()
  })

  it('is released once when attaching the run to the document fails before the write', async () => {
    const before = vi
      .spyOn(world.runtime.runs, 'beforeDocumentWrite')
      .mockRejectedValueOnce(new Error('could not hold the document for the run'))
    const human = await world.connect('deck1', 'ed')
    const out = await stage()
    expect(before).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ ok: false, error: { code: 'failed' } })
    expect(handled).toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
    // Never settled: the write was refused before it ran.
    expect(settleStaged).not.toHaveBeenCalled()
    await settle()
    expect(human.remoteUpdates).toHaveLength(0)
  })

  it('is not released after a successful write: the document owns it now', async () => {
    const human = await world.connect('deck1', 'ed')
    const out = await stage()
    expect(out).toMatchObject({ ok: true, result: { staged: 'staged-media' } })
    expect(handled).toEqual(['staged-media'])
    await eventually(() => human.doc.getArray('slides').length === 3)
    expect(release).not.toHaveBeenCalled()
    // Settled exactly once, after the write committed (the stamp racing a
    // move: what it linked follows the deck).
    expect(settleStaged).toHaveBeenCalledExactlyOnceWith({ token: 'staged-media' })
    expect(handled).toEqual(['staged-media'])
  })

  it('settles after the write and before the result returns', async () => {
    let slidesWhenSettled = -1
    settleStaged.mockImplementationOnce(async () => {
      const doc = await world.hocuspocus.openDirectConnection('deck1')
      slidesWhenSettled = doc.document!.getArray('slides').length
      await doc.disconnect()
    })
    const out = await stage()
    expect(out.ok).toBe(true)
    expect(slidesWhenSettled).toBe(3)
  })

  it('is left to the handler when the handler itself refuses', async () => {
    failHandler = true
    const out = await stage()
    expect(out).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(release).not.toHaveBeenCalled()
    expect(settleStaged).not.toHaveBeenCalled()
  })
})

describe('a deck command that also takes a folder', () => {
  // media.delete: a deck's asset for its owner, a master's picture for a
  // folder editor (handed to the folder), a folder's own for the folder owner.
  const deleteOn = (userId: string, target: HostRequest['target']) =>
    exec({
      actor: { userId },
      target,
      invocation: { command: 'media.delete', input: { assetId: 'a1' } },
      confirmation: { via: 'elicitation', commands: ['media.delete'] },
    })

  it('is authorised on the folder, with the role it needs there', async () => {
    const remove = vi
      .spyOn(world.runtime.services.media, 'delete')
      .mockResolvedValue({ outcome: 'deleted' })
    world.grant('folder:f1', 'fo', 'owner')
    world.grant('folder:f1', 'fe', 'editor')
    const editor = await deleteOn('fe', { folderId: 'f1' })
    expect(editor).toMatchObject({
      ok: false,
      error: {
        code: 'forbidden',
        message: expect.stringMatching(/needs the owner role; you are editor/),
      },
    })
    const stranger = await deleteOn('nobody', { folderId: 'f1' })
    expect(stranger).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(remove).not.toHaveBeenCalled()

    const owner = await deleteOn('fo', { folderId: 'f1' })
    expect(owner).toMatchObject({ ok: true, result: { outcome: 'deleted' } })
    expect(remove).toHaveBeenCalledExactlyOnceWith({
      userId: 'fo',
      assetId: 'a1',
      owner: { folderId: 'f1' },
    })
    // A folder has no document: none was opened.
    expect(world.hocuspocus.getDocumentsCount()).toBe(0)
  })

  it('takes a master from a folder editor, and refuses a folder for a deck-only command', async () => {
    const remove = vi
      .spyOn(world.runtime.services.media, 'delete')
      .mockResolvedValue({ outcome: 'handedToFolder' })
    world.createDeck('component:c1')
    world.grant('component:c1', 'ce', 'editor')
    const onMaster = await deleteOn('ce', { componentId: 'c1' })
    expect(onMaster).toMatchObject({ ok: true, result: { outcome: 'handedToFolder' } })
    expect(remove).toHaveBeenCalledWith({
      userId: 'ce',
      assetId: 'a1',
      owner: { componentId: 'c1' },
    })
    // On a deck the same editor is refused: deleting a deck's asset is its owner's.
    const onDeck = await deleteOn('ed', { deckId: 'deck1' })
    expect(onDeck).toMatchObject({ ok: false, error: { code: 'forbidden' } })

    const shareOnFolder = await exec({
      actor: { userId: 'ed' },
      target: { folderId: 'f1' },
      invocation: { command: 'share.links.list', input: {} },
    })
    expect(shareOnFolder).toMatchObject({ ok: false, error: { code: 'no_target' } })
  })
})

describe("a folder read its decks' guests may run too", () => {
  // token.list, folder.fonts.list and media.fontUrl declare
  // `folderReaders: 'content'`: a guest of one of the folder's decks reads its
  // tokens and fonts in the editor, so their agent may too. Everything else
  // folder-scoped stays with the folder's members.
  const run = (userId: string, command: string, input: Record<string, unknown> = {}) =>
    exec({ actor: { userId }, target: { folderId: 'f1' }, invocation: { command, input } })

  it("lets a deck's guest read the folder's tokens and fonts, and nothing else of it", async () => {
    const tokens = vi
      .spyOn(world.runtime.services.tokens, 'list')
      .mockResolvedValue({ colors: {}, textStyles: {}, effectStyles: {} })
    const fonts = vi.spyOn(world.runtime.services.folders, 'listFonts').mockResolvedValue([])
    world.grant('folderContent:f1', 'guest', 'viewer')

    expect(await run('guest', 'token.list')).toMatchObject({ ok: true })
    expect(tokens).toHaveBeenCalledWith({ userId: 'guest', folderId: 'f1' })
    expect(await run('guest', 'folder.fonts.list')).toMatchObject({ ok: true })
    expect(fonts).toHaveBeenCalledWith({ userId: 'guest', folderId: 'f1' })
    // A font file too — the service gets the target folder, so a font of
    // another folder is refused there (services/mediaSharing.test.ts).
    const fontUrl = vi.spyOn(world.runtime.services.media, 'fontUrl').mockResolvedValue({
      assetId: 'font-1',
      url: 'https://storage.test/signed',
      family: 'Brand Sans',
      weight: 400,
      style: 'normal',
      postscriptName: null,
      mimeType: 'font/otf',
    })
    expect(await run('guest', 'media.fontUrl', { assetId: 'font-1' })).toMatchObject({ ok: true })
    expect(fontUrl).toHaveBeenCalledWith({ userId: 'guest', assetId: 'font-1', folderId: 'f1' })

    // Member-only reads, and every write, refuse the guest before anything runs.
    for (const [command, input] of [
      ['token.usages', { category: 'colors', tokenId: 'c1' }],
      ['component.list', {}],
      ['deck.activeEditors', {}],
      ['token.create', { category: 'colors', name: 'Accent', value: '#ff0000' }],
    ] as const) {
      expect(await run('guest', command, input), command).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      })
    }
  })

  it('refuses a stranger, and gives a member their folder role', async () => {
    vi.spyOn(world.runtime.services.tokens, 'list').mockResolvedValue({
      colors: {},
      textStyles: {},
      effectStyles: {},
    })
    expect(await run('nobody', 'token.list')).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    })
    const usages = vi
      .spyOn(world.runtime.services.tokens, 'usages')
      .mockResolvedValue({ usages: [] })
    world.grant('folder:f1', 'member', 'viewer')
    expect(await run('member', 'token.list')).toMatchObject({ ok: true })
    expect(
      await run('member', 'token.usages', { category: 'colors', tokenId: 'c1' }),
    ).toMatchObject({ ok: true, result: { usages: [] } })
    expect(usages).toHaveBeenCalledOnce()
  })
})

describe('deck builds from a spec (A5.3)', () => {
  it(`allows ${DECK_BUILDS_PER_MINUTE} a minute per user, then refuses before reading anything`, async () => {
    // No pack in the deck's folder: each build fails on its own, after the limiter counted it.
    const build = () =>
      exec({
        actor: { userId: 'ed' },
        invocation: {
          command: 'style.deck.apply',
          input: {
            spec: { schemaVersion: 1, packId: 'example', slides: [{ archetype: 'cover' }] },
          },
        },
      })
    for (let i = 0; i < DECK_BUILDS_PER_MINUTE; i++)
      expect(await build()).not.toMatchObject({
        error: { message: expect.stringContaining('a minute') },
      })
    expect(await build()).toMatchObject({
      ok: false,
      error: { code: 'conflict', message: expect.stringContaining('too many deck builds') },
    })
    // Other calls of the command are not counted.
    expect(
      await exec({
        actor: { userId: 'ed' },
        invocation: { command: 'style.deck.apply', input: { guides: false } },
      }),
    ).not.toMatchObject({ error: { message: expect.stringContaining('a minute') } })
  })

  it('does not count a spec its checks refuse', async () => {
    world.setFolder(
      'deck1',
      'f1',
      { colors: { navy: { name: 'Navy', value: '#001e50' } } },
      exampleStylePack() as unknown as Record<string, unknown>,
    )
    // The pack has no layout for an agenda: refused by the checks, every time.
    const refused = () =>
      exec({
        actor: { userId: 'ed' },
        invocation: {
          command: 'style.deck.apply',
          input: {
            spec: { schemaVersion: 1, packId: 'example', slides: [{ archetype: 'agenda' }] },
          },
        },
      })
    for (let i = 0; i < DECK_BUILDS_PER_MINUTE + 2; i++)
      expect(await refused()).toMatchObject({
        ok: false,
        error: { code: 'invalid_input', message: expect.stringContaining('agenda') },
      })
  })
})
