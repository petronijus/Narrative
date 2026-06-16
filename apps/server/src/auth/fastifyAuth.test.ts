/**
 * auth/fastifyAuth.test.ts
 *
 * Tests for Fastify auth plugin and pre-handler hooks (cookie-based, since
 * the 2026-05 cutover from browser-PKCE + Bearer to server-side sessions).
 *
 * Coverage:
 *   authPreHandler:
 *     - valid session cookie → request.user populated from session row
 *     - missing cookie → 401
 *     - cookie present but no matching session row → 401
 *     - bypass mode → dev-user synthesised
 *   requireDeckRole:
 *     - user with required role → passes, request.deckAccess set
 *     - insufficient role → 403
 *     - no user (unauthenticated) → no access → 403
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import {
  registerAuthPlugin,
  authPreHandler,
  requireDeckRole,
  assertAuthBootSafety,
} from './fastifyAuth.js'
import { SESSION_COOKIE_NAME } from './session.js'
import type { Database } from '../db/client.js'
import type { DeckRole, DeckAccessResult } from './permissions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeSession {
  userSub: string
  userEmail: string
  userName: string | null
}

/**
 * Mock db that satisfies both `lookupSession()` (db.update().set().where().returning())
 * and `resolveDeckAccess()` (db.select().from().where().limit()).
 *
 * - `session`: the row `lookupSession` should return for a "valid" cookie, or
 *   null to simulate no row found.
 * - `accessResult`: the role row `resolveDeckAccess` should return; null = none.
 */
function makeMockDb(session: FakeSession | null, accessResult: DeckAccessResult | null) {
  const updateBuilder = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockImplementation(() => Promise.resolve(session ? [session] : [])),
  }

  const selectBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      if (accessResult) {
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
    update: vi.fn().mockReturnValue(updateBuilder),
    select: vi.fn().mockReturnValue(selectBuilder),
  } as unknown as Database
}

async function buildApp(session: FakeSession | null, bypass: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie, { secret: 'test-secret' })

  // resolveDeckAccess: tests below pass different roles via the test-specific
  // arg. We default to editor here; tests that need a different role build
  // their own app.
  const db = makeMockDb(session, { role: 'editor', reason: 'direct' })
  registerAuthPlugin(app, { bypass, db })

  app.get('/test-auth', { preHandler: authPreHandler }, async (req) => ({
    sub: req.user?.sub ?? null,
  }))

  app.get<{ Params: { id: string } }>(
    '/decks/:id/test-role',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (req) => ({ role: req.deckAccess?.role ?? null }),
  )

  await app.ready()
  return app
}

async function buildAppForRole(
  session: FakeSession,
  accessResult: DeckAccessResult | null,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie, { secret: 'test-secret' })
  const db = makeMockDb(session, accessResult)
  registerAuthPlugin(app, { bypass: false, db })

  app.get<{ Params: { id: string } }>(
    '/decks/:id/test-role',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (req) => ({ role: req.deckAccess?.role ?? null }),
  )

  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// authPreHandler tests
// ---------------------------------------------------------------------------

describe('authPreHandler (cookie-based)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('populates request.user when the session cookie resolves', async () => {
    const app = await buildApp(
      { userSub: 'user-abc', userEmail: 'alice@example.com', userName: 'Alice' },
      false,
    )

    const res = await app.inject({
      method: 'GET',
      url: '/test-auth',
      cookies: { [SESSION_COOKIE_NAME]: 'any-opaque-id' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { sub: string }
    expect(body.sub).toBe('user-abc')
  })

  it('returns 401 when the session cookie is missing', async () => {
    const app = await buildApp(null, false)

    const res = await app.inject({ method: 'GET', url: '/test-auth' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 when the cookie is present but no matching session row exists', async () => {
    const app = await buildApp(null, false)

    const res = await app.inject({
      method: 'GET',
      url: '/test-auth',
      cookies: { [SESSION_COOKIE_NAME]: 'stale-cookie' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('synthesises dev-user in bypass mode without touching the DB', async () => {
    const app = await buildApp(null, true)

    const res = await app.inject({ method: 'GET', url: '/test-auth' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { sub: string }
    expect(body.sub).toBe('dev-user')
  })
})

// ---------------------------------------------------------------------------
// requireDeckRole tests
// ---------------------------------------------------------------------------

describe('requireDeckRole (cookie-based)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows access when the user has the required role', async () => {
    const app = await buildAppForRole(
      { userSub: 'user-1', userEmail: 'a@b.c', userName: null },
      { role: 'editor', reason: 'direct' },
    )

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
      cookies: { [SESSION_COOKIE_NAME]: 'any' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { role: DeckRole }
    expect(body.role).toBe('editor')
  })

  it('allows access when the user has a higher role than required', async () => {
    const app = await buildAppForRole(
      { userSub: 'user-1', userEmail: 'a@b.c', userName: null },
      { role: 'owner', reason: 'direct' },
    )

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
      cookies: { [SESSION_COOKIE_NAME]: 'any' },
    })

    expect(res.statusCode).toBe(200)
  })

  it('returns 403 when role is insufficient (viewer < editor)', async () => {
    const app = await buildAppForRole(
      { userSub: 'user-1', userEmail: 'a@b.c', userName: null },
      { role: 'viewer', reason: 'direct' },
    )

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
      cookies: { [SESSION_COOKIE_NAME]: 'any' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 403 when resolveDeckAccess returns null', async () => {
    const app = await buildAppForRole(
      { userSub: 'user-no-access', userEmail: 'a@b.c', userName: null },
      null,
    )

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
      cookies: { [SESSION_COOKIE_NAME]: 'any' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 401 when no cookie is sent (authPreHandler blocks before requireDeckRole)', async () => {
    const app = await buildAppForRole(
      { userSub: 'user-1', userEmail: 'a@b.c', userName: null },
      { role: 'editor', reason: 'direct' },
    )

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1/test-role',
    })

    expect(res.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// assertAuthBootSafety — fail-fast guard against BYPASS_AUTH in production
// ---------------------------------------------------------------------------

describe('assertAuthBootSafety', () => {
  it('THROWS when BYPASS_AUTH is on AND NODE_ENV=production', () => {
    expect(() => assertAuthBootSafety({ bypassAuth: true, nodeEnv: 'production' })).toThrowError(
      /BYPASS_AUTH.*production/i,
    )
  })

  it('does NOT throw with BYPASS_AUTH on in dev (NODE_ENV=development)', () => {
    expect(() => assertAuthBootSafety({ bypassAuth: true, nodeEnv: 'development' })).not.toThrow()
  })

  it('does NOT throw with BYPASS_AUTH on when NODE_ENV is unset (treated as dev)', () => {
    const result = assertAuthBootSafety({ bypassAuth: true, nodeEnv: undefined })
    expect(result.nodeEnvUnset).toBe(true)
  })

  it('does NOT throw in production when BYPASS_AUTH is off', () => {
    const result = assertAuthBootSafety({ bypassAuth: false, nodeEnv: 'production' })
    expect(result.nodeEnvUnset).toBe(false)
  })

  it('reports nodeEnvUnset=false when NODE_ENV is set', () => {
    expect(assertAuthBootSafety({ bypassAuth: false, nodeEnv: 'development' }).nodeEnvUnset).toBe(
      false,
    )
  })
})
