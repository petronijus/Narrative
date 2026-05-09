/**
 * state/useMediaUpload.test.tsx
 *
 * Tests for the useMediaUpload hook + MediaUploadProvider.
 *
 * Strategy:
 *   - Mock tus-js-client so no real HTTP requests are made.
 *   - Control tus lifecycle (onProgress, onSuccess, onError, onAfterResponse)
 *     via the mock's captured callbacks.
 *   - Mock useAuth to provide a stable token.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MediaUploadProvider, useMediaUpload } from './useMediaUpload'
import type { MediaUploadContextValue } from './useMediaUpload'

// ---------------------------------------------------------------------------
// Mock tus-js-client
// ---------------------------------------------------------------------------

interface TusUploadCallbacks {
  onProgress?: (bytesSent: number, bytesTotal: number) => void
  // Response shape mirrors the production hook: server's onUploadFinish
  // now returns { assetId, width, height, … } in the JSON body, so the
  // client reads `res.getBody()` instead of custom X-Narrative-* headers
  // (which the browser strips under CORS — tus's
  // Access-Control-Expose-Headers list is fixed).
  onAfterResponse?: (
    req: unknown,
    res: { getBody?: () => string; getHeader?: (h: string) => string | undefined },
  ) => void
  onSuccess?: () => void
  onError?: (err: Error) => void
}

// Captured tus.Upload instances for each startUpload call
const tusInstances: Array<{
  callbacks: TusUploadCallbacks
  abortMock: Mock
  startMock: Mock
}> = []

vi.mock('tus-js-client', () => {
  class MockUpload {
    callbacks: TusUploadCallbacks
    abortMock = vi.fn().mockResolvedValue(undefined)
    startMock = vi.fn()

    constructor(_file: File, opts: TusUploadCallbacks) {
      this.callbacks = opts
      tusInstances.push(this)
    }

    start() {
      this.startMock()
    }

    abort(_permanently: boolean) {
      return this.abortMock(_permanently)
    }
  }

  return { Upload: MockUpload }
})

// ---------------------------------------------------------------------------
// Mock useAuth
// ---------------------------------------------------------------------------

vi.mock('./AuthContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./AuthContext')>()),
  useAuth: () => ({ token: 'test-token', user: { sub: 'test-user' } }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImageFile(name = 'photo.jpg', type = 'image/jpeg', size = 1024): File {
  return new File(['x'.repeat(size)], name, { type })
}

function makeTextFile(name = 'doc.txt'): File {
  return new File(['hello'], name, { type: 'text/plain' })
}

/**
 * A component that exposes the upload context state for assertions.
 */
function UploadConsumer({ onContext }: { onContext: (ctx: MediaUploadContextValue) => void }) {
  const ctx = useMediaUpload()
  onContext(ctx)
  return (
    <div>
      {ctx.uploads.map((u) => (
        <div key={u.id} data-testid={`upload-${u.id}`}>
          {u.status}:{u.filename}:{Math.round(u.progress * 100)}
        </div>
      ))}
    </div>
  )
}

function TestWrapper({ onContext }: { onContext: (ctx: MediaUploadContextValue) => void }) {
  return (
    <MediaUploadProvider deckId="deck-123">
      <UploadConsumer onContext={onContext} />
    </MediaUploadProvider>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  tusInstances.length = 0
})

