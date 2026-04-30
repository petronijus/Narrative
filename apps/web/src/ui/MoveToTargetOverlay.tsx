/**
 * ui/MoveToTargetOverlay.tsx
 *
 * Visual editor for the `moveTo` animation preset. When a moveTo step
 * is selected in the timeline / inspector, the overlay renders the
 * object's destination silhouette at (targetX, targetY) plus a
 * draggable centre handle. Dragging the handle writes new target
 * params back to the Y.Doc through `updateAnimation`.
 *
 * Coordinates are slide-px — the parent artboard applies the canvas
 * zoom via `transform: scale()`, same convention as PathPointsOverlay.
 */

import { useCallback, useRef } from 'react'
import type { SlideObject, AnimationStep } from '@narrative/shared'
import type { AnimationsMutationContext } from '@narrative/slide-model'
import { updateAnimation } from '@narrative/slide-model'
import { useZoomLevel } from '../state/useZoomLevel.js'

const HANDLE_SIZE = 14

interface DragState {
  pointerStartX: number
  pointerStartY: number
  startTargetX: number
  startTargetY: number
}

interface MoveToTargetOverlayProps {
  obj: SlideObject
  step: AnimationStep
  mutationCtx: AnimationsMutationContext
}

export function MoveToTargetOverlay({ obj, step, mutationCtx }: MoveToTargetOverlayProps) {
  const dragRef = useRef<DragState | null>(null)
  const { zoom } = useZoomLevel()

  // moveTo preset writes proxy.x / proxy.y directly. Pixi pivots
  // every object at its centre (rectangleRenderer sets
  // pivot=(w/2,h/2) and container.x/y = obj.x + w/2, etc.), so
  // proxy.x/y semantically represents the object's CENTRE in
  // slide-coords. Treat targetX/targetY here the same way so the
  // silhouette ghost lands exactly where playback finishes.
  const sourceCx = obj.x + obj.width / 2
  const sourceCy = obj.y + obj.height / 2
  const targetCx = (step.params?.['targetX'] as number | undefined) ?? sourceCx
  const targetCy = (step.params?.['targetY'] as number | undefined) ?? sourceCy

  const w = obj.width
  const h = obj.height

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      dragRef.current = {
        pointerStartX: e.clientX,
        pointerStartY: e.clientY,
        startTargetX: targetCx,
        startTargetY: targetCy,
      }
    },
    [targetCx, targetCy],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag === null) return
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return

      const dx = (e.clientX - drag.pointerStartX) / zoom
      const dy = (e.clientY - drag.pointerStartY) / zoom

      updateAnimation(mutationCtx, step.id, {
        params: {
          ...(step.params ?? {}),
          targetX: Math.round(drag.startTargetX + dx),
          targetY: Math.round(drag.startTargetY + dy),
        },
      })
    },
    [mutationCtx, step.id, step.params, zoom],
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return
    e.stopPropagation()
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
  }, [])

  // SVG line is drawn inside an absolute-positioned container at (0,0)
  // sized to cover the artboard; pointer events on it are disabled so
  // it doesn't steal clicks from underlying objects.
  const minX = Math.min(sourceCx, targetCx) - 16
  const minY = Math.min(sourceCy, targetCy) - 16
  const maxX = Math.max(sourceCx, targetCx) + 16
  const maxY = Math.max(sourceCy, targetCy) + 16
  const svgW = Math.max(1, maxX - minX)
  const svgH = Math.max(1, maxY - minY)

  return (
    <>
      {/* Dashed silhouette of the object at the target position.
          targetCx/Cy is the object's CENTRE, so subtract w/2 / h/2
          to derive the CSS top-left. */}
      <div
        aria-hidden
        className="pointer-events-none absolute rounded-sm border border-dashed border-blue-400/80 bg-blue-400/5"
        style={{
          left: targetCx - w / 2,
          top: targetCy - h / 2,
          width: w,
          height: h,
          transform: `rotate(${obj.rotation}rad)`,
          transformOrigin: 'center',
        }}
      />

      {/* Connecting line from source centre to target centre. */}
      <svg
        aria-hidden
        className="pointer-events-none absolute"
        style={{ left: minX, top: minY, width: svgW, height: svgH, overflow: 'visible' }}
      >
        <line
          x1={sourceCx - minX}
          y1={sourceCy - minY}
          x2={targetCx - minX}
          y2={targetCy - minY}
          stroke="rgb(96 165 250)"
          strokeWidth={1.5 / zoom}
          strokeDasharray={`${6 / zoom} ${4 / zoom}`}
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={sourceCx - minX}
          cy={sourceCy - minY}
          r={4 / zoom}
          fill="white"
          stroke="rgb(96 165 250)"
          strokeWidth={1.5 / zoom}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* Drag handle at the target centre. */}
      <div
        role="button"
        aria-label="Drag move-to target"
        title="Drag to set move-to target"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="absolute cursor-move rounded-full border-2 border-blue-400 bg-white shadow"
        style={{
          left: targetCx - HANDLE_SIZE / (2 * zoom),
          top: targetCy - HANDLE_SIZE / (2 * zoom),
          width: HANDLE_SIZE / zoom,
          height: HANDLE_SIZE / zoom,
        }}
      />
    </>
  )
}
