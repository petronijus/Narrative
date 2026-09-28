/**
 * routes/pptxImport.test.ts — POST /decks/:id/insert-slides, the editor's
 * cross-deck slide paste: body validation, the editor role on the TARGET
 * deck, and the hand-off to the shared insert service (the access rule on
 * the source deck, media copy and token rebinding are that service's, and
 * services/deckInsert.test.ts covers them).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import type { DeckAccessResult } from '../auth/permissions.js'

vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return { ...original, resolveDeckAccess: vi.fn() }
})

const insertSlidesFromDeck = vi.fn()
vi.mock('../services/pptx.js', () => ({
  createPptxService: () => ({ insertSlidesFromDeck }),
}))

const { resolveDeckAccess } = await import('../auth/permissions.js')
const { registerAuthPlugin } = await import('../auth/fastifyAuth.js')
const { registerPptxImportRoutes } = await import('./pptxImport.js')
const { forbidden } = await import('../services/errors.js')

async function buildApp(
  access: DeckAccessResult | null = { role: 'editor', reason: 'direct' },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = {} as Database
  registerAuthPlugin(app, { bypass: true, db })
  vi.mocked(resolveDeckAccess).mockResolvedValue(access)
  await registerPptxImportRoutes(app, db)
  await app.ready()
  return app
}

const RESULT = {
  slideIds: ['n1', 'n2'],
  insertedAt: 3,
  objectsCreated: 4,
  mediaRegistered: 1,
  skipped: { images: 0, unknownShapes: 0 },
  ignoredElements: [],
  droppedLinks: 0,
}

describe('POST /decks/:id/insert-slides', () => {
  beforeEach(() => {
    insertSlidesFromDeck.mockReset()
    insertSlidesFromDeck.mockResolvedValue(RESULT)
  })

  it('copies the chosen slides of the source deck into this one', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/decks/dst/insert-slides',
      payload: { sourceDeckId: 'src', slideIds: ['s1', 's3'], at: 3 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(RESULT)
    expect(insertSlidesFromDeck).toHaveBeenCalledWith({
      userId: 'dev-user',
      deckId: 'dst',
      sourceDeckId: 'src',
      slideIds: ['s1', 's3'],
      at: 3,
    })
  })

  it('refuses a body that is not { sourceDeckId, slideIds, at? }', async () => {
    const app = await buildApp()
    for (const payload of [
      {},
      { sourceDeckId: 'src', slideIds: [] },
      { sourceDeckId: 'src', slideIds: ['s1'], at: -1 },
      { sourceDeckId: 'src', slideIds: ['s1'], extra: true },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/decks/dst/insert-slides', payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(insertSlidesFromDeck).not.toHaveBeenCalled()
  })

  it('needs the editor role on the target deck', async () => {
    const app = await buildApp({ role: 'viewer', reason: 'direct' })
    const res = await app.inject({
      method: 'POST',
      url: '/decks/dst/insert-slides',
      payload: { sourceDeckId: 'src', slideIds: ['s1'] },
    })
    expect(res.statusCode).toBe(403)
    expect(insertSlidesFromDeck).not.toHaveBeenCalled()
  })

  it("answers with the service's refusal (no editor access to the source deck)", async () => {
    insertSlidesFromDeck.mockRejectedValue(forbidden('Copying slides needs editor access'))
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/decks/dst/insert-slides',
      payload: { sourceDeckId: 'src', slideIds: ['s1'] },
    })
    expect(res.statusCode).toBe(403)
  })
})
