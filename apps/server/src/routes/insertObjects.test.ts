/**
 * routes/insertObjects.test.ts — POST /decks/:id/insert-objects, the
 * editor's cross-deck object paste: body validation, the editor role on the
 * TARGET deck, invalid objects answered as 400 with the field, and the
 * hand-off to the shared insert service (the source access rule, media copy
 * and token rebinding are the service's; services/deckInsert.test.ts covers
 * them).
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

const insertObjectsFromDeck = vi.fn()
vi.mock('../services/deckInsert.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/deckInsert.js')>()
  return { ...original, insertObjectsFromDeck }
})

const { resolveDeckAccess } = await import('../auth/permissions.js')
const { registerAuthPlugin } = await import('../auth/fastifyAuth.js')
const { registerDeckRoutes } = await import('./decks.js')
const { forbidden } = await import('../services/errors.js')

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
    insertObjectsFromDeck.mockReset()
    insertObjectsFromDeck.mockResolvedValue(RESULT)
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
    expect(insertObjectsFromDeck).toHaveBeenCalledWith(expect.anything(), {
      userId: 'dev-user',
      deckId: 'dst',
      sourceDeckId: 'src',
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
    ]) {
      const res = await app.inject({ method: 'POST', url: '/decks/dst/insert-objects', payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(insertObjectsFromDeck).not.toHaveBeenCalled()
  })

  it('answers invalid objects with 400 and the offending field', async () => {
    insertObjectsFromDeck.mockRejectedValue(
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
    expect(insertObjectsFromDeck).not.toHaveBeenCalled()

    insertObjectsFromDeck.mockRejectedValue(forbidden('Copying from deck src needs editor access'))
    const app = await buildApp()
    expect(
      (await app.inject({ method: 'POST', url: '/decks/dst/insert-objects', payload })).statusCode,
    ).toBe(403)
  })
})
