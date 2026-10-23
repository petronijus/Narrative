/**
 * renderer/presentKeepWarm.test.ts — present mode's idle turn in an engine
 * without idle callbacks (WebKit): right after the next rendered frame, not
 * wherever a 0-ms timer lands; a hidden page (no frames) still gets its turn
 * at the timeout; a cancelled turn never runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPresentIdleFallback, whenPresentIdle } from './presentKeepWarm.js'

describe('whenPresentIdle without requestIdleCallback', () => {
  let frames: Array<FrameRequestCallback | null>
  const runFrame = (): void => {
    const pending = frames
    frames = []
    for (const f of pending) f?.(performance.now())
  }

  beforeEach(() => {
    vi.useFakeTimers()
    frames = []
    vi.stubGlobal('requestIdleCallback', undefined)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      frames[handle - 1] = null
    })
    setPresentIdleFallback('frame')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    setPresentIdleFallback('frame')
  })

  it('runs in the task after the next frame, not before it', () => {
    const cb = vi.fn()
    whenPresentIdle(cb, 2000)
    vi.advanceTimersByTime(100)
    expect(cb).not.toHaveBeenCalled()
    runFrame()
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(cb).toHaveBeenCalledTimes(1)
    // Once only: the timeout that would have run it is gone.
    vi.advanceTimersByTime(5000)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('runs at the timeout when no frame comes (a hidden page)', () => {
    const cb = vi.fn()
    whenPresentIdle(cb, 500)
    vi.advanceTimersByTime(499)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
    runFrame()
    vi.advanceTimersByTime(0)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('never runs once cancelled', () => {
    const cb = vi.fn()
    const cancel = whenPresentIdle(cb, 500)
    runFrame()
    cancel()
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('the timer fallback runs on a 0-ms timer, frame or no frame', () => {
    setPresentIdleFallback('timer')
    const cb = vi.fn()
    whenPresentIdle(cb, 500)
    vi.advanceTimersByTime(0)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(0)
  })
})