describe('useMediaUpload', () => {
  it('throws when used outside provider', () => {
    const originalError = console.error
    console.error = () => undefined
    expect(() => render(<UploadConsumer onContext={() => undefined} />)).toThrow(
      'useMediaUpload must be used within MediaUploadProvider',
    )
    console.error = originalError
  })

  it('startUpload creates entry with status queued then uploading', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeImageFile())
    })

    await waitFor(() => {
      // After dimension probe + tus start, status should be 'uploading'
      expect(capturedCtx!.uploads).toHaveLength(1)
    })

    const entry = capturedCtx!.uploads[0]!
    expect(entry.filename).toBe('photo.jpg')
    expect(entry.status).toBe('uploading')
  })

  it('progress events update entry progress and status', async () => {
    let capturedCtx: MediaUploadContextValue | null = null
    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeImageFile())
    })

    // Wait for tus instance to be created
    await waitFor(() => expect(tusInstances.length).toBeGreaterThan(0))

    const instance = tusInstances[0]!
    act(() => {
      instance.callbacks.onProgress?.(512, 1024)
    })

    await waitFor(() => {
      const entry = capturedCtx!.uploads[0]!
      expect(entry.status).toBe('uploading')
      expect(entry.progress).toBeCloseTo(0.5)
    })
  })

  it('onSuccess sets status done and fires onDone callback', async () => {
    let capturedCtx: MediaUploadContextValue | null = null
    const onDone = vi.fn()

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeImageFile(), { onDone })
    })

    await waitFor(() => expect(tusInstances.length).toBeGreaterThan(0))

    const instance = tusInstances[0]!
    act(() => {
      // Simulate the server's final PATCH response — onUploadFinish on the
      // server now returns assetId/width/height in the JSON body. Headers
      // are stripped by the browser CORS layer (tus's
      // Access-Control-Expose-Headers list is fixed), so the client reads
      // the body instead.
      instance.callbacks.onAfterResponse?.(
        {},
        {
          getBody: () => JSON.stringify({ assetId: 'asset-abc', width: 800, height: 600 }),
        },
      )
    })

    act(() => {
      instance.callbacks.onSuccess?.()
    })

    await waitFor(() => {
      const entry = capturedCtx!.uploads[0]!
      expect(entry.status).toBe('done')
      expect(entry.assetId).toBe('asset-abc')
      expect(entry.width).toBe(800)
      expect(entry.height).toBe(600)
    })

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'done', assetId: 'asset-abc' }),
      )
    })
  })

  it('onError sets status error with message', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeImageFile())
    })

    await waitFor(() => expect(tusInstances.length).toBeGreaterThan(0))

    act(() => {
      tusInstances[0]!.callbacks.onError?.(new Error('Network error'))
    })

    await waitFor(() => {
      const entry = capturedCtx!.uploads[0]!
      expect(entry.status).toBe('error')
      expect(entry.error).toBe('Network error')
    })
  })

  it('cancelUpload calls tus abort and sets status cancelled', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeImageFile())
    })

    await waitFor(() => expect(tusInstances.length).toBeGreaterThan(0))

    const id = capturedCtx!.uploads[0]!.id

    await act(async () => {
      capturedCtx!.cancelUpload(id)
    })

    await waitFor(() => {
      const entry = capturedCtx!.uploads.find((u) => u.id === id)!
      expect(entry.status).toBe('cancelled')
    })

    expect(tusInstances[0]!.abortMock).toHaveBeenCalledWith(true)
  })

  it('non-image/non-video MIME is rejected client-side with error status — no tus call', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeTextFile())
    })

    await waitFor(() => expect(capturedCtx!.uploads).toHaveLength(1))

    const entry = capturedCtx!.uploads[0]!
    expect(entry.status).toBe('error')
    expect(entry.error).toMatch(/unsupported file type/i)
    // No tus instance created
    expect(tusInstances).toHaveLength(0)
  })

  it('concurrent uploads tracked independently', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeImageFile('a.jpg'))
      capturedCtx!.startUpload(makeImageFile('b.png', 'image/png'))
    })

    await waitFor(() => expect(capturedCtx!.uploads).toHaveLength(2))

    const filenames = capturedCtx!.uploads.map((u) => u.filename)
    expect(filenames).toContain('a.jpg')
    expect(filenames).toContain('b.png')

    // Complete one upload
    await waitFor(() => expect(tusInstances.length).toBe(2))

    act(() => {
      tusInstances[0]!.callbacks.onSuccess?.()
    })

    await waitFor(() => {
      const a = capturedCtx!.uploads.find((u) => u.filename === 'a.jpg')!
      const b = capturedCtx!.uploads.find((u) => u.filename === 'b.png')!
      expect(a.status).toBe('done')
      expect(b.status).toBe('uploading')
    })
  })

  it('dismissUpload removes done entry from list', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeImageFile())
    })

    await waitFor(() => expect(tusInstances.length).toBeGreaterThan(0))

    act(() => {
      tusInstances[0]!.callbacks.onSuccess?.()
    })

    await waitFor(() => expect(capturedCtx!.uploads[0]!.status).toBe('done'))

    const id = capturedCtx!.uploads[0]!.id
    act(() => {
      capturedCtx!.dismissUpload(id)
    })

    await waitFor(() => expect(capturedCtx!.uploads).toHaveLength(0))
  })

  it('dismissUpload does not remove uploading entry', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeImageFile())
    })

    await waitFor(() => expect(capturedCtx!.uploads).toHaveLength(1))
    const id = capturedCtx!.uploads[0]!.id

    act(() => {
      capturedCtx!.dismissUpload(id)
    })

    // Still there since it's uploading/queued
    await waitFor(() => expect(capturedCtx!.uploads).toHaveLength(1))
  })

  it('retryUpload re-creates tus instance for errored upload', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeImageFile())
    })

    await waitFor(() => expect(tusInstances.length).toBe(1))

    act(() => {
      tusInstances[0]!.callbacks.onError?.(new Error('timeout'))
    })

    await waitFor(() => expect(capturedCtx!.uploads[0]!.status).toBe('error'))

    const id = capturedCtx!.uploads[0]!.id
    act(() => {
      capturedCtx!.retryUpload(id)
    })

    // A second tus instance should be created
    await waitFor(() => expect(tusInstances.length).toBe(2))

    await waitFor(() => expect(capturedCtx!.uploads[0]!.status).toBe('uploading'))
  })
})

