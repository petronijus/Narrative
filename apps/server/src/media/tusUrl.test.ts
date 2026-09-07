/**
 * media/tusUrl.test.ts
 *
 * Regression guard for the prod-only broken tus `Location` header
 * (2026-09-07): behind Caddy the upload URL came back as
 * `http://server:3001/api/uploads/<id>` — the Docker-internal hostname with
 * the stripped `/api` prefix missing — and tus-js-client died with
 * "failed to resume upload, caused by [object ProgressEvent]".
 */

import { describe, it, expect } from 'vitest'
import { buildPublicUploadUrl } from './tus.js'

describe('buildPublicUploadUrl', () => {
  const base = { proto: 'https', host: 'narrative.bastla.com', path: '/api/uploads', id: 'abc:def' }

  it('re-attaches the prefix the proxy stripped', () => {
    expect(buildPublicUploadUrl({ ...base, forwardedPrefix: '/api' })).toBe(
      'https://narrative.bastla.com/api/api/uploads/abc:def',
    )
  })

  it('behaves like the tus default when no proxy prefix is present (dev)', () => {
    expect(
      buildPublicUploadUrl({
        proto: 'http',
        host: 'localhost:3001',
        path: '/api/uploads',
        id: 'abc:def',
        forwardedPrefix: undefined,
      }),
    ).toBe('http://localhost:3001/api/uploads/abc:def')
  })

  it('normalises a prefix without a leading slash and with a trailing one', () => {
    expect(buildPublicUploadUrl({ ...base, forwardedPrefix: 'api/' })).toBe(
      'https://narrative.bastla.com/api/api/uploads/abc:def',
    )
  })

  it('treats a bare "/" prefix as no prefix', () => {
    expect(buildPublicUploadUrl({ ...base, forwardedPrefix: '/' })).toBe(
      'https://narrative.bastla.com/api/uploads/abc:def',
    )
  })

  it('takes the first value when the header arrives repeated', () => {
    expect(buildPublicUploadUrl({ ...base, forwardedPrefix: ['/api', '/other'] })).toBe(
      'https://narrative.bastla.com/api/api/uploads/abc:def',
    )
  })
})
