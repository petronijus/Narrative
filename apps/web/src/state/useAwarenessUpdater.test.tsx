/**
 * state/useAwarenessUpdater.test.tsx
 *
 * Testy pro useAwarenessUpdater() hook.
 *
 * Klíčové chování:
 *   - Rapid setCursor calls jsou batched (30Hz throttle)
 *   - setCursor(null) bypass throttle — okamžitý emit
 *   - setSelection je immediate
 *   - setUserName je immediate
 *   - Merge pattern — nemaže ostatní fields
 *
 * Timing testy: vitest fake timers + fake rAF.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { SlideDocContext, createMockSlideDocValue } from './slideDocContext.js'
import { useAwarenessUpdater } from './useAwarenessUpdater.js'
import type { Awareness } from 'y-protocols/awareness'
import type { PeerAwarenessState } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Fake Awareness
// ---------------------------------------------------------------------------

function makeFakeAwareness() {
  let localState: PeerAwarenessState = {
    user: { id: 'test-id', name: 'User test', color: 'hsl(42, 70%, 55%)' },
    selectedObjectIds: [],
    cursor: null,
  }

  const awareness = {
    clientID: 1,
    getStates: () => new Map(),
    on: vi.fn(),
    off: vi.fn(),
    setLocalState: vi.fn((state: PeerAwarenessState | null) => {
      if (state !== null) localState = state
    }),
    getLocalState: vi.fn(() => localState),
  }

  return awareness
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function makeWrapper(fakeAwareness: ReturnType<typeof makeFakeAwareness>) {
  const Wrapper = ({ children }: { children: React.ReactNode }) => {
    const ctxValue = createMockSlideDocValue({
      awareness: fakeAwareness as unknown as Awareness,
    })
    return <SlideDocContext.Provider value={ctxValue}>{children}</SlideDocContext.Provider>
  }
  return Wrapper
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAwarenessUpdater', () => {
  let fakeAwareness: ReturnType<typeof makeFakeAwareness>
  let rafCallbacks: Array<() => void>

  beforeEach(() => {
    vi.useFakeTimers()
    fakeAwareness = makeFakeAwareness()

    // Fake rAF
    rafCallbacks = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: () => void) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length // handle
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    // Fake performance.now — začínáme na 0
    vi.stubGlobal('performance', { now: vi.fn(() => 0) })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function flushRaf() {
    const cbs = [...rafCallbacks]
    rafCallbacks.length = 0
    for (const cb of cbs) cb()
  }

  function advanceTime(ms: number) {
    ;(performance.now as ReturnType<typeof vi.fn>).mockReturnValue(ms)
  }

  it('setCursor emits immediately when enough time has passed', () => {
    const { result } = renderHook(() => useAwarenessUpdater(), {
      wrapper: makeWrapper(fakeAwareness),
    })

    advanceTime(100) // více než 33ms

    act(() => {
      result.current.setCursor({ x: 10, y: 20 })
    })

    expect(fakeAwareness.setLocalState).toHaveBeenCalledTimes(1)
    const call = fakeAwareness.setLocalState.mock.calls[0]![0] as PeerAwarenessState
    expect(call.cursor).toEqual({ x: 10, y: 20 })
  })

  it('rapid setCursor calls are batched via rAF throttle', () => {
    const { result } = renderHook(() => useAwarenessUpdater(), {
      wrapper: makeWrapper(fakeAwareness),
    })

    // První volání — čas 0, žádný předchozí emit → immediate
    advanceTime(0)
    act(() => {
      result.current.setCursor({ x: 1, y: 1 })
    })
    const callsAfterFirst = fakeAwareness.setLocalState.mock.calls.length

    // Druhé volání — čas 10ms (< 33ms) → pending + rAF
    advanceTime(10)
    act(() => {
      result.current.setCursor({ x: 50, y: 60 })
    })

    // Třetí volání — čas 15ms → aktualizuje pending, neplánuje druhý rAF
    advanceTime(15)
    act(() => {
      result.current.setCursor({ x: 99, y: 88 })
    })

    // Zatím by měl být emit jen z prvního volání
    expect(fakeAwareness.setLocalState.mock.calls.length).toBe(callsAfterFirst)

    // Po flush rAF — trailing update s posledním pending
    act(() => {
      flushRaf()
    })

    const lastCall = fakeAwareness.setLocalState.mock.lastCall![0] as PeerAwarenessState
    expect(lastCall.cursor).toEqual({ x: 99, y: 88 })
  })

  it('setCursor(null) bypasses throttle and emits immediately', () => {
    const { result } = renderHook(() => useAwarenessUpdater(), {
      wrapper: makeWrapper(fakeAwareness),
    })

    // Set a pending cursor update
    advanceTime(0)
    act(() => {
      result.current.setCursor({ x: 1, y: 1 }) // immediate (first)
    })
    advanceTime(5) // < 33ms
    act(() => {
      result.current.setCursor({ x: 50, y: 60 }) // pending
    })

    const callsBefore = fakeAwareness.setLocalState.mock.calls.length

    // setCursor(null) — must bypass throttle
    act(() => {
      result.current.setCursor(null)
    })

    expect(fakeAwareness.setLocalState.mock.calls.length).toBe(callsBefore + 1)
    const lastCall = fakeAwareness.setLocalState.mock.lastCall![0] as PeerAwarenessState
    expect(lastCall.cursor).toBeNull()
  })

  it('setSelection is immediate', () => {
    const { result } = renderHook(() => useAwarenessUpdater(), {
      wrapper: makeWrapper(fakeAwareness),
    })

    act(() => {
      result.current.setSelection(['obj-1', 'obj-2'])
    })

    expect(fakeAwareness.setLocalState).toHaveBeenCalledTimes(1)
    const call = fakeAwareness.setLocalState.mock.calls[0]![0] as PeerAwarenessState
    expect(call.selectedObjectIds).toEqual(['obj-1', 'obj-2'])
  })

  it('setSelection preserves other state fields (merge)', () => {
    fakeAwareness.getLocalState.mockReturnValue({
      user: { id: 'x', name: 'User x', color: 'hsl(0, 70%, 55%)' },
      selectedObjectIds: [],
      cursor: { x: 100, y: 200 },
    })

    const { result } = renderHook(() => useAwarenessUpdater(), {
      wrapper: makeWrapper(fakeAwareness),
    })

    act(() => {
      result.current.setSelection(['obj-3'])
    })

    const call = fakeAwareness.setLocalState.mock.calls[0]![0] as PeerAwarenessState
    // Cursor musí být zachován
    expect(call.cursor).toEqual({ x: 100, y: 200 })
    expect(call.selectedObjectIds).toEqual(['obj-3'])
  })

  it('setUserName is immediate', () => {
    const { result } = renderHook(() => useAwarenessUpdater(), {
      wrapper: makeWrapper(fakeAwareness),
    })

    act(() => {
      result.current.setUserName('Alice')
    })

    expect(fakeAwareness.setLocalState).toHaveBeenCalledTimes(1)
    const call = fakeAwareness.setLocalState.mock.calls[0]![0] as PeerAwarenessState
    expect(call.user.name).toBe('Alice')
  })

  it('setUserName preserves user.id and user.color (merge)', () => {
    fakeAwareness.getLocalState.mockReturnValue({
      user: { id: 'original-id', name: 'Old Name', color: 'hsl(100, 70%, 55%)' },
      selectedObjectIds: ['obj-1'],
      cursor: null,
    })

    const { result } = renderHook(() => useAwarenessUpdater(), {
      wrapper: makeWrapper(fakeAwareness),
    })

    act(() => {
      result.current.setUserName('New Name')
    })

    const call = fakeAwareness.setLocalState.mock.calls[0]![0] as PeerAwarenessState
    expect(call.user.id).toBe('original-id')
    expect(call.user.color).toBe('hsl(100, 70%, 55%)')
    expect(call.user.name).toBe('New Name')
    // selectedObjectIds musí být zachovány
    expect(call.selectedObjectIds).toEqual(['obj-1'])
  })
})
