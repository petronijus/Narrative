import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { z } from 'zod'
import { LOCAL_ORIGIN, agentOrigin, createUndoManager, listSlides } from '@narrative/slide-model'
import { CommandRegistry, defineCommand } from './registry.js'
import {
  commandReadsFolderTokens,
  prepareInvocation,
  runBatch,
  runCommand,
  runCommandSync,
  runGroup,
} from './run.js'
import { CommandError } from './errors.js'
import { createDefaultRegistry } from './catalog.js'
import { createFixtureDeck } from './testing/fixtureDeck.js'
import type { CommandContext } from './types.js'
import type { ServerServices } from './services.js'

function ctxFor(
  deck = createFixtureDeck(),
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    actor: { userId: 'u1', role: 'editor', kind: 'human' },
    host: 'browser',
    origin: LOCAL_ORIGIN,
    deck,
    ...overrides,
  }
}

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    return e instanceof CommandError ? e.code : `non-command error: ${String(e)}`
  }
  return undefined
}

const slideIds = (ctx: CommandContext) => listSlides(ctx.deck!).map((s) => s.id)

describe('runCommandSync — the gatekeeping every host relies on', () => {
  const registry = createDefaultRegistry()

  it('rejects unknown commands, invalid input, low roles and missing targets before writing', () => {
    const ctx = ctxFor()
    const before = Y.encodeStateVector(ctx.deck!.doc)
    expect(code(() => runCommandSync(registry, ctx, 'slide.nope', {}))).toBe('unknown_command')
    expect(code(() => runCommandSync(registry, ctx, 'slide.add', { index: -1 }))).toBe(
      'invalid_input',
    )
    expect(code(() => runCommandSync(registry, ctx, 'slide.add', { bogus: true }))).toBe(
      'invalid_input',
    )
    const viewer = ctxFor(ctx.deck, { actor: { userId: 'u2', role: 'viewer', kind: 'human' } })
    expect(code(() => runCommandSync(registry, viewer, 'slide.add', {}))).toBe('forbidden')
    const noDeck: CommandContext = { actor: ctx.actor, host: 'browser', origin: LOCAL_ORIGIN }
    expect(code(() => runCommandSync(registry, noDeck, 'slide.add', {}))).toBe('no_target')
    expect(Y.encodeStateVector(ctx.deck!.doc)).toEqual(before)
  })

  it('refuses a command on a host it does not declare', () => {
    const registry2 = new CommandRegistry().register(
      defineCommand({
        id: 'query.serverOnly',
        domain: 'query',
        title: 'Server only',
        description: 'A server-only probe used to test host checks in the runner.',
        input: z.object({}),
        output: z.object({}),
        role: 'viewer',
        effects: [],
        readOnly: true,
        undo: 'n/a',
        confirm: 'never',
        hosts: ['server'],
        implementedWith: [],
        examples: [{ title: 'probe', input: {} }],
        handler: () => ({}),
      }),
    )
    expect(code(() => runCommandSync(registry2, ctxFor(), 'query.serverOnly', {}))).toBe(
      'wrong_host',
    )
  })

  it('attributes the whole command to ONE transaction with the host origin', () => {
    const ctx = ctxFor(undefined, { origin: agentOrigin('run-origin'), host: 'server' })
    const origins: unknown[] = []
    ctx.deck!.doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    runCommandSync(registry, ctx, 'object.duplicate', { slide: 's1', objects: ['ga', 'gb'] })
    expect(origins).toEqual([agentOrigin('run-origin')])
  })

  it('makes a command one undo step for the editor', () => {
    const ctx = ctxFor()
    const undo = createUndoManager(ctx.deck!)
    runCommandSync(registry, ctx, 'object.duplicate', { slide: 's1', objects: ['r1', 'e1'] })
    expect(undo.undoStack).toHaveLength(1)
  })

  it('validates outputs against the declared schema', () => {
    const lying = new CommandRegistry().register(
      defineCommand({
        id: 'query.liar',
        domain: 'query',
        title: 'Liar',
        description: 'Returns something that does not match its declared output schema.',
        input: z.object({}),
        output: z.object({ n: z.number() }),
        role: 'viewer',
        effects: [],
        readOnly: true,
        undo: 'n/a',
        confirm: 'never',
        hosts: ['browser'],
        implementedWith: [],
        examples: [{ title: 'lie', input: {} }],
        handler: () => ({ n: 'not a number' }) as unknown as { n: number },
      }),
    )
    expect(code(() => runCommandSync(lying, ctxFor(), 'query.liar', {}))).toBe('failed')
  })

  it('runCommand also runs document commands (synchronously underneath)', async () => {
    const ctx = ctxFor()
    const out = (await runCommand(registry, ctx, 'slide.add', {})) as { slideId: string }
    expect(slideIds(ctx)).toContain(out.slideId)
  })
})

