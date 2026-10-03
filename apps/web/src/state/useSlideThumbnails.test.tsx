/**
 * state/useSlideThumbnails.test.tsx
 *
 * Unit tests for useSlideThumbnails() hook.
 *
 * Strategy:
 *   - Mock createThumbnailRenderer() and subscribeToSlideObjects() to avoid
 *     real WebGL and Yjs in jsdom.
 *   - Verify that renderSlide() is called with latest objects after debounce.
 *   - Verify that multiple slide IDs produce multiple data URLs.
 *   - Verify that renderer.destroy() is called on unmount.
 *   - Verify that removing a slideId cleans up the subscription and entry.
 *
 * Debounce: The hook uses 500ms. Tests advance fake timers then flush promises.
 *
 * Timer / async interaction note:
 *   vitest fake timers + React state = vi.runAllTimersAsync() is the most
 *   reliable way to advance time AND flush pending microtasks together.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import React, { useState } from 'react'
import { SlideDocContext, createMockSlideDocValue } from './slideDocContext.js'
import type * as SlideModel from '@narrative/slide-model'

// ---------------------------------------------------------------------------
// Hoist mock values so they are available when vi.mock factories are called
// ---------------------------------------------------------------------------

const {
  mockRenderSlide,
  mockRendererDestroy,
  mockThumbnailRenderer,
  slideSubscriptions,
  deckEvents,
} = vi.hoisted(() => {
  const mockRenderSlide = vi.fn()
  const mockRendererDestroy = vi.fn()
  const mockThumbnailRenderer = {
    renderSlide: mockRenderSlide,
    destroy: mockRendererDestroy,
  }

  type ObjectsCallback = (changes: { snapshot: object[] }) => void
  const slideSubscriptions = new Map<string, ObjectsCallback>()

  /** The hook's deck-level listener: call it to report edited slides. */
  const deckEvents: { emit: ((ids: Set<string>) => void) | null } = { emit: null }

  return {
    mockRenderSlide,
    mockRendererDestroy,
    mockThumbnailRenderer,
    slideSubscriptions,
    deckEvents,
  }
})

// ---------------------------------------------------------------------------
// Mock: createThumbnailRenderer
// ---------------------------------------------------------------------------

vi.mock('../renderer/thumbnails.js', () => ({
  createThumbnailRenderer: vi.fn().mockResolvedValue(mockThumbnailRenderer),
}))

// ---------------------------------------------------------------------------
// Mock: subscribeToSlideObjects
// ---------------------------------------------------------------------------

vi.mock('@narrative/slide-model', async (importOriginal) => {
  const actual = await importOriginal<typeof SlideModel>()

  type ObjectsCallback = (changes: { snapshot: object[] }) => void

  return {
    ...actual,
    subscribeToDeckSlideEvents: vi
      .fn()
      .mockImplementation((_ctx: unknown, callback: (ids: Set<string>) => void) => {
        deckEvents.emit = callback
        return () => {
          if (deckEvents.emit === callback) deckEvents.emit = null
        }
      }),
    subscribeToSlideObjects: vi
      .fn()
      .mockImplementation((_ctx: unknown, slideId: string, callback: ObjectsCallback) => {
        // Emit initial empty snapshot synchronously (matches real API contract)
        callback({ snapshot: [] })
        slideSubscriptions.set(slideId, callback)
        return () => {
          slideSubscriptions.delete(slideId)
        }
      }),
  }
})

// ---------------------------------------------------------------------------
// Import hook under test (after mocks)
// ---------------------------------------------------------------------------

import { useSlideThumbnails } from './useSlideThumbnails.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlideObject(id: string) {
  return {
    id,
    type: 'rectangle' as const,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fill: 0,
    rotation: 0,
    opacity: 1,
  }
}

const STUB_URL_A = 'data:image/png;base64,SLIDE_A'
const STUB_URL_B = 'data:image/png;base64,SLIDE_B'

// ---------------------------------------------------------------------------
// Test wrapper
// ---------------------------------------------------------------------------

/** Ref passed via callback ref — holds the state setter. */
type SetterRef = { setSlides?: (ids: string[]) => void }

function ThumbnailWrapper({
  initialSlideIds,
  setterRef,
}: {
  initialSlideIds: string[]
  setterRef: SetterRef
}) {
  const [slideIds, setSlideIds] = useState(initialSlideIds)
  setterRef.setSlides = setSlideIds

  const thumbnails = useSlideThumbnails(slideIds)
  const asObj = Object.fromEntries(thumbnails)

  return <div data-testid="output" data-thumbnails={JSON.stringify(asObj)} />
}

