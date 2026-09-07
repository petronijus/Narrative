/**
 * media/tusUrl.test.ts
 *
 * Regression guard for the prod-only broken tus `Location` header
 * (2026-09-07). Behind Caddy the upload URL came back first as
 * `http://server:3001/api/uploads/<id>` (Docker-internal hostname, stripped
 * `/api` prefix missing) and then as `http://narrative.bastla.com/...`
 * (mixed content — Caddy overwrites X-Forwarded-Proto with `http`). Both
 * killed tus-js-client with "failed to resume upload, caused by
 * [object ProgressEvent]". The URL is therefore relative now: only the
 * stripped prefix is ours to restore.
 */

import { describe, it, expect } from 'vitest'
import { buildPublicUploadUrl } from './tus.js'

describe('buildPublicUploadUrl', () => {
  const base = { path: '/api/uploads', id: 'abc:def' }

  it('re-attaches the prefix the proxy stripped', () => {
    expect(buildPublicUploadUrl({ ...base, forwardedPrefix: '/api' })).toBe(
      '/api/api/uploads/abc:def',
    )
  })

  it('is relative, so the browser supplies scheme and host', () => {
    const url = buildPublicUploadUrl({ ...base, forwardedPrefix: '/api' })
    expect(url.startsWith('/')).toBe(true)
    expect(url).not.toMatch(/^https?:/)
  })

  it('returns the bare path when no proxy prefix is present (dev)', () => {
    expect(buildPublicUploadUrl({ ...base, forwardedPrefix: undefined })).toBe(
      '/api/uploads/abc:def',
    )
  })

  it('normalises a prefix without a leading slash and with a trailing one', () => {
    expect(buildPublicUploadUrl({ ...base, forwardedPrefix: 'api/' })).toBe(
      '/api/api/uploads/abc:def',
    )
  })

  it('treats a bare "/" prefix as no prefix', () => {
    expect(buildPublicUploadUrl({ ...base, forwardedPrefix: '/' })).toBe('/api/uploads/abc:def')
  })

  it('takes the first value when the header arrives repeated', () => {
    expect(buildPublicUploadUrl({ ...base, forwardedPrefix: ['/api', '/other'] })).toBe(
      '/api/api/uploads/abc:def',
    )
  })
})
