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
 * M7: Inspector pane bude mít transform controls.
 */

import { useCallback, useEffect, useRef } from 'react'
import { Canvas } from '../renderer/Canvas'
import { Toolbar } from '../ui/Toolbar'
import { Inspector } from '../ui/Inspector'
import { useSelection } from '../state/SelectionContext'
import { useTool } from '../state/ToolContext'
import { useSlideObjects } from '../state/useSlideObjects'
import { useSlideDoc } from '../state/useSlideDoc'
import { useUndoManager } from '../state/useUndoManager'
import { createObjectOfType, removeObject, updateObject } from '@narrative/slide-model'
import type { SlideObjectType } from '@narrative/shared'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useDevMetrics, FpsOnlyDashboard } from '../observability/index.js'

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
 * k canvas containeru (= "world" souřadnice pro M2, bez zoom/pan).
 *
 * TODO (po merge s renderer agentem): Pokud renderer exponuje SceneGraph
 * s hitTest + worldTransform, nahradit naivní výpočet přes SceneGraph.hitTest.
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

/**
 * Naivní hit test pro M2 — zkontroluje, zda bod leží v bounding boxu objektu.
 * Ignoruje rotation pro jednoduchost (přesný hit test přijde v M7).
 *
 * TODO (po merge s renderer agentem): nahradit voláním SceneGraph.hitTest().
 */
