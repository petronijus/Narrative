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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Canvas } from '../renderer/Canvas'
import { Toolbar } from '../ui/Toolbar'
import { Inspector } from '../ui/Inspector'
import { AnimationTimeline } from '../ui/AnimationTimeline'
import { SlideNotesPanel } from '../ui/SlideNotesPanel'
import { SlidesPanel } from '../ui/SlidesPanel'
import { ResizableSidebar } from '../ui/ResizableSidebar'
import { TransformHandles } from '../ui/TransformHandles'
import { LineEndpointHandles } from '../ui/LineEndpointHandles'
import { SnapGuides } from '../ui/SnapGuides'
import { PeerCursors } from '../ui/PeerCursors'
import { PeerSelectionOverlays } from '../ui/PeerSelectionOverlays'
import { LockBadges } from '../ui/LockBadges'
import { useSelection } from '../state/SelectionContext'
import { useTool } from '../state/ToolContext'
import { useTextEdit } from '../state/TextEditContext'
import { useCropMode } from '../state/CropModeContext'
import { CropOverlay } from '../ui/CropOverlay'
import { TextEditOverlay } from '../ui/TextEditOverlay'
import { EditorVideoPreview } from '../ui/EditorVideoPreview'
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
  addObjects,
  moveObjectsLayer,
  groupObjects,
  ungroupObjects,
} from '@narrative/slide-model'
import { setClipboard, readClipboardForPaste, hasClipboard } from '../state/clipboard.js'
import type { SlideObjectType, PathAnchor, PathObject } from '@narrative/shared'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useDevMetrics, FpsOnlyDashboard } from '../observability/index.js'
import type { SnapGuide } from '../editor/snap.js'
import { computeSnap } from '../editor/snap.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { UploadDropZone } from '../ui/UploadDropZone.js'
import { UploadProgressStack } from '../ui/UploadProgressCard.js'
import { StageBgPicker } from '../ui/StageBgPicker.js'
import { ZoomControl } from '../ui/ZoomControl.js'
import { useStageBgColor } from '../state/useStageBgColor.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { useShortcuts } from '../state/useShortcuts.js'
import { ShortcutsCheatsheet } from '../ui/ShortcutsCheatsheet.js'
import { EditorContextMenu } from '../ui/EditorContextMenu.js'
import { Rulers, GuideOverlay } from '../ui/Rulers.js'
import { useRulers } from '../state/RulersContext.js'
import { useDeckGuides } from '../state/useDeckGuides.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts viewport (clientX, clientY) coordinates into artboard-local
 * slide coordinates. When the artboard is rendered under a CSS
 * transform:scale, getBoundingClientRect already returns the scaled
 * visual rect — we reverse that scale so slide-coord math stays in
 * unscaled 1920×1080 space.
 */
function clientToCanvasCoords(
  clientX: number,
  clientY: number,
  canvasRect: DOMRect,
  zoom: number = 1,
): { x: number; y: number } {
  const s = zoom === 0 ? 1 : zoom
  return {
    x: (clientX - canvasRect.left) / s,
    y: (clientY - canvasRect.top) / s,
  }
}

/**
 * Applies the Shift-key aspect-ratio constraint to a draft drag
 * outcome. Shapes (rectangle / ellipse / triangle / polygon) snap to
 * a square around the start point. Lines / arrows snap to the
 * nearest 45° increment.
 */
