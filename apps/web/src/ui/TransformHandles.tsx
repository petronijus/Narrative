/**
 * ui/TransformHandles.tsx
 *
 * Transform handles pro single/multi-select objekty v editoru (M7).
 *
 * Renderuje:
 * - 1 selection outline (obdélník / rotovaný polygon)
 * - 8 resize handles (TL, TC, TR, ML, MR, BL, BC, BR)
 * - 1 rotation handle (nad TC, 24px offset)
 *
 * Implementace jako DOM overlay (absolutně pozicované divy nad canvas containerem).
 * Nepoužívá OverlayCompositor.registerOverlay pro handles — ty jsou DOM-only
 * (nepotřebují Pixi Container tracking, souřadnice čteme přímo z SceneGraph.getBounds).
 *
 * Single-select: rotation-aware outline + handles v rotated coordinate system.
 * Multi-select: AABB outline (rotation=0) + handles, bez rotation handle.
 *
 * Resize matematika:
 * - Corner handles: free resize (Shift = aspect lock). Opposite corner zůstane fixní.
 * - Edge handles: resize jen v jedné ose.
 * - Rotation: atan2 od středu objektu.
 *
 * M14: Multi-select group resize + keyboard focus ring pro handles.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import type { ObjectBounds } from '../renderer/types.js'
import { resizeFromHandle } from '@narrative/commands'
import type { SlideObject } from '@narrative/shared'
import { computeSnap, snapsThisFrame, type SnapGuideTarget } from '../editor/snap.js'
import { useCommand } from '../state/useCommand.js'
import type { SnapGuide } from '../editor/snap.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { useSnapping } from '../state/SnappingContext.js'
import { isModHeld } from '../state/useShortcuts.js'
import { useDragModifierReplay, type DragPointer } from '../state/useDragModifierReplay.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HandleKind = 'TL' | 'TC' | 'TR' | 'ML' | 'MR' | 'BL' | 'BC' | 'BR' | 'rotate'

interface HandlePoint {
  kind: HandleKind
  x: number
  y: number
  cursor: string
  ariaLabel: string
}

interface DragState {
  kind: HandleKind
  startMouseX: number
  startMouseY: number
  bounds: ObjectBounds
  objectIds: string[]
  /**
   * Počáteční bounds všech vybraných objektů (pro group drag).
   * P15: x/y/w/h are the object's UNROTATED slide-space bounds (data
   * model layout box) and `rotation` is the angle in radians around
   * its center. Resize math projects pointer deltas into the local
   * frame so rotated objects scale along their own axes instead of
   * world axes.
   */
  allInitialBounds: Array<{
    id: string
    x: number
    y: number
    w: number
    h: number
    rotation: number
  }>
  /**
   * Multi-select drags move the objects with `object.move`, which is
   * relative: the translation already applied, so each pointermove sends
   * only the difference to the pointer's total travel.
   */
  applied: { dx: number; dy: number }
  /**
   * Artboard client rect snapshotted at drag start — used by the
   * rotate handle to convert screen-space mouse positions to
   * slide-space so the angle math shares a coord system with
   * `bounds.center`.
   */
  artboardLeft: number
  artboardTop: number
}

