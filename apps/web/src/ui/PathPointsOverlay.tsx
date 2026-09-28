/**
 * ui/PathPointsOverlay.tsx
 *
 * Edit-mode overlay for PathObject. Renders one draggable dot per anchor
 * in slide-space (the parent artboard div applies the canvas zoom via
 * `transform: scale()`, so positions written here are in slide-px).
 *
 * The dots sit where the renderer draws the anchors — rotation AND
 * mirroring included (`anchorsOnSlide`, the same placement math the
 * renderer's pivot / scale imply). A drag works in slide space too: the
 * dragged anchor's pointer-down slide position plus the pointer's travel
 * goes to `object.path.setAnchors` as a `move` by index, which refits the
 * box while keeping the path's rotation and mirroring and leaves every
 * other anchor where it is drawn. Each frame's write is absolute, so it is
 * idempotent — and it carries one point, whatever the path's size.
 *
 * Behaviour:
 *   • Esc / outside click exits — wired by EditorLayout.
 *   • Control points (cpIn / cpOut) travel with their anchor unchanged.
 */

import { useCallback, useRef } from 'react'
import type { PathObject } from '@narrative/shared'
import { anchorsOnSlide, type PathPoint } from '@narrative/commands'
import { useCommand } from '../state/useCommand.js'
import { useZoomLevel } from '../state/useZoomLevel.js'

const HANDLE_SIZE = 10

interface DragState {
  index: number
  startPointerX: number
  startPointerY: number
  /** The dragged anchor's slide position at drag start. */
  from: PathPoint
}

interface PathPointsOverlayProps {
  obj: PathObject
  /** The slide the path is on — every write is a command addressed to it. */
  slideId: string
}

export function PathPointsOverlay({ obj, slideId }: PathPointsOverlayProps) {
  const dragRef = useRef<DragState | null>(null)
  const { zoom } = useZoomLevel()
  const command = useCommand()

  const onSlide = anchorsOnSlide(
    {
      x: obj.x,
      y: obj.y,
      width: obj.width,
      height: obj.height,
      rotation: obj.rotation,
      flipH: obj.flipH === true,
      flipV: obj.flipV === true,
    },
    obj.anchors,
  )

  const onPointerDown = useCallback(
    (idx: number, from: PathPoint) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      dragRef.current = {
        index: idx,
        startPointerX: e.clientX,
        startPointerY: e.clientY,
        from,
      }
    },
    [],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag === null) return
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      // Slide-space pointer travel: the dragged anchor follows the cursor.
      const z = zoom === 0 ? 1 : zoom
      const dx = (e.clientX - drag.startPointerX) / z
      const dy = (e.clientY - drag.startPointerY) / z
      command.tryRun('object.path.setAnchors', {
        slide: slideId,
        object: obj.id,
        moves: [{ index: drag.index, x: drag.from.x + dx, y: drag.from.y + dy }],
      })
    },
    [command, slideId, obj.id, zoom],
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
  }, [])

  return (
    <>
      {onSlide.map((w, i) => {
        return (
          <div
            key={i}
            data-path-points-handle="true"
            onPointerDown={onPointerDown(i, w)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              position: 'absolute',
              left: w.x - HANDLE_SIZE / 2,
              top: w.y - HANDLE_SIZE / 2,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              background: '#fff',
              border: '2px solid #3b82f6',
              borderRadius: '50%',
              cursor: 'grab',
              touchAction: 'none',
              // Keep handles a constant on-screen size at any zoom and
              // counter-rotate them so the dot itself doesn't tilt.
              transform: `scale(${1 / zoom})`,
              transformOrigin: 'center',
              zIndex: 50,
            }}
          />
        )
      })}
    </>
  )
}