// ---------------------------------------------------------------------------
// M12: Video upload tests
// ---------------------------------------------------------------------------

describe('useMediaUpload — video uploads (M12)', () => {
  function makeVideoFile(name = 'clip.mp4', type = 'video/mp4', size = 1024 * 1024): File {
    return new File(['x'.repeat(Math.min(size, 100))], name, { type })
  }

  it('video file starts upload (no dimension probe)', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeVideoFile())
    })

    await waitFor(() => expect(capturedCtx!.uploads).toHaveLength(1))
    // tus instance created immediately (no createImageBitmap probe for video)
    await waitFor(() => expect(tusInstances.length).toBeGreaterThan(0))

    const entry = capturedCtx!.uploads[0]!
    expect(entry.mimeType).toBe('video/mp4')
    expect(entry.status).toBe('uploading')
  })

  it('video with transcodeStatus pending starts poll and stays finalizing', async () => {
    let capturedCtx: MediaUploadContextValue | null = null
    const onDone = vi.fn()

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeVideoFile(), { onDone })
    })

    await waitFor(() => expect(tusInstances.length).toBeGreaterThan(0))

    const instance = tusInstances[0]!

    // Simulate tus PATCH final response — server returns assetId in the
    // JSON body (read via res.getBody()).
    act(() => {
      instance.callbacks.onAfterResponse?.(
        {},
        { getBody: () => JSON.stringify({ assetId: 'vid-asset-123' }) },
      )
    })

    act(() => {
      instance.callbacks.onSuccess?.()
    })

    // Should be in 'finalizing' — waiting for transcode
    await waitFor(() => {
      const entry = capturedCtx!.uploads[0]!
      expect(entry.status).toBe('finalizing')
      expect(entry.assetId).toBe('vid-asset-123')
    })

    // onDone should NOT have been called yet (transcode still pending)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('video upload rejects oversized file (>500MB) client-side', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    // Create a file with size > 500MB (fake — just set size in File metadata)
    const bigFile = new File(['x'], 'huge.mp4', { type: 'video/mp4' })
    Object.defineProperty(bigFile, 'size', { value: 501 * 1024 * 1024 })

    act(() => {
      capturedCtx!.startUpload(bigFile)
    })

    await waitFor(() => expect(capturedCtx!.uploads).toHaveLength(1))

    const entry = capturedCtx!.uploads[0]!
    expect(entry.status).toBe('error')
    expect(entry.error).toMatch(/too large/i)
    // No tus instance created
    expect(tusInstances).toHaveLength(0)
  })

  it('cancelUpload during finalizing clears transcode poll timer', async () => {
    let capturedCtx: MediaUploadContextValue | null = null

    render(
      <TestWrapper
        onContext={(ctx) => {
          capturedCtx = ctx
        }}
      />,
    )

    act(() => {
      capturedCtx!.startUpload(makeVideoFile())
    })

    await waitFor(() => expect(tusInstances.length).toBeGreaterThan(0))

    const instance = tusInstances[0]!
    act(() => {
      instance.callbacks.onAfterResponse?.(
        {},
        { getBody: () => JSON.stringify({ assetId: 'vid-abc' }) },
      )
    })
    act(() => {
      instance.callbacks.onSuccess?.()
    })

    await waitFor(() => {
      expect(capturedCtx!.uploads[0]!.status).toBe('finalizing')
    })

    const id = capturedCtx!.uploads[0]!.id
    act(() => {
      capturedCtx!.cancelUpload(id)
    })

    await waitFor(() => {
      expect(capturedCtx!.uploads[0]!.status).toBe('cancelled')
    })
  })
})
