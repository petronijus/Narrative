/**
 * ui/PeerCursors.test.tsx
 *
 * Testy pro PeerCursors komponentu.
 *
 * Strategie:
 * - Mock useAwareness — různé scénáře remote peerů s/bez cursoru.
 * - Mock useCanvasInstance — fake compositor + sceneGraph.
 * - Ověřujeme volání compositor.registerOverlay / handle.destroy.
 *
 * PeerCursors renderuje null — efekty jsou side-effecty na OverlayCompositor.
 * Testy ověřují, že overlay je registrován/odregistrován správně.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { PeerCursors } from './PeerCursors'
import type { PeerInfo } from '@narrative/shared'
import type { OverlayOpts } from '../renderer/overlay/types.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAwarenessData = {
  peers: [] as PeerInfo[],
  remotePeers: [] as PeerInfo[],
  localClientId: 1,
}

vi.mock('../state/useAwareness.js', () => ({
  useAwareness: () => mockAwarenessData,
  useRemotePeers: () => mockAwarenessData.remotePeers,
}))

// Fake OverlayHandle
function makeHandle() {
  return {
    update: vi.fn(),
    setInteractive: vi.fn(),
    destroy: vi.fn(),
  }
}

// Fake OverlayCompositor
const mockCompositor = {
  registerOverlay: vi.fn(() => makeHandle()),
}

// Fake SceneGraph s public root container
const fakeRootContainer = { toGlobal: vi.fn(() => ({ x: 0, y: 0 })) }
const mockSceneGraph = {
  root: fakeRootContainer,
  getBounds: vi.fn(() => null),
}

// Fake CanvasInstance
const mockCanvasInstance = {
  compositor: mockCompositor,
  sceneGraph: mockSceneGraph,
}

vi.mock('../renderer/CanvasInstanceContext.js', () => ({
  useCanvasInstance: () => mockCanvasInstance,
}))

vi.mock('../state/ActiveSlideContext.js', () => ({
  useActiveSlide: () => ({ activeSlideId: 'slide-test', setActiveSlideId: () => {} }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePeer(
  clientId: number,
  name: string,
  cursor: { x: number; y: number } | null,
  slideId = 'slide-test',
): PeerInfo {
  return {
    clientId,
    isLocal: false,
    state: {
      user: { id: `user-${clientId}`, name, color: 'hsl(142, 70%, 55%)' },
      selectedObjectIds: [],
      cursor: cursor === null ? null : { ...cursor, slideId },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockAwarenessData.remotePeers = []
  mockCompositor.registerOverlay.mockReset()
  mockCompositor.registerOverlay.mockImplementation(() => makeHandle())
})

describe('PeerCursors', () => {
  it('renders null — no DOM output', () => {
    const { container } = render(<PeerCursors />)
    expect(container.firstChild).toBeNull()
  })

  it('registers overlay for peer with cursor', () => {
    const peer = makePeer(2, 'Bob', { x: 100, y: 200 })
    mockAwarenessData.remotePeers = [peer]

    render(<PeerCursors />)

    expect(mockCompositor.registerOverlay).toHaveBeenCalledTimes(1)
    const callArgs = (
      mockCompositor.registerOverlay.mock.calls as unknown as OverlayOpts[][]
    )[0]?.[0] as OverlayOpts | undefined
    expect(callArgs?.worldOffset).toEqual({ x: 100, y: 200 })
  })

  it('registers overlays for 2 remote peers with cursors', () => {
    mockAwarenessData.remotePeers = [
      makePeer(2, 'Bob', { x: 50, y: 60 }),
      makePeer(3, 'Carol', { x: 150, y: 250 }),
    ]

    render(<PeerCursors />)

    expect(mockCompositor.registerOverlay).toHaveBeenCalledTimes(2)
  })

  it('does not register overlay for peer with cursor=null', () => {
    mockAwarenessData.remotePeers = [
      makePeer(2, 'Bob', null), // cursor je null
    ]

    render(<PeerCursors />)

    expect(mockCompositor.registerOverlay).toHaveBeenCalledTimes(0)
  })

  it('registers overlay only for peers with cursor (mixed null/non-null)', () => {
    mockAwarenessData.remotePeers = [
      makePeer(2, 'Bob', { x: 10, y: 20 }),
      makePeer(3, 'Carol', null), // bez cursoru
    ]

    render(<PeerCursors />)

    expect(mockCompositor.registerOverlay).toHaveBeenCalledTimes(1)
  })

  it('destroys overlay on unmount', () => {
    const handle = makeHandle()
    mockCompositor.registerOverlay.mockReturnValue(handle)

    const peer = makePeer(2, 'Bob', { x: 10, y: 20 })
    mockAwarenessData.remotePeers = [peer]

    const { unmount } = render(<PeerCursors />)

    expect(handle.destroy).not.toHaveBeenCalled()
    act(() => {
      unmount()
    })
    expect(handle.destroy).toHaveBeenCalledTimes(1)
  })

  it('registers overlay with correct worldOffset for cursor position', () => {
    const peer = makePeer(2, 'Bob', { x: 300, y: 450 })
    mockAwarenessData.remotePeers = [peer]

    render(<PeerCursors />)

    const call = (
      mockCompositor.registerOverlay.mock.calls as unknown as OverlayOpts[][]
    )[0]?.[0] as OverlayOpts | undefined
    expect(call?.worldOffset).toEqual({ x: 300, y: 450 })
    // interactive musí být false — nesmí blokovat canvas
    expect(call?.interactive).toBe(false)
  })
})
