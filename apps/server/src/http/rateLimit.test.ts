/**
 * http/rateLimit.test.ts
 *
 * The rate-limit configuration: bucket keys per identity (token, session)
 * with an IP fallback that also catches invalid credentials, the client-IP
 * header, the global numbers, exempt routes, and the agent-route limit the
 * agent host mounts on /api/commands and /api/mcp.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'

const sessionLookups = vi.hoisted(() => ({ count: 0 }))

vi.mock('../auth/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/session.js')>()
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, raw: string) => {
      sessionLookups.count++
      return raw === 'good-session'
        ? { userSub: 'user-1', userEmail: 'one@example.com', userName: null }
        : null
    }),
  }
})

import { registerAuthPlugin, requireTokenScope } from '../auth/fastifyAuth.js'
import { createPatService, type PatService } from '../auth/personalAccessTokens.js'
import {
  AGENT_RATE_LIMIT,
  agentRouteRateLimit,
  INVITE_RATE_LIMIT,
  inviteRouteRateLimit,
  clientIp,
  GLOBAL_RATE_LIMIT,
  IP_PRE_LIMIT,
  NEW_BEARER_PRE_LIMIT,
  rateLimitPluginOptions,
  registerRateLimit,
  type RateLimitSettings,
} from './rateLimit.js'
import {
  createMemoryPatStore,
  allowAllPatOwners,
  type MemoryPatStore,
} from '../test-support/memoryPatStore.js'
import type { Database } from '../db/client.js'
import { mintRenderToken, revokeRenderToken } from '../auth/renderTokens.js'

let pats: PatService
let patStore: MemoryPatStore

async function buildApp(
  settings: RateLimitSettings = {},
  opts: { bypass?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass: opts.bypass === true, db: {} as Database, pats })
  await registerRateLimit(app, settings)
  const { keyGenerator } = rateLimitPluginOptions(settings)
  app.get('/key', async (req) => ({ key: await keyGenerator(req) }))
  app.get('/health', async () => ({ status: 'ok' }))
  app.post('/invite', { config: inviteRouteRateLimit }, async () => ({ ok: true }))
  app.post(
    '/api/commands',
    { config: agentRouteRateLimit, preHandler: [requireTokenScope('api')] },
    async () => ({ ok: true }),
  )
  await app.ready()
  return app
}

async function key(app: FastifyInstance, headers: Record<string, string> = {}) {
  return (
    await app.inject({ method: 'GET', url: '/key', headers, remoteAddress: '203.0.113.9' })
  ).json().key
}

beforeEach(() => {
  patStore = createMemoryPatStore()
  pats = createPatService(patStore, { isOwnerAllowed: allowAllPatOwners })
})

describe('bucket keys', () => {
  it('keys a PAT by token id, a session by user, and the rest by IP', async () => {
    const app = await buildApp()
    const { token, summary } = await pats.create('user-1', {
      name: 'a',
      scopes: ['api'],
      expiresInDays: 365,
    })
    expect(await key(app, { authorization: `Bearer ${token}` })).toBe(`pat:${summary.id}`)
    expect(await key(app, { cookie: 'narrative_session=good-session' })).toBe('user:user-1')
    expect(await key(app)).toBe('ip:203.0.113.9')
  })

  it("keys the render worker's page by who asked for the render, not by its one address", async () => {
    const app = await buildApp()
    const token = mintRenderToken('deck-1', 'alice')
    const res = await app.inject({
      method: 'GET',
      url: `/key?share_token=${token}`,
      remoteAddress: '203.0.113.9',
    })
    expect(res.json().key).toBe('render:alice')
    // An unknown or ended token is just an anonymous request.
    revokeRenderToken(token)
    const ended = await app.inject({
      method: 'GET',
      url: `/key?share_token=${token}`,
      remoteAddress: '203.0.113.9',
    })
    expect(ended.json().key).toBe('ip:203.0.113.9')
  })

  it('counts render pages in the pre-limit per render, not per address', async () => {
    const app = await buildApp({ ipPreLimit: { max: 2, timeWindowMs: 60_000 } })
    const hit = (url: string) =>
      app.inject({ method: 'GET', url, remoteAddress: '203.0.113.9' }).then((r) => r.statusCode)
    const a = mintRenderToken('deck-1', 'alice')
    const b = mintRenderToken('deck-2', 'bob')
    expect([await hit(`/key?share_token=${a}`), await hit(`/key?share_token=${a}`)]).toEqual([
      200, 200,
    ])
    // Render A spent its two; render B and the address itself still have theirs.
    expect(await hit(`/key?share_token=${a}`)).toBe(429)
    expect(await hit(`/key?share_token=${b}`)).toBe(200)
    expect(await hit('/key')).toBe(200)
  })

  it("keys BYPASS_AUTH's identities apart, as dev buckets (dev only)", async () => {
    const app = await buildApp({}, { bypass: true })
    expect(await key(app)).toBe('dev:dev-user')
    // A switched identity (auth/devIdentity.ts) — already known, so no directory write.
    expect(await key(app, { cookie: 'narrative_dev_as=dev-user' })).toBe('dev:dev-user')
  })

  it('gives each token of one user its own bucket', async () => {
    const app = await buildApp()
    const a = await pats.create('user-1', { name: 'a', scopes: ['api'], expiresInDays: 365 })
    const b = await pats.create('user-1', { name: 'b', scopes: ['api'], expiresInDays: 365 })
    expect(await key(app, { authorization: `Bearer ${a.token}` })).not.toBe(
      await key(app, { authorization: `Bearer ${b.token}` }),
    )
  })

  it('puts invalid credentials in the IP bucket, so a token spray shares one bucket', async () => {
    const app = await buildApp()
    const keys = new Set([
      await key(app, { authorization: `Bearer nrt_${'a'.repeat(43)}` }),
      await key(app, { authorization: `Bearer nrt_${'b'.repeat(43)}` }),
      await key(app, { cookie: 'narrative_session=forged' }),
    ])
    expect([...keys]).toEqual(['ip:203.0.113.9'])
  })

  it('reads the client IP from the configured header only, and only when it is an IP', async () => {
    const unset = await buildApp()
    expect(await key(unset, { 'cf-connecting-ip': '198.51.100.7' })).toBe('ip:203.0.113.9')

    const cf = await buildApp({ clientIpHeader: 'cf-connecting-ip' })
    expect(await key(cf, { 'cf-connecting-ip': '198.51.100.7' })).toBe('ip:198.51.100.7')
    expect(await key(cf, { 'cf-connecting-ip': 'not-an-ip' })).toBe('ip:203.0.113.9')
    expect(await key(cf)).toBe('ip:203.0.113.9')
    // IPv6 clients share their /64.
    expect(await key(cf, { 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' })).toBe(
      await key(cf, { 'cf-connecting-ip': '2001:db8:1:2:bbbb::2' }),
    )
  })

  it('clientIp falls back to the socket address', () => {
    const req = { headers: {}, ip: '10.0.0.1' } as unknown as FastifyRequest
    expect(clientIp(req)).toBe('10.0.0.1')
    expect(clientIp(req, 'cf-connecting-ip')).toBe('10.0.0.1')
  })
})

describe('global limit', () => {
  it('allows identified callers more than anonymous ones', () => {
    const { max } = rateLimitPluginOptions()
    const req = {} as FastifyRequest
    expect(max(req, 'ip:1.2.3.4')).toBe(GLOBAL_RATE_LIMIT.anonymousMax)
    expect(max(req, 'user:u')).toBe(GLOBAL_RATE_LIMIT.identifiedMax)
    expect(max(req, 'pat:t')).toBe(GLOBAL_RATE_LIMIT.identifiedMax)
    expect(GLOBAL_RATE_LIMIT.identifiedMax).toBeGreaterThan(GLOBAL_RATE_LIMIT.anonymousMax)
    // BYPASS_AUTH identities (dev only): the parallel e2e browsers share one.
    expect(max(req, 'dev:dev-user')).toBe(GLOBAL_RATE_LIMIT.devMax)
    expect(GLOBAL_RATE_LIMIT.devMax).toBeGreaterThan(GLOBAL_RATE_LIMIT.identifiedMax)
  })

  it('stops an anonymous flood at the anonymous limit', async () => {
    const app = await buildApp()
    let last = 0
    for (let i = 0; i <= GLOBAL_RATE_LIMIT.anonymousMax; i++) {
      last = (await app.inject({ method: 'GET', url: '/key', remoteAddress: '192.0.2.50' }))
        .statusCode
    }
    expect(last).toBe(429)
    // Another address is unaffected.
    expect(
      (await app.inject({ method: 'GET', url: '/key', remoteAddress: '192.0.2.51' })).statusCode,
    ).toBe(200)
  })

  it('never counts /health', async () => {
    const app = await buildApp()
    const { allowList } = rateLimitPluginOptions()
    for (let i = 0; i <= GLOBAL_RATE_LIMIT.anonymousMax; i++) {
      await app.inject({ method: 'GET', url: '/health', remoteAddress: '192.0.2.60' })
    }
    const res = await app.inject({ method: 'GET', url: '/health', remoteAddress: '192.0.2.60' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-ratelimit-limit']).toBeUndefined()
    expect(allowList({ routeOptions: { url: '/metrics' } } as FastifyRequest)).toBe(true)
  })
})

describe('agent route limit', () => {
  it(`caps each token at ${AGENT_RATE_LIMIT.max} requests per window on the agent endpoints`, async () => {
    const app = await buildApp()
    const a = await pats.create('user-1', { name: 'a', scopes: ['api'], expiresInDays: 365 })
    const b = await pats.create('user-1', { name: 'b', scopes: ['api'], expiresInDays: 365 })
    const call = (t: string) =>
      app.inject({
        method: 'POST',
        url: '/api/commands',
        headers: { authorization: `Bearer ${t}` },
      })

    for (let i = 0; i < AGENT_RATE_LIMIT.max; i++)
      expect((await call(a.token)).statusCode).toBe(200)
    const limited = await call(a.token)
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['x-ratelimit-limit']).toBe(String(AGENT_RATE_LIMIT.max))
    expect((await call(b.token)).statusCode).toBe(200)
  })
})

describe('share-by-email limit', () => {
  it(`caps each person at ${INVITE_RATE_LIMIT.max} invitations per hour`, async () => {
    const app = await buildApp()
    const invite = (cookie: string) =>
      app.inject({ method: 'POST', url: '/invite', headers: { cookie } })
    for (let i = 0; i < INVITE_RATE_LIMIT.max; i++)
      expect((await invite('narrative_session=good-session')).statusCode).toBe(200)
    const limited = await invite('narrative_session=good-session')
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['x-ratelimit-limit']).toBe(String(INVITE_RATE_LIMIT.max))
  })
})

describe('per-IP pre-limit', () => {
  it('sits above the per-identity limits', () => {
    expect(IP_PRE_LIMIT.max).toBeGreaterThan(GLOBAL_RATE_LIMIT.identifiedMax)
  })

  it('answers 429 without any credential lookup once an IP exceeds it', async () => {
    const app = await buildApp({ ipPreLimit: { max: 3, timeWindowMs: 60_000 } })
    const call = (remoteAddress: string) =>
      app.inject({
        method: 'GET',
        url: '/key',
        headers: { cookie: 'narrative_session=forged' },
        remoteAddress,
      })
    for (let i = 0; i < 3; i++) expect((await call('192.0.2.70')).statusCode).toBe(200)

    sessionLookups.count = 0
    const refused = await call('192.0.2.70')
    expect(refused.statusCode).toBe(429)
    expect(refused.headers['retry-after']).toBeDefined()
    expect(sessionLookups.count).toBe(0)

    // Another address is unaffected, and /health is never counted.
    expect((await call('192.0.2.71')).statusCode).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/health', remoteAddress: '192.0.2.70' })).statusCode,
    ).toBe(200)
  })

  it('keys on the configured client-IP header', async () => {
    const app = await buildApp({
      clientIpHeader: 'cf-connecting-ip',
      ipPreLimit: { max: 1, timeWindowMs: 60_000 },
    })
    const call = (client: string) =>
      app.inject({
        method: 'GET',
        url: '/key',
        headers: { 'cf-connecting-ip': client },
        remoteAddress: '10.0.0.9',
      })
    expect((await call('198.51.100.20')).statusCode).toBe(200)
    expect((await call('198.51.100.21')).statusCode).toBe(200)
    expect((await call('198.51.100.20')).statusCode).toBe(429)
  })
})

describe('shared egress: agent tokens get their own pre-limit bucket', () => {
  // One address of Anthropic's egress range, shared by every claude.ai user.
  const SHARED = '160.79.104.10'
  const junk = (c: string) => `nrt_${c.repeat(43)}`

  const call = (app: FastifyInstance, headers: Record<string, string> = {}, url = '/key') =>
    app.inject({ method: 'GET', url, headers, remoteAddress: SHARED })

  it('is looser than the per-bucket pre-limit and positive', () => {
    expect(NEW_BEARER_PRE_LIMIT.max).toBeGreaterThan(0)
    expect(NEW_BEARER_PRE_LIMIT.max).toBeLessThan(IP_PRE_LIMIT.max)
  })

  it('keeps a valid token working when its address has exhausted the IP bucket', async () => {
    const app = await buildApp({ ipPreLimit: { max: 3, timeWindowMs: 60_000 } })
    const { token } = await pats.create('user-1', { name: 'a', scopes: ['api'], expiresInDays: 30 })
    for (let i = 0; i < 3; i++) expect((await call(app)).statusCode).toBe(200)
    expect((await call(app)).statusCode).toBe(429)
    // Another user's traffic from the same range does not touch this token's budget…
    for (let i = 0; i < 3; i++)
      expect((await call(app, { authorization: `Bearer ${token}` })).statusCode).toBe(200)
    // …which is its own: it runs out on its own schedule.
    expect((await call(app, { authorization: `Bearer ${token}` })).statusCode).toBe(429)
    // Plain traffic from the address is still refused.
    expect((await call(app)).statusCode).toBe(429)
  })

  it('keys a junk bearer on the IP once it failed, and never looks it up again', async () => {
    const app = await buildApp({ ipPreLimit: { max: 3, timeWindowMs: 60_000 } })
    const bad = { authorization: `Bearer ${junk('j')}` }
    expect((await call(app, bad)).statusCode).toBe(200) // own bucket, one lookup
    expect(patStore.calls.findByHash).toBe(1)
    // Now negative-cached: the IP bucket counts it, the resolver short-circuits.
    for (let i = 0; i < 3; i++) expect((await call(app, bad)).statusCode).toBe(200)
    expect((await call(app, bad)).statusCode).toBe(429)
    expect((await call(app)).statusCode).toBe(429)
    expect(patStore.calls.findByHash).toBe(1)
    const keyed = await app.inject({
      method: 'GET',
      url: '/key',
      headers: bad,
      remoteAddress: '198.51.100.99',
    })
    expect(keyed.json().key).toBe('ip:198.51.100.99')
    expect(patStore.calls.findByHash).toBe(1)
  })

  it('refuses a spray of fresh bearers at the new-bearer limit, before any lookup', async () => {
    const app = await buildApp({
      ipPreLimit: { max: 100, timeWindowMs: 60_000 },
      newBearerPreLimit: { max: 2, timeWindowMs: 60_000 },
    })
    expect((await call(app, { authorization: `Bearer ${junk('a')}` })).statusCode).toBe(200)
    expect((await call(app, { authorization: `Bearer ${junk('b')}` })).statusCode).toBe(200)
    const lookups = patStore.calls.findByHash
    const refused = await call(app, { authorization: `Bearer ${junk('c')}` })
    expect(refused.statusCode).toBe(429)
    expect(refused.headers['retry-after']).toBeDefined()
    expect(patStore.calls.findByHash).toBe(lookups)
    // A token admitted before keeps working; so does another address.
    const { token } = await pats.create('user-1', { name: 'a', scopes: ['api'], expiresInDays: 30 })
    const other = await app.inject({
      method: 'GET',
      url: '/key',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '198.51.100.1',
    })
    expect(other.statusCode).toBe(200)
    for (let i = 0; i < 3; i++)
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/key',
            headers: { authorization: `Bearer ${token}` },
            remoteAddress: SHARED,
          })
        ).statusCode,
      ).toBe(200)
  })

  it('treats malformed bearers as plain IP traffic and never counts /health', async () => {
    const app = await buildApp({
      ipPreLimit: { max: 2, timeWindowMs: 60_000 },
      newBearerPreLimit: { max: 1, timeWindowMs: 60_000 },
    })
    const malformed = { authorization: `Bearer nrt_short` }
    expect((await call(app, malformed)).statusCode).toBe(200)
    expect((await call(app, malformed)).statusCode).toBe(200)
    expect((await call(app, malformed)).statusCode).toBe(429)
    for (let i = 0; i < 5; i++)
      expect(
        (await call(app, { authorization: `Bearer ${junk(String(i))}` }, '/health')).statusCode,
      ).toBe(200)
  })
})
