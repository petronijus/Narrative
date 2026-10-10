/**
 * http/sameOrigin.test.ts — `requireSameOrigin` (L6): a session-cookie
 * request must carry an allowed Origin; tokens, anonymous requests and the
 * dev bypass are left to the route's own auth.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('../auth/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/session.js')>()
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, raw: string) =>
      raw === 'good-session'
        ? { userSub: 'user-1', userEmail: 'one@example.com', userName: null }
        : null,
    ),
  }
})

import { registerAuthPlugin, requireTokenScope } from '../auth/fastifyAuth.js'
import { createPatService, type PatService } from '../auth/personalAccessTokens.js'
import { allowAllPatOwners, createMemoryPatStore } from '../test-support/memoryPatStore.js'
import {
  isFromWebApp,
  normalizeOrigin,
  registerSameOriginPolicy,
  requireSameOrigin,
} from './sameOrigin.js'
import type { Database } from '../db/client.js'

let pats: PatService

async function buildApp(opts: { bypass?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass: opts.bypass === true, db: {} as Database, pats })
  registerSameOriginPolicy(app, {
    allowedOrigins: ['https://narrative.example.com', 'http://localhost:5173'],
  })
  app.post(
    '/commands',
    { preHandler: [requireSameOrigin, requireTokenScope('api', { allowSession: true })] },
    async () => ({
      ok: true,
    }),
  )
  await app.ready()
  return app
}

const cookie = { cookie: 'narrative_session=good-session' }
const post = (app: FastifyInstance, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/commands', headers })

beforeEach(() => {
  pats = createPatService(createMemoryPatStore(), { isOwnerAllowed: allowAllPatOwners })
})

describe('requireSameOrigin', () => {
  it('lets a session request from an allowed origin through', async () => {
    const app = await buildApp()
    expect(
      (await post(app, { ...cookie, origin: 'https://narrative.example.com' })).statusCode,
    ).toBe(200)
    expect((await post(app, { ...cookie, origin: 'http://LOCALHOST:5173' })).statusCode).toBe(200)
  })

  it('refuses a session request from another origin, with no origin, or origin null', async () => {
    const app = await buildApp()
    for (const origin of [
      'https://evil.example',
      'https://narrative.example.com.evil.example',
      'null',
    ]) {
      const res = await post(app, { ...cookie, origin })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ error: 'forbidden_origin' })
    }
    expect((await post(app, cookie)).statusCode).toBe(403)
  })

  it('does not check personal access tokens', async () => {
    const app = await buildApp()
    const { token } = await pats.create('user-1', { name: 'a', scopes: ['api'], expiresInDays: 30 })
    const res = await post(app, {
      authorization: `Bearer ${token}`,
      origin: 'https://evil.example',
    })
    expect(res.statusCode).not.toBe(403)
  })

  it('leaves unauthenticated requests to the auth pre-handler', async () => {
    const app = await buildApp()
    expect((await post(app, { origin: 'https://evil.example' })).statusCode).toBe(401)
  })

  it('does not apply to the BYPASS_AUTH dev user', async () => {
    const app = await buildApp({ bypass: true })
    expect((await post(app, { origin: 'https://evil.example' })).statusCode).toBe(200)
  })

  it('refuses to register a non-http origin', () => {
    expect(() =>
      registerSameOriginPolicy(Fastify(), { allowedOrigins: ['javascript:alert(1)'] }),
    ).toThrow()
    expect(normalizeOrigin('https://Example.com:443/path')).toBe('https://example.com')
  })
})

describe('isFromWebApp', () => {
  async function probe(headers: Record<string, string>): Promise<boolean> {
    const app = Fastify({ logger: false })
    registerSameOriginPolicy(app, { allowedOrigins: ['http://localhost:5173'] })
    app.get('/x', async (req) => ({ ok: isFromWebApp(req) }))
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/x', headers })
    return (res.json() as { ok: boolean }).ok
  }

  it('passes the app itself, a direct visit and clients without fetch metadata', async () => {
    expect(await probe({ 'sec-fetch-site': 'same-origin' })).toBe(true)
    expect(await probe({ 'sec-fetch-site': 'none' })).toBe(true)
    expect(await probe({})).toBe(true)
    // The web app on another origin (development) names itself.
    expect(await probe({ 'sec-fetch-site': 'same-site', origin: 'http://localhost:5173' })).toBe(
      true,
    )
  })

  it('refuses an embed from a sibling subdomain or another site', async () => {
    expect(await probe({ 'sec-fetch-site': 'same-site' })).toBe(false)
    expect(await probe({ 'sec-fetch-site': 'cross-site' })).toBe(false)
    expect(await probe({ 'sec-fetch-site': 'same-site', origin: 'https://blog.example.com' })).toBe(
      false,
    )
  })
})
