/**
 * ui/InstanceEditHandles.tsx
 *
 * M16 P8 — Overlay chrome for ComponentInstance "inner editing" mode.
 *
 * Two visual layers:
 *   1. Faded dashed violet border around the instance outer bbox — signals
 *      "you're inside this component" without hiding the boundary.
 *   2. Full transform handles (violet chrome) around the currently selected
 *      leaf, if any. Drag/resize mutations go to setLeafOverridePatch instead
 *      of updateObject so the leaf stays a phantom (not a slide-level object).
 *
 * Leaf transform math (drag / resize):
 *   - Dragging writes absolute x/y. The resolver in resolveOverrides.ts
 *     treats bare x/y keys as ABSOLUTE so master position is replaced, not
 *     added to.
 *   - Resizing writes x/y/width/height all as absolute values — same convention.
 *   - Rotation writes rotation (radians) as an absolute override.
 *
 * The component reads the synthesised leaf geometry from resolveInstanceTree
 * so the displayed handles / Inspector always match what's rendered on canvas.
 *
 * Constraints:
 *   - Does NOT alter the master Y.Doc.
 *   - Does NOT show override badges.
 *   - Guards against nested componentInstance leaves (skips without error).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import type { ObjectBounds } from '../renderer/types.js'
import type { ObjectsMutationContext } from '@narrative/slide-model'
import { resolveInstanceTree, setLeafOverridePatch } from '@narrative/slide-model'
import type { ComponentInstanceObject, SlideObject } from '@narrative/shared'
import { getInstanceLeafContainer } from '../renderer/objectRenderers/componentInstanceRenderer.js'
import { Handle, ACCENT_STROKE, ROTATION_OFFSET } from './handleVisuals.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { getComponentDoc, getComponentDocSyncStatus } from '../state/componentDocCache.js'
import { extractComponentSnapshot } from '../state/extractComponentSnapshot.js'
import type { SnapGuide } from '../editor/snap.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ResizeHandle = 'TL' | 'TC' | 'TR' | 'ML' | 'MR' | 'BL' | 'BC' | 'BR'
type HandleKind = ResizeHandle | 'rotate'

interface DragState {
  kind: HandleKind
  startMouseX: number
  startMouseY: number
  /** Initial layout box in slide/master space. */
  initialX: number
  initialY: number
  initialW: number
  initialH: number
  initialRotation: number
  bounds: ObjectBounds
  artboardLeft: number
  artboardTop: number
}

