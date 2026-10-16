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
import { useRemotePeers } from '../state/useAwareness.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import type { OverlayHandle } from '../renderer/overlay/types.js'
import type { PeerInfo } from '@narrative/shared'

// ---------------------------------------------------------------------------
// SVG cursor markup
// ---------------------------------------------------------------------------

/**
 * Whitelist of safe CSS color forms. `color` reaches an innerHTML SVG
 * `fill="..."` attribute and is peer-controllable via awareness state, so
 * a value like `red" onload="alert(1)` would break out of the attribute.
 * We accept only hex (`#rgb`..`#rrggbbaa`), the rgb/hsl function forms with
 * a numeric/percent/comma/slash body, and bare keyword names (letters).
 * Anything else — quotes, angle brackets, `;` — is rejected.
 */
const SAFE_CSS_COLOR = /^#[0-9a-fA-F]{3,8}$|^(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\)$|^[a-zA-Z]+$/

function safeCssColor(raw: string): string {
  const c = raw.trim()
  return SAFE_CSS_COLOR.test(c) ? c : '#888888'
}

/**
 * Vytvoří SVG šipku (cursor pointer) ve specifikované barvě.
 * Viewbox: 14×18, origin v tip pointeru (top-left).
 */
function createCursorSvg(color: string): string {
  // SVG injected as innerHTML — fill/stroke go inside double-quoted attributes,
  // so `hsl(142, 70%, 55%)` and `rgba(...)` work as-is. Earlier code wrapped
  // these in encodeURIComponent which produced `hsl(142%2C%2070%25...)` —
  // an invalid CSS color, so the path painted with no fill/stroke and
  // the cursor was effectively invisible. `color` is validated by
  // safeCssColor() before it reaches the attribute to prevent breakout.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="22" viewBox="0 0 14 18" fill="none">
    <path d="M2 2L2 14L5.5 10.5L8 16L10 15L7.5 9.5L12 9.5L2 2Z"
      fill="${safeCssColor(color)}" stroke-linejoin="round"/>
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

  // Inner counter-scale layer. The artboard renders under
  // `transform: scale(zoom)` so this wrapper would otherwise grow /
  // shrink with the editor zoom; we apply `scale(1/zoom)` here so the
  // cursor stays at a constant viewport size. transform-origin top-
  // left keeps the pointer tip pinned to the (0,0) of the wrapper —
  // which is what OverlayCompositor's translate() targets.
  const scaler = document.createElement('div')
  scaler.dataset['role'] = 'scale'
  scaler.style.position = 'absolute'
  scaler.style.top = '0'
  scaler.style.left = '0'
  scaler.style.transformOrigin = 'top left'

  // SVG arrow (Figma-style mouse pointer at the cursor tip).
  // Black outline replaced with a soft drop-shadow that matches the badge.
  const svgContainer = document.createElement('div')
  svgContainer.dataset['role'] = 'pointer'
  svgContainer.style.display = 'inline-block'
  svgContainer.style.lineHeight = '0'
  svgContainer.style.filter = 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))'
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

  scaler.appendChild(svgContainer)
  scaler.appendChild(label)
  wrapper.appendChild(scaler)

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
  const remotePeers = useRemotePeers()
  const canvasInstance = useCanvasInstance()
  const { activeSlideId } = useActiveSlide()
  const { zoom } = useZoomLevel()

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

  // Counter-scale every cursor's inner layer so the pointer + name
  // badge stay a constant viewport size regardless of editor zoom.
  // The artboard wraps everything in `transform: scale(zoom)`, which
  // would otherwise shrink the cursor at zoom-out and inflate it at
  // zoom-in. Applied via the dedicated `[data-role="scale"]` div
  // because OverlayCompositor controls the wrapper's `transform`
  // (translate) every frame and would clobber a transform set here.
  // This effect must run AFTER the lifecycle effect above so newly
  // registered cursors are already in `overlaysRef` when we scan it.
  useEffect(() => {
    const inv = zoom > 0 ? 1 / zoom : 1
    overlaysRef.current.forEach((entry) => {
      const scaler = entry.element.querySelector('[data-role="scale"]') as HTMLDivElement | null
      if (scaler !== null) scaler.style.transform = `scale(${inv})`
    })
  }, [zoom, remotePeers, activeSlideId])

  return null
}
