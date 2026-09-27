/**
 * agent.* and editor.* — what the handlers do with the server services
 * (in-memory fakes here; the real services are tested in apps/server).
 */

import { describe, expect, it } from 'vitest'
import { LOCAL_ORIGIN } from '@narrative/slide-model'
import { createDefaultRegistry } from '../catalog.js'
import { runCommand } from '../run.js'
import { CommandError } from '../errors.js'
import { createFixtureDeck } from '../testing/fixtureDeck.js'
import {
  FIXTURE_COMPONENT_ID,
  FIXTURE_DECK_ID,
  createFakeServices,
  type FakeServices,
} from '../testing/fakeServices.js'
import type { CommandContext } from '../types.js'

const registry = createDefaultRegistry()

function ctx(overrides: Partial<CommandContext> = {}): CommandContext & { services: FakeServices } {
  return {
    actor: { userId: 'u1', role: 'editor', kind: 'agent' },
    host: 'server',
    origin: LOCAL_ORIGIN,
    deck: createFixtureDeck(),
    target: { deckId: FIXTURE_DECK_ID },
    services: createFakeServices(),
    session: { key: 'mcp:1', surface: 'mcp', clientName: 'claude-code' },
    ...overrides,
  } as CommandContext & { services: FakeServices }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof CommandError) return e.code
    throw e
  }
  throw new Error('expected a CommandError')
}

describe('agent.startRun', () => {
  it('opens a run for the calling session on the target deck', async () => {
    const c = ctx()
    const out = await runCommand(registry, c, 'agent.startRun', { request: '  Shorten slide 3  ' })
    expect(out).toEqual({ runId: 'run_1' })
    expect(c.services.calls).toEqual([
      {
        service: 'runs',
        method: 'startRun',
        args: {
          userId: 'u1',
          session: { key: 'mcp:1', surface: 'mcp', clientName: 'claude-code' },
          target: { kind: 'deck', deckId: FIXTURE_DECK_ID },
          request: 'Shorten slide 3',
        },
      },
    ])
  })

  it('opens a run on a component master when the target is one', async () => {
    const c = ctx({ target: { componentId: FIXTURE_COMPONENT_ID } })
    expect(
      await runCommand(registry, c, 'agent.startRun', { request: 'Tighten the master' }),
    ).toEqual({ runId: 'run_1' })
    expect(c.services.calls[0]).toMatchObject({
      method: 'startRun',
      args: { target: { kind: 'component', componentId: FIXTURE_COMPONENT_ID } },
    })
  })

  it('needs an agent session, a target document and the editor role', async () => {
    const { session: _s, ...noSession } = ctx()
    expect(await code(runCommand(registry, noSession, 'agent.startRun', { request: 'x' }))).toBe(
      'wrong_host',
    )
    const { target: _t, deck: _d, ...noTarget } = ctx()
    expect(await code(runCommand(registry, noTarget, 'agent.startRun', { request: 'x' }))).toBe(
      'no_target',
    )
    expect(
      await code(
        runCommand(
          registry,
          ctx({ actor: { userId: 'u1', role: 'viewer', kind: 'agent' } }),
          'agent.startRun',
          {
            request: 'x',
          },
        ),
      ),
    ).toBe('forbidden')
    expect(await code(runCommand(registry, ctx(), 'agent.startRun', { request: '   ' }))).toBe(
      'invalid_input',
    )
  })

  it('is not available in the editor (browser host)', async () => {
    expect(
      await code(
        runCommand(registry, ctx({ host: 'browser' }), 'agent.startRun', { request: 'x' }),
      ),
    ).toBe('wrong_host')
  })
})