describe('runGroup — several editor commands as one change', () => {
  const registry = createDefaultRegistry()

  it('runs every command in one transaction: one update, one undo step', () => {
    const ctx = ctxFor()
    const undo = createUndoManager(ctx.deck!)
    let updates = 0
    ctx.deck!.doc.on('update', () => updates++)
    const copies = runGroup(registry, ctx, (run) => [
      run<{ slideId: string }>('slide.duplicate', { slide: 's1' }).slideId,
      run<{ slideId: string }>('slide.duplicate', { slide: 's3' }).slideId,
    ])
    expect(updates).toBe(1)
    expect(slideIds(ctx)).toEqual(['s1', copies[0], 's2', 's3', copies[1]])
    undo.undo()
    expect(slideIds(ctx)).toEqual(['s1', 's2', 's3'])
  })

  it('propagates a failure and keeps what ran before it (it is not atomic)', () => {
    const ctx = ctxFor()
    expect(
      code(() =>
        runGroup(registry, ctx, (run) => {
          run('slide.rename', { slide: 's1', name: 'Kept' })
          run('slide.rename', { slide: 'nope', name: 'x' })
        }),
      ),
    ).toBe('not_found')
    expect(listSlides(ctx.deck!)[0]!.name).toBe('Kept')
  })
})

describe('runBatch — atomic batches', () => {
  const registry = createDefaultRegistry()

  it('applies all ops as ONE transaction, in order, each seeing the previous result', () => {
    const ctx = ctxFor(undefined, { origin: agentOrigin('run-batch'), host: 'server' })
    const origins: unknown[] = []
    ctx.deck!.doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    const { results } = runBatch(registry, ctx, [
      { command: 'slide.add', input: {} },
      { command: 'slide.rename', input: { slide: { index: 3 }, name: 'Summary' } },
    ])
    expect(origins).toEqual([agentOrigin('run-batch')])
    const slides = listSlides(ctx.deck!)
    expect(slides[3]!.name).toBe('Summary')
    expect((results[0] as { slideId: string }).slideId).toBe(slides[3]!.id)
  })

  it('leaves the live document untouched when any op fails', () => {
    const ctx = ctxFor()
    const before = Y.encodeStateVector(ctx.deck!.doc)
    let error: unknown
    try {
      runBatch(registry, ctx, [
        { command: 'slide.add', input: {} },
        { command: 'object.move', input: { slide: 's1', objects: ['missing'], dx: 1, dy: 1 } },
      ])
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(CommandError)
    expect((error as CommandError).code).toBe('not_found')
    expect((error as CommandError).opIndex).toBe(1)
    expect(Y.encodeStateVector(ctx.deck!.doc)).toEqual(before)
    expect(listSlides(ctx.deck!)).toHaveLength(3)
  })

  it('validates every input before running anything', () => {
    const ctx = ctxFor()
    const before = Y.encodeStateVector(ctx.deck!.doc)
    expect(
      code(() =>
        runBatch(registry, ctx, [
          { command: 'slide.add', input: {} },
          { command: 'slide.rename', input: { slide: 's1' } },
        ]),
      ),
    ).toBe('invalid_input')
    expect(Y.encodeStateVector(ctx.deck!.doc)).toEqual(before)
  })

  it('is one undo step for the editor, and undo restores the exact prior state', () => {
    const ctx = ctxFor()
    const undo = createUndoManager(ctx.deck!)
    const before = listSlides(ctx.deck!)
    runBatch(registry, ctx, [
      { command: 'slide.add', input: {} },
      { command: 'object.duplicate', input: { slide: 's1', objects: ['r1'] } },
      { command: 'object.move', input: { slide: 's1', objects: ['img1'], dx: 5, dy: 5 } },
    ])
    expect(undo.undoStack).toHaveLength(1)
    undo.undo()
    // Structural comparison — CRDT bytes are not canonical (CLAUDE.md).
    expect(JSON.parse(JSON.stringify(listSlides(ctx.deck!)))).toEqual(
      JSON.parse(JSON.stringify(before)),
    )
  })

  it('syncs to a collaborator exactly like any other edit', () => {
    const ctx = ctxFor()
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ctx.deck!.doc))
    ctx.deck!.doc.on('update', (u: Uint8Array) => Y.applyUpdate(peer, u))
    runBatch(registry, ctx, [
      { command: 'slide.add', input: {} },
      { command: 'slide.rename', input: { slide: { index: 3 }, name: 'Synced' } },
    ])
    const peerSlides = listSlides({ doc: peer, slides: peer.getArray('slides') })
    expect(peerSlides[3]!.name).toBe('Synced')
  })

  it('refuses commands that touch more than the deck document', () => {
    const registry2 = createDefaultRegistry().register(
      defineCommand({
        id: 'deck.exportFake',
        domain: 'deck',
        title: 'Export (fake)',
        description: 'A server-effect command used to test that batches refuse it.',
        input: z.object({}),
        output: z.object({}),
        role: 'editor',
        effects: ['server'],
        undo: 'n/a',
        confirm: 'never',
        hosts: ['browser', 'server'],
        implementedWith: [],
        examples: [{ title: 'fake', input: {} }],
        handler: () => ({}),
      }),
    )
    expect(
      code(() =>
        runBatch(
          registry2,
          // The server host provides services; without them the runner would
          // stop earlier with wrong_host.
          ctxFor(undefined, { host: 'server', services: {} as ServerServices }),
          [{ command: 'deck.exportFake', input: {} }],
        ),
      ),
    ).toBe('not_batchable')
  })

  it('non-atomic batches report failures and keep going', () => {
    const ctx = ctxFor()
    const { results } = runBatch(
      registry,
      ctx,
      [
        { command: 'object.move', input: { slide: 's1', objects: ['missing'], dx: 1, dy: 1 } },
        { command: 'slide.add', input: {} },
      ],
      { atomic: false },
    )
    expect((results[0] as { error: { code: string } }).error.code).toBe('not_found')
    expect(listSlides(ctx.deck!)).toHaveLength(4)
  })

  it('is reachable as the ops.apply command', () => {
    const ctx = ctxFor()
    const out = runCommandSync(registry, ctx, 'ops.apply', {
      ops: [{ command: 'slide.add', input: {} }],
    }) as { results: unknown[] }
    expect(out.results).toHaveLength(1)
    expect(listSlides(ctx.deck!)).toHaveLength(4)
  })
})

