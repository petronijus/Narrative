/**
 * ui/VideoOverlay.test.tsx
 *
 * Tests for VideoOverlay component.
 *
 * Strategy:
 *   - Mock OverlayCompositor (registerOverlay / destroy).
 *   - Mock useVideoInfo.
 *   - Mock openMediaCache.
 *   - Assert: overlay registered on mount when transcode done.
 *   - Assert: <video> src set to playbackUrl when transcode done.
 *   - Assert: handle.destroy() called on unmount.
 *   - Assert: nothing rendered while transcoding pending.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { VideoOverlay } from './VideoOverlay'
import type { VideoObject } from '@narrative/shared'
import type { VideoInfoResponse } from '../api/client'

// ---------------------------------------------------------------------------
// Mock useVideoInfo
// ---------------------------------------------------------------------------

let mockVideoInfo: VideoInfoResponse | null = null

vi.mock('../state/useVideoInfo.js', () => ({
  useVideoInfo: () => ({
    info: mockVideoInfo,
    isLoading: false,
    error: null,
  }),
}))

// ---------------------------------------------------------------------------
// Mock SceneGraph
// ---------------------------------------------------------------------------

const mockContainer = {
  toGlobal: vi.fn(() => ({ x: 100, y: 200 })),
  x: 100,
  y: 200,
}

const mockGetNode = vi.fn(() => ({ container: mockContainer, data: {} }))

const mockSceneGraph = {
  getNode: mockGetNode,
}

// ---------------------------------------------------------------------------
// Mock OverlayCompositor
// ---------------------------------------------------------------------------

const mockOverlayHandleDestroy = vi.fn()
const mockRegisterOverlay = vi.fn(() => ({
  destroy: mockOverlayHandleDestroy,
  update: vi.fn(),
  setInteractive: vi.fn(),
}))

const mockCompositor = {
  registerOverlay: mockRegisterOverlay,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVideoObject(overrides: Partial<VideoObject> = {}): VideoObject {
  return {
    id: 'vid-1',
    type: 'video',
    assetId: 'asset-123',
    x: 100,
    y: 200,
    width: 640,
    height: 360,
    rotation: 0,
    opacity: 1,
    autoplay: false,
    loop: false,
    muted: true,
    ...overrides,
  }
}

function makeVideoInfo(
  status: VideoInfoResponse['transcodeStatus'],
  overrides: Partial<VideoInfoResponse> = {},
): VideoInfoResponse {
  return {
    assetId: 'asset-123',
    transcodeStatus: status,
    durationSec: 30,
    width: 1920,
    height: 1080,
    posterUrl: 'https://cdn.example.com/poster.jpg',
    thumbnailUrl: null,
    playbackUrl: 'https://cdn.example.com/playback.mp4',
    transcodeError: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockVideoInfo = null
})

describe('VideoOverlay', () => {
  it('renders nothing while transcodeStatus is pending', () => {
    mockVideoInfo = makeVideoInfo('pending')

    const { container } = render(
      <VideoOverlay
        videoObject={makeVideoObject()}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sceneGraph={mockSceneGraph as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compositor={mockCompositor as any}
      />,
    )

    expect(container.firstChild).toBeNull()
    expect(mockRegisterOverlay).not.toHaveBeenCalled()
  })

  it('renders nothing while info is null (loading)', () => {
    mockVideoInfo = null

    render(
      <VideoOverlay
        videoObject={makeVideoObject()}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sceneGraph={mockSceneGraph as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compositor={mockCompositor as any}
      />,
    )

    expect(mockRegisterOverlay).not.toHaveBeenCalled()
  })

  it('registers overlay with compositor when transcode is done', async () => {
    mockVideoInfo = makeVideoInfo('done')

    render(
      <VideoOverlay
        videoObject={makeVideoObject()}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sceneGraph={mockSceneGraph as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compositor={mockCompositor as any}
      />,
    )

    await waitFor(() => {
      expect(mockRegisterOverlay).toHaveBeenCalledOnce()
    })

    const opts = (
      mockRegisterOverlay.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0]
    expect(opts?.['pixiContainer']).toBe(mockContainer)
    expect(opts?.['domElement']).toBeInstanceOf(HTMLVideoElement)
    expect(opts?.['interactive']).toBe(true)
  })

  it('sets <video> src to playbackUrl when transcode is done', async () => {
    mockVideoInfo = makeVideoInfo('done')

    render(
      <VideoOverlay
        videoObject={makeVideoObject()}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sceneGraph={mockSceneGraph as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compositor={mockCompositor as any}
      />,
    )

    await waitFor(() => {
      expect(mockRegisterOverlay).toHaveBeenCalledOnce()
    })

    const call = (
      mockRegisterOverlay.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0]
    const videoEl = call?.['domElement'] as HTMLVideoElement
    expect(videoEl.src).toContain('https://cdn.example.com/playback.mp4')
  })

  it('destroys overlay handle on unmount', async () => {
    mockVideoInfo = makeVideoInfo('done')

    const { unmount } = render(
      <VideoOverlay
        videoObject={makeVideoObject()}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sceneGraph={mockSceneGraph as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compositor={mockCompositor as any}
      />,
    )

    await waitFor(() => {
      expect(mockRegisterOverlay).toHaveBeenCalledOnce()
    })

    act(() => {
      unmount()
    })

    expect(mockOverlayHandleDestroy).toHaveBeenCalledOnce()
  })

  it('sets video element attributes from VideoObject props', async () => {
    mockVideoInfo = makeVideoInfo('done')

    const videoObj = makeVideoObject({
      autoplay: true,
      loop: true,
      muted: true,
      alt: 'Product demo video',
      width: 800,
      height: 450,
    })

    render(
      <VideoOverlay
        videoObject={videoObj}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sceneGraph={mockSceneGraph as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compositor={mockCompositor as any}
      />,
    )

    await waitFor(() => {
      expect(mockRegisterOverlay).toHaveBeenCalledOnce()
    })

    const call = (
      mockRegisterOverlay.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0]
    const videoEl = call?.['domElement'] as HTMLVideoElement
    expect(videoEl.autoplay).toBe(true)
    expect(videoEl.loop).toBe(true)
    expect(videoEl.muted).toBe(true)
    expect(videoEl.style.width).toBe('800px')
    expect(videoEl.style.height).toBe('450px')
    expect(videoEl.getAttribute('aria-label')).toBe('Product demo video')
  })
})
