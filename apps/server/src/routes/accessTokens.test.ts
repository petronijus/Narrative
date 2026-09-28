/**
 * routes/accessTokens.test.ts
 *
 * The personal access token routes: session-only credential management.
 * A PAT can never list, mint or revoke PATs; the secret is returned once and
 * kept out of caches; revocation takes effect on the next call; creation is
 * rate limited per user.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('../auth/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/session.js')>()
  const users: Record<string, { userSub: string; userEmail: string; userName: string | null }> = {
    'session-user-1': { userSub: 'user-1', userEmail: 'one@example.com', userName: 'One' },
    'session-user-2': { userSub: 'user-2', userEmail: 'two@example.com', userName: 'Two' },
  }
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, raw: string) => users[raw] ?? null),
  }
})

import { registerAgentSessionRegistry } from '../auth/agentSessions.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import {
  createPatService,
  MAX_ACTIVE_PATS_PER_USER,
  type PatService,
} from '../auth/personalAccessTokens.js'
import { registerAccessTokenRoutes } from './accessTokens.js'
import { registerRateLimit, TOKEN_CREATE_RATE_LIMIT } from '../http/rateLimit.js'
import {
  createMemoryPatStore,
  type MemoryPatStore,
  allowAllPatOwners,
} from '../test-support/memoryPatStore.js'
import type { Database } from '../db/client.js'

const asUser1 = { cookie: 'narrative_session=session-user-1' }
const asUser2 = { cookie: 'narrative_session=session-user-2' }
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

let store: MemoryPatStore
let pats: PatService
let app: FastifyInstance
const revokeUploadSessions = vi.fn(async (_key: string) => 0)

async function buildApp(opts: { rateLimit?: boolean } = {}) {
  const a = Fastify({ logger: false })
  registerAuthPlugin(a, { bypass: false, db: {} as Database, pats })
  if (opts.rateLimit) await registerRateLimit(a)
  registerAccessTokenRoutes(a, { revokeUploadSessions })
  await a.ready()
  return a
}

function create(
  headers: Record<string, string>,
  body: unknown = { name: 'Laptop', scopes: ['mcp'], expiresInDays: 90 },
) {
  return app.inject({ method: 'POST', url: '/access-tokens', headers, payload: body as object })
}

beforeEach(async () => {
  vi.clearAllMocks()
  store = createMemoryPatStore()
  pats = createPatService(store, { isOwnerAllowed: allowAllPatOwners })
  app = await buildApp()
})

describe('POST /access-tokens', () => {
  it('201: returns the raw token once, uncacheable, with the summary', async () => {
    const res = await create(asUser1)
    expect(res.statusCode).toBe(201)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json()
    expect(body.token).toMatch(/^nrt_[A-Za-z0-9_-]{43}$/)
    expect(body.accessToken).toMatchObject({
      name: 'Laptop',
      scopes: ['mcp'],
      prefix: body.token.slice(0, 10),
    })
    expect(body.accessToken).not.toHaveProperty('tokenHash')
    expect(await pats.verify(body.token)).toMatchObject({ userSub: 'user-1' })
  })

  it('400 with a code and message for invalid input', async () => {
    const res = await create(asUser1, { name: '', scopes: ['mcp'] })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid_name' })
    expect(store.rows).toHaveLength(0)
  })

  it('409 once the user holds the maximum number of active tokens', async () => {
    for (let i = 0; i < MAX_ACTIVE_PATS_PER_USER; i++)
      expect((await create(asUser1)).statusCode).toBe(201)
    const res = await create(asUser1)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'token_limit_reached' })
  })

  it('401 without a session', async () => {
    expect((await create({})).statusCode).toBe(401)
  })

  it('400 for a token without an expiry: "never" is not a choice', async () => {
    for (const expiresInDays of [undefined, null, 730]) {
      const res = await create(asUser1, { name: 'Laptop', scopes: ['mcp'], expiresInDays })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'invalid_expiry' })
    }
    expect(store.rows).toHaveLength(0)
  })
})

describe('a personal access token cannot manage tokens', () => {
  it('is refused on list, create and revoke — whatever its scopes', async () => {
    const minted = (
      await create(asUser1, { name: 'agent', scopes: ['mcp', 'api'], expiresInDays: 30 })
    ).json()
    const headers = bearer(minted.token)

    const list = await app.inject({ method: 'GET', url: '/access-tokens', headers })
    const mint = await create(headers)
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/access-tokens/${minted.accessToken.id}`,
      headers,
    })

    for (const res of [list, mint, revoke]) {
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ error: 'token_not_accepted' })
    }
    // Nothing changed: still exactly one live token, and it still works.
    expect(store.rows).toHaveLength(1)
    expect(await pats.verify(minted.token)).not.toBeNull()
  })

  it('is refused even when a valid session cookie rides along', async () => {
    const minted = (await create(asUser1)).json()
    const res = await create({ ...asUser1, ...bearer(minted.token) })
    expect(res.statusCode).toBe(403)
    expect(store.rows).toHaveLength(1)
  })
})

describe('GET /access-tokens', () => {
  it('lists only the caller’s tokens, never secret material', async () => {
    const mine = (await create(asUser1)).json()
    await create(asUser2)
    const res = await app.inject({ method: 'GET', url: '/access-tokens', headers: asUser1 })
    expect(res.statusCode).toBe(200)
    const { tokens } = res.json()
    expect(tokens).toHaveLength(1)
    expect(tokens[0].id).toBe(mine.accessToken.id)
    expect(res.body).not.toContain(mine.token.slice(10))
    expect(res.body).not.toContain(store.rows[0]!.tokenHash)
  })
})

describe('DELETE /access-tokens/:id', () => {
  it('revokes the caller’s token, which stops verifying, then 404s', async () => {
    const minted = (await create(asUser1)).json()
    const url = `/access-tokens/${minted.accessToken.id}`

    const res = await app.inject({ method: 'DELETE', url, headers: asUser1 })
    expect(res.statusCode).toBe(204)
    expect(await pats.verify(minted.token)).toBeNull()

    expect((await app.inject({ method: 'DELETE', url, headers: asUser1 })).statusCode).toBe(404)
  })

  it('ends the revoked token’s open MCP sessions at once, and only those', async () => {
    const closeCredential = vi.fn(async () => 1)
    const closeUser = vi.fn(async () => 0)
    const unregister = registerAgentSessionRegistry({ closeCredential, closeUser })
    try {
      const minted = (await create(asUser1)).json()
      const res = await app.inject({
        method: 'DELETE',
        url: `/access-tokens/${minted.accessToken.id}`,
        headers: asUser1,
      })
      expect(res.statusCode).toBe(204)
      expect(closeCredential).toHaveBeenCalledExactlyOnceWith(
        `token:${minted.accessToken.id}`,
        expect.any(String),
      )
      expect(closeUser).not.toHaveBeenCalled()
      // The upload sessions the token opened go with it.
      expect(revokeUploadSessions).toHaveBeenCalledExactlyOnceWith(`token:${minted.accessToken.id}`)
      // Nothing is closed for a token that was not revoked.
      closeCredential.mockClear()
      revokeUploadSessions.mockClear()
      const theirs = (await create(asUser2)).json()
      await app.inject({
        method: 'DELETE',
        url: `/access-tokens/${theirs.accessToken.id}`,
        headers: asUser1,
      })
      expect(closeCredential).not.toHaveBeenCalled()
      expect(revokeUploadSessions).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('404 for another user’s token, which stays live', async () => {
    const theirs = (await create(asUser2)).json()
    const res = await app.inject({
      method: 'DELETE',
      url: `/access-tokens/${theirs.accessToken.id}`,
      headers: asUser1,
    })
    expect(res.statusCode).toBe(404)
    expect(await pats.verify(theirs.token)).not.toBeNull()
  })
})

describe('rate limit on creation', () => {
  it(`allows ${TOKEN_CREATE_RATE_LIMIT.max} creations per hour per user, then 429`, async () => {
    app = await buildApp({ rateLimit: true })
    for (let i = 0; i < TOKEN_CREATE_RATE_LIMIT.max; i++) {
      expect((await create(asUser1)).statusCode).toBe(201)
    }
    const limited = await create(asUser1)
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
    // Per user: someone else is unaffected, and listing is not capped by it.
    expect((await create(asUser2)).statusCode).toBe(201)
    expect(
      (await app.inject({ method: 'GET', url: '/access-tokens', headers: asUser1 })).statusCode,
    ).toBe(200)
  })
})
