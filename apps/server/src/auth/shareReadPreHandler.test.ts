/**
 * auth/shareReadPreHandler.test.ts
 *
 * The pre-handler of the reads a share-link visitor (and the render worker's
 * page) makes: no credential passes through anonymously for the route to
 * authorise from `share_token`; a session attaches as usual; a credential
 * that does not verify is never downgraded to anonymous; a personal access
 * token is refused as on every browser route. Real identity resolution, no
 * BYPASS_AUTH — the e2e stack runs with it and cannot show any of this.
 */

import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

vi.mock('./session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./session.js')>()
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, raw: string) =>
      raw === 'good-session'
        ? { userSub: 'cookie-user', userEmail: 'c@example.com', userName: null }
        : null,
    ),
  }
})

import { nanoid } from 'nanoid'
import { readShareToken, registerAuthPlugin, shareReadPreHandler } from './fastifyAuth.js'
import { isShareTokenShape, SHARE_TOKEN_SHAPE } from './shareLinks.js'
import { mintRenderToken, revokeRenderToken } from './renderTokens.js'
import type { PatService } from './personalAccessTokens.js'
import type { Database } from '../db/client.js'

const PAT = `nrt_${'k'.repeat(43)}`

function app() {
  const server = Fastify()
  const pats = {
    verify: vi.fn(async (raw: string) =>
      raw === PAT ? { userSub: 'pat-user', scopes: ['read'], tokenId: 't1' } : null,
    ),
  } as unknown as PatService
  registerAuthPlugin(server, { bypass: false, db: {} as Database, pats })
  server.get('/probe', { preHandler: shareReadPreHandler }, async (request) => ({
    user: request.user?.sub ?? null,
  }))
  return server
}

describe('shareReadPreHandler', () => {
  it('lets a request without any credential through, anonymously', async () => {
    const res = await app().inject({ method: 'GET', url: '/probe?share_token=abc' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ user: null })
  })

  it('attaches a valid session', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: 'narrative_session=good-session' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ user: 'cookie-user' })
  })

  it('refuses a session that does not verify instead of treating it as anonymous', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/probe?share_token=abc',
      headers: { cookie: 'narrative_session=expired' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a personal access token, valid or not', async () => {
    const valid = await app().inject({
      method: 'GET',
      url: '/probe?share_token=abc',
      headers: { authorization: `Bearer ${PAT}` },
    })
    expect(valid.statusCode).toBe(403)
    const forged = await app().inject({
      method: 'GET',
      url: '/probe?share_token=abc',
      headers: { authorization: `Bearer nrt_${'x'.repeat(43)}` },
    })
    expect(forged.statusCode).toBe(401)
  })
})

describe('readShareToken: one well-formed token, checked before any lookup', () => {
  async function read(query: string) {
    const server = Fastify()
    server.get('/q', async (request) => readShareToken(request))
    return (await server.inject({ method: 'GET', url: `/q${query}` })).json()
  }

  it('fits the tokens Narrative issues: share-link ids and render tokens', () => {
    for (let i = 0; i < 50; i++) expect(isShareTokenShape(nanoid(21))).toBe(true)
    const render = mintRenderToken({ kind: 'deck', id: 'd1' }, 'u1')
    expect(SHARE_TOKEN_SHAPE.test(render)).toBe(true)
    revokeRenderToken(render)
  })

  it('reads an absent token as none and a well-formed one as itself', async () => {
    expect(await read('')).toEqual({ valid: true, token: null })
    expect(await read('?share_token=AbC_12-x')).toEqual({ valid: true, token: 'AbC_12-x' })
  })

  it('refuses an empty, NUL-bearing, repeated, over-long or oddly-charactered token', async () => {
    for (const query of [
      '?share_token=',
      '?share_token=%00',
      '?share_token=abc%00',
      '?share_token=a&share_token=b',
      `?share_token=${'a'.repeat(65)}`,
      '?share_token=a%20b',
      "?share_token=a'b",
    ])
      expect(await read(query), query).toEqual({ valid: false })
  })

  it('answers a malformed token 401 in the pre-handler, the route never runs', async () => {
    const res = await app().inject({ method: 'GET', url: '/probe?share_token=%00' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Unauthorized' })
    const repeated = await app().inject({
      method: 'GET',
      url: '/probe?share_token=a&share_token=b',
    })
    expect(repeated.statusCode).toBe(401)
    expect(repeated.json()).toEqual({ error: 'Unauthorized' })
  })
})