export interface InstanceEditHandlesProps {
  instanceObj: ComponentInstanceObject
  activeLeafId: string | null
  sceneGraph: SceneGraph
  mutationCtx: ObjectsMutationContext
  onSnapGuides?: (guides: SnapGuide[]) => void
  /** Other objects for future snap support — currently unused. */
  otherBounds?: ReadonlyArray<{ id: string; x: number; y: number; width: number; height: number }>
  /**
   * Called after a resize / rotate gesture ends, so the parent can re-fit
   * the outer instance bbox to the (possibly enlarged) content union.
   */
  onEditEnd?: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function cornersToSvgPoints(corners: Array<{ x: number; y: number }>): string {
  return corners.map((c) => `${c.x},${c.y}`).join(' ')
}

const HANDLE_LOCAL_SIGN: Record<ResizeHandle, { sx: number; sy: number }> = {
  TL: { sx: -1, sy: -1 },
  TR: { sx: 1, sy: -1 },
  BR: { sx: 1, sy: 1 },
  BL: { sx: -1, sy: 1 },
  TC: { sx: 0, sy: -1 },
  BC: { sx: 0, sy: 1 },
  ML: { sx: -1, sy: 0 },
  MR: { sx: 1, sy: 0 },
}

function computeResizeAligned(
  handle: ResizeHandle,
  init: { x: number; y: number; w: number; h: number },
  dx: number,
  dy: number,
): { x: number; y: number; width: number; height: number } {
  let { x, y } = init
  let width = init.w
  let height = init.h
  const sign = HANDLE_LOCAL_SIGN[handle]

  // Horizontal axis
  if (sign.sx < 0) {
    width = Math.max(1, init.w - dx)
    x = init.x + init.w - width
  } else if (sign.sx > 0) {
    width = Math.max(1, init.w + dx)
  }
  // Vertical axis
  if (sign.sy < 0) {
    height = Math.max(1, init.h - dy)
    y = init.y + init.h - height
  } else if (sign.sy > 0) {
    height = Math.max(1, init.h + dy)
  }
  return { x, y, width, height }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InstanceEditHandles({
  instanceObj,
  activeLeafId,
  sceneGraph,
  mutationCtx,
  onSnapGuides,
  onEditEnd,
}: InstanceEditHandlesProps) {
  const { zoom } = useZoomLevel()
  const inv = 1 / (zoom || 1)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const dragRef = useRef<DragState | null>(null)
  const [, forceUpdate] = useState(0)

  // Resolve the leaf's synthesised SlideObject from the master + overrides.
  // We read the cache synchronously (same path the renderer uses) so the
  // data is always in sync with what's on screen. Memoised so the
  // `forceUpdate` ticks fired during drag don't re-extract the master
  // snapshot or re-resolve the override tree on every render.
  const resolvedLeaf: SlideObject | null = useMemo(() => {
    if (activeLeafId === null) return null
    const status = getComponentDocSyncStatus(instanceObj.componentId)
    if (status !== 'synced') return null
    const doc = getComponentDoc(instanceObj.componentId)
    if (doc === null) return null
    const snap = extractComponentSnapshot(doc)
    if (snap === null) return null
    const resolved = resolveInstanceTree(snap.objects, instanceObj.overrides)
    return resolved.find((o) => o.id === activeLeafId) ?? null
  }, [activeLeafId, instanceObj.componentId, instanceObj.overrides])

  // Outer instance bounds — for the faded dashed chrome.
  const instanceBounds = sceneGraph.getBounds(instanceObj.id)

  // Leaf bounds — derived from the leaf's Pixi container in world space.
  const leafBounds: ObjectBounds | null = (() => {
    if (activeLeafId === null || resolvedLeaf === null) return null
    const instanceNode = sceneGraph.getNode(instanceObj.id)
    if (instanceNode === undefined) return null
    const leafContainer = getInstanceLeafContainer(instanceNode.container, activeLeafId)
    if (leafContainer === null) return null
    return sceneGraph.getContainerBoundsFromData(leafContainer, resolvedLeaf)
  })()

  // ---------------------------------------------------------------------------
  // Handle geometry
  // ---------------------------------------------------------------------------

  function computeHandlePoints(bounds: ObjectBounds, rotateOffsetMul = 1) {
    const [tl, tr, br, bl] = bounds.corners
    if (tl === undefined || tr === undefined || br === undefined || bl === undefined) return []

    const tc = midpoint(tl, tr)
    const bc = midpoint(bl, br)
    const ml = midpoint(tl, bl)
    const mr = midpoint(tr, br)

    const edgeDx = tr.x - tl.x
    const edgeDy = tr.y - tl.y
    const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1
    const normalX = -edgeDy / edgeLen
    const normalY = edgeDx / edgeLen

    return [
      {
        kind: 'TL' as HandleKind,
        x: tl.x,
        y: tl.y,
        cursor: 'nwse-resize',
        ariaLabel: 'Resize top-left',
      },
      {
        kind: 'TC' as HandleKind,
        x: tc.x,
        y: tc.y,
        cursor: 'ns-resize',
        ariaLabel: 'Resize top-center',
      },
      {
        kind: 'TR' as HandleKind,
        x: tr.x,
        y: tr.y,
        cursor: 'nesw-resize',
        ariaLabel: 'Resize top-right',
      },
      {
        kind: 'ML' as HandleKind,
        x: ml.x,
        y: ml.y,
        cursor: 'ew-resize',
        ariaLabel: 'Resize middle-left',
      },
      {
        kind: 'MR' as HandleKind,
        x: mr.x,
        y: mr.y,
        cursor: 'ew-resize',
        ariaLabel: 'Resize middle-right',
      },
      {
        kind: 'BL' as HandleKind,
        x: bl.x,
        y: bl.y,
        cursor: 'nesw-resize',
        ariaLabel: 'Resize bottom-left',
      },
      {
        kind: 'BC' as HandleKind,
        x: bc.x,
        y: bc.y,
        cursor: 'ns-resize',
        ariaLabel: 'Resize bottom-center',
      },
      {
        kind: 'BR' as HandleKind,
        x: br.x,
        y: br.y,
        cursor: 'nwse-resize',
        ariaLabel: 'Resize bottom-right',
      },
      {
        kind: 'rotate' as HandleKind,
        x: tc.x + normalX * ROTATION_OFFSET * rotateOffsetMul,
        y: tc.y + normalY * ROTATION_OFFSET * rotateOffsetMul,
        cursor: 'grab',
        ariaLabel: 'Rotate',
      },
    ]
  }

  // ---------------------------------------------------------------------------
  // Pointer handlers
  // ---------------------------------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, kind: HandleKind) => {
      if (leafBounds === null || resolvedLeaf === null) return
      e.stopPropagation()
      e.preventDefault()

      const artboardEl = (e.currentTarget as HTMLElement).closest('.artboard') as HTMLElement | null
      const rect = artboardEl?.getBoundingClientRect()

      dragRef.current = {
        kind,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        initialX: resolvedLeaf.x,
        initialY: resolvedLeaf.y,
        initialW: resolvedLeaf.width,
        initialH: resolvedLeaf.height,
        initialRotation: resolvedLeaf.rotation ?? 0,
        bounds: leafBounds,
        artboardLeft: rect?.left ?? 0,
        artboardTop: rect?.top ?? 0,
      }
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    },
    [leafBounds, resolvedLeaf],
  )

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current
      if (drag === null || activeLeafId === null) return

      const z = zoomRef.current || 1
      const dx = (e.clientX - drag.startMouseX) / z
      const dy = (e.clientY - drag.startMouseY) / z

