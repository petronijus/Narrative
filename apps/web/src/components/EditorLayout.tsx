/**
 * EditorLayout — 3-pane editor shell.
 *
 * M0: placeholder panes only, no PixiJS.
 * M1: Center pane mountuje PixiJS renderer přes <Canvas /> komponentu.
 * M2: Canvas čte objekty z Y.Doc přes useSlideObjects hook. SlideDocProvider
 *     poskytuje Y.Doc kontext celému editoru.
 *     Pointer events pro drag + vytváření objektů.
 *     Undo/redo keyboard shortcuts.
 *     Delete key pro removal.
 * M7: Multi-select (shift-click, marquee), transform handles, snapping,
 *     SceneGraph.hitTest (rotation-aware), keyboard duplicate + nudge.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Canvas } from '../renderer/Canvas'
import { Toolbar } from '../ui/Toolbar'
import { Inspector } from '../ui/Inspector'
import { TransformHandles } from '../ui/TransformHandles'
import { SnapGuides } from '../ui/SnapGuides'
import { PeerCursors } from '../ui/PeerCursors'
import { PeerSelectionOverlays } from '../ui/PeerSelectionOverlays'
import { useSelection } from '../state/SelectionContext'
import { useTool } from '../state/ToolContext'
import { useSlideObjects } from '../state/useSlideObjects'
import { useSlideDoc } from '../state/useSlideDoc'
import { useUndoManager } from '../state/useUndoManager'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext'
import { useAwarenessUpdater } from '../state/useAwarenessUpdater.js'
import {
  createObjectOfType,
  removeObject,
  duplicateObject,
  bulkUpdateObjects,
} from '@narrative/slide-model'
import type { SlideObjectType } from '@narrative/shared'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useDevMetrics, FpsOnlyDashboard } from '../observability/index.js'
import type { SnapGuide } from '../editor/snap.js'
import { computeSnap } from '../editor/snap.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Je fokus v textovém inputu? */
function isInputFocused(): boolean {
  const el = document.activeElement
  if (el === null) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable
}

/**
 * Převede CSS client souřadnice (z PointerEvent) na souřadnice relativní
 * k canvas containeru (= "world" souřadnice pro M7, bez zoom/pan).
 *
 * M8+: při zoom/pan zde přidat viewport transform.
 */
function clientToCanvasCoords(
  clientX: number,
  clientY: number,
  canvasRect: DOMRect,
): { x: number; y: number } {
  return {
    x: clientX - canvasRect.left,
    y: clientY - canvasRect.top,
  }
}

// ---------------------------------------------------------------------------
// Marquee rect
// ---------------------------------------------------------------------------

interface MarqueeState {
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean // shift was held → add to existing selection
}

function MarqueeOverlay({ marquee }: { marquee: MarqueeState }) {
  const x = Math.min(marquee.startX, marquee.currentX)
  const y = Math.min(marquee.startY, marquee.currentY)
  const w = Math.abs(marquee.currentX - marquee.startX)
  const h = Math.abs(marquee.currentY - marquee.startY)

  if (w < 2 && h < 2) return null

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute border border-blue-400 bg-blue-400/10"
      style={{ left: x, top: y, width: w, height: h }}
    />
  )
}

// ---------------------------------------------------------------------------
// EditorLayout
// ---------------------------------------------------------------------------

export interface EditorLayoutProps {
  onCanvasReady?: ((instance: CanvasInstance) => void) | undefined
}

