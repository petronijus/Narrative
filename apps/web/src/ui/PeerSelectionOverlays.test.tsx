/**
 * ui/PeerSelectionOverlays.test.tsx
 *
 * Testy pro PeerSelectionOverlays komponentu.
 *
 * Strategie:
 * - Mock useAwareness + useCanvasInstance.
 * - Ověřujeme, že SVG polygon outlines jsou renderovány pro každý (peer × object).
 * - Multi-peer overlap: více peerů na stejném objektu → více polygonů.
 * - Objekt bez bounds → není polygon.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { PeerSelectionOverlays } from './PeerSelectionOverlays'
import type { PeerInfo } from '@narrative/shared'
import type { ObjectBounds } from '../renderer/types.js'

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

const mockGetBounds = vi.fn<(id: string) => ObjectBounds | null>()

const mockCanvasInstance = {
  compositor: {},
  sceneGraph: {
    getBounds: mockGetBounds,
    onTextLayout: () => () => {},
  },
}

vi.mock('../renderer/CanvasInstanceContext.js', () => ({
  useCanvasInstance: () => mockCanvasInstance,
}))

vi.mock('../state/ActiveSlideContext.js', () => ({
  useActiveSlide: () => ({ activeSlideId: 'slide-1', setActiveSlideId: () => {} }),
}))

vi.mock('../state/useDeckStore.js', () => ({
  useActiveSlideObjectFieldsById: () => [],
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePeer(clientId: number, name: string, selectedObjectIds: string[]): PeerInfo {
  return {
    clientId,
    isLocal: false,
    state: {
      user: { id: `user-${clientId}`, name, color: `hsl(${clientId * 60}, 70%, 55%)` },
      selectedObjectIds,
      cursor: null,
    },
  }
}

function makeBounds(x: number, y: number, w: number, h: number): ObjectBounds {
  return {
    world: { x, y, width: w, height: h },
    corners: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    center: { x: x + w / 2, y: y + h / 2 },
    rotation: 0,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockAwarenessData.remotePeers = []
  mockGetBounds.mockReset()
})

describe('PeerSelectionOverlays', () => {
  it('renders nothing when no remote peers', () => {
    const { container } = render(<PeerSelectionOverlays />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when remote peer has empty selection', () => {
    mockAwarenessData.remotePeers = [makePeer(2, 'Bob', [])]

    const { container } = render(<PeerSelectionOverlays />)
    expect(container.firstChild).toBeNull()
  })

  it('renders SVG polygon for each selected object of a peer', () => {
    mockAwarenessData.remotePeers = [makePeer(2, 'Bob', ['obj-1', 'obj-2'])]
    mockGetBounds.mockImplementation((id) =>
      id === 'obj-1' ? makeBounds(10, 20, 100, 80) : makeBounds(200, 50, 60, 40),
    )

    const { container } = render(<PeerSelectionOverlays />)
    const polygons = container.querySelectorAll('polygon')
    expect(polygons).toHaveLength(2)
  })

  it('renders outline per peer per object — multi-peer overlap', () => {
    // 2 peers mají oba stejný objekt → 2 polygony
    mockAwarenessData.remotePeers = [makePeer(2, 'Bob', ['obj-1']), makePeer(3, 'Carol', ['obj-1'])]
    mockGetBounds.mockReturnValue(makeBounds(0, 0, 100, 100))

    const { container } = render(<PeerSelectionOverlays />)
    const polygons = container.querySelectorAll('polygon')
    expect(polygons).toHaveLength(2)
  })

  it('skips object if getBounds returns null', () => {
    mockAwarenessData.remotePeers = [makePeer(2, 'Bob', ['obj-missing', 'obj-ok'])]
    mockGetBounds.mockImplementation((id) => (id === 'obj-ok' ? makeBounds(0, 0, 50, 50) : null))

    const { container } = render(<PeerSelectionOverlays />)
    const polygons = container.querySelectorAll('polygon')
    // Jen obj-ok má bounds
    expect(polygons).toHaveLength(1)
  })

  it('polygon stroke color matches peer color', () => {
    const peer = makePeer(2, 'Bob', ['obj-1'])
    mockAwarenessData.remotePeers = [peer]
    mockGetBounds.mockReturnValue(makeBounds(0, 0, 100, 100))

    const { container } = render(<PeerSelectionOverlays />)
    // querySelector('polygon') funguje v jsdom pro SVG namespace
    // React renderuje SVG atributy jako namespace-aware — getAttribute funguje
    const polygons = container.querySelectorAll('polygon')
    expect(polygons.length).toBeGreaterThan(0)
    const polygon = polygons[0]!
    // stroke je SVG presentation attribute — getAttribute vrací hodnotu
    const strokeAttr = polygon.getAttribute('stroke')
    expect(strokeAttr).toBe(peer.state.user.color)
  })

  it('polygon has dashed stroke to differentiate from local selection', () => {
    mockAwarenessData.remotePeers = [makePeer(2, 'Bob', ['obj-1'])]
    mockGetBounds.mockReturnValue(makeBounds(0, 0, 100, 100))

    const { container } = render(<PeerSelectionOverlays />)
    const polygons = container.querySelectorAll('polygon')
    expect(polygons.length).toBeGreaterThan(0)
    const polygon = polygons[0]!
    // stroke-dasharray je SVG atribut — React camelCase → DOM kebab-case
    const dashArray = polygon.getAttribute('stroke-dasharray')
    expect(dashArray).toBeTruthy()
  })

  it('tooltip (title) contains peer names for multi-peer overlap', () => {
    mockAwarenessData.remotePeers = [makePeer(2, 'Bob', ['obj-1']), makePeer(3, 'Carol', ['obj-1'])]
    mockGetBounds.mockReturnValue(makeBounds(0, 0, 100, 100))

    const { container } = render(<PeerSelectionOverlays />)
    const titles = Array.from(container.querySelectorAll('title')).map((t) => t.textContent)
    // Každý polygon má tooltip s oběma jmény
    expect(titles.every((t) => t?.includes('Bob') && t?.includes('Carol'))).toBe(true)
  })

  it('renders SVG when canvasInstance is available and bounds exist', () => {
    // Ověřuje, že s platným canvasInstance a bounds se polygon renderuje.
    // Early return na null canvasInstance nelze testovat přes re-mock v Vitest
    // bez vi.resetModules() — proto ověřujeme happy path.
    mockAwarenessData.remotePeers = [makePeer(2, 'Bob', ['obj-1'])]
    mockGetBounds.mockReturnValue(makeBounds(10, 20, 80, 60))

    const { container } = render(<PeerSelectionOverlays />)
    const polygons = container.querySelectorAll('polygon')
    expect(polygons.length).toBe(1)
  })
})
