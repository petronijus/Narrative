/**
 * auth/tokenAuth.test.ts
 *
 * Personal access tokens as a second identity in the Fastify pre-handlers:
 *   - `authPreHandler` (every browser route) stays session-only and rejects
 *     a valid PAT with 403, so PATs reach nothing but the agent surface;
 *   - `requireTokenScope(scope)` admits PATs carrying `scope` only;
 *   - identity is resolved once per request (rate limiter + pre-handler).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('./session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./session.js')>()
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, rawId: string) =>
      rawId === 'good-session'
        ? { userSub: 'user-1', userEmail: 'petr@example.com', userName: 'Petr' }
        : null,
    ),
  }
})

import { lookupSession } from './session.js'
import { authPreHandler, registerAuthPlugin, requireTokenScope } from './fastifyAuth.js'
import { createPatService, type PatScope, type PatService } from './personalAccessTokens.js'
import { registerRateLimit } from '../http/rateLimit.js'
import {
  createMemoryPatStore,
  type MemoryPatStore,
  allowAllPatOwners,
} from '../test-support/memoryPatStore.js'
import type { Database } from '../db/client.js'

const COOKIE = { cookie: 'narrative_session=good-session' }
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

let store: MemoryPatStore
let pats: PatService

async function buildApp(
  opts: { bypass?: boolean; rateLimit?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass: opts.bypass ?? false, db: {} as Database, pats })
  if (opts.rateLimit) await registerRateLimit(app)
  const echo = async (req: { user?: unknown; auth?: unknown }) => ({
    user: req.user,
    auth: req.auth,
  })
  app.get('/legacy', { preHandler: [authPreHandler] }, echo)
  app.post('/agent/api', { preHandler: [requireTokenScope('api')] }, echo)
  app.post('/agent/mcp', { preHandler: [requireTokenScope('mcp')] }, echo)
  app.post(
    '/agent/api-or-session',
    { preHandler: [requireTokenScope('api', { allowSession: true })] },
    echo,
  )
  await app.ready()
  return app
}

async function mint(scopes: PatScope[], userSub = 'user-1') {
  return (await pats.create(userSub, { name: 't', scopes, expiresInDays: 365 })).token
}

beforeEach(() => {
  vi.clearAllMocks()
  store = createMemoryPatStore()
  store.owners.set('user-1', { email: 'petr@example.com', name: 'Petr' })
  pats = createPatService(store, { isOwnerAllowed: allowAllPatOwners })
})

describe('authPreHandler (browser routes)', () => {
  it('admits a session cookie and marks the request as a session', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/legacy', headers: COOKIE })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      user: { sub: 'user-1', email: 'petr@example.com', name: 'Petr' },
      auth: {
        kind: 'session',
        scopes: [],
        tokenId: null,
        sessionKey: expect.any(String),
        bypass: false,
      },
    })
  })

  it('rejects a valid PAT with 403, whatever its scopes', async () => {
    const app = await buildApp()
    for (const scopes of [['mcp'], ['api'], ['mcp', 'api']] as PatScope[][]) {
      const res = await app.inject({
        method: 'GET',
        url: '/legacy',
        headers: bearer(await mint(scopes)),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ error: 'token_not_accepted' })
    }
  })

  it('does not let a PAT ride along with a valid cookie', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/legacy',
      headers: { ...COOKIE, ...bearer(await mint(['api'])) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('treats an invalid PAT as unauthenticated even when a valid cookie is present', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/legacy',
      headers: { ...COOKIE, ...bearer(`nrt_${'x'.repeat(43)}`) },
    })
    expect(res.statusCode).toBe(401)
  })

  it('ignores bearer values that are not PAT claims (the cookie still decides)', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/legacy',
      headers: { ...COOKIE, authorization: 'Bearer some-metrics-token' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('keeps BYPASS_AUTH behaviour: no credential → dev-user', async () => {
    const app = await buildApp({ bypass: true })
    const res = await app.inject({ method: 'GET', url: '/legacy' })
    expect(res.statusCode).toBe(200)
    expect(res.json().user).toEqual({ sub: 'dev-user', email: 'dev@localhost', name: 'Dev User' })
    expect(lookupSession).not.toHaveBeenCalled()
  })

  it('401 without any credential', async () => {
    const app = await buildApp()
    expect((await app.inject({ method: 'GET', url: '/legacy' })).statusCode).toBe(401)
  })
})

describe('requireTokenScope (agent routes)', () => {
  it('admits a PAT carrying the scope and attaches the token identity', async () => {
    const app = await buildApp()
    const token = await mint(['api'])
    const res = await app.inject({ method: 'POST', url: '/agent/api', headers: bearer(token) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user).toEqual({ sub: 'user-1', email: 'petr@example.com', name: 'Petr' })
    expect(body.auth).toMatchObject({ kind: 'token', scopes: ['api'], bypass: false })
    expect(body.auth.tokenId).toBe(store.rows[0]!.id)
  })

  it('403 insufficient_scope for a PAT without the scope, with an RFC 6750 challenge', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/agent/mcp',
      headers: bearer(await mint(['api'])),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: 'insufficient_scope', scope: 'mcp' })
    expect(res.headers['www-authenticate']).toBe(
      'Bearer realm="narrative", error="insufficient_scope", scope="mcp"',
    )
  })

  it('401 invalid_token for a revoked, expired or unknown PAT', async () => {
    const app = await buildApp()
    const revoked = await mint(['api'])
    await pats.revoke('user-1', store.rows[0]!.id)
    const expired = await mint(['api'])
    store.rows[1]!.expiresAt = new Date(Date.now() - 1000)

    for (const token of [revoked, expired, `nrt_${'Z'.repeat(43)}`]) {
      const res = await app.inject({ method: 'POST', url: '/agent/api', headers: bearer(token) })
      expect(res.statusCode).toBe(401)
      expect(res.headers['www-authenticate']).toBe(
        'Bearer realm="narrative", error="invalid_token"',
      )
    }
  })

  it('401 with a bare challenge when no credential is sent', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/agent/api' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer realm="narrative"')
  })

  it('refuses a session cookie unless the route allows sessions', async () => {
    const app = await buildApp()
    const denied = await app.inject({ method: 'POST', url: '/agent/api', headers: COOKIE })
    expect(denied.statusCode).toBe(401)
    expect(denied.json()).toMatchObject({ error: 'token_required' })

    const allowed = await app.inject({
      method: 'POST',
      url: '/agent/api-or-session',
      headers: COOKIE,
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().auth.kind).toBe('session')
  })

  it('admits the BYPASS_AUTH dev-user, but still verifies a presented PAT', async () => {
    const app = await buildApp({ bypass: true })
    const dev = await app.inject({ method: 'POST', url: '/agent/mcp' })
    expect(dev.statusCode).toBe(200)
    expect(dev.json().auth).toMatchObject({ kind: 'session', bypass: true })

    const bad = await app.inject({
      method: 'POST',
      url: '/agent/mcp',
      headers: bearer(`nrt_${'Q'.repeat(43)}`),
    })
    expect(bad.statusCode).toBe(401)

    const scoped = await app.inject({
      method: 'POST',
      url: '/agent/mcp',
      headers: bearer(await mint(['api'])),
    })
    expect(scoped.statusCode).toBe(403)
  })
})

describe('identity resolution is memoised per request', () => {
  it('verifies a PAT once even though the rate limiter and the pre-handler both need it', async () => {
    const app = await buildApp({ rateLimit: true })
    const token = await mint(['api'])
    const before = store.calls.findByHash
    const res = await app.inject({ method: 'POST', url: '/agent/api', headers: bearer(token) })
    expect(res.statusCode).toBe(200)
    expect(store.calls.findByHash - before).toBe(1)
  })

  it('looks a session up once per request', async () => {
    const app = await buildApp({ rateLimit: true })
    await app.inject({ method: 'GET', url: '/legacy', headers: COOKIE })
    expect(lookupSession).toHaveBeenCalledTimes(1)
  })
})
