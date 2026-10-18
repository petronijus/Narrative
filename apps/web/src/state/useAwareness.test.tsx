/**
 * state/useAwareness.test.tsx
 *
 * Testy pro useAwareness() hook.
 *
 * Strategy:
 *   - Mock SlideDocContext s fake Awareness object (EventEmitter-like)
 *   - Ověřit že hook správně transformuje awareness states na PeerInfo[]
 *   - Ověřit že change event triggeruje re-render
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import React from 'react'
import { SlideDocContext } from './slideDocContext.js'
import { createMockSlideDocValue } from './slideDocContext.js'
import { useAwareness, usePresencePeers, useRemotePeers } from './useAwareness.js'
import type { Awareness } from 'y-protocols/awareness'
import type { PeerAwarenessState } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Fake Awareness
// ---------------------------------------------------------------------------

type ChangeHandler = () => void

function makeFakeAwareness(initialStates: Map<number, PeerAwarenessState>, localClientId: number) {
  const states = new Map<number, PeerAwarenessState>(initialStates)
  const listeners = new Set<ChangeHandler>()

  const awareness = {
    clientID: localClientId,
    getStates: () => states,
    on: (_event: string, handler: ChangeHandler) => {
      listeners.add(handler)
    },
    off: (_event: string, handler: ChangeHandler) => {
      listeners.delete(handler)
    },
    setLocalState: vi.fn(),
    getLocalState: vi.fn(() => null),
    // Test helper: emit change
    _emit: () => {
      for (const fn of listeners) fn()
    },
    _setStates: (newStates: Map<number, PeerAwarenessState>) => {
      // Mutate in-place aby reference fungovala v getStates
      states.clear()
      for (const [k, v] of newStates) states.set(k, v)
    },
  }

  return awareness
}

// ---------------------------------------------------------------------------
// Test component
// ---------------------------------------------------------------------------

function AwarenessReadout() {
  const { peers, remotePeers, localClientId } = useAwareness()
  return (
    <div>
      <div data-testid="peer-count">{peers.length}</div>
      <div data-testid="remote-count">{remotePeers.length}</div>
      <div data-testid="local-client-id">{localClientId}</div>
      <div data-testid="peer-ids">{peers.map((p) => p.clientId).join(',')}</div>
      <div data-testid="local-flags">{peers.map((p) => (p.isLocal ? '1' : '0')).join(',')}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(id: string): PeerAwarenessState {
  return {
    user: { id, name: `User ${id.slice(0, 4)}`, color: 'hsl(42, 70%, 55%)' },
    selectedObjectIds: [],
    cursor: null,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAwareness', () => {
  let fakeAwareness: ReturnType<typeof makeFakeAwareness>

  beforeEach(() => {
    fakeAwareness = makeFakeAwareness(new Map(), 1)
  })

  function renderWithContext() {
    const ctxValue = createMockSlideDocValue({
      awareness: fakeAwareness as unknown as Awareness,
    })
    return render(
      <SlideDocContext value={ctxValue}>
        <AwarenessReadout />
      </SlideDocContext>,
    )
  }

  it('returns empty state when no peers', () => {
    renderWithContext()
    expect(screen.getByTestId('peer-count').textContent).toBe('0')
    expect(screen.getByTestId('remote-count').textContent).toBe('0')
  })

  it('returns correct localClientId', () => {
    renderWithContext()
    expect(screen.getByTestId('local-client-id').textContent).toBe('1')
  })

  it('includes local peer with isLocal=true', () => {
    fakeAwareness = makeFakeAwareness(new Map([[1, makeState('local-id')]]), 1)
    renderWithContext()
    expect(screen.getByTestId('peer-count').textContent).toBe('1')
    expect(screen.getByTestId('local-flags').textContent).toBe('1')
    expect(screen.getByTestId('remote-count').textContent).toBe('0')
  })

  it('marks remote peers with isLocal=false', () => {
    fakeAwareness = makeFakeAwareness(
      new Map([
        [1, makeState('local-id')],
        [2, makeState('remote-id')],
      ]),
      1,
    )
    renderWithContext()
    expect(screen.getByTestId('peer-count').textContent).toBe('2')
    expect(screen.getByTestId('remote-count').textContent).toBe('1')
    // Local=1 je první nebo druhý — oba musí být přítomni
    const peerIds = screen.getByTestId('peer-ids').textContent!.split(',').map(Number)
    expect(peerIds).toContain(1)
    expect(peerIds).toContain(2)
  })

  it('re-renders when awareness change event fires', () => {
    fakeAwareness = makeFakeAwareness(new Map([[1, makeState('peer-a')]]), 1)
    renderWithContext()

    expect(screen.getByTestId('peer-count').textContent).toBe('1')

    // Přidáme druhého peera a emitujeme change
    act(() => {
      fakeAwareness._setStates(
        new Map([
          [1, makeState('peer-a')],
          [2, makeState('peer-b')],
        ]),
      )
      fakeAwareness._emit()
    })

    expect(screen.getByTestId('peer-count').textContent).toBe('2')
  })

  it('removes peer when state cleared and change emitted', () => {
    fakeAwareness = makeFakeAwareness(
      new Map([
        [1, makeState('peer-a')],
        [2, makeState('peer-b')],
      ]),
      1,
    )
    renderWithContext()

    expect(screen.getByTestId('peer-count').textContent).toBe('2')

    act(() => {
      fakeAwareness._setStates(new Map([[1, makeState('peer-a')]]))
      fakeAwareness._emit()
    })

    expect(screen.getByTestId('peer-count').textContent).toBe('1')
  })

  it('skips peers with invalid state', () => {
    // Jeden validní, jeden s neplatným state (chybí user field)
    const badState = { selectedObjectIds: [], cursor: null } as unknown as PeerAwarenessState
    fakeAwareness = makeFakeAwareness(
      new Map([
        [1, makeState('peer-a')],
        [2, badState],
      ]),
      1,
    )
    renderWithContext()
    // Pouze validní peer se zobrazí
    expect(screen.getByTestId('peer-count').textContent).toBe('1')
  })
})

describe('useRemotePeers', () => {
  let renders = 0

  function RemoteReadout() {
    const remote = useRemotePeers()
    renders++
    return <div data-testid="remote-ids">{remote.map((p) => p.clientId).join(',')}</div>
  }

  function setup(states: Map<number, PeerAwarenessState>) {
    const awareness = makeFakeAwareness(states, 1)
    renders = 0
    render(
      <SlideDocContext
        value={createMockSlideDocValue({ awareness: awareness as unknown as Awareness })}
      >
        <RemoteReadout />
      </SlideDocContext>,
    )
    return awareness
  }

  it('lists the other peers only', () => {
    setup(
      new Map([
        [1, makeState('local-id')],
        [2, makeState('remote-id')],
      ]),
    )
    expect(screen.getByTestId('remote-ids').textContent).toBe('2')
  })

  it("does not render when only this client's own state changes", () => {
    const remote = makeState('remote-id')
    const awareness = setup(
      new Map([
        [1, makeState('local-id')],
        [2, remote],
      ]),
    )
    const before = renders
    act(() => {
      // The local cursor moves: a new state object for client 1, the same one for client 2.
      awareness._setStates(
        new Map([
          [1, { ...makeState('local-id'), cursor: { x: 5, y: 6, slideId: 's' } }],
          [2, remote],
        ]),
      )
      awareness._emit()
    })
    expect(renders).toBe(before)
  })

  it("renders when a remote peer's state is replaced, joins or leaves", () => {
    const awareness = setup(new Map([[1, makeState('local-id')]]))
    const before = renders
    act(() => {
      awareness._setStates(
        new Map([
          [1, makeState('local-id')],
          [2, makeState('remote-id')],
        ]),
      )
      awareness._emit()
    })
    expect(screen.getByTestId('remote-ids').textContent).toBe('2')
    expect(renders).toBeGreaterThan(before)

    act(() => {
      awareness._setStates(new Map([[1, makeState('local-id')]]))
      awareness._emit()
    })
    expect(screen.getByTestId('remote-ids').textContent).toBe('')
  })

  it('does not render when a remote state is re-sent unchanged (a new object, the same content)', () => {
    const awareness = setup(
      new Map([
        [1, makeState('local-id')],
        [2, makeState('remote-id')],
      ]),
    )
    const before = renders
    act(() => {
      // The sync server re-broadcasts states it already sent: y-protocols
      // stores each as a freshly parsed object.
      awareness._setStates(
        new Map([
          [1, { ...makeState('local-id'), cursor: { x: 1, y: 2, slideId: 's' } }],
          [2, makeState('remote-id')],
        ]),
      )
      awareness._emit()
    })
    expect(renders).toBe(before)
    act(() => {
      awareness._setStates(
        new Map([
          [1, makeState('local-id')],
          [2, { ...makeState('remote-id'), selectedObjectIds: ['x'] }],
        ]),
      )
      awareness._emit()
    })
    expect(renders).toBeGreaterThan(before)
  })
})

describe('usePresencePeers', () => {
  let renders = 0

  function PresenceReadout() {
    const { peers } = usePresencePeers()
    renders++
    return <div data-testid="presence">{peers.map((p) => p.state.user.name).join(',')}</div>
  }

  function setup(states: Map<number, PeerAwarenessState>) {
    const awareness = makeFakeAwareness(states, 1)
    renders = 0
    render(
      <SlideDocContext
        value={createMockSlideDocValue({ awareness: awareness as unknown as Awareness })}
      >
        <PresenceReadout />
      </SlideDocContext>,
    )
    return awareness
  }

  it('lists every peer, and renders only when an identity changes', () => {
    const awareness = setup(
      new Map([
        [1, makeState('local-id')],
        [2, makeState('remote-id')],
      ]),
    )
    expect(screen.getByTestId('presence').textContent?.split(',')).toHaveLength(2)
    const before = renders
    act(() => {
      // Cursors and selections move, states are re-sent: no identity changed.
      awareness._setStates(
        new Map([
          [1, { ...makeState('local-id'), cursor: { x: 5, y: 6, slideId: 's' } }],
          [2, { ...makeState('remote-id'), selectedObjectIds: ['a'] }],
        ]),
      )
      awareness._emit()
    })
    expect(renders).toBe(before)
    act(() => {
      awareness._setStates(new Map([[1, makeState('local-id')]]))
      awareness._emit()
    })
    expect(renders).toBeGreaterThan(before)
    expect(screen.getByTestId('presence').textContent?.split(',')).toHaveLength(1)
  })
})