function constrainDraft(
  tool: SlideObjectType,
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): { currentX: number; currentY: number } {
  const dx = currentX - startX
  const dy = currentY - startY
  if (tool === 'line' || tool === 'arrow') {
    const angle = Math.atan2(dy, dx)
    const snap = Math.PI / 4
    const snapped = Math.round(angle / snap) * snap
    const length = Math.hypot(dx, dy)
    return {
      currentX: startX + Math.cos(snapped) * length,
      currentY: startY + Math.sin(snapped) * length,
    }
  }
  const size = Math.max(Math.abs(dx), Math.abs(dy))
  return {
    currentX: startX + Math.sign(dx || 1) * size,
    currentY: startY + Math.sign(dy || 1) * size,
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

function PenPreview({ anchors }: { anchors: PathAnchor[] }) {
  if (anchors.length === 0) return null
  // Build an SVG path from the in-progress anchor list so the user can
  // see the curve taking shape. The SVG itself fills the artboard at
  // 1:1 slide coords (artboard is SLIDE_WIDTH × SLIDE_HEIGHT px).
  let d = `M ${anchors[0]!.x} ${anchors[0]!.y}`
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1]!
    const cur = anchors[i]!
    if (prev.cpOut !== undefined && cur.cpIn !== undefined) {
      const c1x = prev.x + prev.cpOut.x
      const c1y = prev.y + prev.cpOut.y
      const c2x = cur.x + cur.cpIn.x
      const c2y = cur.y + cur.cpIn.y
      d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${cur.x} ${cur.y}`
    } else {
      d += ` L ${cur.x} ${cur.y}`
    }
  }
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ width: '100%', height: '100%', overflow: 'visible' }}
    >
      <path d={d} fill="none" stroke="rgb(96 165 250)" strokeWidth={2} />
      {anchors.map((a, i) => (
        <g key={i}>
          {a.cpIn !== undefined && (
            <line
              x1={a.x}
              y1={a.y}
              x2={a.x + a.cpIn.x}
              y2={a.y + a.cpIn.y}
              stroke="rgb(96 165 250 / 0.5)"
              strokeWidth={1}
            />
          )}
          {a.cpOut !== undefined && (
            <line
              x1={a.x}
              y1={a.y}
              x2={a.x + a.cpOut.x}
              y2={a.y + a.cpOut.y}
              stroke="rgb(96 165 250 / 0.5)"
              strokeWidth={1}
            />
          )}
          <circle cx={a.x} cy={a.y} r={4} fill="white" stroke="rgb(96 165 250)" strokeWidth={2} />
          {a.cpIn !== undefined && (
            <circle cx={a.x + a.cpIn.x} cy={a.y + a.cpIn.y} r={3} fill="rgb(96 165 250)" />
          )}
          {a.cpOut !== undefined && (
            <circle cx={a.x + a.cpOut.x} cy={a.y + a.cpOut.y} r={3} fill="rgb(96 165 250)" />
          )}
        </g>
      ))}
    </svg>
  )
}

function DraftOverlay({
  draft,
}: {
  draft: {
    tool: SlideObjectType
    startX: number
    startY: number
    currentX: number
    currentY: number
  }
}) {
  const x = Math.min(draft.startX, draft.currentX)
  const y = Math.min(draft.startY, draft.currentY)
  const w = Math.abs(draft.currentX - draft.startX)
  const h = Math.abs(draft.currentY - draft.startY)
  if (w < 1 && h < 1) return null

  // Line + arrow: thin coloured segment from start to current.
  if (draft.tool === 'line' || draft.tool === 'arrow') {
    const length = Math.hypot(draft.currentX - draft.startX, draft.currentY - draft.startY)
    const angle = Math.atan2(draft.currentY - draft.startY, draft.currentX - draft.startX)
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{
          left: draft.startX,
          top: draft.startY,
          width: length,
          height: 2,
          background: 'rgb(96 165 250 / 0.85)',
          transform: `rotate(${angle}rad)`,
          transformOrigin: '0 50%',
        }}
      />
    )
  }

  // Ellipse → rounded rect of the same bbox.
  if (draft.tool === 'ellipse') {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute border-2 border-blue-400 bg-blue-400/10"
        style={{ left: x, top: y, width: w, height: h, borderRadius: '50%' }}
      />
    )
  }

  // Triangle / polygon → inline SVG so the preview matches the shape
  // we'll draw on commit, not a misleading rectangle.
  if (draft.tool === 'triangle' || draft.tool === 'polygon') {
    const sides = draft.tool === 'triangle' ? 3 : 5
    const points: string[] = []
    for (let i = 0; i < sides; i++) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / sides
      const px = 0.5 + 0.5 * Math.cos(angle)
      const py = 0.5 + 0.5 * Math.sin(angle)
      points.push(`${px},${py}`)
    }
    return (
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{ left: x, top: y, width: w, height: h, overflow: 'visible' }}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
      >
        <polygon
          points={points.join(' ')}
          fill="rgb(96 165 250 / 0.15)"
          stroke="rgb(96 165 250)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }

  // Rectangle + everything else: outlined AABB.
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute border-2 border-blue-400 bg-blue-400/10"
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
  const { selectedIds, selectOne, selectMany, toggle, clear } = useSelection()
  const { editingId: editingTextId, beginEdit, endEdit } = useTextEdit()
  const { cropImageId, enterCrop, exitCrop } = useCropMode()
  const { activeTool, setActiveTool } = useTool()
  const { objects, objectsCtx: mutationCtx } = useSlideObjects()
  const { undo, redo } = useUndoManager()
  const canvasInstance = useCanvasInstance()
  const { role } = useDeckRole()
  const isViewer = role === 'viewer'
  const { color: stageBgColor } = useStageBgColor()
  const { zoom } = useZoomLevel()
  // P11: rulers + deck-level guides.
  const { visible: rulersVisible } = useRulers()
  const { guides: deckGuides, guidesCtx } = useDeckGuides()
  // Mirror the live guide list into a ref so the pointermove callback's
  // computeSnap(...) call always sees the latest set without forcing a
  // dependency-array churn on the heavy drag handler.
  const deckGuidesRef = useRef(deckGuides)
  deckGuidesRef.current = deckGuides

  // Expose the latest zoom to the pointer callbacks without having to
  // include it in their dependency arrays (which would churn the
  // callbacks on every zoom change).
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // M8: Awareness updater — broadcast cursor + selection
  const { setCursor, setSelection } = useAwarenessUpdater()

  /** Ref na canvas container div — pro bounding rect výpočty */
  const canvasContainerRef = useRef<HTMLDivElement>(null)

  /** Ref on the scroll container so we can centre the artboard on mount. */
  const stageScrollRef = useRef<HTMLDivElement>(null)

  /** Hand-tool pan state — live while the pointer is held. */
  const panRef = useRef<{
    startX: number
    startY: number
    scrollLeft: number
    scrollTop: number
  } | null>(null)

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

  /** Drag-to-draw state for shape / line creation tools. */
  interface DraftState {
    tool: SlideObjectType
    startX: number
    startY: number
    currentX: number
    currentY: number
  }
  const [draft, setDraft] = useState<DraftState | null>(null)
  const draftRef = useRef<DraftState | null>(null)

  /**
   * Pen-tool session — accumulates anchor points while the user is
   * drawing. Anchors live in SLIDE coords (absolute). `dragIndex` is
   * the index of the anchor being shaped (cpOut + symmetric cpIn)
   * while the pointer is held after a pointerdown.
   */
  interface PenSession {
    anchors: PathAnchor[]
    dragIndex: number | null
  }
  const [penSession, setPenSession] = useState<PenSession | null>(null)
  const penSessionRef = useRef<PenSession | null>(null)

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

  // Keep the artboard centred in the viewport on mount AND after every
  // zoom change (zoom-to-artboard-centre UX). Runs in useLayoutEffect
  // so the scroll adjustment is synchronous with the zoom-induced
  // layout change — no visible jump.
  useLayoutEffect(() => {
    const scroller = stageScrollRef.current
    const artboard = canvasContainerRef.current
    if (scroller === null || artboard === null) return
    const a = artboard.getBoundingClientRect()
    const s = scroller.getBoundingClientRect()
    const centerX = a.left - s.left + scroller.scrollLeft + a.width / 2
    const centerY = a.top - s.top + scroller.scrollTop + a.height / 2
    scroller.scrollLeft = Math.max(0, centerX - scroller.clientWidth / 2)
    scroller.scrollTop = Math.max(0, centerY - scroller.clientHeight / 2)
  }, [zoom])

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

      // P11 (Keynote crop): if we're in crop mode and the pointer hit
      // anything other than the crop UI (image-drag overlay or
      // resize handles), exit crop mode and continue processing the
      // click as a regular selection / draw / marquee gesture.
      if (cropImageId !== null) {
        const target = e.target as HTMLElement | null
        const inCropUI =
          target !== null &&
          (target.closest('[data-crop-overlay-image="true"]') !== null ||
            target.closest('[data-crop-overlay-handle="true"]') !== null)
        if (!inCropUI) {
          exitCrop()
          // fall through — the click should still select / start
          // marquee / etc., now in normal-mode terms.
        } else {
          // Pointer is on the crop UI; let the overlay handle it.
          return
        }
      }

      // Hand tool — pan the scroll container while the pointer is held.
      if (activeTool === 'hand') {
        const scroller = stageScrollRef.current
        if (scroller === null) return
        ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
        panRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          scrollLeft: scroller.scrollLeft,
          scrollTop: scroller.scrollTop,
        }
        return
      }

      const containerEl = canvasContainerRef.current
      if (containerEl === null) return

      const rect = containerEl.getBoundingClientRect()
      const { x, y } = clientToCanvasCoords(e.clientX, e.clientY, rect, zoomRef.current)

      if (activeTool !== 'select') {
        // Create tool — viewer cannot create objects
        if (isViewer) return
        if (mutationCtx === null) return
        // Pen tool — multi-click session. Each pointerdown drops a new
        // anchor; the pointer drag between down + up shapes symmetric
        // cubic controls on that anchor. Enter commits, Esc cancels.
        if (activeTool === 'pen') {
          const current = penSessionRef.current
          const newAnchor: PathAnchor = { x, y }
          const anchors = current === null ? [newAnchor] : [...current.anchors, newAnchor]
          const next: PenSession = { anchors, dragIndex: anchors.length - 1 }
          penSessionRef.current = next
          setPenSession({ ...next })
          ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
          return
        }
        // Text + image stay click-to-create; every other creation tool
        // uses drag-to-draw so the user can size the new object in one
        // gesture (Keynote / Figma / Sketch convention).
        if (activeTool === 'text') {
          createObjectOfType(mutationCtx, 'text', { x, y })
          setActiveTool('select')
          return
        }
        draftRef.current = {
          tool: activeTool,
          startX: x,
          startY: y,
          currentX: x,
          currentY: y,
        }
        setDraft({ ...draftRef.current })
        ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
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

      // P6: click on a group member selects the whole group. Shift+click
      // onto a single member still toggles (lets the user peel one member
      // out of the current selection if they really want).
      const hitObj = objects.find((o) => o.id === hitId)
      const hitGroupId = hitObj?.groupId
      const groupMembers: string[] =
        hitGroupId !== undefined && hitGroupId !== ''
          ? objects.filter((o) => o.groupId === hitGroupId).map((o) => o.id)
          : [hitId]

      if (e.shiftKey) {
        // Shift-click: toggle selection, nestart drag
        if (groupMembers.length > 1) {
          // Whole group toggles atomically.
          const anySelected = groupMembers.some((id) => selectedIds.has(id))
          if (anySelected) {
            const next = new Set(selectedIds)
            for (const id of groupMembers) next.delete(id)
            selectMany([...next])
          } else {
            selectMany([...selectedIds, ...groupMembers])
          }
        } else {
          toggle(hitId)
        }
        return
      }

      // Normální klik na objekt: nahraď selection + start drag
      if (groupMembers.length > 1) {
        // If the whole group is already in selection, keep it as-is;
        // otherwise replace selection with the group members.
        const allInSelection = groupMembers.every((id) => selectedIds.has(id))
        if (!allInSelection) selectMany(groupMembers)
      } else if (!selectedIds.has(hitId)) {
        selectOne(hitId)
      }

      // P5a: locked objects can be selected but not moved — filter them out
      // of the drag set. If every hit id is locked, we skip drag entirely so
      // the pointer behaves like a plain selection click.
      const baseDragIds =
        groupMembers.length > 1 || selectedIds.has(hitId)
          ? Array.from(new Set([...selectedIds, ...groupMembers]))
          : [hitId]
      const rawDragIds = baseDragIds
      const dragIds = rawDragIds.filter((id) => {
        const obj = objects.find((o) => o.id === id)
        return obj !== undefined && obj.locked !== true
      })
      if (dragIds.length === 0) return

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
      cropImageId,
      exitCrop,
    ],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Hand-tool pan — scroll the backdrop instead of moving objects.
      const pan = panRef.current
      if (pan !== null) {
        const scroller = stageScrollRef.current
        if (scroller !== null) {
          scroller.scrollLeft = pan.scrollLeft - (e.clientX - pan.startX)
          scroller.scrollTop = pan.scrollTop - (e.clientY - pan.startY)
        }
        return
      }

      // M8: Broadcast cursor position (throttled 30Hz na state-sync straně)
      // Získáme canvas-relative coords jednou a reuse pro marquee i cursor broadcast.
      const containerEl = canvasContainerRef.current
      const canvasCoords =
        containerEl !== null
          ? clientToCanvasCoords(
              e.clientX,
              e.clientY,
              containerEl.getBoundingClientRect(),
              zoomRef.current,
            )
          : null

      if (canvasCoords !== null) {
        setCursor({ x: canvasCoords.x, y: canvasCoords.y })
      }

      // Pen session — shape the outgoing control of the anchor the
      // user just dropped. Symmetric: cpIn = -cpOut.
      const pen = penSessionRef.current
      if (pen !== null && pen.dragIndex !== null) {
        if (canvasCoords !== null) {
          const idx = pen.dragIndex
          const anchor = pen.anchors[idx]
          if (anchor !== undefined) {
            const dx = canvasCoords.x - anchor.x
            const dy = canvasCoords.y - anchor.y
            const newAnchors = pen.anchors.slice()
            newAnchors[idx] = {
              x: anchor.x,
              y: anchor.y,
              cpOut: { x: dx, y: dy },
              cpIn: { x: -dx, y: -dy },
            }
            const next: PenSession = { anchors: newAnchors, dragIndex: idx }
            penSessionRef.current = next
            setPenSession({ ...next })
          }
        }
        return
      }

      // Draft (drag-to-draw) update
      const dr = draftRef.current
      if (dr !== null) {
        if (canvasCoords !== null) {
          const { currentX, currentY } = e.shiftKey
            ? constrainDraft(dr.tool, dr.startX, dr.startY, canvasCoords.x, canvasCoords.y)
            : { currentX: canvasCoords.x, currentY: canvasCoords.y }
          const updated: DraftState = {
            ...dr,
            currentX,
            currentY,
          }
          draftRef.current = updated
          setDraft({ ...updated })
        }
        return
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
      if (mutationCtx === null) return

      // Pointer deltas are screen-px; divide by the current CSS zoom to
      // recover a slide-space delta so the object tracks the cursor 1:1
      // at any zoom level.
      const z = zoomRef.current || 1
      const dx = (e.clientX - drag.startX) / z
      const dy = (e.clientY - drag.startY) / z

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
            10,
            6,
            // P11: deck-level guides feed in as extra snap targets. Read
            // from the ref so the closure always reflects the current set.
            deckGuidesRef.current.map((g) => ({
              orientation: g.orientation,
              position: g.position,
            })),
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
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (panRef.current !== null) {
        panRef.current = null
        return
      }

      // Pen session — just release the current drag (the controls set
      // during pointermove stay on the anchor). If no drag delta, clear
      // the controls so tap-clicks produce polyline segments.
      const pen = penSessionRef.current
      if (pen !== null && pen.dragIndex !== null) {
        const idx = pen.dragIndex
        const a = pen.anchors[idx]
        if (a !== undefined && a.cpOut !== undefined) {
          const len = Math.hypot(a.cpOut.x, a.cpOut.y)
          if (len < 2) {
            const newAnchors = pen.anchors.slice()
            newAnchors[idx] = { x: a.x, y: a.y }
            penSessionRef.current = { anchors: newAnchors, dragIndex: null }
            setPenSession({ anchors: newAnchors, dragIndex: null })
            return
          }
        }
        const next: PenSession = { anchors: pen.anchors, dragIndex: null }
        penSessionRef.current = next
        setPenSession({ ...next })
        return
      }

      // Finalize draft drag-to-draw → create object sized by the rect.
      const dr = draftRef.current
      if (dr !== null) {
        draftRef.current = null
        setDraft(null)
        if (mutationCtx !== null) {
          // Re-apply shift constraint at commit time — handles the
          // case where shift was pressed after the last pointermove.
          const { currentX: cx, currentY: cy } = e.shiftKey
            ? constrainDraft(dr.tool, dr.startX, dr.startY, dr.currentX, dr.currentY)
            : { currentX: dr.currentX, currentY: dr.currentY }
          const x = Math.min(dr.startX, cx)
          const y = Math.min(dr.startY, cy)
          const w = Math.abs(cx - dr.startX)
          const h = Math.abs(cy - dr.startY)
          // Tiny-drag fallback — treat as click-to-create with default size.
          const minSize = 6
          if (w < minSize && h < minSize) {
            createObjectOfType(mutationCtx, dr.tool, { x: dr.startX, y: dr.startY })
          } else if (dr.tool === 'line' || dr.tool === 'arrow') {
            createObjectOfType(mutationCtx, dr.tool, {
              x,
              y,
              width: w,
              height: h,
              p1: { x: dr.startX - x, y: dr.startY - y },
              p2: { x: cx - x, y: cy - y },
            })
          } else {
            createObjectOfType(mutationCtx, dr.tool, { x, y, width: w, height: h })
          }
        }
        setActiveTool('select')
        return
      }

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

  // P7: double-click a text object → enter inline edit mode. Hit-test
  // via the scene graph (same path as single-click select) and begin
  // editing if the hit is a text object. Non-text objects ignore the
  // second click and keep normal selection behaviour.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (canvasInstance === null) return
      const containerEl = canvasContainerRef.current
      if (containerEl === null) return
      const rect = containerEl.getBoundingClientRect()
      const { x, y } = clientToCanvasCoords(e.clientX, e.clientY, rect, zoomRef.current)
      const hitId = canvasInstance.sceneGraph.hitTest(x, y)
      if (hitId === null) return
      const hit = objects.find((o) => o.id === hitId)
      if (hit === undefined) return
      if (hit.type === 'text') {
        selectOne(hitId)
        beginEdit(hitId)
        return
      }
      if (hit.type === 'image') {
        // Keynote-style crop: dbl-click enters crop mode for this image.
        // Editing role only — viewer's selection model still works,
        // but mutating imageRect / frame would no-op anyway.
        if (isViewer) return
        selectOne(hitId)
        enterCrop(hitId)
        return
      }
    },
    [canvasInstance, objects, selectOne, beginEdit, enterCrop, isViewer],
  )

  // ---------------------------------------------------------------------------
  // Cheatsheet modal state
  // ---------------------------------------------------------------------------

  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts — P9 centralised registry
  // ---------------------------------------------------------------------------

  // Pen tool: Enter commits path, Escape cancels. These fire globally because
  // the user shouldn't have to click the canvas first to commit a pen path.
  useShortcuts([
    {
      keys: 'Enter',
      scope: 'global',
      // preventDefault is called conditionally inside handler — only fires
      // when pen tool is active with an in-progress path.
      description: 'Commit pen path',
      handler: (e) => {
        const pen = penSessionRef.current
        // Only intercept Enter when a pen session is in progress.
        if (pen === null) return
        e.preventDefault()
        if (pen.anchors.length >= 2 && mutationCtx !== null) {
          let minX = Infinity
          let minY = Infinity
          let maxX = -Infinity
          let maxY = -Infinity
          for (const a of pen.anchors) {
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
          const rel: PathAnchor[] = pen.anchors.map((a) => {
            const out: PathAnchor = { x: a.x - minX, y: a.y - minY }
            if (a.cpIn !== undefined) out.cpIn = { ...a.cpIn }
            if (a.cpOut !== undefined) out.cpOut = { ...a.cpOut }
            return out
          })
          const override: Partial<PathObject> = {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
            anchors: rel,
          }
          createObjectOfType(mutationCtx, 'path', override)
        }
        penSessionRef.current = null
        setPenSession(null)
        setActiveTool('select')
      },
    },
    {
      keys: 'Escape',
      scope: 'global',
      // No preventDefault here — Escape should still propagate to
      // dropdown-close handlers (StageBgPicker, SlideItemMenu, etc.)
      description: 'Cancel pen path / clear canvas selection',
      handler: (e) => {
        const pen = penSessionRef.current
        if (pen !== null) {
          e.preventDefault()
          penSessionRef.current = null
          setPenSession(null)
          setActiveTool('select')
          return
        }
        // Crop mode wins over plain selection clearing — Esc exits it.
        if (cropImageId !== null) {
          exitCrop()
          return
        }
        // Clear canvas selection on Escape. No preventDefault — other
        // Escape handlers (dropdowns etc.) need to keep working.
        clear()
      },
    },
  ])

  useShortcuts([
    // Undo
    {
      keys: 'Mod+z',
      scope: 'global',
      preventDefault: true,
      description: 'Undo',
      handler: () => {
        undo()
      },
    },
    // Redo — Mod+Shift+Z
    {
      keys: 'Mod+Shift+z',
      scope: 'global',
      preventDefault: true,
      description: 'Redo',
      handler: () => {
        redo()
      },
    },
    // Redo alternate — Ctrl+Y (non-mac)
    {
      keys: 'Ctrl+y',
      scope: 'global',
      preventDefault: true,
      handler: () => {
        redo()
      },
    },
  ])

  // Canvas-scoped shortcuts — only fire when the artboard area has focus.
  useShortcuts([
    {
      keys: ['Delete', 'Backspace'],
      scope: 'canvas',
      description: 'Delete selected object(s)',
      handler: () => {
        if (selectedIds.size > 0 && mutationCtx !== null) {
          let removed = 0
          for (const id of selectedIds) {
            const obj = objects.find((o) => o.id === id)
            if (obj !== undefined && obj.locked === true) continue
            removeObject(mutationCtx, id)
            removed += 1
          }
          if (removed > 0) clear()
        }
      },
    },
    {
      keys: 'Mod+d',
      scope: 'canvas',
      preventDefault: true,
      description: 'Duplicate selected object(s)',
      handler: () => {
        if (selectedIds.size > 0 && mutationCtx !== null) {
          const newIds: string[] = []
          for (const id of selectedIds) {
            const dup = duplicateObject(mutationCtx, id, { x: 20, y: 20 })
            if (dup !== null) newIds.push(dup.id)
          }
          if (newIds.length > 0) selectMany(newIds)
        }
      },
    },
    {
      keys: 'Mod+c',
      scope: 'canvas',
      description: 'Copy selected object(s)',
      handler: () => {
        if (selectedIds.size === 0) return
        const toCopy = [...selectedIds]
          .map((id) => objects.find((o) => o.id === id))
          .filter((o): o is (typeof objects)[number] => o !== undefined)
        setClipboard(toCopy)
      },
    },
    {
      keys: 'Mod+v',
      scope: 'canvas',
      preventDefault: true,
      description: 'Paste object(s)',
      handler: () => {
        if (!hasClipboard() || mutationCtx === null) return
        const pasted = readClipboardForPaste({ x: 10, y: 10 })
        if (pasted === null || pasted.length === 0) return
        addObjects(mutationCtx, pasted)
        selectMany(pasted.map((o) => o.id))
      },
    },
    {
      keys: 'Mod+g',
      scope: 'canvas',
      preventDefault: true,
      description: 'Group selected objects',
      handler: () => {
        if (mutationCtx === null) return
        if (selectedIds.size >= 2) groupObjects(mutationCtx, [...selectedIds])
      },
    },
    {
      keys: 'Mod+Shift+g',
      scope: 'canvas',
      preventDefault: true,
      description: 'Ungroup selected objects',
      handler: () => {
        if (mutationCtx === null) return
        ungroupObjects(mutationCtx, [...selectedIds])
      },
    },
    {
      keys: ']',
      scope: 'canvas',
      preventDefault: true,
      description: 'Bring forward',
      handler: () => {
        if (mutationCtx === null || selectedIds.size === 0) return
        moveObjectsLayer(mutationCtx, [...selectedIds], 'forward')
      },
    },
    {
      keys: '[',
      scope: 'canvas',
      preventDefault: true,
      description: 'Send backward',
      handler: () => {
        if (mutationCtx === null || selectedIds.size === 0) return
        moveObjectsLayer(mutationCtx, [...selectedIds], 'backward')
      },
    },
    {
      keys: 'Mod+]',
      scope: 'canvas',
      preventDefault: true,
      description: 'Bring to front',
      handler: () => {
        if (mutationCtx === null || selectedIds.size === 0) return
        moveObjectsLayer(mutationCtx, [...selectedIds], 'front')
      },
    },
    {
      keys: 'Mod+[',
      scope: 'canvas',
      preventDefault: true,
      description: 'Send to back',
      handler: () => {
        if (mutationCtx === null || selectedIds.size === 0) return
        moveObjectsLayer(mutationCtx, [...selectedIds], 'back')
      },
    },
    {
      keys: 'Mod+a',
      scope: 'canvas',
      preventDefault: true,
      description: 'Select all objects',
      handler: () => {
        selectMany(objects.map((o) => o.id))
      },
    },
    {
      keys: ['ArrowLeft', 'Shift+ArrowLeft'],
      scope: 'canvas',
      preventDefault: true,
      description: 'Nudge left (hold Shift for ×10)',
      handler: (e) => {
        if (selectedIds.size === 0 || mutationCtx === null) return
        const step = e.shiftKey ? 10 : 1
        const updates = [...selectedIds].flatMap((id) => {
          const obj = objects.find((o) => o.id === id)
          if (obj === undefined || obj.locked === true) return []
          return [{ id, patch: { x: obj.x - step, y: obj.y } }]
        })
        if (updates.length > 0) bulkUpdateObjects(mutationCtx, updates)
      },
    },
    {
      keys: ['ArrowRight', 'Shift+ArrowRight'],
      scope: 'canvas',
      preventDefault: true,
      description: 'Nudge right (hold Shift for ×10)',
      handler: (e) => {
        if (selectedIds.size === 0 || mutationCtx === null) return
        const step = e.shiftKey ? 10 : 1
        const updates = [...selectedIds].flatMap((id) => {
          const obj = objects.find((o) => o.id === id)
          if (obj === undefined || obj.locked === true) return []
          return [{ id, patch: { x: obj.x + step, y: obj.y } }]
        })
        if (updates.length > 0) bulkUpdateObjects(mutationCtx, updates)
      },
    },
    {
      keys: ['ArrowUp', 'Shift+ArrowUp'],
      scope: 'canvas',
      preventDefault: true,
      description: 'Nudge up (hold Shift for ×10)',
      handler: (e) => {
        if (selectedIds.size === 0 || mutationCtx === null) return
        const step = e.shiftKey ? 10 : 1
        const updates = [...selectedIds].flatMap((id) => {
          const obj = objects.find((o) => o.id === id)
          if (obj === undefined || obj.locked === true) return []
          return [{ id, patch: { x: obj.x, y: obj.y - step } }]
        })
        if (updates.length > 0) bulkUpdateObjects(mutationCtx, updates)
      },
    },
    {
      keys: ['ArrowDown', 'Shift+ArrowDown'],
      scope: 'canvas',
      preventDefault: true,
      description: 'Nudge down (hold Shift for ×10)',
      handler: (e) => {
        if (selectedIds.size === 0 || mutationCtx === null) return
        const step = e.shiftKey ? 10 : 1
        const updates = [...selectedIds].flatMap((id) => {
          const obj = objects.find((o) => o.id === id)
          if (obj === undefined || obj.locked === true) return []
          return [{ id, patch: { x: obj.x, y: obj.y + step } }]
        })
        if (updates.length > 0) bulkUpdateObjects(mutationCtx, updates)
      },
    },
  ])

  // Cheatsheet: Mod+/ — global so it works from anywhere in the editor.
  useShortcuts([
    {
      keys: 'Mod+/',
      scope: 'global',
      preventDefault: true,
      description: 'Keyboard shortcuts cheatsheet',
      handler: () => {
        setCheatsheetOpen((prev) => !prev)
      },
    },
  ])

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
  const canvasCursor =
    activeTool === 'hand'
      ? panRef.current !== null
        ? 'grabbing'
        : 'grab'
      : activeTool === 'select'
        ? 'default'
        : 'crosshair'

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* Left sidebar — slides panel, user-resizable (P3) */}
      {/* Left sidebar — slides panel. data-shortcut-scope marks it for
          scope-aware shortcut dispatch (P9). */}
      <div data-shortcut-scope="slidePanel" className="contents">
        <ResizableSidebar
          storageKey="narrative:sidebarWidth"
          minWidth={180}
          maxWidth={420}
          defaultWidth={240}
          side="left"
          className="panel border-r border-border overflow-hidden"
        >
          <SlidesPanel />
        </ResizableSidebar>
      </div>

      {/* Center: canvas area */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <Toolbar />

        <EditorContextMenu canvasContainerRef={canvasContainerRef}>
          <div
            className="canvas-backdrop relative flex flex-1 overflow-hidden"
            data-shortcut-scope="canvas"
            style={{
              cursor: canvasCursor,
              ...(stageBgColor !== null ? { background: stageBgColor } : {}),
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onDoubleClick={handleDoubleClick}
          >
            {/* Scrollable stage: artboard has a fixed size, so the
              backdrop provides scrollbars when the window is smaller. */}
            <div ref={stageScrollRef} className="flex flex-1 overflow-auto" data-stage-scroll>
              {/* Stage padding wrapper — 400 px of space around the
                artboard on every side. width:fit-content makes it hug
                the artboard + padding so scrollbars reveal the full
                margin, min-width/min-height:100% stretch the wrapper
                to at least the viewport when it's larger. Grid
                place-items keeps the artboard centered in both
                scenarios without the "stuck to the start" quirk that
                flex centering has when the content overflows. */}
              <div
                style={{
                  width: 'fit-content',
                  minWidth: '100%',
                  minHeight: '100%',
                  padding: 200,
                  boxSizing: 'border-box',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                {/* Zoom wrapper — its layout size is the scaled artboard
                  (so the scroll container knows the real footprint),
                  while the artboard itself is CSS-transformed from the
                  top-left so slide coordinates stay in unscaled 1920×
                  1080 space. Pointer math divides by `zoom` to recover
                  slide coords from the transformed visual bounds. */}
                <div
                  className="relative flex-shrink-0"
                  style={{
                    width: SLIDE_WIDTH * zoom,
                    height: SLIDE_HEIGHT * zoom,
                  }}
                >
                  {/* P11: ruler strips — drawn OUTSIDE the artboard's
                      transform:scale wrapper so the ticks live in
                      screen-space px and stay 24 px thick at any zoom.
                      Their drag-out gesture inserts deck-level guides. */}
                  {rulersVisible && (
                    <Rulers
                      slideWidth={SLIDE_WIDTH}
                      slideHeight={SLIDE_HEIGHT}
                      zoom={zoom}
                      artboardRef={canvasContainerRef}
                      guidesCtx={guidesCtx}
                    />
                  )}
                  <div
                    ref={canvasContainerRef}
                    className="artboard relative rounded-md"
                    style={{
                      width: SLIDE_WIDTH,
                      height: SLIDE_HEIGHT,
                      background: 'hsl(var(--surface-elevated))',
                      overflow: 'visible',
                      transform: `scale(${zoom})`,
                      transformOrigin: 'top left',
                    }}
                  >
                    <Canvas onReady={onCanvasReady} bleedPx={400} artboardSize={canvasSize} />

                    {/* Artboard rim — drawn ABOVE the Pixi canvas since Pixi bleeds
                beyond the artboard rect and would otherwise occlude a border
                on the artboard div. Pointer-events:none to pass clicks
                through to overlays. */}
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-md border border-border shadow-[0_0_0_1px_hsl(var(--border-strong))]"
                    />

                    {/* Snap guide lines — viditelné jen během dragu */}
                    <SnapGuides
                      guides={snapGuides}
                      canvasWidth={canvasSize.width}
                      canvasHeight={canvasSize.height}
                    />

                    {/* P11: deck-level alignment guides. Hidden when
                          the rulers UI is collapsed — the guides only
                          make sense alongside the strips that created
                          them. */}
                    {rulersVisible && (
                      <GuideOverlay
                        guides={deckGuides}
                        slideWidth={SLIDE_WIDTH}
                        slideHeight={SLIDE_HEIGHT}
                        guidesCtx={guidesCtx}
                      />
                    )}

                    {/* Marquee selection overlay */}
                    {marquee !== null && <MarqueeOverlay marquee={marquee} />}
                    {draft !== null && <DraftOverlay draft={draft} />}
                    {penSession !== null && <PenPreview anchors={penSession.anchors} />}

                    {/* M8: Peer selection highlights — dashed outlines ve barvách peerů */}
                    <PeerSelectionOverlays />

                    {/* P5a: padlock badge over each locked object. */}
                    <LockBadges />

                    {/* P8: click-to-play video preview in the editor.
                      Mounted BEFORE TransformHandles so the handles +
                      selection outline + snap guides render ON TOP of
                      the <video> element. EditorVideoPreview itself
                      is pointer-events:none on its wrapper; only the
                      <video> child is interactive. */}
                    {objects
                      .filter((o) => o.type === 'video')
                      .map((vidObj) => (
                        <EditorVideoPreview
                          key={`editor-video-${vidObj.id}`}
                          videoObject={vidObj}
                        />
                      ))}

                    {/* Transform handles — lines/arrows get endpoint handles
                      instead of the 8-handle scale + rotate rig. Locked
                      objects (P5a) skip the handles entirely; the object
                      stays selected (Inspector is still useful for
                      toggling the flag) but can't be dragged / resized. */}
                    {!isViewer &&
                      selectedIds.size > 0 &&
                      canvasInstance !== null &&
                      mutationCtx !== null &&
                      (() => {
                        // Build the subset of selected ids that are editable.
                        const editableIds = [...selectedIds].filter((sid) => {
                          const o = objects.find((x) => x.id === sid)
                          if (o === undefined || o.locked === true) return false
                          // While in crop mode, the cropped image is
                          // driven by CropOverlay — suppress the normal
                          // 8-handle transform rig.
                          if (cropImageId !== null && sid === cropImageId) return false
                          return true
                        })
                        if (editableIds.length === 0) return null

                        if (editableIds.length === 1) {
                          const onlyId = editableIds[0]
                          const obj = objects.find((o) => o.id === onlyId)
                          if (obj !== undefined && (obj.type === 'line' || obj.type === 'arrow')) {
                            return <LineEndpointHandles object={obj} mutationCtx={mutationCtx} />
                          }
                        }
                        // P8: lock aspect ratio when any selected object is a
                        // VideoObject with aspectLocked=true. Resizing then
                        // behaves as if Shift were held (corner handles
                        // preserve native ratio).
                        const aspectLock = editableIds.some((sid) => {
                          const o = objects.find((x) => x.id === sid)
                          return o !== undefined && o.type === 'video' && o.aspectLocked === true
                        })
                        return (
                          <TransformHandles
                            objectIds={editableIds}
                            sceneGraph={canvasInstance.sceneGraph}
                            mutationCtx={mutationCtx}
                            onSnapGuides={handleSnapGuides}
                            otherBounds={otherBounds}
                            forceAspectLock={aspectLock}
                            extraGuides={deckGuides.map((g) => ({
                              orientation: g.orientation,
                              position: g.position,
                            }))}
                          />
                        )
                      })()}

                    {/* M8: Remote peer cursors — DOM overlays přes OverlayCompositor */}
                    <PeerCursors />

                    {/* M11: Drop zone for image uploads — inert for viewer role */}
                    <UploadDropZone canvasContainerRef={canvasContainerRef} />

                    {/* P7: inline text edit overlay. Sits above the Pixi
                      text and takes focus while the user edits. */}
                    {editingTextId !== null &&
                      mutationCtx !== null &&
                      (() => {
                        const obj = objects.find((o) => o.id === editingTextId)
                        if (obj === undefined || obj.type !== 'text') return null
                        return (
                          <TextEditOverlay obj={obj} mutationCtx={mutationCtx} onEnd={endEdit} />
                        )
                      })()}

                    {/* P11: Keynote-style image crop overlay. */}
                    {cropImageId !== null &&
                      mutationCtx !== null &&
                      (() => {
                        const obj = objects.find((o) => o.id === cropImageId)
                        if (obj === undefined || obj.type !== 'image') return null
                        return <CropOverlay obj={obj} mutationCtx={mutationCtx} />
                      })()}
                  </div>
                </div>
              </div>
            </div>

            {/* Stage color picker — absolute to the non-scrolling backdrop
              so it stays pinned to the editor corner while the user
              scrolls the stage. */}
            <div className="pointer-events-none absolute right-3 top-3 z-10">
              <StageBgPicker />
            </div>

            {/* Zoom pill — bottom-right of the stage. Sits above the
              scrollbar so it doesn't collide with it at any zoom. */}
            <div className="pointer-events-none absolute right-3 bottom-6 z-10">
              <ZoomControl stageScrollRef={stageScrollRef} />
            </div>
          </div>
        </EditorContextMenu>

        {/* M14 phase 1: bottom animations timeline panel. Read-only visual
            layout with click-to-select and × to remove. Drag/play in a later
            phase. Collapsible. */}
        <div data-shortcut-scope="timeline">
          <AnimationTimeline />
        </div>

        {/* M19 phase 1: per-slide speaker notes. Plain text for now,
            Tiptap rich text in phase 2. Collapsible. */}
        <SlideNotesPanel />
      </main>

      {/* Right sidebar: inspector */}
      <aside className="panel flex w-64 flex-shrink-0 flex-col border-l border-border">
        <div className="border-b border-border px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Inspector
          </span>
        </div>
        <Inspector />
      </aside>

      {import.meta.env.DEV && <DevMetricsOverlay />}

      {/* M11: Upload progress stack — fixed bottom-right, visible across the editor */}
      <UploadProgressStack />

      {/* P9: Keyboard shortcuts cheatsheet — triggered by Mod+/ */}
      <ShortcutsCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
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