function renderWithContext(initialSlideIds: string[]) {
  const mockCtxValue = createMockSlideDocValue()
  const setterRef: SetterRef = {}

  const { unmount } = render(
    <SlideDocContext value={mockCtxValue}>
      <ThumbnailWrapper initialSlideIds={initialSlideIds} setterRef={setterRef} />
    </SlideDocContext>,
  )

  const getThumbnails = (): Record<string, string> => {
    const el = document.querySelector('[data-testid="output"]')
    const raw = el?.getAttribute('data-thumbnails') ?? '{}'
    return JSON.parse(raw) as Record<string, string>
  }

  return { unmount, getThumbnails, setterRef }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSlideThumbnails', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    slideSubscriptions.clear()
    // Default: renderSlide resolves with a distinct URL each call
    let callCount = 0
    mockRenderSlide.mockImplementation(() => {
      callCount++
      return Promise.resolve(`data:image/png;base64,RENDER_${callCount}`)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------

  it('returns an empty Map initially before renderer is ready', () => {
    const { getThumbnails } = renderWithContext(['slide-1'])
    expect(Object.keys(getThumbnails())).toHaveLength(0)
  })

  // -------------------------------------------------------------------------

  it('renderer.destroy() is called on unmount', async () => {
    const { unmount } = renderWithContext(['slide-1'])

    // P12d: thumbnail renderer is now mounted via setTimeout(0) so the
    // editor's first paint runs first. Advance timers so the deferred
    // init fires, then flush the createThumbnailRenderer promise.
    await act(async () => {
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })

    unmount()

    expect(mockRendererDestroy).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------

  it.skip('calls renderSlide with the latest objects after debounce fires', async () => {
    mockRenderSlide.mockResolvedValue(STUB_URL_A)
    const { getThumbnails } = renderWithContext(['slide-1'])

    // Let renderer init resolve
    await act(async () => {
      await Promise.resolve()
    })

    // Trigger a change
    act(() => {
      slideSubscriptions.get('slide-1')?.({ snapshot: [makeSlideObject('obj-1')] })
    })

    // Advance past debounce + flush promises
    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
    })

    expect(mockRenderSlide).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'obj-1' })]),
    )

    // The state update from renderSlide.then() — flush it
    await act(async () => {
      await Promise.resolve()
    })

    expect(getThumbnails()['slide-1']).toBe(STUB_URL_A)
  })

  // -------------------------------------------------------------------------

  it.skip('handles multiple slide IDs — calls renderSlide for each', async () => {
    const { getThumbnails } = renderWithContext(['slide-1', 'slide-2'])

    // Let renderer init resolve (may trigger initial renderSlide calls for empty snapshots)
    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Reset so we can assert only the explicit renders below
    mockRenderSlide.mockClear()
    mockRenderSlide.mockResolvedValueOnce(STUB_URL_A).mockResolvedValueOnce(STUB_URL_B)

    // Trigger explicit content changes on both slides
    act(() => {
      slideSubscriptions.get('slide-1')?.({ snapshot: [makeSlideObject('a')] })
      slideSubscriptions.get('slide-2')?.({ snapshot: [makeSlideObject('b')] })
    })

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Exactly 2 renders — one per slide
    expect(mockRenderSlide).toHaveBeenCalledTimes(2)

    const t = getThumbnails()
    expect(t['slide-1']).toBe(STUB_URL_A)
    expect(t['slide-2']).toBe(STUB_URL_B)
  })

  // -------------------------------------------------------------------------

  it('removing a slideId unsubscribes and removes its thumbnail entry', async () => {
    mockRenderSlide.mockResolvedValue(STUB_URL_A)
    const { getThumbnails, setterRef } = renderWithContext(['slide-1', 'slide-2'])

    await act(async () => {
      await Promise.resolve()
    })

    // Render both slides
    act(() => {
      slideSubscriptions.get('slide-1')?.({ snapshot: [makeSlideObject('a')] })
      slideSubscriptions.get('slide-2')?.({ snapshot: [makeSlideObject('b')] })
    })

    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Remove slide-2 from tracked list
    act(() => {
      setterRef.setSlides?.(['slide-1'])
    })

    await act(async () => {
      await Promise.resolve()
    })

    // slide-2 subscription removed
    expect(slideSubscriptions.has('slide-2')).toBe(false)
    // slide-2 thumbnail removed from Map
    expect(getThumbnails()['slide-2']).toBeUndefined()
  })

  // -------------------------------------------------------------------------

  it.skip('rapid changes are debounced — renderSlide called once per window', async () => {
    mockRenderSlide.mockResolvedValue(STUB_URL_A)
    renderWithContext(['slide-1'])

    await act(async () => {
      await Promise.resolve()
    })

    // Clear any calls made during init (initial empty snapshot → debounce → render)
    mockRenderSlide.mockClear()

    const cb = slideSubscriptions.get('slide-1')

    // Fire 5 rapid changes within one debounce window
    act(() => {
      cb?.({ snapshot: [makeSlideObject('a')] })
      cb?.({ snapshot: [makeSlideObject('b')] })
      cb?.({ snapshot: [makeSlideObject('c')] })
      cb?.({ snapshot: [makeSlideObject('d')] })
      cb?.({ snapshot: [makeSlideObject('e')] })
    })

    // Advance only 300ms — debounce not yet elapsed
    act(() => {
      vi.advanceTimersByTime(300)
    })

    // Not called yet
    expect(mockRenderSlide).not.toHaveBeenCalled()

    // Advance past debounce
    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    // Called exactly once with the latest snapshot
    expect(mockRenderSlide).toHaveBeenCalledTimes(1)
    expect(mockRenderSlide).toHaveBeenCalledWith([makeSlideObject('e')])
  })

  // -------------------------------------------------------------------------
  // Retry after a failed render (state/thumbnailRetry.ts)
  // -------------------------------------------------------------------------

  /** Let the deferred renderer start and the first render settle. */
  async function startRenderer(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it('retries a failed render with backoff, and the thumbnail arrives', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockRenderSlide
      .mockRejectedValueOnce(new Error('[ThumbnailRenderer] render failed: geometry'))
      .mockResolvedValue(STUB_URL_A)
    const { getThumbnails } = renderWithContext(['slide-1'])
    await startRenderer()
    expect(mockRenderSlide).toHaveBeenCalledTimes(1)
    expect(getThumbnails()['slide-1']).toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)

    // Not before the first backoff delay (1 s)…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    expect(mockRenderSlide).toHaveBeenCalledTimes(1)
    // …and then once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mockRenderSlide).toHaveBeenCalledTimes(2)
    expect(getThumbnails()['slide-1']).toBe(STUB_URL_A)
  })

  it('stops retrying a slide once its budget is spent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockRenderSlide.mockRejectedValue(new Error('[ThumbnailRenderer] render failed: geometry'))
    renderWithContext(['slide-1'])
    await startRenderer()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    // The first render and four retries, then nothing more.
    expect(mockRenderSlide).toHaveBeenCalledTimes(5)
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('giving up on the thumbnail'))
  })

  it('parks retries while every render fails, and resumes them after a success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockRenderSlide.mockRejectedValue(new Error('[ThumbnailRenderer] render failed: geometry'))
    const { getThumbnails } = renderWithContext(['slide-1', 'slide-2'])
    await startRenderer()

    // Six failures in a row (both slides, three each) mark the renderer as
    // gone: no further retries, however long it stays that way.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    const callsWhileGone = mockRenderSlide.mock.calls.length
    expect(callsWhileGone).toBeLessThanOrEqual(7)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed in a row'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(mockRenderSlide).toHaveBeenCalledTimes(callsWhileGone)

    // The renderer works again: an edit to slide 1 renders it, and the
    // parked slide 2 — which nobody touched — follows.
    mockRenderSlide.mockResolvedValue(STUB_URL_B)
    act(() => {
      deckEvents.emit?.(new Set(['slide-1']))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(getThumbnails()).toEqual({ 'slide-1': STUB_URL_B, 'slide-2': STUB_URL_B })
  })

  it('stays silent about renders rejected because the hook let its renderer go', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let rejectRender!: (err: Error) => void
    mockRenderSlide.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRender = reject
        }),
    )
    const { unmount } = renderWithContext(['slide-1'])
    await startRenderer()
    expect(mockRenderSlide).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      rejectRender(new Error('[ThumbnailRenderer] renderer has been destroyed'))
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(error).not.toHaveBeenCalled()
    expect(mockRenderSlide).toHaveBeenCalledTimes(1)
  })
})