export interface TransformHandlesProps {
  objectIds: string[]
  sceneGraph: SceneGraph
  /** The slide the objects are on — every write is a command addressed to it. */
  slideId: string
  /** Callback pro předání aktivních snap guides do EditorLayout (vizualizace). */
  onSnapGuides?: (guides: SnapGuide[]) => void
  /** Bounds ostatních objektů pro snapping (all objects minus selected). */
  otherBounds: Array<{ id: string; x: number; y: number; width: number; height: number }>
  /**
   * P8: when true, corner resizes preserve the original aspect ratio
   * even without Shift held. Used by VideoObject (aspectLocked flag in
   * Inspector) so the user can't accidentally squish a clip.
   */
  forceAspectLock?: boolean
  /**
   * P11: deck-level alignment guides — fed straight into computeSnap as
   * extra snap targets so resizing also snaps to user-dropped guides.
   */
  extraGuides?: ReadonlyArray<SnapGuideTarget>
  /**
   * Live snapshot of the slide's objects: the resize math starts from each
   * object's unrotated layout box and rotation. (A cropped picture scales
   * with its frame inside `object.resize`.)
   */
  objects?: ReadonlyArray<SlideObject>
  /** Selection-chrome accent. Forwarded to the SVG outline + handle
   *  borders. Defaults to 'default' (blue); pass 'component' to render
   *  the Figma-style violet chrome for ComponentInstance selections. */
  accent?: SelectionAccent
}

// ---------------------------------------------------------------------------
// Handle geometry helpers
// ---------------------------------------------------------------------------

import { ROTATION_OFFSET, Handle, ACCENT_STROKE, type SelectionAccent } from './handleVisuals.js'

/**
 * Interpoluje bod mezi dvěma body (pro edge midpoints).
 */
function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Vypočítá pozice 8 resize handles + 1 rotation handle z ObjectBounds.
 * Pro single-select s rotací: handles jsou v rotated space (z corners).
 * Pro multi-select (rotation=0): handles jsou na AABB.
 */
function computeHandlePoints(bounds: ObjectBounds, rotateOffsetMul = 1): HandlePoint[] {
  const [tl, tr, br, bl] = bounds.corners

  if (tl === undefined || tr === undefined || br === undefined || bl === undefined) {
    return []
  }

  const tc = midpoint(tl, tr)
  const bc = midpoint(bl, br)
  const ml = midpoint(tl, bl)
  const mr = midpoint(tr, br)

  // Rotation handle: 24px v směru "nahoru" z TC (v local space = -Y direction)
  // Vypočítáme normal z TR-TL (horní hrana)
  const edgeDx = tr.x - tl.x
  const edgeDy = tr.y - tl.y
  const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1
  // Normál kolmý na horní hranu, směřující "ven" (nahoru v local space)
  const normalX = -edgeDy / edgeLen
  const normalY = edgeDx / edgeLen

  const rotHandle: HandlePoint = {
    kind: 'rotate',
    x: tc.x + normalX * ROTATION_OFFSET * rotateOffsetMul,
    y: tc.y + normalY * ROTATION_OFFSET * rotateOffsetMul,
    cursor: 'grab',
    ariaLabel: 'Rotate handle',
  }

  return [
    { kind: 'TL', x: tl.x, y: tl.y, cursor: 'nwse-resize', ariaLabel: 'Resize top-left handle' },
    { kind: 'TC', x: tc.x, y: tc.y, cursor: 'ns-resize', ariaLabel: 'Resize top-center handle' },
    { kind: 'TR', x: tr.x, y: tr.y, cursor: 'nesw-resize', ariaLabel: 'Resize top-right handle' },
    { kind: 'ML', x: ml.x, y: ml.y, cursor: 'ew-resize', ariaLabel: 'Resize middle-left handle' },
    { kind: 'MR', x: mr.x, y: mr.y, cursor: 'ew-resize', ariaLabel: 'Resize middle-right handle' },
    { kind: 'BL', x: bl.x, y: bl.y, cursor: 'nesw-resize', ariaLabel: 'Resize bottom-left handle' },
    { kind: 'BC', x: bc.x, y: bc.y, cursor: 'ns-resize', ariaLabel: 'Resize bottom-center handle' },
    {
      kind: 'BR',
      x: br.x,
      y: br.y,
      cursor: 'nwse-resize',
      ariaLabel: 'Resize bottom-right handle',
    },
    rotHandle,
  ]
}

// ---------------------------------------------------------------------------
// Resize math
// ---------------------------------------------------------------------------

/** The drag math lives in @narrative/commands (geometry.ts), shared with `object.resize`. */

