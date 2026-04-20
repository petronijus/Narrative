/**
 * state/useMediaPreload.test.tsx
 *
 * Tests for useMediaPreload hook.
 *
 * Strategy:
 *   - Mock api (getMediaUrl, getVideoInfo) and fetch.
 *   - Mock openMediaCache to return a fake in-memory cache.
 *   - Assert progress emits correctly.
 *   - Assert errors don't abort preload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { useMediaPreload } from './useMediaPreload'
import type { Slide } from '@narrative/shared'
import type { PreloadProgress } from './useMediaPreload'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetMediaUrl = vi.fn<(assetId: string) => Promise<string>>()
const mockGetVideoInfo = vi.fn()

vi.mock('../api/client.js', () => ({
  useApi: () => ({
    getMediaUrl: mockGetMediaUrl,
    getVideoInfo: mockGetVideoInfo,
  }),
}))

vi.mock('./AuthContext.js', () => ({
  useAuth: () => ({ token: 'test-token' }),
}))

// Fake cache
const fakeCacheStore = new Map<string, { content: Blob | string; expiresAt: number }>()
const mockCacheGet = vi.fn(async (url: string) => {
  const entry = fakeCacheStore.get(url)
  if (!entry || Date.now() > entry.expiresAt) return null
  return {
    url,
    kind: 'image' as const,
    content: entry.content,
    cachedAt: 0,
    expiresAt: entry.expiresAt,
  }
})
const mockCachePut = vi.fn(async (url: string, content: Blob | string) => {
  fakeCacheStore.set(url, { content, expiresAt: Date.now() + 86400000 })
})

vi.mock('./mediaCache.js', () => ({
  openMediaCache: vi.fn(async () => ({
    get: mockCacheGet,
    put: mockCachePut,
    clear: vi.fn(),
    size: vi.fn().mockResolvedValue(0),
  })),
}))

// Mock global fetch
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlide(objects: Slide['objects'] = [], id = 'slide-1'): Slide {
  return {
    id,
    objects,
    animations: [],
    transition: { kind: 'none', durationMs: 0 },
  }
}

function makeImageObject(assetId: string) {
  return {
    id: `img-${assetId}`,
    type: 'image' as const,
    assetId,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    rotation: 0,
    opacity: 1,
  }
}

function makeVideoObject(assetId: string) {
  return {
    id: `vid-${assetId}`,
    type: 'video' as const,
    assetId,
    x: 0,
    y: 0,
    width: 640,
    height: 360,
    rotation: 0,
    opacity: 1,
  }
}

// ---------------------------------------------------------------------------
// Test component
// ---------------------------------------------------------------------------

interface TestState {
  progress: PreloadProgress
  isPreloading: boolean
  start: (slides: Slide[]) => Promise<void>
}

function TestComponent({ onState }: { onState: (s: TestState) => void }) {
  const { start, progress, isPreloading } = useMediaPreload()
  onState({ start, progress, isPreloading })
  return null
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  fakeCacheStore.clear()
})

describe('useMediaPreload', () => {
  it('starts with isPreloading=false and total=0', () => {
    let state: TestState | null = null
    render(
      <TestComponent
        onState={(s) => {
          state = s
        }}
      />,
    )
    expect(state!.isPreloading).toBe(false)
    expect(state!.progress.total).toBe(0)
  })

  it('preloads image URLs and updates progress', async () => {
    mockGetMediaUrl.mockResolvedValue('https://cdn.example.com/img.jpg')
    mockFetch.mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['data'])),
    })

    let state: TestState | null = null
    render(
      <TestComponent
        onState={(s) => {
          state = s
        }}
      />,
    )

    const slides = [makeSlide([makeImageObject('asset-1')])]

    await act(async () => {
      await state!.start(slides)
    })

    await waitFor(() => {
      expect(state!.progress.isDone).toBe(true)
    })

    expect(state!.progress.completed).toBe(1)
    expect(state!.progress.errored).toBe(0)
    expect(mockCachePut).toHaveBeenCalledWith(
      'https://cdn.example.com/img.jpg',
      expect.any(Blob),
      'image',
    )
  })

  it('preloads video poster and HLS manifest', async () => {
    mockGetVideoInfo.mockResolvedValue({
      assetId: 'vid-asset',
      transcodeStatus: 'done',
      posterUrl: 'https://cdn.example.com/poster.jpg',
      hlsManifestUrl: 'https://cdn.example.com/manifest.m3u8',
      durationSec: null,
      width: null,
      height: null,
      thumbnailUrl: null,
      transcodeError: null,
    })
    mockFetch
      .mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(new Blob(['poster'])) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('#EXTM3U') })

    let state: TestState | null = null
    render(
      <TestComponent
        onState={(s) => {
          state = s
        }}
      />,
    )

    const slides = [makeSlide([makeVideoObject('vid-asset')])]

    await act(async () => {
      await state!.start(slides)
    })

    await waitFor(() => {
      expect(state!.progress.isDone).toBe(true)
    })

    expect(state!.progress.total).toBe(2) // poster + manifest
    expect(state!.progress.completed).toBe(2)
  })

  it('errors do not abort preload — errored increments', async () => {
    mockGetMediaUrl
      .mockResolvedValueOnce('https://cdn.example.com/ok.jpg')
      .mockResolvedValueOnce('https://cdn.example.com/fail.jpg')

    mockFetch
      .mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(new Blob(['ok'])) })
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)

    let state: TestState | null = null
    render(
      <TestComponent
        onState={(s) => {
          state = s
        }}
      />,
    )

    const slides = [makeSlide([makeImageObject('asset-ok'), makeImageObject('asset-fail')])]

    await act(async () => {
      await state!.start(slides)
    })

    await waitFor(() => {
      expect(state!.progress.isDone).toBe(true)
    })

    expect(state!.progress.completed).toBe(1)
    expect(state!.progress.errored).toBe(1)
  })

  it('skips URLs already in cache', async () => {
    const url = 'https://cdn.example.com/cached.jpg'
    mockGetMediaUrl.mockResolvedValue(url)

    // Pre-populate cache
    fakeCacheStore.set(url, {
      content: new Blob(['cached']),
      expiresAt: Date.now() + 86400000,
    })

    let state: TestState | null = null
    render(
      <TestComponent
        onState={(s) => {
          state = s
        }}
      />,
    )

    const slides = [makeSlide([makeImageObject('asset-cached')])]

    await act(async () => {
      await state!.start(slides)
    })

    await waitFor(() => {
      expect(state!.progress.isDone).toBe(true)
    })

    expect(state!.progress.completed).toBe(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockCachePut).not.toHaveBeenCalled()
  })

  it('handles empty slide list gracefully', async () => {
    let state: TestState | null = null
    render(
      <TestComponent
        onState={(s) => {
          state = s
        }}
      />,
    )

    await act(async () => {
      await state!.start([])
    })

    expect(state!.progress.total).toBe(0)
    expect(state!.progress.isDone).toBe(true)
    expect(state!.isPreloading).toBe(false)
  })
})
