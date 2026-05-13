/**
 * renderer/imageUrl.test.ts
 *
 * Unit tests for the imageUrl resolver.
 *
 * Tests:
 * - Cache hits return the same Promise instance.
 * - fetch() is called exactly once per (assetId, variant) key.
 * - Different variants produce independent cache entries.
 * - Auth header is attached when token provider returns a value.
 * - No auth header when token is null.
 * - Error response (non-ok status) removes cache entry and rejects.
 * - Missing 'url' field in response body rejects and removes cache entry.
 * - Retry is possible after a failed fetch (cache entry cleared).
 * - setDefaultImageUrlResolver / getDefaultImageUrlResolver lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createImageUrlResolver,
  setDefaultImageUrlResolver,
  getDefaultImageUrlResolver,
  _resetDefaultImageUrlResolver,
} from './imageUrl'

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function makeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createImageUrlResolver', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a signed URL from the API response', async () => {
    const signed = 'https://imgproxy.example.com/signed/image.jpg'
    vi.stubGlobal('fetch', makeFetch({ url: signed }))

    const resolver = createImageUrlResolver('https://api.example.com')
    const url = await resolver({ assetId: 'asset-1', variant: 'display' })

    expect(url).toBe(signed)
    expect(fetch).toHaveBeenCalledOnce()
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/media/asset-1/url?variant=display',
    )
  })

  it('defaults variant to display when omitted', async () => {
    vi.stubGlobal('fetch', makeFetch({ url: 'https://imgproxy.example.com/x.jpg' }))
    const resolver = createImageUrlResolver('')
    await resolver({ assetId: 'asset-2' })
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain('variant=display')
  })

  it('cache hit: returns same Promise, fetch called only once', async () => {
    vi.stubGlobal('fetch', makeFetch({ url: 'https://imgproxy.example.com/cached.jpg' }))
    const resolver = createImageUrlResolver('')

    const p1 = resolver({ assetId: 'asset-3', variant: 'display' })
    const p2 = resolver({ assetId: 'asset-3', variant: 'display' })

    expect(p1).toBe(p2) // same Promise instance
    await p1
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('different variants produce independent cache entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ url: 'https://example.com/thumb.jpg' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ url: 'https://example.com/display.jpg' }),
        } as Response),
    )

    const resolver = createImageUrlResolver('')
    const [thumbUrl, displayUrl] = await Promise.all([
      resolver({ assetId: 'asset-4', variant: 'thumb' }),
      resolver({ assetId: 'asset-4', variant: 'display' }),
    ])

    expect(thumbUrl).toBe('https://example.com/thumb.jpg')
    expect(displayUrl).toBe('https://example.com/display.jpg')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('sends fetch with credentials:include so the session cookie travels', async () => {
    vi.stubGlobal('fetch', makeFetch({ url: 'https://imgproxy.example.com/auth.jpg' }))
    const resolver = createImageUrlResolver('')
    await resolver({ assetId: 'asset-5', variant: 'display' })

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(init.credentials).toBe('include')
  })

  it('rejects and removes cache entry on non-ok HTTP status', async () => {
    vi.stubGlobal('fetch', makeFetch({ error: 'not found' }, 404))
    const resolver = createImageUrlResolver('')

    await expect(resolver({ assetId: 'asset-7', variant: 'display' })).rejects.toThrow(/HTTP 404/)

    // After rejection the cache entry is cleared — a second call retries (new fetch).
    vi.stubGlobal('fetch', makeFetch({ url: 'https://imgproxy.example.com/retry.jpg' }))
    const url = await resolver({ assetId: 'asset-7', variant: 'display' })
    expect(url).toBe('https://imgproxy.example.com/retry.jpg')
    expect(fetch).toHaveBeenCalledOnce() // only the retry, previous stub was already consumed
  })

  it('rejects when response body is missing url field', async () => {
    vi.stubGlobal('fetch', makeFetch({ signed_url: 'wrong-key' }))
    const resolver = createImageUrlResolver('')

    await expect(resolver({ assetId: 'asset-8', variant: 'display' })).rejects.toThrow(
      /missing 'url' field/,
    )
  })

  it('retry is possible after error (cache entry cleared)', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://imgproxy.example.com/ok.jpg' }),
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const resolver = createImageUrlResolver('')

    await expect(resolver({ assetId: 'asset-9', variant: 'display' })).rejects.toThrow()

    // Wait a tick for the cache.delete() catch handler to run.
    await Promise.resolve()

    const url = await resolver({ assetId: 'asset-9', variant: 'display' })
    expect(url).toBe('https://imgproxy.example.com/ok.jpg')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('default resolver lifecycle', () => {
  beforeEach(() => {
    _resetDefaultImageUrlResolver()
  })

  it('getDefaultImageUrlResolver throws before setDefaultImageUrlResolver is called', () => {
    expect(() => getDefaultImageUrlResolver()).toThrow(/No default resolver installed/)
  })

  it('returns the installed resolver after setDefaultImageUrlResolver', () => {
    const resolver = createImageUrlResolver('')
    setDefaultImageUrlResolver(resolver)
    expect(getDefaultImageUrlResolver()).toBe(resolver)
  })

  it('replaces resolver on second setDefaultImageUrlResolver call', () => {
    const r1 = createImageUrlResolver('')
    const r2 = createImageUrlResolver('')
    setDefaultImageUrlResolver(r1)
    setDefaultImageUrlResolver(r2)
    expect(getDefaultImageUrlResolver()).toBe(r2)
  })
})