describe('agent.revert', () => {
  it('passes the run, the deck the caller was authorised on, and lastOps', async () => {
    const c = ctx()
    const out = await runCommand(registry, c, 'agent.revert', { runId: 'run_fixture', lastOps: 2 })
    expect(out).toEqual({
      runId: 'run_fixture',
      revertedChanges: 2,
      remainingChanges: 1,
      status: 'open',
    })
    expect(c.services.calls[0]).toMatchObject({
      method: 'revertRun',
      args: {
        userId: 'u1',
        target: { kind: 'deck', deckId: FIXTURE_DECK_ID },
        runId: 'run_fixture',
        lastOps: 2,
      },
    })
  })

  it('reverts a run on a component master, and only on the master it belongs to', async () => {
    const c = ctx({ target: { componentId: FIXTURE_COMPONENT_ID } })
    const { runId } = (await runCommand(registry, c, 'agent.startRun', {
      request: 'Recolour',
    })) as {
      runId: string
    }
    const listed = (await runCommand(registry, c, 'agent.runs', {})) as { runs: { id: string }[] }
    expect(listed.runs.map((r) => r.id)).toEqual([runId])
    expect(await runCommand(registry, c, 'agent.revert', { runId })).toMatchObject({
      runId,
      status: 'reverted',
    })
    // The deck's run is not reachable through the master, nor the master's through the deck.
    expect(await code(runCommand(registry, c, 'agent.revert', { runId: 'run_fixture' }))).toBe(
      'not_found',
    )
    expect(
      await code(runCommand(registry, ctx({ services: c.services }), 'agent.revert', { runId })),
    ).toBe('not_found')
  })

  it('surfaces the service errors unchanged', async () => {
    expect(await code(runCommand(registry, ctx(), 'agent.revert', { runId: 'run_other' }))).toBe(
      'not_found',
    )
    expect(
      await code(runCommand(registry, ctx(), 'agent.revert', { runId: 'run_fixture', lastOps: 0 })),
    ).toBe('invalid_input')
  })

  it('is batch-proof: it cannot run inside ops.apply', async () => {
    const out = code(
      runCommand(registry, ctx(), 'ops.apply', {
        ops: [{ command: 'agent.revert', input: { runId: 'run_fixture' } }],
      }),
    )
    expect(await out).toBe('not_batchable')
  })
})

describe('editor.context', () => {
  it("summarises the user's most recently active tab and lists all of them", async () => {
    const out = await runCommand(registry, ctx(), 'editor.context', {})
    expect(out).toEqual({
      open: true,
      activeSlideId: 's1',
      activeSlideIndex: 0,
      selectedObjectIds: ['r1'],
      editors: [
        {
          activeSlideId: 's1',
          activeSlideIndex: 0,
          selectedObjectIds: ['r1'],
          lastActiveAt: '2026-09-26T10:05:00.000Z',
        },
      ],
    })
  })

  it('says so when the user has no editor open', async () => {
    const out = await runCommand(
      registry,
      ctx({ actor: { userId: 'someone-else', role: 'viewer', kind: 'agent' } }),
      'editor.context',
      {},
    )
    expect(out).toMatchObject({
      open: false,
      activeSlideId: null,
      selectedObjectIds: [],
      editors: [],
    })
  })
})

describe('editor.show', () => {
  it('resolves the slide ref to an id and de-duplicates objects before sending', async () => {
    const c = ctx({ run: { runId: 'run_fixture', surface: 'mcp' } })
    const out = await runCommand(registry, c, 'editor.show', {
      slide: { index: 0 },
      objects: ['r1', 'r1', 't1'],
    })
    expect(out).toEqual({ delivered: 1, slideId: 's1' })
    expect(c.services.calls[0]).toMatchObject({
      method: 'show',
      args: { slideId: 's1', objectIds: ['r1', 't1'], runId: 'run_fixture' },
    })
  })

  it('refuses objects that are not on the slide, without sending anything', async () => {
    const c = ctx()
    expect(
      await code(runCommand(registry, c, 'editor.show', { slide: 's2', objects: ['r1'] })),
    ).toBe('not_found')
    expect(c.services.calls).toEqual([])
  })
})

describe('editor.present.link', () => {
  it('defaults to the first slide and numbers slides from 1', async () => {
    expect(await runCommand(registry, ctx(), 'editor.present.link', {})).toEqual({
      url: 'https://narrative.test/deck/deck_fixture/present?slide=1',
      slideNumber: 1,
    })
    expect(await runCommand(registry, ctx(), 'editor.present.link', { slide: 's3' })).toMatchObject(
      {
        slideNumber: 3,
      },
    )
  })
})