// ---------------------------------------------------------------------------
// Outline polygon helper
// ---------------------------------------------------------------------------

/** Vrátí SVG polygon points string ze 4 corners. */
function cornersToSvgPoints(corners: Array<{ x: number; y: number }>): string {
  return corners.map((c) => `${c.x},${c.y}`).join(' ')
}

// ---------------------------------------------------------------------------
// TransformHandles component
// ---------------------------------------------------------------------------

export function TransformHandles({
  objectIds,
  sceneGraph,
  slideId,
  onSnapGuides,
  otherBounds,
  extraGuides = [],
  forceAspectLock = false,
  objects = [],
  accent = 'default',
}: TransformHandlesProps) {
  const command = useCommand()
  const dragRef = useRef<DragState | null>(null)
  const [, forceUpdate] = useState(0)
  const { zoom } = useZoomLevel()
  const { enabled: snappingEnabled } = useSnapping()
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  // Invert-scale for handle chrome so TL/BR dots, the selection outline
  // stroke, and the rotation handle stay at a constant SCREEN size regardless
  // of artboard zoom. All ARE positioned by slide-space bounds and inherit
  // the artboard's CSS transform scale.
  const inv = 1 / (zoom || 1)

  // Bounds pro render (re-fetch každý render z SceneGraph)
  const bounds: ObjectBounds | null =
    objectIds.length === 1
      ? sceneGraph.getBounds(objectIds[0] ?? '')
      : objectIds.length > 1
        ? sceneGraph.getMultiBounds(objectIds)
        : null

  const isMulti = objectIds.length > 1

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, kind: HandleKind) => {
      e.stopPropagation()
      e.preventDefault()

      const currentBounds =
        objectIds.length === 1
          ? sceneGraph.getBounds(objectIds[0] ?? '')
          : sceneGraph.getMultiBounds(objectIds)

      if (currentBounds === null) return

      // P15: snapshot the OBJECT'S unrotated layout box (data x/y/w/h)
      // plus its rotation. b.world is the AABB of the rotated rect —
      // not the local layout — so using it for resize math under
      // non-zero rotation produces wrong-sized objects. Falling back
      // to b.world only when the object isn't in `objects` (preserves
      // the legacy axis-aligned behaviour).
      const allInitialBounds = objectIds.flatMap((id) => {
        const o = objects?.find((x) => x.id === id)
        if (o !== undefined) {
          return [
            {
              id,
              x: o.x,
              y: o.y,
              w: o.width,
              // A growing text box is as tall as it is drawn.
              h: sceneGraph.drawnSize(id)?.height ?? o.height,
              rotation: o.rotation ?? 0,
            },
          ]
        }
        const b = sceneGraph.getBounds(id)
        if (b === null) return []
        return [
          {
            id,
            x: b.world.x,
            y: b.world.y,
            w: b.world.width,
            h: b.world.height,
            rotation: 0,
          },
        ]
      })

      // Snapshot the artboard's on-screen origin so the rotate handle
      // can translate mouse events into slide-space.
      const artboardEl = (e.currentTarget as HTMLElement).closest('.artboard') as HTMLElement | null
      const rect = artboardEl?.getBoundingClientRect()
      dragRef.current = {
        kind,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        bounds: currentBounds,
        objectIds: [...objectIds],
        allInitialBounds,
        applied: { dx: 0, dy: 0 },
        artboardLeft: rect?.left ?? 0,
        artboardTop: rect?.top ?? 0,
      }
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    },
    [objectIds, sceneGraph, objects],
  )

  // One frame of a handle drag. Absolute from the pointer-down snapshot
  // (the multi-select move tracks what it already applied), so
  // `useDragModifierReplay` can re-run it when Shift or ⌘ / Ctrl changes
  // with the pointer standing still.
  const dragFrame = useCallback(
    (e: DragPointer) => {
      const drag = dragRef.current
      if (drag === null) return

      // Screen-px delta → slide-space delta (artboard CSS scaled by zoom).
      const z = zoomRef.current || 1
      const dx = (e.clientX - drag.startMouseX) / z
      const dy = (e.clientY - drag.startMouseY) / z

      const shiftHeld = e.shiftKey

      if (drag.kind === 'rotate') {
        // Convert both mouse positions to slide-space so they share a
        // coord system with `bounds.center` (which is slide-space).
        // atan2 of a vector in a different coord system than its pivot
        // yields a meaningless angle — that produced the "I pull the
        // handle right and the object rotates left" bug.
        const center = drag.bounds.center
        const sx = (drag.startMouseX - drag.artboardLeft) / z
        const sy = (drag.startMouseY - drag.artboardTop) / z
        const cx = (e.clientX - drag.artboardLeft) / z
        const cy = (e.clientY - drag.artboardTop) / z
        const startAngle = Math.atan2(sy - center.y, sx - center.x)
        const currentAngle = Math.atan2(cy - center.y, cx - center.x)
        const deltaAngle = currentAngle - startAngle
        const initialRotation = drag.bounds.rotation
        const newRotation = initialRotation + deltaAngle

        if (drag.objectIds.length === 1) {
          const id = drag.objectIds[0]
          if (id !== undefined) {
            command.tryRun('object.rotate', {
              slide: slideId,
              objects: [id],
              degrees: (newRotation * 180) / Math.PI,
            })
          }
        }
        return
      }

      if (drag.objectIds.length === 1) {
        // Single-select resize
        const initial = drag.allInitialBounds[0]
        if (initial === undefined) return

        // P15: aspect-lock semantics — XOR of the per-object lock and
        // the live Shift state. With lock OFF (default), Shift toggles
        // it ON for the drag; with lock ON, Shift toggles it OFF.
        // Matches Figma / Sketch / Keynote.
        const lockAspect = shiftHeld !== forceAspectLock
        const newRect = resizeFromHandle(
          {
            x: initial.x,
            y: initial.y,
            width: initial.w,
            height: initial.h,
            rotation: initial.rotation,
          },
          drag.kind,
          dx,
          dy,
          lockAspect,
        )

        // Snap — unless snapping is off for this frame (the toolbar
        // toggle, or ⌘ / Ctrl held against it): then the box follows the
        // handle freely, with no object, guide or grid snap.
        const snapResult = snapsThisFrame(snappingEnabled, isModHeld(e))
          ? computeSnap(
              { x: newRect.x, y: newRect.y, width: newRect.width, height: newRect.height },
              otherBounds,
              10,
              6,
              extraGuides,
            )
          : { dx: 0, dy: 0, guides: [] }

        const snappedX = newRect.x + snapResult.dx
        const snappedY = newRect.y + snapResult.dy

        onSnapGuides?.(snapResult.guides)

        const id = drag.objectIds[0]
        if (id !== undefined) {
          // The exact snapped box; `object.resize` scales a cropped
          // picture with the frame (from the live frame to the new one,
          // so the steps of a drag compose exactly).
          command.tryRun('object.resize', {
            slide: slideId,
            object: id,
            x: snappedX,
            y: snappedY,
            width: newRect.width,
            height: newRect.height,
          })
        }
      } else {
        // Multi-select: translation only. `object.move` is relative and
        // carries each cropped picture along with its frame.
        const step = { dx: dx - drag.applied.dx, dy: dy - drag.applied.dy }
        if (step.dx !== 0 || step.dy !== 0) {
          const moved = command.tryRun('object.move', {
            slide: slideId,
            objects: drag.objectIds,
            ...step,
          })
          if (moved !== null) drag.applied = { dx, dy }
        }
        onSnapGuides?.([])
      }

      // Force re-render aby handles sledovaly novou pozici
      forceUpdate((n) => n + 1)
    },
    [command, slideId, otherBounds, onSnapGuides, extraGuides, forceAspectLock, snappingEnabled],
  )
  const dragModifierReplay = useDragModifierReplay(dragFrame)

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (dragRef.current === null) return
      dragModifierReplay.track(e)
      dragFrame(e)
    },
    [dragFrame, dragModifierReplay],
  )

  const handlePointerUp = useCallback(() => {
    dragRef.current = null
    dragModifierReplay.end()
    onSnapGuides?.([])
  }, [onSnapGuides, dragModifierReplay])

  // Global pointermove/pointerup pro drag (capture na handle elementu)
  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  // A growing text box changes its drawn height without a write to the
  // document (another line of an agent's text, a face that loaded): follow it.
  const idsKey = objectIds.join(',')
  useEffect(() => {
    const ids = new Set(idsKey.split(','))
    return sceneGraph.onTextLayout((id) => {
      if (ids.has(id)) forceUpdate((n) => n + 1)
    })
  }, [sceneGraph, idsKey])

  if (bounds === null || objectIds.length === 0) return null

  // Rotation handle sits ROTATION_OFFSET slide-px above the top edge; with
  // CSS scale(zoom) that becomes ROTATION_OFFSET*zoom screen-px which stays
  // glued to the edge at low zoom. Feed inv so the on-screen gap is constant.
  const handlePoints = computeHandlePoints(bounds, inv)
  // A box that grows with its text takes its height from the text: only its
  // width and rotation have handles.
  const single = isMulti ? undefined : objects.find((o) => o.id === objectIds[0])
  const growsDown = single?.type === 'text' && single.autofit === 'grow-down'
  // Multi-select: skip rotation handle
  const visibleHandles = isMulti
    ? handlePoints.filter((h) => h.kind !== 'rotate')
    : growsDown
      ? handlePoints.filter((h) => h.kind === 'ML' || h.kind === 'MR' || h.kind === 'rotate')
      : handlePoints

  // Outline: SVG polygon přes 4 corners
  const [tl, tr, br, bl] = bounds.corners
  if (tl === undefined || tr === undefined || br === undefined || bl === undefined) return null

  const svgMinX = Math.min(tl.x, tr.x, br.x, bl.x) - 2
  const svgMinY = Math.min(tl.y, tr.y, br.y, bl.y) - 2
  const svgMaxX = Math.max(tl.x, tr.x, br.x, bl.x) + 2
  const svgMaxY = Math.max(tl.y, tr.y, br.y, bl.y) + 2
  const svgW = svgMaxX - svgMinX
  const svgH = svgMaxY - svgMinY

  return (
    <>
      {/* Selection outline jako SVG polygon — rotation-aware. Stroke je
          dělený zoomem aby vypadal konstantně tlustý na obrazovce
          bez ohledu na CSS scale artboardu. */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        style={{ width: svgW, height: svgH, transform: `translate(${svgMinX}px, ${svgMinY}px)` }}
      >
        <polygon
          points={cornersToSvgPoints(
            bounds.corners.map((c) => ({ x: c.x - svgMinX, y: c.y - svgMinY })),
          )}
          fill="none"
          stroke={ACCENT_STROKE[accent]}
          strokeWidth={1.5 * inv}
          strokeDasharray={isMulti ? `${4 * inv} ${3 * inv}` : undefined}
        />
      </svg>

      {/* Transform handles — visuals shared with CropOverlay's
          image-mode handles via <Handle>. */}
      {visibleHandles.map((h) => (
        <Handle
          key={h.kind}
          left={h.x}
          top={h.y}
          cursor={h.cursor}
          shape={h.kind === 'rotate' ? 'circle' : 'square'}
          inv={inv}
          ariaLabel={h.ariaLabel}
          accent={accent}
          onPointerDown={(e) => handlePointerDown(e, h.kind)}
        />
      ))}
    </>
  )
}
