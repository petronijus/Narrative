/**
 * mcp/auth.test.ts — the /mcp credential check's use of the bearer cache
 * (http/bearerCache.ts): an MCP OAuth access token that failed verification
 * is refused without asking the OAuth service again (no database lookup),
 * by both the pre-handler and the rate-limit key; a thrown verification
 * (database down) records nothing; a success keeps the token "seen".
 */

import { describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import { createPatService } from '../auth/personalAccessTokens.js'
import type { Database } from '../db/client.js'
import { BearerCache, hashBearer } from '../http/bearerCache.js'
import { allowAllPatOwners, createMemoryPatStore } from '../test-support/memoryPatStore.js'
import { mcpAuthPreHandler, mcpRateLimitKey, type McpAuthDeps } from './auth.js'
import { buildMcpPublicConfig } from './config.js'
import type { McpOAuthService, VerifiedMcpToken } from './oauth/service.js'

const GOOD = `nmo_${'g'.repeat(43)}`
const BAD = `nmo_${'b'.repeat(43)}`
const FLAKY = `nmo_${'f'.repeat(43)}`

const verified: VerifiedMcpToken = {
  grantId: 'grant-1',
  clientId: 'client-1',
  clientName: 'Claude',
  userSub: 'user-1',
  email: null,
  name: null,
  scopes: ['mcp'],
}

async function build() {
  const verifyAccessToken = vi.fn(async (raw: string) => {
    if (raw === FLAKY) throw new Error('database down')
    return raw === GOOD ? verified : null
  })
  const bearers = new BearerCache()
  const deps: McpAuthDeps = {
    config: buildMcpPublicConfig({
      apiBaseUrl: 'http://127.0.0.1:1',
      spaOrigin: 'http://127.0.0.1:1',
    }),
    oauth: { verifyAccessToken } as unknown as McpOAuthService,
    bearers,
  }
  const app: FastifyInstance = Fastify({ logger: false })
  registerAuthPlugin(app, {
    bypass: false,
    db: {} as Database,
    pats: createPatService(createMemoryPatStore(), { isOwnerAllowed: allowAllPatOwners }),
    bearers,
  })
  const key = mcpRateLimitKey(deps)
  app.get('/mcp', { preHandler: [mcpAuthPreHandler(deps)] }, async (req) => ({
    user: req.user?.sub,
    key: await key(req),
  }))
  await app.ready()
  const call = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '160.79.104.20',
    })
  return { app, call, verifyAccessToken, bearers }
}

describe('/mcp and the bearer negative cache', () => {
  it('refuses a token that failed verification without asking the OAuth service again', async () => {
    const { call, verifyAccessToken, bearers } = await build()
    expect((await call(BAD)).statusCode).toBe(401)
    expect(verifyAccessToken).toHaveBeenCalledTimes(1)
    expect(bearers.isKnownInvalid(BAD)).toBe(true)
    for (let i = 0; i < 3; i++) {
      const res = await call(BAD)
      expect(res.statusCode).toBe(401)
      expect(res.headers['www-authenticate']).toContain('invalid_token')
    }
    expect(verifyAccessToken).toHaveBeenCalledTimes(1)
  })

  it('keys a negative-cached token on the IP, without a lookup', async () => {
    const { verifyAccessToken, bearers } = await build()
    bearers.recordInvalid(BAD)
    const deps: McpAuthDeps = {
      config: buildMcpPublicConfig({ apiBaseUrl: 'https://x', spaOrigin: 'https://x' }),
      oauth: { verifyAccessToken } as unknown as McpOAuthService,
      bearers,
    }
    const app = Fastify({ logger: false })
    registerAuthPlugin(app, { bypass: false, db: {} as Database, bearers })
    const key = mcpRateLimitKey(deps)
    app.get('/k', async (req) => ({ key: await key(req) }))
    const res = await app.inject({
      method: 'GET',
      url: '/k',
      headers: { authorization: `Bearer ${BAD}` },
      remoteAddress: '160.79.104.21',
    })
    expect(res.json().key).toBe('ip:160.79.104.21')
    expect(verifyAccessToken).not.toHaveBeenCalled()
  })

  it('records a success as seen and a thrown verification not at all', async () => {
    const { app, call, verifyAccessToken, bearers } = await build()
    const ok = await call(GOOD)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ user: 'user-1', key: 'oauth:grant-1' })
    // One verification per request, shared by the pre-handler and the key.
    expect(verifyAccessToken).toHaveBeenCalledTimes(1)
    expect(bearers.hasSeenHash(hashBearer(GOOD))).toBe(true)

    const flaky = await call(FLAKY)
    expect(flaky.statusCode).toBe(500)
    expect(bearers.isKnownInvalid(FLAKY)).toBe(false)
    await app.close()
  })
})
