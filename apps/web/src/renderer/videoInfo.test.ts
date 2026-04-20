/**
 * renderer/videoInfo.test.ts
 *
 * Unit tests for the videoInfo resolver.
 *
 * Tests:
 * - Returns correct VideoInfoResult from API response.
 * - Resolver returns pending status → cached for 5s, re-fetched after TTL expires.
 * - Resolver returns done → permanent cache (no re-fetch).
 * - Auth header attached when token getter returns a value.
 * - No auth header when token getter returns null.
 * - Error response clears cache entry (retry possible).
 * - Missing required fields in response rejects and clears cache.
 * - setDefaultVideoInfoResolver / getDefaultVideoInfoResolver lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createVideoInfoResolver,
  setDefaultVideoInfoResolver,
  getDefaultVideoInfoResolver,
  _resetDefaultVideoInfoResolver,
  type VideoInfoResult,
} from './videoInfo'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<VideoInfoResult> = {}): VideoInfoResult {
  return {
    assetId: 'asset-1',
    transcodeStatus: 'done',
    durationSec: 30,
    width: 1920,
    height: 1080,
    posterUrl: 'https://imgproxy.example.com/poster.jpg',
    thumbnailUrl: 'https://imgproxy.example.com/thumb.jpg',
    hlsManifestUrl: 'https://minio.example.com/hls/manifest.m3u8',
    transcodeError: null,
    ...overrides,
  }
}

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

describe('createVideoInfoResolver', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns VideoInfoResult from API response', async () => {
    const result = makeResult()
    vi.stubGlobal('fetch', makeFetch(result))

    const resolver = createVideoInfoResolver('https://api.example.com')
    const info = await resolver({ assetId: 'asset-1' })

    expect(info).toMatchObject(result)
    expect(fetch).toHaveBeenCalledOnce()
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/media/asset-1/video-info',
    )
  })

  it('done status: cached permanently — fetch called only once', async () => {
    vi.stubGlobal('fetch', makeFetch(makeResult({ transcodeStatus: 'done' })))

    const resolver = createVideoInfoResolver('')
    const p1 = resolver({ assetId: 'asset-done' })
    const p2 = resolver({ assetId: 'asset-done' })

    // Same promise instance for concurrent callers.
    expect(p1).toBe(p2)
    await p1

    // Second independent call after resolution should also use cache.
    await resolver({ assetId: 'asset-done' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('failed status: cached permanently', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(makeResult({ transcodeStatus: 'failed', transcodeError: 'timeout' })),
    )

    const resolver = createVideoInfoResolver('')
    const info = await resolver({ assetId: 'asset-failed' })

    expect(info.transcodeStatus).toBe('failed')
    expect(info.transcodeError).toBe('timeout')

    // Second call: still cached.
    await resolver({ assetId: 'asset-failed' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('pending status: cached for TTL, then re-fetched after TTL expires', async () => {
    vi.useFakeTimers()

    const pendingResult = makeResult({ transcodeStatus: 'pending', posterUrl: null })
    const doneResult = makeResult({ transcodeStatus: 'done' })

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => pendingResult,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => doneResult,
      } as Response)

    vi.stubGlobal('fetch', fetchMock)

    const resolver = createVideoInfoResolver('')

    // First call: fetches, gets pending.
    const info1 = await resolver({ assetId: 'asset-pending' })
    expect(info1.transcodeStatus).toBe('pending')
    expect(fetchMock).toHaveBeenCalledOnce()

    // Call within TTL: uses cache, no new fetch.
    const info2 = await resolver({ assetId: 'asset-pending' })
    expect(info2.transcodeStatus).toBe('pending')
    expect(fetchMock).toHaveBeenCalledOnce()

    // Advance past TTL.
    vi.advanceTimersByTime(5_001)

    // Next call after TTL: re-fetches.
    const info3 = await resolver({ assetId: 'asset-pending' })
    expect(info3.transcodeStatus).toBe('done')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('processing status: same TTL cache behaviour as pending', async () => {
    vi.useFakeTimers()

    const processingResult = makeResult({ transcodeStatus: 'processing', posterUrl: null })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => processingResult,
    } as Response)

    vi.stubGlobal('fetch', fetchMock)

    const resolver = createVideoInfoResolver('')

    await resolver({ assetId: 'asset-processing' })
    await resolver({ assetId: 'asset-processing' }) // within TTL
    expect(fetchMock).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(5_001)

    await resolver({ assetId: 'asset-processing' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('attaches Authorization header when token getter returns a value', async () => {
    vi.stubGlobal('fetch', makeFetch(makeResult()))

    const resolver = createVideoInfoResolver('', () => 'my-jwt-token')
    await resolver({ assetId: 'asset-auth' })

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer my-jwt-token')
  })

  it('does NOT attach Authorization header when token getter returns null', async () => {
    vi.stubGlobal('fetch', makeFetch(makeResult()))

    const resolver = createVideoInfoResolver('', () => null)
    await resolver({ assetId: 'asset-noauth' })

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('rejects and clears cache on non-ok HTTP status (retry possible)', async () => {
    vi.stubGlobal('fetch', makeFetch({ error: 'not found' }, 404))

    const resolver = createVideoInfoResolver('')
    await expect(resolver({ assetId: 'asset-404' })).rejects.toThrow(/HTTP 404/)

    // After rejection cache should be cleared — second call retries.
    vi.stubGlobal('fetch', makeFetch(makeResult()))
    const info = await resolver({ assetId: 'asset-404' })
    expect(info.transcodeStatus).toBe('done')
  })

  it('rejects when response is missing required fields', async () => {
    vi.stubGlobal('fetch', makeFetch({ unexpected: true }))

    const resolver = createVideoInfoResolver('')
    await expect(resolver({ assetId: 'asset-bad' })).rejects.toThrow(/missing required fields/)
  })

  it('nullish optional fields default to null', async () => {
    const minimalResult = {
      assetId: 'asset-min',
      transcodeStatus: 'pending',
      // All optional fields omitted
    }
    vi.stubGlobal('fetch', makeFetch(minimalResult))

    const resolver = createVideoInfoResolver('')
    const info = await resolver({ assetId: 'asset-min' })

    expect(info.durationSec).toBeNull()
    expect(info.width).toBeNull()
    expect(info.height).toBeNull()
    expect(info.posterUrl).toBeNull()
    expect(info.thumbnailUrl).toBeNull()
    expect(info.hlsManifestUrl).toBeNull()
    expect(info.transcodeError).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Default resolver lifecycle
// ---------------------------------------------------------------------------

describe('default video info resolver lifecycle', () => {
  beforeEach(() => {
    _resetDefaultVideoInfoResolver()
  })

  it('getDefaultVideoInfoResolver throws before setDefaultVideoInfoResolver is called', () => {
    expect(() => getDefaultVideoInfoResolver()).toThrow(/No default resolver installed/)
  })

  it('returns installed resolver after set', () => {
    const resolver = createVideoInfoResolver('')
    setDefaultVideoInfoResolver(resolver)
    expect(getDefaultVideoInfoResolver()).toBe(resolver)
  })

  it('replaces resolver on second set call', () => {
    const r1 = createVideoInfoResolver('')
    const r2 = createVideoInfoResolver('')
    setDefaultVideoInfoResolver(r1)
    setDefaultVideoInfoResolver(r2)
    expect(getDefaultVideoInfoResolver()).toBe(r2)
  })
})
