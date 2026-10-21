/**
 * routes/agent.test.ts — POST /commands (public /api/commands, the command API) and the
 * Agent activity routes, over a real agent host (test-support/agentWorld.ts).
 * Most tests run in BYPASS_AUTH mode (the synthetic `dev-user`); the last
 * block runs with real sessions (mocked at `lookupSession`: cookie
 * `narrative_session=s-<user>-<n>` is <user>'s session n) and personal
 * access tokens, for the origin check and the per-session API key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('../auth/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/session.js')>()
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, raw: string) => {
      const m = /^s-(user-\d+)-\d+$/.exec(raw)
      return m ? { userSub: m[1]!, userEmail: `${m[1]}@example.com`, userName: null } : null
    }),
  }
})

import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import { createPatService } from '../auth/personalAccessTokens.js'
import type { Database } from '../db/client.js'
import { registerSameOriginPolicy } from '../http/sameOrigin.js'
import { allowAllPatOwners, createMemoryPatStore } from '../test-support/memoryPatStore.js'
import { createAgentWorld, type AgentWorld } from '../test-support/agentWorld.js'
import { FAKE_INTERNAL_DETAIL, registryWithFakes } from '../test-support/fakeCommands.js'
import { parseServerTiming } from '../observability/phases.js'
import { COMMAND_ERROR_STATUS, parseCommandBody, registerAgentRoutes } from './agent.js'

let world: AgentWorld
let app: FastifyInstance
const SPA = 'http://localhost:5173'

beforeEach(async () => {
  world = await createAgentWorld({ registry: registryWithFakes() })
  world.createDeck('deck1')
  world.grant('deck1', 'dev-user', 'editor')
  world.createDeck('deck2')
  world.grant('deck2', 'dev-user', 'viewer')
  app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass: true, db: {} as Database })
  registerSameOriginPolicy(app, { allowedOrigins: [SPA] })
  await registerAgentRoutes(app, { agent: world.runtime })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  await world.destroy()
})

function post(body: unknown) {
  return app.inject({ method: 'POST', url: '/commands', payload: body as object })
}

describe('POST /commands', () => {
  it('runs a command and returns its result with the run it joined', async () => {
    const res = await post({
      target: { deckId: 'deck1' },
      command: 'object.update',
      input: { slide: 's1', object: 'r1', patch: { fill: '#ff0000' } },
      client: 'deploy-script',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ ok: true, result: { updated: ['r1'] } })
    expect(world.store.runs.get(body.runId)).toMatchObject({
      surface: 'api',
      clientName: 'deploy-script',
    })
  })

  it('answers the phases of a request that asks for them, and only then (G7)', async () => {
    const body = {
      target: { deckId: 'deck1' },
      command: 'object.update',
      input: { slide: 's1', object: 'r1', patch: { x: 3 } },
    }
    const plain = await post(body)
    expect(plain.headers['server-timing']).toBeUndefined()
    const timed = await app.inject({
      method: 'POST',
      url: '/commands',
      headers: { 'x-narrative-timing': '1' },
      payload: body,
    })
    expect(timed.statusCode).toBe(200)
    const phases = parseServerTiming(String(timed.headers['server-timing']))
    expect(Object.keys(phases)).toEqual(
      expect.arrayContaining([
        'http.pre',
        'http.parse',
        'host',
        'http.serialize',
        'host.admit',
        'host.load',
        'host.validate',
        'host.apply',
        'host.audit',
      ]),
    )
    for (const ms of Object.values(phases)) expect(ms).toBeGreaterThanOrEqual(0)
    // No slice of the time before the handler (the credential's check) is told apart.
    expect(Object.keys(phases).filter((p) => p.startsWith('http.'))).toEqual([
      'http.pre',
      'http.parse',
      'http.serialize',
    ])
  })

  it('answers no phases for a call refused before it was authorised on its target (G7 review)', async () => {
    const timed = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: '/commands',
        headers: { 'x-narrative-timing': '1' },
        payload: body as object,
      })
    const write = {
      command: 'object.update',
      input: { slide: 's1', object: 'r1', patch: { x: 1 } },
    }
    for (const body of [
      { target: { deckId: 'deck2' }, ...write }, // viewer: forbidden
      { target: { deckId: 'no-such-deck' }, ...write }, // unknown deck: forbidden
      { target: { deckId: 'deck1' }, command: 'object.teleport', input: {} }, // unknown command
      { ...write }, // no target
      { target: { deckId: 'deck1' }, command: 7 }, // a body the route refuses
    ]) {
      const res = await timed(body)
      expect(res.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(400)
      expect(res.headers['server-timing'], JSON.stringify(body)).toBeUndefined()
    }
    // Authorised on the deck, then refused by the command (an unknown object): its phases are the caller's.
    const missing = await timed({
      target: { deckId: 'deck1' },
      command: 'object.update',
      input: { slide: 's1', object: 'ghost', patch: { x: 1 } },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['server-timing']).toContain('host.admit')
  })

  it('runs a batch as one change', async () => {
    const res = await post({
      target: { deckId: 'deck1' },
      ops: [
        { command: 'slide.add', input: {} },
        { command: 'slide.rename', input: { slide: { index: 2 }, name: 'End' } },
      ],
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().result.results).toHaveLength(2)
  })

  it.each([
    [
      'invalid_input',
      { target: { deckId: 'deck1' }, command: 'object.update', input: { slide: 's1' } },
      400,
    ],
    [
      'unknown_command',
      { target: { deckId: 'deck1' }, command: 'object.teleport', input: {} },
      400,
    ],
    [
      'no_target',
      { command: 'object.update', input: { slide: 's1', object: 'r1', patch: {} } },
      400,
    ],
    [
      'forbidden',
      {
        target: { deckId: 'deck2' },
        command: 'object.update',
        input: { slide: 's1', object: 'r1', patch: { x: 1 } },
      },
      403,
    ],
    [
      'not_found',
      {
        target: { deckId: 'deck1' },
        command: 'object.update',
        input: { slide: 's1', object: 'ghost', patch: { x: 1 } },
      },
      404,
    ],
    [
      'conflict',
      { target: { deckId: 'deck1' }, runId: 'run_gone', command: 'query.deck', input: {} },
      409,
    ],
  ])('maps %s to HTTP %i', async (code, body, status) => {
    const res = await post(body)
    expect(res.statusCode).toBe(status)
    expect(res.json()).toMatchObject({ ok: false, error: { code } })
    expect(COMMAND_ERROR_STATUS[code as keyof typeof COMMAND_ERROR_STATUS]).toBe(status)
  })

  it('rejects malformed bodies before anything runs', async () => {
    for (const body of [
      [],
      { target: { deckId: 'deck1' } },
      { target: { deckId: 'deck1', slideId: 's1' }, command: 'query.deck' },
      { target: { deckId: 'deck1' }, command: 'query.deck', ops: [] },
      { target: { deckId: 'deck1' }, ops: [{ command: 'slide.add', input: {}, extra: 1 }] },
      { target: { deckId: 'deck1' }, command: 'query.deck', atomic: true },
    ]) {
      const res = await post(body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(res.json().error.code).toBe('invalid_input')
    }
    expect(world.hocuspocus.getDocumentsCount()).toBe(0)
  })

  it('parses both body shapes', () => {
    expect(parseCommandBody({ target: { deckId: 'd' }, command: 'query.deck' })).toEqual({
      target: { deckId: 'd' },
      invocation: { command: 'query.deck', input: {} },
    })
    expect(parseCommandBody({ ops: [{ command: 'slide.add' }], atomic: false })).toEqual({
      target: {},
      batch: { ops: [{ command: 'slide.add', input: {} }], atomic: false },
    })
  })
})

describe('POST /commands: irreversible commands', () => {
  const revoke = {
    target: { deckId: 'deck1' },
    command: 'share.fakeRevoke',
    input: { linkId: 'l1' },
  }
  const fakeOps = () => world.store.ops.filter((o) => o.command === 'share.fakeRevoke')

  it('refuses them with 428 unless the body confirms that command by id', async () => {
    const refused = await post(revoke)
    expect(refused.statusCode).toBe(428)
    expect(refused.json()).toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    expect(COMMAND_ERROR_STATUS.confirmation_required).toBe(428)

    const otherCommand = await post({ ...revoke, confirm: ['deck.delete'] })
    expect(otherCommand.statusCode).toBe(428)
    expect(fakeOps().every((o) => o.error !== undefined)).toBe(true)

    const confirmed = await post({ ...revoke, confirm: ['share.fakeRevoke'] })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json()).toMatchObject({ ok: true, result: { revoked: 'l1' } })
    expect(fakeOps().find((o) => o.error === undefined)).toMatchObject({
      confirmation: { via: 'explicit', by: 'dev-user', surface: 'api' },
    })
  })

  it('accepts only a list of distinct command ids as `confirm` (no blanket flag)', async () => {
    for (const confirm of [
      true,
      'share.fakeRevoke',
      [],
      ['share.fakeRevoke', 'share.fakeRevoke'],
      ['not an id'],
    ]) {
      const res = await post({ ...revoke, confirm })
      expect(res.statusCode, JSON.stringify(confirm)).toBe(400)
    }
  })

  it('answers internal failures with a reference, never the detail', async () => {
    const res = await post({ command: 'deck.fakeCrash', input: {} })
    expect(res.statusCode).toBe(500)
    expect(res.json().error.message).toMatch(/reference [0-9a-f-]{36}/)
    expect(res.body).not.toContain(FAKE_INTERNAL_DETAIL)
  })
})

describe('Agent activity routes', () => {
  it('lists runs and reverts one', async () => {
    const run = (
      await post({
        target: { deckId: 'deck1' },
        command: 'object.update',
        input: { slide: 's1', object: 'r1', patch: { fill: '#ff0000' } },
      })
    ).json().runId as string

    const list = await app.inject({ method: 'GET', url: '/decks/deck1/agent-runs' })
    expect(list.statusCode).toBe(200)
    expect(list.json().runs).toEqual([
      expect.objectContaining({
        id: run,
        changeCount: 1,
        revertible: true,
        status: 'open',
        surface: 'api',
      }),
    ])

    const revert = await app.inject({ method: 'POST', url: `/agent-runs/${run}/revert` })
    expect(revert.statusCode).toBe(200)
    expect(revert.json()).toEqual({
      runId: run,
      revertedChanges: 1,
      remainingChanges: 0,
      status: 'reverted',
    })

    const again = await app.inject({ method: 'POST', url: `/agent-runs/${run}/revert` })
    expect(again.statusCode).toBe(409)
  })

  it('lists and reverts runs on a component master, separately from any deck', async () => {
    world.createDeck('component:c1')
    world.grant('component:c1', 'dev-user', 'owner')
    const run = (
      await post({
        target: { componentId: 'c1' },
        command: 'object.update',
        input: { slide: 's1', object: 'r1', patch: { fill: '#00ff00' } },
      })
    ).json().runId as string

    const list = await app.inject({ method: 'GET', url: '/components/c1/agent-runs' })
    expect(list.statusCode).toBe(200)
    expect(list.json().runs).toEqual([
      expect.objectContaining({ id: run, changeCount: 1, revertible: true }),
    ])
    const deckList = await app.inject({ method: 'GET', url: '/decks/deck1/agent-runs' })
    expect(deckList.json().runs).toEqual([])

    const revert = await app.inject({ method: 'POST', url: `/agent-runs/${run}/revert` })
    expect(revert.statusCode).toBe(200)
    expect(revert.json()).toMatchObject({ runId: run, revertedChanges: 1, status: 'reverted' })

    // Access to the master is what counts: without it the list is refused.
    world.roles.delete('component:c1|dev-user')
    const refused = await app.inject({ method: 'GET', url: '/components/c1/agent-runs' })
    expect(refused.statusCode).toBe(403)
  })

  it('answers 404 for an unknown run and 403 below the editor role', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/agent-runs/run_nope/revert' })
    expect(unknown.statusCode).toBe(404)
    const viewer = await app.inject({ method: 'GET', url: '/decks/deck2/agent-runs' })
    expect(viewer.statusCode).toBe(403)
  })

  it('validates lastOps through the command schema', async () => {
    const run = (
      await post({
        target: { deckId: 'deck1' },
        command: 'object.update',
        input: { slide: 's1', object: 'r1', patch: { fill: '#ff0000' } },
      })
    ).json().runId as string
    const res = await app.inject({
      method: 'POST',
      url: `/agent-runs/${run}/revert`,
      payload: { lastOps: 0 },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /commands with real credentials', () => {
  let real: FastifyInstance
  let patToken: string

  beforeEach(async () => {
    world.grant('deck1', 'user-1', 'editor')
    const pats = createPatService(createMemoryPatStore(), { isOwnerAllowed: allowAllPatOwners })
    patToken = (await pats.create('user-1', { name: 'script', scopes: ['api'], expiresInDays: 30 }))
      .token
    real = Fastify({ logger: false })
    registerAuthPlugin(real, { bypass: false, db: {} as Database, pats })
    registerSameOriginPolicy(real, { allowedOrigins: [SPA] })
    await registerAgentRoutes(real, { agent: world.runtime })
    await real.ready()
  })

  afterEach(async () => {
    await real.close()
  })

  const rename = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
    real.inject({
      method: 'POST',
      url: '/commands',
      headers,
      payload: {
        target: { deckId: 'deck1' },
        command: 'slide.rename',
        input: { slide: { index: 1 }, name: 'Renamed' },
        ...extra,
      },
    })
  const session = (n: number) => ({ cookie: `narrative_session=s-user-1-${n}` })

  it('refuses a session without Narrative’s own Origin, before anything runs', async () => {
    for (const headers of [
      session(1),
      { ...session(1), origin: 'https://evil.example' },
      { ...session(1), origin: 'null' },
    ]) {
      const res = await rename(headers)
      expect(res.statusCode, JSON.stringify(headers)).toBe(403)
      expect(res.json()).toMatchObject({ error: 'forbidden_origin' })
    }
    expect(world.store.runs.size).toBe(0)
    expect((await rename({ ...session(1), origin: SPA })).statusCode).toBe(200)
  })

  it('answers no phases to a caller that is not authenticated (G7 review)', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer nrt_not-a-real-token-0000000000000000' },
      { authorization: `Bearer ${patToken}x` },
    ]) {
      const res = await rename({ ...headers, 'x-narrative-timing': '1' })
      expect(res.statusCode, JSON.stringify(headers)).toBe(401)
      expect(res.headers['server-timing']).toBeUndefined()
    }
    const ok = await rename({ authorization: `Bearer ${patToken}`, 'x-narrative-timing': '1' })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['server-timing']).toContain('http.pre')
  })

  it('needs no Origin for a personal access token, and still 401s without any credential', async () => {
    expect((await rename({ authorization: `Bearer ${patToken}` })).statusCode).toBe(200)
    expect((await rename({ origin: SPA })).statusCode).toBe(401)
  })

  it('keys runs per browser session: another session of the same user cannot attach to them', async () => {
    const first = await rename({ ...session(1), origin: SPA })
    expect(first.statusCode).toBe(200)
    const runId = first.json().runId as string
    // The same session may continue the run…
    const same = await rename({ ...session(1), origin: SPA }, { runId })
    expect(same.statusCode).toBe(200)
    expect(same.json().runId).toBe(runId)
    // …another browser session of the same user may not, and neither may a token.
    const other = await rename({ ...session(2), origin: SPA }, { runId })
    expect(other.statusCode).toBe(409)
    expect(other.json().error).toMatchObject({ code: 'conflict' })
    const byToken = await rename({ authorization: `Bearer ${patToken}` }, { runId })
    expect(byToken.statusCode).toBe(409)
    // Without a runId, the other session gets a run of its own.
    const own = await rename({ ...session(2), origin: SPA })
    expect(own.statusCode).toBe(200)
    expect(own.json().runId).not.toBe(runId)
  })
})
