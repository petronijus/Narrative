/**
 * state/useVideoInfo.test.tsx
 *
 * Tests for useVideoInfo hook.
 *
 * Strategy:
 *   - Mock useApi to control getVideoInfo responses.
 *   - Use fake timers to control polling interval.
 *   - Assert polling stops on terminal states (done/failed).
 *   - Assert polling continues on non-terminal states (pending/processing).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { useVideoInfo } from './useVideoInfo'
import type { VideoInfoResponse } from '../api/client'

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockGetVideoInfo = vi.fn<(assetId: string) => Promise<VideoInfoResponse>>()

vi.mock('../api/client.js', () => ({
  useApi: () => ({
    getVideoInfo: mockGetVideoInfo,
  }),
}))

// ---------------------------------------------------------------------------
// Test component
// ---------------------------------------------------------------------------

interface TestProps {
  assetId: string | null
  onResult: (result: ReturnType<typeof useVideoInfo>) => void
}

function TestComponent({ assetId, onResult }: TestProps) {
  const result = useVideoInfo(assetId)
  onResult(result)
  return (
    <div data-testid="status">
      {result.isLoading ? 'loading' : (result.info?.transcodeStatus ?? 'null')}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVideoInfo(
  status: VideoInfoResponse['transcodeStatus'],
  overrides: Partial<VideoInfoResponse> = {},
): VideoInfoResponse {
  return {
    assetId: 'asset-123',
    transcodeStatus: status,
    durationSec: null,
    width: null,
    height: null,
    posterUrl: null,
    thumbnailUrl: null,
    playbackUrl: null,
    transcodeError: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // A reset, not a clear: a test's unconsumed mockResolvedValueOnce queue
  // must not answer the next test's fetches.
  mockGetVideoInfo.mockReset()
})

describe('useVideoInfo', () => {
  it('returns null initially and isLoading=true', async () => {
    // getVideoInfo resolves after a delay
    mockGetVideoInfo.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(makeVideoInfo('done')), 100)),
    )

    let captured: ReturnType<typeof useVideoInfo> | null = null
    render(
      <TestComponent
        assetId="asset-123"
        onResult={(r) => {
          captured = r
        }}
      />,
    )

    // Initial render — before first fetch resolves
    expect(captured!.info).toBeNull()
    expect(captured!.isLoading).toBe(true)
  })

  it('returns info when fetch resolves', async () => {
    const info = makeVideoInfo('done', { playbackUrl: 'https://cdn/playback.mp4' })
    mockGetVideoInfo.mockResolvedValue(info)

    render(<TestComponent assetId="asset-123" onResult={() => undefined} />)

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('done')
    })

    expect(mockGetVideoInfo).toHaveBeenCalledTimes(1)
    expect(mockGetVideoInfo).toHaveBeenCalledWith('asset-123')
  })

  it('returns null when assetId is null', () => {
    let captured: ReturnType<typeof useVideoInfo> | null = null
    render(
      <TestComponent
        assetId={null}
        onResult={(r) => {
          captured = r
        }}
      />,
    )

    expect(captured!.info).toBeNull()
    expect(captured!.isLoading).toBe(false)
    expect(mockGetVideoInfo).not.toHaveBeenCalled()
  })

  it('refresh() re-fetches and yields a fresh playbackUrl (MEDIA-1 expiry recovery)', async () => {
    // First load returns a presigned URL; refresh returns a rotated one.
    mockGetVideoInfo
      .mockResolvedValueOnce(
        makeVideoInfo('done', { playbackUrl: '/storage/m/k?X-Amz-Signature=OLD' }),
      )
      .mockResolvedValueOnce(
        makeVideoInfo('done', { playbackUrl: '/storage/m/k?X-Amz-Signature=NEW' }),
      )

    let captured: ReturnType<typeof useVideoInfo> | null = null
    render(
      <TestComponent
        assetId="asset-123"
        onResult={(r) => {
          captured = r
        }}
      />,
    )

    await waitFor(() => {
      expect(captured!.info?.playbackUrl).toContain('OLD')
    })

    let refreshed: VideoInfoResponse | null = null
    await act(async () => {
      refreshed = await captured!.refresh()
    })

    expect(refreshed!.playbackUrl).toContain('NEW')
    // State updated so the <video src> effect re-runs with the fresh URL.
    await waitFor(() => {
      expect(captured!.info?.playbackUrl).toContain('NEW')
    })
    expect(mockGetVideoInfo).toHaveBeenCalledTimes(2)
  })

  it('refresh() returns null and does not throw when assetId is null', async () => {
    let captured: ReturnType<typeof useVideoInfo> | null = null
    render(
      <TestComponent
        assetId={null}
        onResult={(r) => {
          captured = r
        }}
      />,
    )
    let refreshed: VideoInfoResponse | null = makeVideoInfo('done')
    await act(async () => {
      refreshed = await captured!.refresh()
    })
    expect(refreshed).toBeNull()
    expect(mockGetVideoInfo).not.toHaveBeenCalled()
  })

  it('sets error when fetch throws', async () => {
    mockGetVideoInfo.mockRejectedValue(new Error('Network failure'))

    let captured: ReturnType<typeof useVideoInfo> | null = null
    render(
      <TestComponent
        assetId="asset-123"
        onResult={(r) => {
          captured = r
        }}
      />,
    )

    await waitFor(() => {
      expect(captured!.error).not.toBeNull()
    })

    expect(captured!.error?.message).toBe('Network failure')
    expect(captured!.isLoading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Polling — fake timers; time moves with the async advance, so the resolved
// fetches and the React commits they cause land inside act()
// ---------------------------------------------------------------------------

describe('useVideoInfo — polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Move the clock by `ms` and let what it set off settle. */
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  const status = () => screen.getByTestId('status').textContent

  it('polls every 2 s while the status is pending or processing', async () => {
    mockGetVideoInfo
      .mockResolvedValueOnce(makeVideoInfo('pending'))
      .mockResolvedValueOnce(makeVideoInfo('processing'))
      .mockResolvedValueOnce(makeVideoInfo('done'))

    render(<TestComponent assetId="asset-123" onResult={() => undefined} />)

    await advance(0)
    expect(status()).toBe('pending')
    expect(mockGetVideoInfo).toHaveBeenCalledTimes(1)

    await advance(1999)
    expect(mockGetVideoInfo).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(status()).toBe('processing')
    expect(mockGetVideoInfo).toHaveBeenCalledTimes(2)

    await advance(2000)
    expect(status()).toBe('done')
    expect(mockGetVideoInfo).toHaveBeenCalledTimes(3)
  })

  it('stops polling once the status is done', async () => {
    mockGetVideoInfo.mockResolvedValue(makeVideoInfo('done'))

    render(<TestComponent assetId="asset-123" onResult={() => undefined} />)

    await advance(0)
    expect(status()).toBe('done')
    await advance(10_000)
    expect(mockGetVideoInfo).toHaveBeenCalledTimes(1)
  })

  it('stops polling once the status is failed', async () => {
    mockGetVideoInfo.mockResolvedValue(makeVideoInfo('failed', { transcodeError: 'FFmpeg crash' }))

    let captured: ReturnType<typeof useVideoInfo> | null = null
    render(
      <TestComponent
        assetId="asset-123"
        onResult={(r) => {
          captured = r
        }}
      />,
    )

    await advance(0)
    expect(captured!.info?.transcodeStatus).toBe('failed')
    expect(captured!.info?.transcodeError).toBe('FFmpeg crash')
    await advance(10_000)
    expect(mockGetVideoInfo).toHaveBeenCalledTimes(1)
  })
})