function naiveHitTest(
  x: number,
  y: number,
  objects: Array<{ id: string; x: number; y: number; width: number; height: number }>,
): string | null {
  // Iterujeme pozpátku → objekty "nahoře" (vyšší index) mají prioritu
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i]
    if (obj === undefined) continue
    if (x >= obj.x && x <= obj.x + obj.width && y >= obj.y && y <= obj.y + obj.height) {
      return obj.id
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// EditorLayout
// ---------------------------------------------------------------------------

export interface EditorLayoutProps {
  onCanvasReady?: ((instance: CanvasInstance) => void) | undefined
}

export function EditorLayout({ onCanvasReady }: EditorLayoutProps = {}) {
  const { selectedId, setSelectedId, clearSelection } = useSelection()
  const { activeTool, setActiveTool } = useTool()
  const { objects, mutationCtx } = useSlideObjects()
  const { undo, redo } = useUndoManager()

  /** Ref na canvas container div — pro bounding rect výpočty */
  const canvasContainerRef = useRef<HTMLDivElement>(null)

  /** Drag state — ephemeral, neukládá se do Y.Doc */
  const dragRef = useRef<{
    active: boolean
    objectId: string
    startX: number
    startY: number
    objStartX: number
    objStartY: number
  } | null>(null)

  // ---------------------------------------------------------------------------
  // Pointer event handlers
  // ---------------------------------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Jen levé tlačítko
      if (e.button !== 0) return

      const containerEl = canvasContainerRef.current
      if (containerEl === null) return

      const rect = containerEl.getBoundingClientRect()
      const { x, y } = clientToCanvasCoords(e.clientX, e.clientY, rect)

      if (activeTool === 'select') {
        // Hit test → select nebo deselect
        const hitId = naiveHitTest(x, y, objects)
        if (hitId === null) {
          clearSelection()
          return
        }

        setSelectedId(hitId)

        // Začni drag
        const obj = objects.find((o) => o.id === hitId)
        if (obj !== undefined) {
          ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
          dragRef.current = {
            active: true,
            objectId: hitId,
            startX: e.clientX,
            startY: e.clientY,
            objStartX: obj.x,
            objStartY: obj.y,
          }
        }
      } else {
        // Create tool — vytvoř objekt na pozici kliku
        createObjectOfType(mutationCtx, activeTool as SlideObjectType, { x, y })
        // Vrať se na select po vytvoření
        setActiveTool('select')
      }
    },
    [activeTool, objects, mutationCtx, setActiveTool, setSelectedId, clearSelection],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag === null || !drag.active) return

      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY

      updateObject(mutationCtx, drag.objectId, {
        x: drag.objStartX + dx,
        y: drag.objStartY + dy,
      })
    },
    [mutationCtx],
  )

  const handlePointerUp = useCallback((_e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
  }, [])

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts — delete + undo/redo
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

      // Delete/Backspace → remove selected object
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isInputFocused()) return
        if (selectedId !== null) {
          removeObject(mutationCtx, selectedId)
          clearSelection()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedId, mutationCtx, undo, redo, clearSelection])

  // ---------------------------------------------------------------------------
  // Selection outline overlay (naivní fallback — DOM div nad canvasem)
  //
  // TODO (po merge s renderer agentem): Pokud renderer exponuje OverlayCompositor,
  // nahradit registrací přes compositor.register(id, element).
  // ---------------------------------------------------------------------------

  const selectedObj = selectedId !== null ? objects.find((o) => o.id === selectedId) : undefined

  // Cursor style podle aktivního toolu
  const canvasCursor = activeTool === 'select' ? 'default' : 'crosshair'

  return (
    <div className="flex h-full w-full overflow-hidden bg-gray-950">
      {/* Left sidebar: slide panel */}
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
        {/* Toolbar */}
        <Toolbar />

        {/*
          Canvas container: position: relative + overflow: hidden = clipping container
          pro absolutně pozicovaný canvas element. Canvas.tsx používá position: absolute; inset: 0.
          Pointer events jsou zachyceny zde (parent div), ne uvnitř Canvas.tsx.
        */}
        <div
          ref={canvasContainerRef}
          className="relative flex-1 overflow-hidden bg-gray-950"
          style={{ cursor: canvasCursor }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <Canvas onReady={onCanvasReady} />

          {/* Selection outline overlay — naivní DOM implementace */}
          {selectedObj !== undefined && <SelectionOverlay obj={selectedObj} />}
        </div>
      </main>

      {/* Right sidebar: inspector panel */}
      <aside className="flex w-64 flex-shrink-0 flex-col border-l border-gray-800 bg-gray-900">
        <div className="border-b border-gray-800 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Inspector
          </span>
        </div>
        <Inspector />
      </aside>

      {/* DEV-only metrics overlay — Ctrl+Shift+M */}
      {import.meta.env.DEV && <DevMetricsOverlay />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DevMetricsOverlay — DEV-only wrapper (bezpečné volání hooks — vždy mounted)
// ---------------------------------------------------------------------------

function DevMetricsOverlay() {
  const { visible, fpsTracker } = useDevMetrics()
  const { wsStatus } = useSlideDoc()
  if (!visible || fpsTracker === null) return null
  return <FpsOnlyDashboard fpsTracker={fpsTracker} wsStatus={wsStatus} />
}

// ---------------------------------------------------------------------------
// SelectionOverlay
// ---------------------------------------------------------------------------

interface SelectionOverlayProps {
  obj: { x: number; y: number; width: number; height: number; rotation: number }
}

/**
 * Naivní selection outline jako absolutně pozicovaný div.
 *
 * TODO (po merge s renderer agentem): Pokud renderer exponuje OverlayCompositor,
 * tuto komponentu nahradit registrací overlay elementu přes compositor API.
 * OverlayCompositor zajistí správné DPR-aware positioning i při zoom/pan.
 *
 * Pro M2 (žádný zoom/pan): x/y odpovídají CSS logical pixelům přímo.
 */
function SelectionOverlay({ obj }: SelectionOverlayProps) {
  const rotationStyle = obj.rotation !== 0 ? `rotate(${obj.rotation}rad)` : undefined

  return (
    <div
      className="pointer-events-none absolute border-2 border-blue-400"
      style={{
        left: obj.x,
        top: obj.y,
        width: obj.width,
        height: obj.height,
        transform: rotationStyle,
        transformOrigin: 'center center',
      }}
      aria-hidden="true"
    />
  )
}