export function EditorLayout({ onCanvasReady }: EditorLayoutProps = {}) {
  const { selectedIds, selectedId, selectOne, selectMany, toggle, clear } = useSelection()
  const { activeTool, setActiveTool } = useTool()
  const { objects, mutationCtx } = useSlideObjects()
  const { undo, redo } = useUndoManager()
  const canvasInstance = useCanvasInstance()

  // M8: Awareness updater — broadcast cursor + selection
  const { setCursor, setSelection } = useAwarenessUpdater()

  /** Ref na canvas container div — pro bounding rect výpočty */
  const canvasContainerRef = useRef<HTMLDivElement>(null)

  // ---------------------------------------------------------------------------
  // Drag state — ephemeral, neukládá se do Y.Doc
  // ---------------------------------------------------------------------------

  const dragRef = useRef<{
    active: boolean
    objectIds: string[]
    startX: number
    startY: number
    /** Počáteční pozice objektů v dragu */
    initialPositions: Array<{ id: string; x: number; y: number }>
  } | null>(null)

  /** Marquee drag state */
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const marqueeRef = useRef<MarqueeState | null>(null)

  /** Snap guides — aktivní během dragu/resize */
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])

  /** Canvas size pro SnapGuides vizualizaci */
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })

  // ---------------------------------------------------------------------------
  // M8: Selection broadcast → awareness
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setSelection([...selectedIds])
  }, [selectedIds, setSelection])

  // Canvas size observer
  useEffect(() => {
    const el = canvasContainerRef.current
    if (el === null) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      setCanvasSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---------------------------------------------------------------------------
  // Pointer event handlers
  // ---------------------------------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return

      const containerEl = canvasContainerRef.current
      if (containerEl === null) return

      const rect = containerEl.getBoundingClientRect()
      const { x, y } = clientToCanvasCoords(e.clientX, e.clientY, rect)

      if (activeTool !== 'select') {
        // Create tool — vytvoř objekt na pozici kliku
        createObjectOfType(mutationCtx, activeTool as SlideObjectType, { x, y })
        setActiveTool('select')
        return
      }

      // Hit test — preferuj SceneGraph.hitTest pokud dostupný
      let hitId: string | null = null
      if (canvasInstance !== null) {
        hitId = canvasInstance.sceneGraph.hitTest(x, y)
      } else {
        // Fallback naivní AABB (Canvas ještě není ready)
        for (let i = objects.length - 1; i >= 0; i--) {
          const obj = objects[i]
          if (obj === undefined) continue
          if (x >= obj.x && x <= obj.x + obj.width && y >= obj.y && y <= obj.y + obj.height) {
            hitId = obj.id
            break
          }
        }
      }

      if (hitId === null) {
        // Klik na prázdnou plochu
        if (!e.shiftKey) {
          clear()
        }
        // Start marquee drag
        const ms: MarqueeState = {
          startX: x,
          startY: y,
          currentX: x,
          currentY: y,
          additive: e.shiftKey,
        }
        marqueeRef.current = ms
        setMarquee(ms)
        ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
        return
      }

      if (e.shiftKey) {
        // Shift-click: toggle selection, nestart drag
        toggle(hitId)
        return
      }

      // Normální klik na objekt: nahraď selection + start drag
      if (!selectedIds.has(hitId)) {
        selectOne(hitId)
      }

      // Sberi selected IDs (pokud kliknutý objekt byl už selected, drag pohne celý group)
      const dragIds = selectedIds.has(hitId) ? [...selectedIds] : [hitId]

      const initialPositions = dragIds.flatMap((id) => {
        const obj = objects.find((o) => o.id === id)
        if (obj === undefined) return []
        return [{ id, x: obj.x, y: obj.y }]
      })

      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      dragRef.current = {
        active: true,
        objectIds: dragIds,
        startX: e.clientX,
        startY: e.clientY,
        initialPositions,
      }
    },
    [
      activeTool,
      objects,
      mutationCtx,
      setActiveTool,
      selectedIds,
      selectOne,
      toggle,
      clear,
      canvasInstance,
    ],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // M8: Broadcast cursor position (throttled 30Hz na state-sync straně)
      // Získáme canvas-relative coords jednou a reuse pro marquee i cursor broadcast.
      const containerEl = canvasContainerRef.current
      const canvasCoords =
        containerEl !== null
          ? clientToCanvasCoords(e.clientX, e.clientY, containerEl.getBoundingClientRect())
          : null

      if (canvasCoords !== null) {
        setCursor({ x: canvasCoords.x, y: canvasCoords.y })
      }

      // Marquee update
      const mq = marqueeRef.current
      if (mq !== null) {
        if (canvasCoords !== null) {
          const updated: MarqueeState = {
            ...mq,
            currentX: canvasCoords.x,
            currentY: canvasCoords.y,
          }
          marqueeRef.current = updated
          setMarquee({ ...updated })
        }
        return
      }

      // Object drag
      const drag = dragRef.current
      if (drag === null || !drag.active) return

      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY

      // Propose new positions
      const proposed = drag.initialPositions.map((init) => ({
        id: init.id,
        x: init.x + dx,
        y: init.y + dy,
      }))

      // Snap (použijeme bounds prvního objektu pro jednoduchost u group)
      const firstProposed = proposed[0]
      if (firstProposed !== undefined) {
        const firstObj = objects.find((o) => o.id === firstProposed.id)
        if (firstObj !== undefined) {
          const otherBounds = objects
            .filter((o) => !drag.objectIds.includes(o.id))
            .map((o) => ({ id: o.id, x: o.x, y: o.y, width: o.width, height: o.height }))

          const snapResult = computeSnap(
            {
              x: firstProposed.x,
              y: firstProposed.y,
              width: firstObj.width,
              height: firstObj.height,
            },
            otherBounds,
          )

          setSnapGuides(snapResult.guides)

          const updates = proposed.map((p) => ({
            id: p.id,
            patch: { x: p.x + snapResult.dx, y: p.y + snapResult.dy },
          }))
          bulkUpdateObjects(mutationCtx, updates)
          return
        }
      }

      bulkUpdateObjects(
        mutationCtx,
        proposed.map((p) => ({ id: p.id, patch: { x: p.x, y: p.y } })),
      )
    },
    [mutationCtx, objects, setCursor],
  )

  const handlePointerUp = useCallback(
    (_e: React.PointerEvent<HTMLDivElement>) => {
      // Finalize marquee
      const mq = marqueeRef.current
      if (mq !== null) {
        marqueeRef.current = null
        setMarquee(null)

        const rectX = Math.min(mq.startX, mq.currentX)
        const rectY = Math.min(mq.startY, mq.currentY)
        const rectW = Math.abs(mq.currentX - mq.startX)
        const rectH = Math.abs(mq.currentY - mq.startY)

        if (rectW > 2 || rectH > 2) {
          // Najdi objekty jejichž AABB world bounds se překrývají s marquee rect
          const hitIds: string[] = []

          if (canvasInstance !== null) {
            for (const obj of objects) {
              const bounds = canvasInstance.sceneGraph.getBounds(obj.id)
              if (bounds === null) continue
              const { x: bx, y: by, width: bw, height: bh } = bounds.world
              // Overlap test
              if (bx < rectX + rectW && bx + bw > rectX && by < rectY + rectH && by + bh > rectY) {
                hitIds.push(obj.id)
              }
            }
          } else {
            // Fallback naivní AABB
            for (const obj of objects) {
              if (
                obj.x < rectX + rectW &&
                obj.x + obj.width > rectX &&
                obj.y < rectY + rectH &&
                obj.y + obj.height > rectY
              ) {
                hitIds.push(obj.id)
              }
            }
          }

          if (hitIds.length > 0) {
            if (mq.additive) {
              selectMany([...selectedIds, ...hitIds])
            } else {
              selectMany(hitIds)
            }
          }
        }
      }

      dragRef.current = null
      setSnapGuides([])
    },
    [objects, canvasInstance, selectedIds, selectMany],
  )

  // M8: Cursor leave — broadcast null (peer offline z canvasu)
  const handlePointerLeave = useCallback(() => {
    setCursor(null)
  }, [setCursor])

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Undo: Ctrl/Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (isInputFocused()) return
        e.preventDefault()
        undo()
        return
      }

      // Redo: Ctrl/Cmd+Shift+Z nebo Ctrl+Y
      if (
        ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) ||
        (e.ctrlKey && e.key === 'y')
      ) {
        if (isInputFocused()) return
        e.preventDefault()
        redo()
        return
      }

      // Delete/Backspace → odstraň vybrané objekty
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isInputFocused()) return
        if (selectedIds.size > 0) {
          for (const id of selectedIds) {
            removeObject(mutationCtx, id)
          }
          clear()
        }
        return
      }

      // Ctrl/Cmd+D — duplicate selected
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        if (isInputFocused()) return
        e.preventDefault()
        if (selectedIds.size > 0) {
          const newIds: string[] = []
          for (const id of selectedIds) {
            const dup = duplicateObject(mutationCtx, id, { x: 20, y: 20 })
            if (dup !== null) {
              newIds.push(dup.id)
            }
          }
          if (newIds.length > 0) {
            selectMany(newIds)
          }
        }
        return
      }

      // Arrow keys — nudge selected
      if (
        selectedIds.size > 0 &&
        (e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown')
      ) {
        if (isInputFocused()) return
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        let dx = 0
        let dy = 0
        if (e.key === 'ArrowLeft') dx = -step
        if (e.key === 'ArrowRight') dx = step
        if (e.key === 'ArrowUp') dy = -step
        if (e.key === 'ArrowDown') dy = step

        const updates = [...selectedIds].flatMap((id) => {
          const obj = objects.find((o) => o.id === id)
          if (obj === undefined) return []
          return [{ id, patch: { x: obj.x + dx, y: obj.y + dy } }]
        })
        bulkUpdateObjects(mutationCtx, updates)
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedIds, selectedId, mutationCtx, undo, redo, clear, selectMany, objects])

  // ---------------------------------------------------------------------------
  // Snap guide callback z TransformHandles
  // ---------------------------------------------------------------------------

  const handleSnapGuides = useCallback((guides: SnapGuide[]) => {
    setSnapGuides(guides)
  }, [])

  // ---------------------------------------------------------------------------
  // Other bounds pro snap
  // ---------------------------------------------------------------------------

  const otherBounds = objects
    .filter((o) => !selectedIds.has(o.id))
    .map((o) => ({ id: o.id, x: o.x, y: o.y, width: o.width, height: o.height }))

  // Cursor style
  const canvasCursor = activeTool === 'select' ? 'default' : 'crosshair'

  return (
    <div className="flex h-full w-full overflow-hidden bg-gray-950">
      {/* Left sidebar */}
      <aside className="flex w-48 flex-shrink-0 flex-col border-r border-gray-800 bg-gray-900">
        <div className="border-b border-gray-800 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Slides
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-gray-600">No slides yet</p>
        </div>
      </aside>

      {/* Center: canvas area */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <Toolbar />

        <div
          ref={canvasContainerRef}
          className="relative flex-1 overflow-hidden bg-gray-950"
          style={{ cursor: canvasCursor }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
        >
          <Canvas onReady={onCanvasReady} />

          {/* Snap guide lines — viditelné jen během dragu */}
          <SnapGuides
            guides={snapGuides}
            canvasWidth={canvasSize.width}
            canvasHeight={canvasSize.height}
          />

          {/* Marquee selection overlay */}
          {marquee !== null && <MarqueeOverlay marquee={marquee} />}

          {/* M8: Peer selection highlights — dashed outlines ve barvách peerů */}
          <PeerSelectionOverlays />

          {/* Transform handles + outline — pokud je selection a canvas ready */}
          {selectedIds.size > 0 && canvasInstance !== null && (
            <TransformHandles
              objectIds={[...selectedIds]}
              sceneGraph={canvasInstance.sceneGraph}
              mutationCtx={mutationCtx}
              onSnapGuides={handleSnapGuides}
              otherBounds={otherBounds}
            />
          )}

          {/* M8: Remote peer cursors — DOM overlays přes OverlayCompositor */}
          <PeerCursors />
        </div>
      </main>

      {/* Right sidebar: inspector */}
      <aside className="flex w-64 flex-shrink-0 flex-col border-l border-gray-800 bg-gray-900">
        <div className="border-b border-gray-800 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Inspector
          </span>
        </div>
        <Inspector />
      </aside>

      {import.meta.env.DEV && <DevMetricsOverlay />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DevMetricsOverlay — DEV-only
// ---------------------------------------------------------------------------

function DevMetricsOverlay() {
  const { visible, fpsTracker } = useDevMetrics()
  const { wsStatus } = useSlideDoc()
  if (!visible || fpsTracker === null) return null
  return <FpsOnlyDashboard fpsTracker={fpsTracker} wsStatus={wsStatus} />
}
