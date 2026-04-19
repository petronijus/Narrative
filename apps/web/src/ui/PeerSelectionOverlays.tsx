/**
 * ui/PeerSelectionOverlays.tsx
 *
 * M8: Remote peer selection highlights.
 *
 * Pro každý remote peer vykreslujeme dashed SVG outline kolem objektů,
 * které daný peer má ve svém selection. Barva outlineu = peer.state.user.color.
 *
 * Strategie renderování:
 * - SVG absolutně pozicované přes canvas container (stejný přístup jako TransformHandles).
 * - Iterujeme remotePeers → jejich selectedObjectIds → sceneGraph.getBounds(id).
 * - Pro každý (peer, objectId) pár renderujeme polygon paths přes rotované rohy (corners).
 * - Dashed border (stroke-dasharray) odlišuje od lokální selection outlineu.
 *
 * Multi-peer overlap:
 * - Pokud více peerů má stejný objekt vybraný, každý peer vykreslí svůj outline.
 *   Outlines se vizuálně překryjí — různé barvy jsou stále rozlišitelné.
 * - Tooltip (title element) na každém pathu vypíše všechny peery se daný objekt.
 *
 * Pointer-events: none — nesmí blokovat canvas input.
 */

import type { PeerInfo } from '@narrative/shared'
import { useAwareness } from '../state/useAwareness.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import type { ObjectBounds } from '../renderer/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Převede ObjectBounds.corners na SVG polygon points string. */
function cornersToPoints(corners: ObjectBounds['corners']): string {
  return corners.map(({ x, y }) => `${x},${y}`).join(' ')
}

/**
 * Vykreslí jeden outline polygon pro daný peer + bounds.
 * strokeOffset: posune outline ven od objektu (pro stacking více peerů).
 */
function PeerObjectOutline({
  peer,
  bounds,
  strokeOffset,
  tooltipNames,
}: {
  peer: PeerInfo
  bounds: ObjectBounds
  strokeOffset: number
  tooltipNames: string
}) {
  const color = peer.state.user.color
  // Posun rohů ven o strokeOffset — přibližná approximace bez true offset path
  // Pro M8 je vizuální dojem dostatečný.
  const offsetCorners = bounds.corners.map(({ x, y }) => {
    // Vektor od středu ke každému rohu, normalizovaný + scaled o offset
    const dx = x - bounds.center.x
    const dy = y - bounds.center.y
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) return { x, y }
    return {
      x: x + (dx / len) * strokeOffset,
      y: y + (dy / len) * strokeOffset,
    }
  })

  return (
    <polygon
      points={cornersToPoints(offsetCorners)}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeDasharray="5 3"
      strokeLinejoin="round"
      opacity={0.85}
    >
      <title>{tooltipNames}</title>
    </polygon>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Renderuje SVG overlay s peer selection highlights.
 * Umístění: absolutně přes canvas container (position:absolute;inset:0;pointer-events:none).
 */
export function PeerSelectionOverlays() {
  const { remotePeers } = useAwareness()
  const canvasInstance = useCanvasInstance()

  // Pokud canvas není ready nebo žádní remote peeri, nerenderujeme nic
  if (canvasInstance === null || remotePeers.length === 0) return null

  const { sceneGraph } = canvasInstance

  // Sbíráme: objectId → peer[]  (pro tooltip multi-peer)
  const objectPeers = new Map<string, PeerInfo[]>()
  for (const peer of remotePeers) {
    for (const objId of peer.state.selectedObjectIds) {
      const existing = objectPeers.get(objId)
      if (existing !== undefined) {
        existing.push(peer)
      } else {
        objectPeers.set(objId, [peer])
      }
    }
  }

  // Sbíráme všechny (peer, objectId, bounds) triple pro renderování
  interface OutlineEntry {
    key: string
    peer: PeerInfo
    bounds: ObjectBounds
    strokeOffset: number
    tooltipNames: string
  }
  const outlines: OutlineEntry[] = []

  // Per-objectId: index peera (pro stacking offset)
  const objectPeerIndex = new Map<string, number>()

  for (const peer of remotePeers) {
    for (const objId of peer.state.selectedObjectIds) {
      const bounds = sceneGraph.getBounds(objId)
      if (bounds === null) continue

      const idx = objectPeerIndex.get(objId) ?? 0
      objectPeerIndex.set(objId, idx + 1)

      const peersOnObj = objectPeers.get(objId) ?? []
      const tooltipNames = peersOnObj.map((p) => p.state.user.name).join(', ')

      outlines.push({
        key: `${peer.clientId}-${objId}`,
        peer,
        bounds,
        strokeOffset: 2 + idx * 4, // každý další peer posune outline ven o 4px
        tooltipNames,
      })
    }
  }

  if (outlines.length === 0) return null

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ overflow: 'visible' }}
    >
      {outlines.map(({ key, peer, bounds, strokeOffset, tooltipNames }) => (
        <PeerObjectOutline
          key={key}
          peer={peer}
          bounds={bounds}
          strokeOffset={strokeOffset}
          tooltipNames={tooltipNames}
        />
      ))}
    </svg>
  )
}
