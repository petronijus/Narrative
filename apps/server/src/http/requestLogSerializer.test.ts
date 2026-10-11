import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { notFoundWithRedactedUrl, redactUrl } from './requestLogSerializer.js'

describe('redactUrl', () => {
  it('masks a share link token in the query', () => {
    expect(redactUrl('/decks/d1?share_token=example-share-link-id')).toBe(
      '/decks/d1?share_token=***',
    )
    expect(redactUrl('/media/m1/url?variant=thumb&share_token=abc&x=1')).toBe(
      '/media/m1/url?variant=thumb&share_token=***&x=1',
    )
  })

  it('masks a render token wherever it appears', () => {
    const token = `nrr_${'a'.repeat(43)}`
    expect(redactUrl(`/api/decks/d1/fonts?share_token=${token}`)).toBe(
      '/api/decks/d1/fonts?share_token=***',
    )
    expect(redactUrl(`/render/d1#${token}`)).toBe('/render/d1#nrr_***')
  })

  it('masks a desktop sign-in ticket', () => {
    const ticket = `ndt_${'b'.repeat(43)}`
    expect(redactUrl(`/auth/desktop/redeem?ticket=${ticket}`)).toBe(
      '/auth/desktop/redeem?ticket=ndt_***',
    )
  })

  it('leaves an ordinary URL alone', () => {
    expect(redactUrl('/decks/d1?folderId=f1')).toBe('/decks/d1?folderId=f1')
  })
})

describe('notFoundWithRedactedUrl', () => {
  it('answers 404 without echoing a share token', async () => {
    const app = Fastify()
    app.setNotFoundHandler(notFoundWithRedactedUrl)
    const res = await app.inject({ method: 'GET', url: '/nope?share_token=secret-link' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('secret-link')
    expect(res.json()).toMatchObject({ message: 'Route GET:/nope?share_token=*** not found' })
  })
})
