/**
 * http/bodylessCompat.test.ts
 *
 * Regression guard for the Cloudflare Tunnel 415 (prod-only, 2026-09-07):
 * a bodyless POST arrives with `Transfer-Encoding: chunked` and no
 * `Content-Type`, and Fastify answered 415 before the route ran — breaking
 * tus upload creation (so every media upload and .pptx import) and
 * POST /auth/logout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerBodylessRequestCompat } from './bodylessCompat.js'

describe('bodyless request compat', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify()
    registerBodylessRequestCompat(app)
    app.post('/echo', async (request) => ({ body: request.body ?? null }))
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('accepts a chunked, bodyless POST without Content-Type (Cloudflare framing)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'transfer-encoding': 'chunked' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ body: null })
  })

  it('still accepts the plain bodyless POST (Content-Length: 0)', async () => {
    const res = await app.inject({ method: 'POST', url: '/echo' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ body: null })
  })

  it('keeps 415 for a non-empty body with an unsupported Content-Type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/x-not-supported' },
      payload: 'some bytes',
    })
    expect(res.statusCode).toBe(415)
    expect(res.json()).toMatchObject({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' })
  })

  it('keeps 415 for a non-empty body with no Content-Type at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'transfer-encoding': 'chunked' },
      payload: Buffer.from('some bytes'),
    })
    expect(res.statusCode).toBe(415)
  })

  it('leaves registered parsers alone — JSON still parses', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 1 }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ body: { a: 1 } })
  })
})