      if (drag.kind === 'rotate') {
        const center = drag.bounds.center
        const sx = (drag.startMouseX - drag.artboardLeft) / z
        const sy = (drag.startMouseY - drag.artboardTop) / z
        const cx = (e.clientX - drag.artboardLeft) / z
        const cy = (e.clientY - drag.artboardTop) / z
        const startAngle = Math.atan2(sy - center.y, sx - center.x)
        const currentAngle = Math.atan2(cy - center.y, cx - center.x)
        const delta = currentAngle - startAngle
        const newRotation = drag.initialRotation + delta
        setLeafOverridePatch(mutationCtx, instanceObj.id, activeLeafId, {
          rotation: newRotation,
        })
        forceUpdate((n) => n + 1)
        return
      }

      const newRect = computeResizeAligned(
        drag.kind as ResizeHandle,
        { x: drag.initialX, y: drag.initialY, w: drag.initialW, h: drag.initialH },
        dx,
        dy,
      )

      setLeafOverridePatch(mutationCtx, instanceObj.id, activeLeafId, {
        x: newRect.x,
        y: newRect.y,
        width: newRect.width,
        height: newRect.height,
      })
      forceUpdate((n) => n + 1)
    },
    [activeLeafId, mutationCtx, instanceObj.id],
  )

  const handlePointerUp = useCallback(() => {
    const wasDragging = dragRef.current !== null
    dragRef.current = null
    onSnapGuides?.([])
    if (wasDragging) onEditEnd?.()
  }, [onSnapGuides, onEditEnd])

  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      {/* Faded dashed violet outline around the whole instance */}
      {instanceBounds !== null &&
        (() => {
          const [tl, tr, br, bl] = instanceBounds.corners
          if (tl === undefined || tr === undefined || br === undefined || bl === undefined)
            return null
          const svgMinX = Math.min(tl.x, tr.x, br.x, bl.x) - 2
          const svgMinY = Math.min(tl.y, tr.y, br.y, bl.y) - 2
          const svgMaxX = Math.max(tl.x, tr.x, br.x, bl.x) + 2
          const svgMaxY = Math.max(tl.y, tr.y, br.y, bl.y) + 2
          const svgW = svgMaxX - svgMinX
          const svgH = svgMaxY - svgMinY
          return (
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 overflow-visible"
              style={{
                width: svgW,
                height: svgH,
                transform: `translate(${svgMinX}px, ${svgMinY}px)`,
                opacity: 0.4,
              }}
            >
              <polygon
                points={cornersToSvgPoints(
                  instanceBounds.corners.map((c) => ({ x: c.x - svgMinX, y: c.y - svgMinY })),
                )}
                fill="none"
                stroke={ACCENT_STROKE['component']}
                strokeWidth={1.5 * inv}
                strokeDasharray={`${6 * inv} ${4 * inv}`}
              />
            </svg>
          )
        })()}

      {/* Full violet handles for the selected leaf */}
      {leafBounds !== null &&
        resolvedLeaf !== null &&
        (() => {
          const [tl, tr, br, bl] = leafBounds.corners
          if (tl === undefined || tr === undefined || br === undefined || bl === undefined)
            return null
          const svgMinX = Math.min(tl.x, tr.x, br.x, bl.x) - 2
          const svgMinY = Math.min(tl.y, tr.y, br.y, bl.y) - 2
          const svgMaxX = Math.max(tl.x, tr.x, br.x, bl.x) + 2
          const svgMaxY = Math.max(tl.y, tr.y, br.y, bl.y) + 2
          const svgW = svgMaxX - svgMinX
          const svgH = svgMaxY - svgMinY
          const handles = computeHandlePoints(leafBounds, inv)
          return (
            <>
              {/* Solid violet outline for the leaf */}
              <svg
                aria-hidden="true"
                data-testid="leaf-outline-svg"
                data-svg-min-x={svgMinX}
                data-svg-min-y={svgMinY}
                className="pointer-events-none absolute left-0 top-0 overflow-visible"
                style={{
                  width: svgW,
                  height: svgH,
                  transform: `translate(${svgMinX}px, ${svgMinY}px)`,
                }}
              >
                <polygon
                  data-testid="leaf-outline-polygon"
                  points={cornersToSvgPoints(
                    leafBounds.corners.map((c) => ({ x: c.x - svgMinX, y: c.y - svgMinY })),
                  )}
                  fill="none"
                  stroke={ACCENT_STROKE['default']}
                  strokeWidth={1.5 * inv}
                />
              </svg>
              {/* Resize + rotation handles */}
              {handles.map((h) => (
                <Handle
                  key={h.kind}
                  left={h.x}
                  top={h.y}
                  cursor={h.cursor}
                  shape={h.kind === 'rotate' ? 'circle' : 'square'}
                  inv={inv}
                  ariaLabel={h.ariaLabel}
                  accent="default"
                  onPointerDown={(e) => handlePointerDown(e, h.kind)}
                />
              ))}
            </>
          )
        })()}
    </>
  )
}
