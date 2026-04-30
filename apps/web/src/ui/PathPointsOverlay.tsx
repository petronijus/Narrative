/**
 * ui/PathPointsOverlay.tsx
 *
 * Edit-mode overlay for PathObject. Renders one draggable dot per anchor
 * in slide-space (the parent artboard div applies the canvas zoom via
 * `transform: scale()`, so positions written here are in slide-px).
 *
 * Rotation is handled with the same rotate-around-center transform the
 * renderer uses (pixi pivot = (w/2, h/2), node.x = obj.x + w/2, etc.).
 * Doing the math in one place — and using its inverse for drag deltas —
 * keeps anchor placement and dragging consistent with the rendered
 * geometry whatever the rotation, instead of fighting it.
 *
 * Each anchor drag also normalizes anchors so the local AABB starts at
 * (0,0) and updates obj.x / y / width / height, while keeping the
 * world-space rotation pivot exactly where it was. That way the
 * transform-handle bounds are snug to the new geometry the moment the
 * user exits point-edit, and the shape doesn't jump on screen.
 *
 * Behaviour:
 *   • Pointerdown captures a snapshot (anchors, obj x/y/w/h/rotation)
 *     so each frame's write is idempotent — re-running with the same
 *     pointer delta produces the same write.
 *   • Esc / outside click exits — wired by EditorLayout.
 *   • Control points (cpIn / cpOut) are preserved verbatim.
 */

import { useCallback, useRef } from 'react'
import type { PathObject, PathAnchor } from '@narrative/shared'
import type { ObjectsMutationContext } from '@narrative/slide-model'
import { updateObject } from '@narrative/slide-model'
import { useZoomLevel } from '../state/useZoomLevel.js'

const HANDLE_SIZE = 10

interface DragState {
  index: number
  startPointerX: number
  startPointerY: number
  /** Snapshot of anchors at drag-start, in original local space (relative to obj.x/y, before normalization). */
  originalAnchors: PathAnchor[]
  originalObjX: number
  originalObjY: number
  originalW: number
  originalH: number
  originalRotation: number
}

interface PathPointsOverlayProps {
  obj: PathObject
  mutationCtx: ObjectsMutationContext
}

/**
 * Local-space (a.x - w/2, a.y - h/2) → world-space, rotated by θ around
 * the object's center (cx, cy). Mirrors `applyTransform` in pathRenderer
 * and `SceneGraph.getBounds` so handles always sit on the rendered geometry.
 */
function localToWorld(
  ax: number,
  ay: number,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  cosθ: number,
  sinθ: number,
): { x: number; y: number } {
  const lx = ax - halfW
  const ly = ay - halfH
  return {
    x: cx + lx * cosθ - ly * sinθ,
    y: cy + lx * sinθ + ly * cosθ,
  }
}

export function PathPointsOverlay({ obj, mutationCtx }: PathPointsOverlayProps) {
  const dragRef = useRef<DragState | null>(null)
  const { zoom } = useZoomLevel()

  const θ = obj.rotation
  const cosθ = Math.cos(θ)
  const sinθ = Math.sin(θ)
  const cx = obj.x + obj.width / 2
  const cy = obj.y + obj.height / 2

  const onPointerDown = useCallback(
    (idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      dragRef.current = {
        index: idx,
        startPointerX: e.clientX,
        startPointerY: e.clientY,
        originalAnchors: obj.anchors.map((a) => ({
          x: a.x,
          y: a.y,
          ...(a.cpIn !== undefined ? { cpIn: { x: a.cpIn.x, y: a.cpIn.y } } : {}),
          ...(a.cpOut !== undefined ? { cpOut: { x: a.cpOut.x, y: a.cpOut.y } } : {}),
        })),
        originalObjX: obj.x,
        originalObjY: obj.y,
        originalW: obj.width,
        originalH: obj.height,
        originalRotation: obj.rotation,
      }
    },
    [obj.anchors, obj.x, obj.y, obj.width, obj.height, obj.rotation],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag === null) return
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return

      // World-space pointer delta, in slide-px.
      const wdx = (e.clientX - drag.startPointerX) / zoom
      const wdy = (e.clientY - drag.startPointerY) / zoom
      // Rotate the world delta into the object's local frame so dragging
      // an anchor moves it in the direction the cursor went on screen.
      const dCos = Math.cos(drag.originalRotation)
      const dSin = Math.sin(drag.originalRotation)
      const ldx = wdx * dCos + wdy * dSin
      const ldy = -wdx * dSin + wdy * dCos

      const orig = drag.originalAnchors[drag.index]
      if (orig === undefined) return

      const movedAnchors = drag.originalAnchors.map((a, i) =>
        i === drag.index ? { ...a, x: orig.x + ldx, y: orig.y + ldy } : a,
      )

      // Compute the new local AABB (anchors + control handles).
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const a of movedAnchors) {
        minX = Math.min(minX, a.x)
        minY = Math.min(minY, a.y)
        maxX = Math.max(maxX, a.x)
        maxY = Math.max(maxY, a.y)
        if (a.cpIn !== undefined) {
          minX = Math.min(minX, a.x + a.cpIn.x)
          minY = Math.min(minY, a.y + a.cpIn.y)
          maxX = Math.max(maxX, a.x + a.cpIn.x)
          maxY = Math.max(maxY, a.y + a.cpIn.y)
        }
        if (a.cpOut !== undefined) {
          minX = Math.min(minX, a.x + a.cpOut.x)
          minY = Math.min(minY, a.y + a.cpOut.y)
          maxX = Math.max(maxX, a.x + a.cpOut.x)
          maxY = Math.max(maxY, a.y + a.cpOut.y)
        }
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return
      const newW = Math.max(1, maxX - minX)
      const newH = Math.max(1, maxY - minY)

      // Shift the local center so the world-space rotation pivot stays
      // put after normalization. Without this, a rotated path "walks"
      // across the canvas every time an anchor is dragged.
      // Local-space delta from old center to new center:
      const dxLocal = minX + newW / 2 - drag.originalW / 2
      const dyLocal = minY + newH / 2 - drag.originalH / 2
      // Same delta in world space (rotated by θ).
      const dxWorld = dxLocal * dCos - dyLocal * dSin
      const dyWorld = dxLocal * dSin + dyLocal * dCos
      const oldCx = drag.originalObjX + drag.originalW / 2
      const oldCy = drag.originalObjY + drag.originalH / 2
      const newCx = oldCx + dxWorld
      const newCy = oldCy + dyWorld

      const nextAnchors = movedAnchors.map((a) => ({
        ...a,
        x: a.x - minX,
        y: a.y - minY,
      }))
      updateObject<PathObject>(mutationCtx, obj.id, {
        anchors: nextAnchors,
        x: newCx - newW / 2,
        y: newCy - newH / 2,
        width: newW,
        height: newH,
      })
    },
    [mutationCtx, obj.id, zoom],
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
      {obj.anchors.map((a, i) => {
        const w = localToWorld(a.x, a.y, cx, cy, obj.width / 2, obj.height / 2, cosθ, sinθ)
        return (
          <div
            key={i}
            data-path-points-handle="true"
            onPointerDown={onPointerDown(i)}
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
