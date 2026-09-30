/**
 * routes/componentStaging.test.ts — the editor's two component writes:
 * POST /decks/:id/promote-component (component.promote) and
 * POST /decks/:id/stamp-component (component.stamp). Body validation, the
 * editor role on the deck, and the hand-off to the shared services (the
 * folder rule and the media copy are theirs; services/componentStaging.test.ts
 * covers them).
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

const promoteComponent = vi.fn()
const prepareComponentStamp = vi.fn()
const stampComponentIntoDeck = vi.fn()
vi.mock('../services/componentStaging.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/componentStaging.js')>()
  return { ...original, promoteComponent, prepareComponentStamp, stampComponentIntoDeck }
})

const { resolveDeckAccess } = await import('../auth/permissions.js')
const { registerAuthPlugin } = await import('../auth/fastifyAuth.js')
const { registerComponentRoutes } = await import('./components.js')
const { forbidden } = await import('../services/errors.js')

/** The component the stamp's master read finds: a folder the dev user owns. */
const COMPONENT_ROW = {
  id: 'cmp1',
  folderId: 'f1',
  name: 'Headline',
  thumbnailKey: null,
  createdAt: new Date('2026-09-30'),
  updatedAt: new Date('2026-09-30'),
}

/** Answers `readMaster`'s lookups: the deck's folder, the component, the folder, its stored master. */
function readMasterDb(): Database {
  const results: unknown[][] = [
    [{ folderId: 'f1' }],
    [COMPONENT_ROW],
    [{ id: 'f1', ownerUserId: 'dev-user', name: 'Client' }],
    [],
  ]
  const query = (): unknown => {
    const q: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'limit', 'orderBy']) q[m] = () => q
    q['then'] = (ok: (v: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(ok)
    return q
  }
  return { select: query } as unknown as Database
}

async function buildApp(
  access: DeckAccessResult | null = { role: 'editor', reason: 'direct' },
  db: Database = {} as Database,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass: true, db })
  vi.mocked(resolveDeckAccess).mockResolvedValue(access)
  await registerComponentRoutes(app, db)
  await app.ready()
  return app
}

const PROMOTED = {
  component: { id: 'cmp1', folderId: 'f1', name: 'Headline' },
  objectCount: 2,
  mediaCopied: 1,
  skippedImages: 0,
  droppedLinks: 0,
}

describe('POST /decks/:id/promote-component', () => {
  beforeEach(() => {
    promoteComponent.mockReset()
    promoteComponent.mockResolvedValue(PROMOTED)
  })

  it('makes the selected objects of the slide a component', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck1/promote-component',
      payload: { slideId: 'S1', objectIds: ['a', 'b'], name: 'Headline' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual(PROMOTED)
    expect(promoteComponent).toHaveBeenCalledWith(expect.anything(), {
      userId: 'dev-user',
      deckId: 'deck1',
      slide: 'S1',
      objects: ['a', 'b'],
      name: 'Headline',
    })
  })

  it('refuses a malformed body before calling the service', async () => {
    const app = await buildApp()
    for (const payload of [
      {},
      { slideId: 'S1', objectIds: [], name: 'X' },
      { slideId: 'S1', objectIds: ['a'], name: '   ' },
      { slideId: 'S1', objectIds: ['a'], name: 'X', extra: 1 },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/decks/deck1/promote-component',
        payload,
      })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(promoteComponent).not.toHaveBeenCalled()
  })

  it("needs the editor role on the deck, and passes on the folder owner's refusal", async () => {
    const payload = { slideId: 'S1', objectIds: ['a'], name: 'X' }
    const viewer = await buildApp({ role: 'viewer', reason: 'direct' })
    expect(
      (await viewer.inject({ method: 'POST', url: '/decks/deck1/promote-component', payload }))
        .statusCode,
    ).toBe(403)
    expect(promoteComponent).not.toHaveBeenCalled()

    promoteComponent.mockRejectedValue(forbidden("this deck's folder is not yours"))
    const app = await buildApp()
    expect(
      (await app.inject({ method: 'POST', url: '/decks/deck1/promote-component', payload }))
        .statusCode,
    ).toBe(403)
  })

  it('answers an object the slide does not have with 404', async () => {
    promoteComponent.mockRejectedValue(
      new CommandError('not_found', "object 'ghost' does not exist on slide 'S1'"),
    )
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck1/promote-component',
      payload: { slideId: 'S1', objectIds: ['ghost'], name: 'X' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /decks/:id/stamp-component', () => {
  const PREPARED = { master: {}, mediaRegistered: 0, skippedImages: 0, discard: vi.fn() }
  const STAMPED = { objectIds: ['n1', 'n2'], filledSlots: [], at: { x: 100, y: 80 } }

  beforeEach(() => {
    prepareComponentStamp.mockReset()
    stampComponentIntoDeck.mockReset()
    prepareComponentStamp.mockResolvedValue(PREPARED)
    stampComponentIntoDeck.mockResolvedValue(STAMPED)
  })

  it('stages the master for the deck, then stamps it onto the slide', async () => {
    const app = await buildApp(undefined, readMasterDb())
    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck1/stamp-component',
      payload: { componentId: 'cmp1', slideId: 'S1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(STAMPED)
    const [, args] = stampComponentIntoDeck.mock.calls[0]! as [
      unknown,
      { prepare: () => Promise<unknown> } & Record<string, unknown>,
    ]
    expect(args).toMatchObject({ deckId: 'deck1', componentId: 'cmp1', slideId: 'S1' })
    // The staging it runs once the slide is found: the master, read with the deck's rule.
    await expect(args.prepare()).resolves.toBe(PREPARED)
    expect(prepareComponentStamp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'dev-user', componentId: 'cmp1', deckId: 'deck1' }),
    )
  })

  it('refuses a malformed body, and a viewer, before staging anything', async () => {
    const app = await buildApp()
    for (const payload of [
      {},
      { componentId: 'cmp1' },
      { componentId: 'cmp1', slideId: 'S1', at: { x: 'a', y: 0 } },
      { componentId: 'cmp1', slideId: 'S1', slots: {} },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/decks/deck1/stamp-component', payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    const viewer = await buildApp({ role: 'viewer', reason: 'direct' })
    const res = await viewer.inject({
      method: 'POST',
      url: '/decks/deck1/stamp-component',
      payload: { componentId: 'cmp1', slideId: 'S1' },
    })
    expect(res.statusCode).toBe(403)
    expect(prepareComponentStamp).not.toHaveBeenCalled()
  })

  it('answers a slide the deck does not have with 404', async () => {
    stampComponentIntoDeck.mockRejectedValue(
      new CommandError('not_found', "slide 'S9' does not exist"),
    )
    const app = await buildApp(undefined, readMasterDb())
    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck1/stamp-component',
      payload: { componentId: 'cmp1', slideId: 'S9' },
    })
    expect(res.statusCode).toBe(404)
  })
})
