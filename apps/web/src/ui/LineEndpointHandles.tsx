/**
 * ui/LineEndpointHandles.tsx
 *
 * P4c: replacement selection chrome for line / arrow objects. Shows
 * two draggable endpoint handles (p1, p2) instead of the 8-handle
 * scale + rotate rig.
 *
 * The handles sit where the renderer draws the ends — rotation and
 * mirroring included (`localToSlide`). A drag snapshots both ends' slide
 * positions and sends them, the dragged one moved by the pointer's travel,
 * to `object.line.setEndpoints`, which refits the box (so hit testing and
 * Magic Move keep working) while the line keeps its rotation and mirroring.
 * Every frame's write is absolute, so it is idempotent.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { LineObject, ArrowObject } from '@narrative/shared'
import { localToSlide, type Placement, type Point } from '@narrative/commands'
import { useCommand } from '../state/useCommand.js'
import { useZoomLevel } from '../state/useZoomLevel.js'

type LineLike = LineObject | ArrowObject

interface Props {
  object: LineLike
  /** The slide the line is on — every write is a command addressed to it. */
  slideId: string
}

interface DragState {
  endpoint: 'p1' | 'p2'
  startMouseX: number
  startMouseY: number
  /** Both ends' slide positions at drag start. */
  p1: Point
  p2: Point
}

const HANDLE_SIZE = 10

function placementOf(o: LineLike): Placement {
  return {
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    rotation: o.rotation,
    flipH: o.flipH === true,
    flipV: o.flipV === true,
  }
}

export function LineEndpointHandles({ object, slideId }: Props) {
  const dragRef = useRef<DragState | null>(null)
  const { zoom } = useZoomLevel()
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const command = useCommand()

  const at = placementOf(object)
  const p1 = localToSlide(at, object.p1)
  const p2 = localToSlide(at, object.p2)

  const startDrag = useCallback(
    (
      e: React.PointerEvent<HTMLDivElement>,
      endpoint: 'p1' | 'p2',
      ends: { p1: Point; p2: Point },
    ) => {
      e.stopPropagation()
      e.preventDefault()
      dragRef.current = {
        endpoint,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        ...ends,
      }
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    },
    [],
  )

  // Window-level move/up so the drag tracks even when the pointer
  // leaves the tiny handle target.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current
      if (drag === null) return
      // Pointer delta is in CSS pixels of the SCALED artboard — divide
      // by the current zoom to recover slide-space delta.
      const z = zoomRef.current || 1
      const dx = (e.clientX - drag.startMouseX) / z
      const dy = (e.clientY - drag.startMouseY) / z
      const moved = { x: drag[drag.endpoint].x + dx, y: drag[drag.endpoint].y + dy }
      command.tryRun('object.line.setEndpoints', {
        slide: slideId,
        object: object.id,
        p1: drag.endpoint === 'p1' ? moved : drag.p1,
        p2: drag.endpoint === 'p2' ? moved : drag.p2,
      })
    }
    function onUp() {
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [command, slideId, object.id])

  const inv = 1 / (zoomRef.current || 1)

  return (
    <>
      <Handle x={p1.x} y={p1.y} inv={inv} onPointerDown={(e) => startDrag(e, 'p1', { p1, p2 })} />
      <Handle x={p2.x} y={p2.y} inv={inv} onPointerDown={(e) => startDrag(e, 'p2', { p1, p2 })} />
    </>
  )
}

function Handle({
  x,
  y,
  inv,
  onPointerDown,
}: {
  x: number
  y: number
  inv: number
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className="pointer-events-auto absolute rounded-full border-2 border-white bg-blue-500 shadow"
      style={{
        left: x,
        top: y,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        cursor: 'grab',
        transform: `translate(-50%, -50%) scale(${inv})`,
        transformOrigin: 'center',
      }}
      onPointerDown={onPointerDown}
      aria-label="Line endpoint"
    />
  )
}
