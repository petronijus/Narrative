/**
 * ui/CanvasContextMenu.tsx
 *
 * P11: Right-click context menu for the canvas backdrop (artboard background).
 *
 * Items:
 *  - Paste (disabled when clipboard empty)
 *  - Insert shape here → submenu: Rectangle, Ellipse, Triangle, Polygon,
 *                                   Line, Arrow, Text
 *  - Separator
 *  - Select all
 *  - Fit to screen (resets zoom to 1)
 *
 * "Insert shape here" drops a default-sized object at the right-click canvas
 * coordinates. The contextmenu event position is converted to slide-space
 * using the same clientToCanvasCoords helper used elsewhere.
 *
 * Mount: wrap the data-shortcut-scope="canvas" div in EditorLayout:
 *   <CanvasContextMenu canvasContainerRef={canvasContainerRef}>
 *     <div data-shortcut-scope="canvas" ...>
 *       ...
 *     </div>
 *   </CanvasContextMenu>
 */

import { useRef } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { createObjectOfType, addObjects } from '@narrative/slide-model'
import { hasClipboard, readClipboardForPaste } from '../state/clipboard.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useSelection } from '../state/SelectionContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import type { SlideObjectType } from '@narrative/shared'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clientToCanvasCoords(
  clientX: number,
  clientY: number,
  canvasRect: DOMRect,
  zoom: number,
): { x: number; y: number } {
  const s = zoom === 0 ? 1 : zoom
  return {
    x: (clientX - canvasRect.left) / s,
    y: (clientY - canvasRect.top) / s,
  }
}

const SHAPE_ITEMS: { type: SlideObjectType; label: string }[] = [
  { type: 'rectangle', label: 'Rectangle' },
  { type: 'ellipse', label: 'Ellipse' },
  { type: 'triangle', label: 'Triangle' },
  { type: 'polygon', label: 'Polygon' },
  { type: 'line', label: 'Line' },
  { type: 'arrow', label: 'Arrow' },
  { type: 'text', label: 'Text' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CanvasContextMenuProps {
  /** Ref to the unscaled artboard container — used for clientToCanvasCoords. */
  canvasContainerRef: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
}

export function CanvasContextMenu({ canvasContainerRef, children }: CanvasContextMenuProps) {
  const { objectsCtx: mutationCtx } = useSlideObjects()
  const { selectMany } = useSelection()
  const { zoom, setZoom } = useZoomLevel()

  // Store the right-click canvas-space coords so shape insertion places objects
  // at the cursor position when the menu item is selected.
  const contextCoordsRef = useRef<{ x: number; y: number }>({ x: 400, y: 300 })

  const captureContextCoords = (e: React.MouseEvent) => {
    const container = canvasContainerRef.current
    if (container === null) return
    const rect = container.getBoundingClientRect()
    const raw = clientToCanvasCoords(e.clientX, e.clientY, rect, zoom)
    // Clamp to slide bounds so "Insert shape here" always lands on the artboard.
    contextCoordsRef.current = {
      x: Math.max(0, Math.min(SLIDE_WIDTH, raw.x)),
      y: Math.max(0, Math.min(SLIDE_HEIGHT, raw.y)),
    }
  }

  const handlePaste = () => {
    if (!hasClipboard() || mutationCtx === null) return
    const { x, y } = contextCoordsRef.current
    const pasted = readClipboardForPaste({ x: 0, y: 0 })
    if (pasted === null || pasted.length === 0) return
    // Centre the pasted group around the right-click position.
    const w = pasted[0]?.width ?? 160
    const h = pasted[0]?.height ?? 120
    const cx = x - w / 2
    const cy = y - h / 2
    const positioned = pasted.map((o) => ({ ...o, x: o.x + cx, y: o.y + cy }))
    addObjects(mutationCtx, positioned)
    selectMany(positioned.map((o) => o.id))
  }

  const handleInsertShape = (type: SlideObjectType) => {
    if (mutationCtx === null) return
    const { x, y } = contextCoordsRef.current
    const DEFAULT_W = type === 'text' ? 200 : 160
    const DEFAULT_H = type === 'text' ? 60 : 120
    createObjectOfType(mutationCtx, type, {
      x: x - DEFAULT_W / 2,
      y: y - DEFAULT_H / 2,
    })
  }

  const handleSelectAll = () => {
    // Dispatch a synthetic Mod+a keyboard event into the canvas scope so the
    // existing useShortcuts handler picks it up without duplicating logic.
    const canvas = canvasContainerRef.current
    if (canvas === null) return
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        metaKey: navigator.platform.toLowerCase().includes('mac'),
        ctrlKey: !navigator.platform.toLowerCase().includes('mac'),
        bubbles: true,
        cancelable: true,
      }),
    )
  }

  const handleFitToScreen = () => {
    setZoom(1)
  }

  const canPaste = hasClipboard()

  return (
    <ContextMenu>
      {/* ContextMenuTrigger renders as a span by default; we override to
          display:contents so it is layout-invisible. Radix attaches the
          contextmenu handler to the underlying DOM node; since the canvas
          backdrop is a descendant, right-click events bubble up correctly. */}
      <ContextMenuTrigger onContextMenu={captureContextCoords} style={{ display: 'contents' }}>
        {children}
      </ContextMenuTrigger>

      <ContextMenuContent className="w-52">
        <ContextMenuItem disabled={!canPaste || mutationCtx === null} onSelect={handlePaste}>
          Paste
        </ContextMenuItem>

        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={mutationCtx === null}>
            Insert shape here
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {SHAPE_ITEMS.map(({ type, label }) => (
              <ContextMenuItem key={type} onSelect={() => handleInsertShape(type)}>
                {label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={handleSelectAll}>Select all</ContextMenuItem>
        <ContextMenuItem onSelect={handleFitToScreen}>Reset zoom</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
