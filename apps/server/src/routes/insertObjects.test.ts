/**
 * routes/insertObjects.test.ts — POST /decks/:id/insert-objects and
 * POST /components/:id/insert-objects, the editor's cross-document object
 * paste: body validation (exactly one source, a deck or a component), the
 * editor role on a TARGET deck, invalid objects answered as 400 with the
 * field, and the hand-off to the shared insert service (the source and
 * master access rules, media copy and token rebinding are the service's;
 * services/deckInsert.test.ts covers them).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { CommandError } from '@narrative/commands'
import type { Database } from '../db/client.js'
import type { DeckAccessResult } from '../auth/permissions.js'

vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return { ...original, resolveDeckAccess: vi.fn() }
})

const insertObjectsFrom = vi.fn()
vi.mock('../services/deckInsert.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/deckInsert.js')>()
  return { ...original, insertObjectsFrom }
})

const { resolveDeckAccess } = await import('../auth/permissions.js')
const { registerAuthPlugin } = await import('../auth/fastifyAuth.js')
const { registerDeckRoutes } = await import('./decks.js')
const { registerComponentRoutes } = await import('./components.js')
const { forbidden, notFound } = await import('../services/errors.js')

async function buildApp(
  access: DeckAccessResult | null = { role: 'editor', reason: 'direct' },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = {} as Database
  registerAuthPlugin(app, { bypass: true, db })
  vi.mocked(resolveDeckAccess).mockResolvedValue(access)
  await registerDeckRoutes(app, db)
  await app.ready()
  return app
}

const OBJECTS = [{ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }]
const RESULT = { objectIds: ['n1'], mediaRegistered: 0, skippedImages: 0, droppedLinks: 0 }

describe('POST /decks/:id/insert-objects', () => {
  beforeEach(() => {
    insertObjectsFrom.mockReset()
    insertObjectsFrom.mockResolvedValue(RESULT)
  })

  it('pastes the objects read from the source deck onto the slide', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/decks/dst/insert-objects',
      payload: { sourceDeckId: 'src', slideId: 'T1', objects: OBJECTS, at: { x: 960, y: 540 } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(RESULT)
    expect(insertObjectsFrom).toHaveBeenCalledWith(expect.anything(), {
      userId: 'dev-user',
      source: { deckId: 'src' },
      target: { deckId: 'dst' },
      slideId: 'T1',
      objects: OBJECTS,
      at: { x: 960, y: 540 },
    })
  })

  it('refuses a malformed body before calling the service', async () => {
    const app = await buildApp()
    for (const payload of [
      {},
      { sourceDeckId: 'src', slideId: 'T1', objects: [] },
      { sourceDeckId: 'src', slideId: 'T1', objects: OBJECTS, extra: 1 },
      { sourceDeckId: 'src', slideId: 'T1', objects: OBJECTS, at: { x: 'a', y: 0 } },
      // Exactly one source.
      { slideId: 'T1', objects: OBJECTS },
      { sourceDeckId: 'src', sourceComponentId: 'cmp1', slideId: 'T1', objects: OBJECTS },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/decks/dst/insert-objects', payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(insertObjectsFrom).not.toHaveBeenCalled()
  })

  it('answers invalid objects with 400 and the offending field', async () => {
    insertObjectsFrom.mockRejectedValue(
      new CommandError('invalid_input', 'objects[0]: invalid rectangle', {
        issues: [{ path: ['objects', 0, 'width'], message: 'Too small' }],
      }),
    )
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/decks/dst/insert-objects',
      payload: { sourceDeckId: 'src', slideId: 'T1', objects: OBJECTS },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().issues[0].path).toEqual(['objects', 0, 'width'])
  })

  it('needs the editor role here, and passes on the refusal for the source', async () => {
    const viewer = await buildApp({ role: 'viewer', reason: 'direct' })
    const payload = { sourceDeckId: 'src', slideId: 'T1', objects: OBJECTS }
    expect(
      (await viewer.inject({ method: 'POST', url: '/decks/dst/insert-objects', payload }))
        .statusCode,
    ).toBe(403)
    expect(insertObjectsFrom).not.toHaveBeenCalled()

    insertObjectsFrom.mockRejectedValue(forbidden('Copying from deck src needs editor access'))
    const app = await buildApp()
    expect(
      (await app.inject({ method: 'POST', url: '/decks/dst/insert-objects', payload })).statusCode,
    ).toBe(403)
  })
})

describe('POST /components/:id/insert-objects', () => {
  beforeEach(() => {
    insertObjectsFrom.mockReset()
    insertObjectsFrom.mockResolvedValue(RESULT)
  })

  async function buildComponentApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false })
    const db = {} as Database
    registerAuthPlugin(app, { bypass: true, db })
    await registerComponentRoutes(app, db)
    await app.ready()
    return app
  }

  it("pastes a deck's objects into the master (the service checks the editor role in its folder)", async () => {
    const app = await buildComponentApp()
    const res = await app.inject({
      method: 'POST',
      url: '/components/cmp1/insert-objects',
      payload: { sourceDeckId: 'src', slideId: 'master', objects: OBJECTS },
    })
    expect(res.statusCode).toBe(200)
    expect(insertObjectsFrom).toHaveBeenCalledWith(expect.anything(), {
      userId: 'dev-user',
      source: { deckId: 'src' },
      target: { componentId: 'cmp1' },
      slideId: 'master',
      objects: OBJECTS,
    })
  })

  it('passes on the refusal for a master the user cannot see', async () => {
    insertObjectsFrom.mockRejectedValue(notFound("Component 'cmp1' not found"))
    const app = await buildComponentApp()
    const res = await app.inject({
      method: 'POST',
      url: '/components/cmp1/insert-objects',
      payload: { sourceComponentId: 'cmp2', slideId: 'master', objects: OBJECTS },
    })
    expect(res.statusCode).toBe(404)
  })
})