describe('commandReadsFolderTokens', () => {
  const registry = createDefaultRegistry()

  it('answers for a command, and for a batch by its ops', () => {
    expect(commandReadsFolderTokens(registry, 'object.slideNumber.set', {})).toBe(true)
    expect(commandReadsFolderTokens(registry, 'object.move', {})).toBe(false)
    const batch = (command: string) => ({
      ops: [
        { command: 'object.move', input: {} },
        { command, input: {} },
      ],
    })
    expect(commandReadsFolderTokens(registry, 'ops.apply', batch('object.fill.gradient'))).toBe(
      true,
    )
    expect(commandReadsFolderTokens(registry, 'ops.apply', batch('object.delete'))).toBe(false)
    expect(commandReadsFolderTokens(registry, 'ops.apply', { ops: 'nonsense' })).toBe(false)
    expect(commandReadsFolderTokens(registry, 'no.such', {})).toBe(false)
  })
})

describe('prepareInvocation — abandoning what load staged', () => {
  function stagingRegistry(release: (loaded: { staged: string }) => Promise<void>) {
    return new CommandRegistry().register(
      defineCommand({
        id: 'object.stagedProbe',
        domain: 'object',
        title: 'Staged probe',
        description: 'Stages something outside the document in load, then writes nothing.',
        input: z.object({}),
        output: z.object({}),
        role: 'editor',
        effects: ['doc', 'server'],
        undo: 'undoable',
        confirm: 'never',
        hosts: ['browser', 'server'],
        implementedWith: [],
        examples: [{ title: 'probe', input: {} }],
        load: async () => ({ staged: 'media' }),
        release,
        handler: () => ({}),
      }),
    )
  }

  const serverCtx = () =>
    ctxFor(undefined, { host: 'server', services: {} as unknown as ServerServices })

  it('releases the staged work when the write never runs, once', async () => {
    const released: string[] = []
    const registry = stagingRegistry(async (loaded) => {
      released.push(loaded.staged)
    })
    const prepared = await prepareInvocation(registry, serverCtx(), 'object.stagedProbe', {})
    await prepared.abandon()
    await prepared.abandon()
    expect(released).toEqual(['media'])
    expect(() => prepared.execute()).toThrow(/executed twice/)
  })

  it('keeps it once the write ran, and swallows a failing release', async () => {
    const release = async () => {
      throw new Error('storage down')
    }
    const ran = await prepareInvocation(
      stagingRegistry(release),
      serverCtx(),
      'object.stagedProbe',
      {},
    )
    ran.execute()
    await expect(ran.abandon()).resolves.toBeUndefined()
    const abandoned = await prepareInvocation(
      stagingRegistry(release),
      serverCtx(),
      'object.stagedProbe',
      {},
    )
    await expect(abandoned.abandon()).resolves.toBeUndefined()
  })
})
