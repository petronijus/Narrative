/**
 * ui/LineEndpointHandles.tsx
 *
 * P4c: replacement selection chrome for line / arrow objects. Shows
 * two draggable endpoint handles (p1, p2) instead of the 8-handle
 * scale + rotate rig. Dragging an endpoint updates that point and
 * renormalises the object's AABB (x, y, width, height) so hit
 * testing and Magic Move keep working.
 */

import { useCallback, useEffect, useRef } from 'react'
import { updateObject } from '@narrative/slide-model'
import type { SlideObject, LineObject, ArrowObject } from '@narrative/shared'
import type { ObjectsMutationContext } from '@narrative/slide-model'
import { useZoomLevel } from '../state/useZoomLevel.js'

type LineLike = LineObject | ArrowObject

interface Props {
  object: LineLike
  mutationCtx: ObjectsMutationContext
}

interface DragState {
  endpoint: 'p1' | 'p2'
  /** World-space position of the OTHER, stationary endpoint. */
  fixedWorldX: number
  fixedWorldY: number
  startMouseX: number
  startMouseY: number
  /** Initial object snapshot for rollback + zoom-aware math. */
  initial: LineLike
}

const HANDLE_SIZE = 10

export function LineEndpointHandles({ object, mutationCtx }: Props) {
  const dragRef = useRef<DragState | null>(null)
  const { zoom } = useZoomLevel()
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  const commit = useCallback(
    (
      fixedWorldX: number,
      fixedWorldY: number,
      movedWorldX: number,
      movedWorldY: number,
      endpoint: 'p1' | 'p2',
      initial: LineLike,
    ) => {
      const p1World =
        endpoint === 'p1' ? { x: movedWorldX, y: movedWorldY } : { x: fixedWorldX, y: fixedWorldY }
      const p2World =
        endpoint === 'p2' ? { x: movedWorldX, y: movedWorldY } : { x: fixedWorldX, y: fixedWorldY }

      const nx = Math.min(p1World.x, p2World.x)
      const ny = Math.min(p1World.y, p2World.y)
      const nw = Math.abs(p1World.x - p2World.x)
      const nh = Math.abs(p1World.y - p2World.y)

      const next: LineLike = {
        ...initial,
        x: nx,
        y: ny,
        width: nw,
        height: nh,
        p1: { x: p1World.x - nx, y: p1World.y - ny },
        p2: { x: p2World.x - nx, y: p2World.y - ny },
      }
      updateObject(mutationCtx, initial.id, next as unknown as SlideObject)
    },
    [mutationCtx],
  )

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, endpoint: 'p1' | 'p2') => {
      e.stopPropagation()
      e.preventDefault()
      const fixedPoint = endpoint === 'p1' ? object.p2 : object.p1
      dragRef.current = {
        endpoint,
        fixedWorldX: object.x + fixedPoint.x,
        fixedWorldY: object.y + fixedPoint.y,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        initial: object,
      }
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    },
    [object],
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
      const movingInitial = drag.endpoint === 'p1' ? drag.initial.p1 : drag.initial.p2
      const movedWorldX = drag.initial.x + movingInitial.x + dx
      const movedWorldY = drag.initial.y + movingInitial.y + dy
      commit(
        drag.fixedWorldX,
        drag.fixedWorldY,
        movedWorldX,
        movedWorldY,
        drag.endpoint,
        drag.initial,
      )
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
  }, [commit])

  const p1X = object.x + object.p1.x
  const p1Y = object.y + object.p1.y
  const p2X = object.x + object.p2.x
  const p2Y = object.y + object.p2.y

  return (
    <>
      <Handle x={p1X} y={p1Y} onPointerDown={(e) => startDrag(e, 'p1')} />
      <Handle x={p2X} y={p2Y} onPointerDown={(e) => startDrag(e, 'p2')} />
    </>
  )
}

function Handle({
  x,
  y,
  onPointerDown,
}: {
  x: number
  y: number
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className="pointer-events-auto absolute rounded-full border-2 border-white bg-blue-500 shadow"
      style={{
        left: x - HANDLE_SIZE / 2,
        top: y - HANDLE_SIZE / 2,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        cursor: 'grab',
      }}
      onPointerDown={onPointerDown}
      aria-label="Line endpoint"
    />
  )
}
