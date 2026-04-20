/**
 * auth/fastifyAuth.test.ts
 *
 * Tests for Fastify auth plugin and pre-handler hooks.
 *
 * Coverage:
 *   authPreHandler:
 *     - valid Bearer token → request.user set
 *     - missing Authorization header → 401
 *     - invalid token → 401
 *     - bypass mode → dev-user synthesized
 *   requireDeckRole:
 *     - user with required role → passes, request.deckAccess set
 *     - insufficient role → 403
 *     - no user (unauthenticated) → no access → 403
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthPlugin, authPreHandler, requireDeckRole } from './fastifyAuth.js'
import type { JwtVerifier, JwtPayload } from './jwt.js'
import type { Database } from '../db/client.js'
import type { DeckRole, DeckAccessResult } from './permissions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVerifier(result: JwtPayload | 'throw'): JwtVerifier {
  return {
    verify: vi.fn(async (token: string) => {
      if (result === 'throw') throw new Error('Invalid credentials')
      if (token === 'valid') return result
      throw new Error('Invalid credentials')
    }),
  }
}

/** Minimal mock db for resolveDeckAccess inside requireDeckRole */
function makeMockDb(accessResult: DeckAccessResult | null) {
  // resolveDeckAccess queries deckPermissions + decks; mock chainable builder
  const chainable = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      if (accessResult) {
        // Return a mock permissions row
        return Promise.resolve([
          {
            deckId: 'deck-1',
            userId: 'user-1',
            role: accessResult.role,
            grantedAt: new Date(),
            grantedBy: null,
          },
        ])
      }
      return Promise.resolve([])
    }),
  }

  return {
    select: vi.fn().mockReturnValue(chainable),
  } as unknown as Database
}

async function buildApp(
  verifier: JwtVerifier | null,
  bypass: boolean,
  db: Database,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAuthPlugin(app, { verifier, bypass, db })

  // Route: tests authPreHandler
  app.get('/test-auth', { preHandler: authPreHandler }, async (req) => {
    return { sub: req.user?.sub ?? null }
  })

  // Route: tests requireDeckRole
  app.get<{ Params: { id: string } }>(
    '/decks/:id/test-role',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (req) => {
      return { role: req.deckAccess?.role ?? null }
    },
  )

  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// authPreHandler tests
// ---------------------------------------------------------------------------

describe('authPreHandler', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sets request.user when Bearer token is valid', async () => {
    const user: JwtPayload = { sub: 'user-abc', email: 'alice@example.com' }
    const db = makeMockDb({ role: 'editor', reason: 'direct' })
    const app = await buildApp(makeVerifier(user), false, db)

    const res = await app.inject({
      method: 'GET',
      url: '/test-auth',
      headers: { authorization: 'Bearer valid' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { sub: string }
    expect(body.sub).toBe('user-abc')
  })

  it('returns 401 when Authorization header is missing', async () => {
    const db = makeMockDb(null)
    const app = await buildApp(makeVerifier('throw'), false, db)

    const res = await app.inject({ method: 'GET', url: '/test-auth' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 when Bearer token is invalid', async () => {
    const db = makeMockDb(null)
    const app = await buildApp(makeVerifier('throw'), false, db)

    const res = await app.inject({
      method: 'GET',
      url: '/test-auth',
      headers: { authorization: 'Bearer bad-token' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 when header uses wrong scheme', async () => {
    const db = makeMockDb(null)
    const app = await buildApp(makeVerifier('throw'), false, db)

    const res = await app.inject({
      method: 'GET',
      url: '/test-auth',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('synthesizes dev-user in bypass mode without calling verifier', async () => {
    const verifier = makeVerifier('throw')
    const db = makeMockDb({ role: 'owner', reason: 'direct' })
    const app = await buildApp(verifier, true, db)

    const res = await app.inject({ method: 'GET', url: '/test-auth' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { sub: string }
    expect(body.sub).toBe('dev-user')
    expect(verifier.verify).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// requireDeckRole tests
// ---------------------------------------------------------------------------

describe('requireDeckRole', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows access when user has required role', async () => {
    const user: JwtPayload = { sub: 'user-1' }
    const db = makeMockDb({ role: 'editor', reason: 'direct' })
    const app = await buildApp(makeVerifier(user), false, db)

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
      headers: { authorization: 'Bearer valid' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { role: DeckRole }
    expect(body.role).toBe('editor')
  })

  it('allows access when user has higher role than required', async () => {
    const user: JwtPayload = { sub: 'user-1' }
    const db = makeMockDb({ role: 'owner', reason: 'direct' })
    const app = await buildApp(makeVerifier(user), false, db)

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
      headers: { authorization: 'Bearer valid' },
    })

    expect(res.statusCode).toBe(200)
  })

  it('returns 403 when user has insufficient role (viewer < editor)', async () => {
    const user: JwtPayload = { sub: 'user-1' }
    const db = makeMockDb({ role: 'viewer', reason: 'direct' })
    // Override mock: role is viewer so roleAtLeast('viewer', 'editor') = false
    // But our mock db returns 'viewer' from permissions query — need a custom mock
    // that actually calls roleAtLeast logic in the real resolveDeckAccess path.
    // For this test, mock db returns a viewer row.
    const app = await buildApp(makeVerifier(user), false, db)

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
      headers: { authorization: 'Bearer valid' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 403 when resolveDeckAccess returns null (no access)', async () => {
    const user: JwtPayload = { sub: 'user-no-access' }
    const db = makeMockDb(null)
    const app = await buildApp(makeVerifier(user), false, db)

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
      headers: { authorization: 'Bearer valid' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 401 when no token provided (authPreHandler blocks before requireDeckRole)', async () => {
    const db = makeMockDb(null)
    const app = await buildApp(makeVerifier('throw'), false, db)

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
    })

    expect(res.statusCode).toBe(401)
  })
})
