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
 *   Cursor pozice jsou v artboard-local souřadnicích (0–1920, 0–1080).
 *   Implementace: používáme SceneGraph.rootContainer + worldOffset = cursor position.
 *   rootContainer.toGlobal({cx, cy}) převede artboard-local bod na globální CSS px —
 *   root má x = y = bleedPx (viz setSlideOrigin), tedy výsledek = bleedPx + cursor.
 *   overlayRoot má inset: -bleedPx, takže výsledný vizuální offset = cursor. ✓
 *   Tím obcházíme nutnost vytvářet Container per cursor.
 *
 * Pointer-events: none — overlay nesmí blokovat canvas input.
 */

import { useEffect, useRef } from 'react'
import { useAwareness } from '../state/useAwareness.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
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

  // SVG arrow (Figma-style mouse pointer at the cursor tip)
  const svgContainer = document.createElement('div')
  svgContainer.dataset['role'] = 'pointer'
  svgContainer.style.display = 'inline-block'
  svgContainer.style.lineHeight = '0'
  svgContainer.innerHTML = createCursorSvg(peer.state.user.color)

  // Name badge — sits just below + right of the pointer tip.
  const label = document.createElement('div')
  label.dataset['role'] = 'label'
  label.style.position = 'absolute'
  label.style.top = '16px'
  label.style.left = '12px'
  label.style.backgroundColor = peer.state.user.color
  label.style.color = '#fff'
  label.style.fontSize = '11px'
  label.style.fontFamily = 'system-ui, sans-serif'
  label.style.fontWeight = '600'
  label.style.lineHeight = '1'
  label.style.padding = '3px 6px'
  label.style.borderRadius = '4px'
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
  const { activeSlideId } = useActiveSlide()

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

    // rootContainer je v Pixi world na (bleedPx, bleedPx); toGlobal(cursor) vrátí
    // (bleedPx+cx, bleedPx+cy), overlayRoot je inset:-bleedPx → vizuálně (cx, cy). ✓
    const rootContainer = sceneGraph.rootContainer

    const currentOverlays = overlaysRef.current

    // Set aktivních clientIds s cursorem
    const activePeerIds = new Set<number>()

    for (const peer of remotePeers) {
      if (peer.state.cursor === null) continue
      // Only render cursors of peers viewing the same slide as us — otherwise
      // a peer editing slide 2 would have their cursor coords (in slide-2's
      // artboard space) painted on top of our slide-1 artboard.
      if (peer.state.cursor.slideId !== activeSlideId) continue
      activePeerIds.add(peer.clientId)

      const existing = currentOverlays.get(peer.clientId)

      if (existing !== undefined) {
        // Update: posun kurzoru. pixiContainer se také aktualizuje — po přechodu
        // na jiný slide mohl adoptSlideRoot() změnit aktivní root container.
        existing.handle.update({
          pixiContainer: rootContainer,
          worldOffset: { x: peer.state.cursor.x, y: peer.state.cursor.y },
        })
        // Update jméno pokud se změnilo. POZOR: dříve se používalo
        // querySelector('div'), které vracelo PRVNÍ div (= pointer s SVG)
        // a přepisovalo jeho textContent — tím se SVG šipka nahradila
        // textovým jménem a uživatel viděl jméno místo pointeru
        // ("Dev user" + badge "Dev user"). Cílíme na badge přes data-role.
        const label = existing.element.querySelector('[data-role="label"]') as HTMLDivElement | null
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
  }, [remotePeers, canvasInstance, activeSlideId])

  // Cleanup při unmount
  useEffect(() => {
    return () => {
      overlaysRef.current.forEach((entry) => entry.handle.destroy())
      overlaysRef.current.clear()
    }
  }, [])

  return null
}
