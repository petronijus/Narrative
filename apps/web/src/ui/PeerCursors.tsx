/**
 * ui/PeerCursors.tsx
 *
 * M8: Remote peer cursors — colored SVG arrow + name label.
 *
 * Architektura:
 * - Pro každý remote peer s nenullovým cursor vytvoříme DOM element a
 *   zaregistrujeme ho přes OverlayCompositor.
 * - Cursor je pozicovaný v world coords (slide space).
 * - Lifecycle management přes Map<clientId, PeerOverlayEntry>.
 *
 * Omezení M8:
 * - OverlayCompositor vyžaduje Pixi Container jako anchor pro toGlobal().
 *   Cursor pozice jsou world coords — potřebujeme fake Pixi Container na dané
 *   world position. OverlayCompositor pozicuje přes worldOffset na root container.
 *   Implementace: používáme SceneGraph.root container + worldOffset = cursor position.
 *   Tím obcházíme nutnost vytvářet Container per cursor. Root je na (0,0), worldOffset
 *   je pak přímo cursor.x / cursor.y.
 *
 * Pointer-events: none — overlay nesmí blokovat canvas input.
 */

import { useEffect, useRef } from 'react'
import { useAwareness } from '../state/useAwareness.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import type { OverlayHandle } from '../renderer/overlay/types.js'
import type { PeerInfo } from '@narrative/shared'

// ---------------------------------------------------------------------------
// SVG cursor markup
// ---------------------------------------------------------------------------

/**
 * Vytvoří SVG šipku (cursor pointer) ve specifikované barvě.
 * Viewbox: 14×18, origin v tip pointeru (top-left).
 */
function createCursorSvg(color: string): string {
  // Encode color pro použití v SVG inline (HSL string je safe)
  const fill = encodeURIComponent(color)
  const stroke = 'rgba(0,0,0,0.5)'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="18" viewBox="0 0 14 18" fill="none">
    <path d="M2 2L2 14L5.5 10.5L8 16L10 15L7.5 9.5L12 9.5L2 2Z"
      fill="${fill}" stroke="${encodeURIComponent(stroke)}" stroke-width="1" stroke-linejoin="round"/>
  </svg>`
}

// ---------------------------------------------------------------------------
// DOM factory
// ---------------------------------------------------------------------------

interface PeerOverlayEntry {
  handle: OverlayHandle
  element: HTMLElement
}

function createCursorElement(peer: PeerInfo): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.style.position = 'absolute'
  wrapper.style.top = '0'
  wrapper.style.left = '0'
  wrapper.style.pointerEvents = 'none'
  wrapper.style.userSelect = 'none'
  // will-change pro GPU compositing — kurzory se mění každý frame
  wrapper.style.willChange = 'transform'

  // SVG arrow
  const svgContainer = document.createElement('div')
  svgContainer.style.display = 'inline-block'
  svgContainer.style.lineHeight = '0'
  svgContainer.innerHTML = createCursorSvg(peer.state.user.color)

  // Name label
  const label = document.createElement('div')
  label.style.position = 'absolute'
  label.style.top = '14px'
  label.style.left = '14px'
  label.style.backgroundColor = peer.state.user.color
  label.style.color = '#fff'
  label.style.fontSize = '11px'
  label.style.fontFamily = 'system-ui, sans-serif'
  label.style.fontWeight = '600'
  label.style.lineHeight = '1'
  label.style.padding = '2px 5px'
  label.style.borderRadius = '3px'
  label.style.whiteSpace = 'nowrap'
  label.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)'
  label.textContent = peer.state.user.name

  wrapper.appendChild(svgContainer)
  wrapper.appendChild(label)

  return wrapper
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renderuje DOM overlay kurzory pro všechny remote peery s aktivním cursorem.
 * Musí být rendered uvnitř canvas container (nebo jeho sourozence) s position:relative.
 *
 * Nevyžaduje žádné DOM output — efekty řídí OverlayCompositor.
 */
export function PeerCursors(): null {
  const { remotePeers } = useAwareness()
  const canvasInstance = useCanvasInstance()

  // Map<clientId, entry> — lifecycle management
  const overlaysRef = useRef<Map<number, PeerOverlayEntry>>(new Map())

  useEffect(() => {
    const compositor = canvasInstance?.compositor
    const sceneGraph = canvasInstance?.sceneGraph

    if (compositor === undefined || sceneGraph === undefined) {
      // Canvas ještě není ready — cleanup existujících overlays
      overlaysRef.current.forEach((entry) => entry.handle.destroy())
      overlaysRef.current.clear()
      return
    }

    // SceneGraph root container je na world (0,0). Worldoffset = cursor world coords.
    // Tím obcházíme nutnost per-cursor Pixi Container.
    const rootContainer = sceneGraph.rootContainer

    const currentOverlays = overlaysRef.current

    // Set aktivních clientIds s cursorem
    const activePeerIds = new Set<number>()

    for (const peer of remotePeers) {
      if (peer.state.cursor === null) continue
      activePeerIds.add(peer.clientId)

      const existing = currentOverlays.get(peer.clientId)

      if (existing !== undefined) {
        // Update: posun kurzoru
        existing.handle.update({
          worldOffset: { x: peer.state.cursor.x, y: peer.state.cursor.y },
        })
        // Update jméno pokud se změnilo
        const label = existing.element.querySelector('div') as HTMLDivElement | null
        if (label !== null && label.textContent !== peer.state.user.name) {
          label.textContent = peer.state.user.name
        }
      } else {
        // Nový peer — vytvoř element a zaregistruj overlay
        const element = createCursorElement(peer)
        const handle = compositor.registerOverlay({
          pixiContainer: rootContainer,
          domElement: element,
          worldOffset: { x: peer.state.cursor.x, y: peer.state.cursor.y },
          interactive: false,
        })
        currentOverlays.set(peer.clientId, { handle, element })
      }
    }

    // Cleanup peerů, kteří zmizeli nebo mají cursor=null
    for (const [clientId, entry] of currentOverlays) {
      if (!activePeerIds.has(clientId)) {
        entry.handle.destroy()
        currentOverlays.delete(clientId)
      }
    }
  }, [remotePeers, canvasInstance])

  // Cleanup při unmount
  useEffect(() => {
    return () => {
      overlaysRef.current.forEach((entry) => entry.handle.destroy())
      overlaysRef.current.clear()
    }
  }, [])

  return null
}
