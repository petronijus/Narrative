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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '../renderer/Canvas'
import { Toolbar } from '../ui/Toolbar'
import { Inspector } from '../ui/Inspector'
import { AnimationTimeline } from '../ui/AnimationTimeline'
import { SlideNotesPanel } from '../ui/SlideNotesPanel'
import { SlidesPanel } from '../ui/SlidesPanel'
import { ResizableSidebar } from '../ui/ResizableSidebar'
import { OverlayScrollbarV, OverlayScrollbarH } from '../ui/OverlayScrollbars'
import { TransformHandles } from '../ui/TransformHandles'
import { LineEndpointHandles } from '../ui/LineEndpointHandles'
import { SnapGuides } from '../ui/SnapGuides'
import { PeerCursors } from '../ui/PeerCursors'
import { PeerSelectionOverlays } from '../ui/PeerSelectionOverlays'
import { EditorShowHighlight, EditorShowNotice } from '../ui/EditorShowOverlay'
import { useEditorShow } from '../ui/useEditorShow'
import { LockBadges } from '../ui/LockBadges'
import { AutofitHeights } from '../ui/AutofitHeights'
import { useTextLayoutTick } from '../ui/useTextLayoutTick'
import { useSelection } from '../state/SelectionContext'
import { useTool } from '../state/ToolContext'
import { useTextEdit } from '../state/TextEditContext'
import { useTableEdit } from '../state/TableEditContext'
import { useCropMode } from '../state/CropModeContext'
import { CropOverlay } from '../ui/CropOverlay'
import { PathPointsOverlay } from '../ui/PathPointsOverlay'
import { MoveToTargetOverlay } from '../ui/MoveToTargetOverlay'
import { useAnimations } from '../state/useAnimations'
import { usePathPointsMode } from '../state/PathPointsModeContext'
import { TextEditOverlay } from '../ui/TextEditOverlay'
import { TableCellEditor } from '../ui/TableCellEditor'
import { TableBorderSelectionOverlay } from '../ui/TableBorderSelectionOverlay'
import { TableChrome } from '../ui/TableChrome'
import { TableRangeHighlight } from '../ui/TableRangeHighlight'
import { EditorVideoPreview } from '../ui/EditorVideoPreview'
import { useSlideObjects } from '../state/useSlideObjects'
import { useSlideDoc } from '../state/useSlideDoc'
import { useUndoManager } from '../state/useUndoManager'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext'
import { useAwarenessUpdater } from '../state/useAwarenessUpdater.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { yMapToPlainObject } from '@narrative/slide-model'
import { useObjectClipboard } from '../state/useObjectClipboard.js'
import { EditorNotice } from '../ui/EditorNotice.js'
import { regularPolygonVertices, triangleVertices } from '@narrative/shared'
import type { SlideObject, SlideObjectType, PathAnchor, TableObject } from '@narrative/shared'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useDevMetrics, FpsOnlyDashboard } from '../observability/index.js'
import type { SnapGuide } from '../editor/snap.js'
import { computeSnap, snapsThisFrame } from '../editor/snap.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { UploadDropZone } from '../ui/UploadDropZone.js'
import { UploadProgressStack } from '../ui/UploadProgressCard.js'
import { StageBgPicker } from '../ui/StageBgPicker.js'
import { ZoomControl } from '../ui/ZoomControl.js'
import { useStageBgColor } from '../state/useStageBgColor.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { useZoomLevel, MIN_ZOOM, MAX_ZOOM } from '../state/useZoomLevel.js'
import { isModHeld, useShortcuts } from '../state/useShortcuts.js'
import { ShortcutsCheatsheet } from '../ui/ShortcutsCheatsheet.js'
import { EditorContextMenu } from '../ui/EditorContextMenu.js'
import { Rulers, GuideOverlay } from '../ui/Rulers.js'
import { useRulers } from '../state/RulersContext.js'
import { useSnapping } from '../state/SnappingContext.js'
import { useDragModifierReplay, type DragPointer } from '../state/useDragModifierReplay.js'
import { useDeckGuides } from '../state/useDeckGuides.js'
import { useCommand } from '../state/useCommand.js'
import { useDefaultObjectFill } from '../state/useDefaultObjectFill.js'
import { PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tap-vs-drag threshold in SCREEN pixels for the table cell-tap gesture.
 * Pointer movement under this distance between down and up commits a
 * tap (enters cell-select mode on the clicked cell); past it the
 * gesture promotes to a regular object-drag of the whole table. Sized
 * to swallow normal hand jitter at any zoom level — kept in client
 * coords on purpose so the feel is the same at 25% and 200%.
 */
const TAP_THRESHOLD_PX = 4

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

/**
 * Inverse-transform a world-space cursor point into a table's local
 * cell coordinates. Returns `{ r, c }` of the cell under the cursor,
 * or `null` when the point falls outside the table's bbox (clicking
 * the rotated halo).
 */
function hitTestTableCell(
  table: TableObject,
  worldX: number,
  worldY: number,
): { r: number; c: number } | null {
  const cx = table.x + table.width / 2
  const cy = table.y + table.height / 2
  const cos = Math.cos(-table.rotation)
  const sin = Math.sin(-table.rotation)
  const dx = worldX - cx
  const dy = worldY - cy
  const localX = cos * dx - sin * dy + table.width / 2
  const localY = sin * dx + cos * dy + table.height / 2
  if (localX < 0 || localX > table.width || localY < 0 || localY > table.height) return null
  const colSum = table.colWidths.reduce((a, b) => a + b, 0) || 1
  const rowSum = table.rowHeights.reduce((a, b) => a + b, 0) || 1
  const sx = table.width / colSum
  const sy = table.height / rowSum
  let acc = 0
  let col = table.colWidths.length - 1
  for (let i = 0; i < table.colWidths.length; i++) {
    acc += (table.colWidths[i] ?? 0) * sx
    if (localX <= acc) {
      col = i
      break
    }
  }
  acc = 0
  let row = table.rowHeights.length - 1
  for (let i = 0; i < table.rowHeights.length; i++) {
    acc += (table.rowHeights[i] ?? 0) * sy
    if (localY <= acc) {
      row = i
      break
    }
  }
  return { r: row, c: col }
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
    // In a unit box, stretched to the drag by the viewBox.
    const vertices =
      draft.tool === 'triangle' ? triangleVertices(1, 1) : regularPolygonVertices(5, 1, 1)
    const points = vertices.map((p) => `${p.x},${p.y}`)
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
  onCanvasReady?: ((instance: CanvasInstance | null) => void) | undefined
  /**
   * M16 P-flatten — when true, the editor shell renders in
   * "component master" mode: slides panel is hidden, slide-creation
   * affordances are gone, and the active doc is treated as a
   * single-slide artboard (the master). Everything else (toolbar,
   * inspector, transform handles, undo, animations) is shared with
   * the deck path so master editing has full editor parity.
   */
  masterMode?: boolean
}

/**
 * P15: localStorage-backed boolean state for sidebar collapse.
 * Identical contract to the panel-collapse pattern in
 * AnimationTimeline / SlideNotesPanel — read once on mount, persist
 * on every change.
 */
function usePersistedBool(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setValueRaw] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored === '1' || stored === 'true') return true
      if (stored === '0' || stored === 'false') return false
      return fallback
    } catch {
      return fallback
    }
  })
  const setValue = useCallback(
    (v: boolean): void => {
      setValueRaw(v)
      try {
        localStorage.setItem(key, v ? '1' : '0')
      } catch {
        // storage unavailable — drop silently
      }
    },
    [key],
  )
  return [value, setValue]
}

export function EditorLayout({ onCanvasReady, masterMode = false }: EditorLayoutProps = {}) {
  const { selectedIds, selectOne, selectMany, toggle, clear, selectedAnimationId } = useSelection()
  const { animations } = useAnimations()
  const { editingId: editingTextId, beginEdit, endEdit } = useTextEdit()
  const {
    active: activeTableCell,
    setActive: setTableCellActive,
    beginEdit: beginTableCellEdit,
    endEdit: endTableCellEdit,
    setRange: setTableCellRange,
    clear: clearTableCellEdit,
  } = useTableEdit()
  const { cropImageId, enterCrop, exitCrop } = useCropMode()
  const { pathPointsId, enterPathPoints, exitPathPoints } = usePathPointsMode()
  const { activeTool, setActiveTool } = useTool()
  const objectDefaults = useDefaultObjectFill()
  // P15: collapse state for the left (Slides) and right (Inspector)
  // sidebars. Persisted per-device via localStorage. Mirrors the
  // existing collapse pattern on AnimationTimeline + SlideNotesPanel.
  const [slidesCollapsed, setSlidesCollapsed] = usePersistedBool(
    'narrative:slidesPanel:collapsed',
    false,
  )
  const [inspectorCollapsed, setInspectorCollapsed] = usePersistedBool(
    'narrative:inspector:collapsed',
    false,
  )
  // P15: mirror the slides panel's live width so the toolbar and
  // bottom panels can inset themselves between the side panels and
  // not extend behind them. The Inspector is fixed-width so its
  // inset is just `inspectorCollapsed ? 36 : 256`.
  const [slidesWidth, setSlidesWidth] = useState(240)
  // masterMode hides the slides panel column entirely — inset is 0 so
  // the toolbar / canvas / timeline stack uses the full width.
  const slidesInset = masterMode ? 0 : slidesCollapsed ? 36 : slidesWidth
  const inspectorInset = inspectorCollapsed ? 36 : 256

  // P15: live heights of the floating toolbar (top) and the bottom
  // chrome stack (AnimationTimeline + SlideNotesPanel) so the custom
  // overlay scrollbars can clear them as the user collapses /
  // expands either group. Two refs + ResizeObserver per box; the
  // result drives `start` / `end` / `perpendicular` on the
  // OverlayScrollbarV / H below.
  const topBarRef = useRef<HTMLDivElement>(null)
  const bottomPanelsRef = useRef<HTMLDivElement>(null)
  const [topBarH, setTopBarH] = useState(40)
  const [bottomPanelsH, setBottomPanelsH] = useState(56)
  useEffect(() => {
    const tEl = topBarRef.current
    const bEl = bottomPanelsRef.current
    if (tEl === null && bEl === null) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = Math.round(entry.contentRect.height)
        if (entry.target === tEl) {
          setTopBarH((prev) => (prev === h ? prev : h))
        } else if (entry.target === bEl) {
          setBottomPanelsH((prev) => (prev === h ? prev : h))
        }
      }
    })
    if (tEl !== null) ro.observe(tEl)
    if (bEl !== null) ro.observe(bEl)
    return () => ro.disconnect()
  }, [])
  const { objects, objectsCtx: mutationCtx } = useSlideObjects()
  const { undo, redo } = useUndoManager()
  const canvasInstance = useCanvasInstance()
  // A growing text box is as tall as it is drawn, whatever its `height`
  // says; snapping measures it so (and re-derives when it reflows).
  const textLayoutTick = useTextLayoutTick(canvasInstance?.sceneGraph ?? null)
  const drawnHeightOf = useCallback(
    (o: SlideObject): number => canvasInstance?.sceneGraph.drawnSize(o.id)?.height ?? o.height,
    [canvasInstance],
  )
  const { role } = useDeckRole()
  const isViewer = role === 'viewer'
  const { color: stageBgColor } = useStageBgColor()
  const { zoom, setZoom, zoomIn, zoomOut, resetZoom } = useZoomLevel()
  // P11: rulers + deck-level guides.
  const { visible: rulersVisible } = useRulers()
  const { enabled: snappingEnabled } = useSnapping()
  const { guides: deckGuides } = useDeckGuides()
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
  const { setCursor, setSelection, setActiveSlide } = useAwarenessUpdater()
  const { activeSlideId } = useActiveSlide()
  // The text box being edited, as commands address its body (stable while
  // the edit lasts, so the overlay's published selection keeps its target).
  const editingTextTarget = useMemo(
    () =>
      editingTextId !== null && activeSlideId !== null
        ? { slide: activeSlideId, object: editingTextId }
        : null,
    [editingTextId, activeSlideId],
  )
  const command = useCommand()
  const objectClipboard = useObjectClipboard()
  const activeSlideIdRef = useRef(activeSlideId)
  activeSlideIdRef.current = activeSlideId

  // Agentic A1: `editor.show` — an agent points this editor at a slide and
  // objects (switch, select, flash; never a document write).
  const editorShow = useEditorShow()

  /** Ref na canvas container div — pro bounding rect výpočty */
  const canvasContainerRef = useRef<HTMLDivElement>(null)

  /** Ref on the scroll container so we can centre the artboard on mount. */
  const stageScrollRef = useRef<HTMLDivElement>(null)

  /**
   * Pending cursor-pivot zoom target. Wheel handler stashes the
   * slide-space point under the cursor + the cursor's viewport offset
   * BEFORE calling setZoom; the recenter-on-zoom useLayoutEffect below
   * consumes this and applies a pivot-aware scroll instead of recentring
   * the artboard. Null for non-wheel zoom paths (keyboard, button,
   * Cmd-0 reset) so they keep the recentre UX.
   */
  const pendingZoomPivotRef = useRef<{
    slideX: number
    slideY: number
    cursorViewportX: number
    cursorViewportY: number
    targetZoom: number
  } | null>(null)

  /** Hand-tool pan state — live while the pointer is held. */
  const panRef = useRef<{
    startX: number
    startY: number
    scrollLeft: number
    scrollTop: number
  } | null>(null)
  /** Middle-mouse pan flag — drives the grabbing cursor while held. */
  const [middlePanning, setMiddlePanning] = useState(false)
  /**
   * Figma-style group isolation: which group the user has "entered"
   * via dbl-click. While set, clicks on a member of this group select
   * the single member instead of promoting to the whole group, and
   * dbl-clicks on members proceed to the type-specific action
   * (crop / path-edit) without breaking the group. Esc or a click
   * outside the group's members exits isolation.
   */
  const [enteredGroupId, setEnteredGroupId] = useState<string | null>(null)
  /**
   * Spacebar-hold pan flag — Figma/Photoshop convention. While held (and no
   * input has focus), the canvas behaves like the hand tool: cursor → grab,
   * left-click + drag pans the artboard.
   */
  const [spaceHeld, setSpaceHeld] = useState(false)
  const spaceHeldRef = useRef(false)
  useEffect(() => {
    spaceHeldRef.current = spaceHeld
  }, [spaceHeld])

  useEffect(() => {
    const isEditable = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      if (el === null) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      return el.isContentEditable === true
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (e.repeat) {
        // Still suppress page-scroll while held, but don't re-toggle state.
        if (spaceHeldRef.current) e.preventDefault()
        return
      }
      if (isEditable(e.target)) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      setSpaceHeld(false)
    }
    const onBlur = () => setSpaceHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

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
    /** The slide the drag started on — every frame's write is addressed to it. */
    slideId: string
  } | null>(null)

  /**
   * Drag state for instance-edit leaf moves. Lives separately from the
   * regular dragRef because the mutation path is different — we write
   * setLeafOverridePatch(instance, leaf, { x, y }) instead of
   * bulkUpdateObjects on slide objects.
   *
   * `innerScale` snapshots the inner letterbox scale at drag-start so
   * the slide-space pointer delta can be converted back into master
   * coordinates (`leaf.x` lives in master space).
   *
   * `moved` is a deadzone gate — pure clicks (no mouse movement) must
   * not write an override or trigger a fit pass, otherwise sub-px
   * pointermove jitter accumulates into visible drift across selections.
   */
  // (removed) leafDragRef — instance leaf-drag state. Components are stamps now.

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
   * M29 Phase 3 — drag-select state for cells inside a TableObject.
   * Set when the user pointerdowns on an already-selected table; cleared
   * on pointerup. `startR/C` is the anchor cell (where the drag began);
   * the resulting `CellRange` in TableEditContext uses (startR, startC)
   * as one corner and the cell under the latest pointer as the other.
   */
  const cellSelectionDragRef = useRef<{
    tableId: string
    startR: number
    startC: number
  } | null>(null)

  /**
   * M29 Phase 3+ — pending tap-vs-drag on an already-selected table.
   * Pointerdown over a table that's in `selectedIds` enters this state
   * (no mutation yet); pointermove past TAP_THRESHOLD_PX promotes it
   * to a regular object drag (move the whole table), pointerup without
   * the promotion commits the tapped cell as the active cell. Pattern
   * mirrors Keynote: drag = move the table, tap = drill into cells.
   */
  const pendingTableTapRef = useRef<{
    tableId: string
    r: number
    c: number
    startClientX: number
    startClientY: number
  } | null>(null)

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
  // Prune selection of ids that no longer exist before broadcasting it.
  // A peer (or a local delete on another slide path) can remove a selected
  // object; without this the stale id lingers in selectedIds, gets broadcast
  // over awareness as a phantom, and downstream objects.find(...) returns
  // undefined. Runs ahead of the awareness broadcast below so peers never see
  // a deleted id.
  //
  // Judged only against a NEW objects snapshot. `objects` is rAF-batched
  // (slide-model subscribeToSlideObjects), so right after a local insert —
  // duplicate, Alt-drag clone, paste — the code selects ids the snapshot
  // does not contain yet. Pruning on that selection change dropped the
  // fresh selection every time (Mod+D, the context menu's Duplicate and
  // Alt-drag all ended with nothing selected). A selected id is stale once
  // a snapshot taken after it was selected still lacks it.
  // ---------------------------------------------------------------------------

  const prunedAgainstObjectsRef = useRef<SlideObject[] | null>(null)
  useEffect(() => {
    if (prunedAgainstObjectsRef.current === objects) return
    prunedAgainstObjectsRef.current = objects
    if (selectedIds.size === 0) return
    const present = new Set(objects.map((o) => o.id))
    let hasStale = false
    for (const id of selectedIds) {
      if (!present.has(id)) {
        hasStale = true
        break
      }
    }
    if (!hasStale) return
    selectMany([...selectedIds].filter((id) => present.has(id)))
  }, [objects, selectedIds, selectMany])

  // ---------------------------------------------------------------------------
  // M8: Selection broadcast → awareness
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setSelection([...selectedIds])
  }, [selectedIds, setSelection])

  // Agentic A1: publish the slide this editor shows, so the server's
  // `editor.context` can tell an agent what "this slide" is. Runs on the
  // first resolution and on every switch; the unmount effect below clears
  // it, so a tab that leaves for present mode stops claiming a slide.
  useEffect(() => {
    setActiveSlide(activeSlideId)
  }, [activeSlideId, setActiveSlide])
  useEffect(() => () => setActiveSlide(null), [setActiveSlide])

  // ---------------------------------------------------------------------------
  // (removed) component-instance edit-mode guard + auto-fit:
  // components are now stamped as primitives, so no per-instance
  // bbox math or active-edit tracking is required.

  // M29 Phase 2: clear table-cell-edit state if the active cell's table
  // disappears (deleted, peer removed it) or selection moves to a non-
  // table object. Mirrors the instance-edit cleanup effect above.
  useEffect(() => {
    if (activeTableCell === null) return
    const t = objects.find((o) => o.id === activeTableCell.tableId)
    if (t === undefined || t.type !== 'table') {
      clearTableCellEdit()
      return
    }
    // Selection moved off the table — drop the editor target so the
    // inspector doesn't show table chrome for an unrelated object.
    if (selectedIds.size > 0 && !selectedIds.has(activeTableCell.tableId)) {
      clearTableCellEdit()
    }
  }, [objects, activeTableCell, selectedIds, clearTableCellEdit])

  // Keep the artboard centred in the viewport on mount AND after every
  // zoom change (zoom-to-artboard-centre UX). Runs in useLayoutEffect
  // so the scroll adjustment is synchronous with the zoom-induced
  // layout change — no visible jump.
  //
  // The scroller is full-bleed under the chrome (top toolbar, side
  // panels, bottom panels) so frosted-glass blur has artboard content
  // to sample. That means clientWidth/clientHeight don't represent the
  // visible channel; we shift the target by half the asymmetric inset
  // so the artboard centres in the *visible* area instead of being
  // partially covered by the bottom panels / inspector.
  useLayoutEffect(() => {
    const scroller = stageScrollRef.current
    const artboard = canvasContainerRef.current
    if (scroller === null || artboard === null) return
    const a = artboard.getBoundingClientRect()
    const s = scroller.getBoundingClientRect()

    // Cursor-pivot path: a wheel handler asked us to keep the slide-space
    // point under the cursor anchored. The artboard rect we just read is
    // post-commit (useLayoutEffect runs after the DOM mutates), so its
    // `.left` already reflects the new zoom + any centring/overflow flip.
    // newAboardContentX = current visual left in content space; the slide
    // point at slideX (in unscaled slide coords) is at slideX * zoom px
    // from the artboard's top-left visually, so:
    //   newCursorContentX = aboardContentX + slideX * zoom
    //   newScrollLeft     = newCursorContentX - cursorViewportX
    const pivot = pendingZoomPivotRef.current
    if (pivot !== null && Math.abs(pivot.targetZoom - zoom) < 1e-6) {
      pendingZoomPivotRef.current = null
      const aboardContentX = a.left - s.left + scroller.scrollLeft
      const aboardContentY = a.top - s.top + scroller.scrollTop
      scroller.scrollLeft = Math.max(
        0,
        aboardContentX + pivot.slideX * zoom - pivot.cursorViewportX,
      )
      scroller.scrollTop = Math.max(0, aboardContentY + pivot.slideY * zoom - pivot.cursorViewportY)
      return
    }

    // Default path: keyboard / button zoom — recentre the artboard in the
    // visible channel (offsetting for the asymmetric chrome insets).
    const centerX = a.left - s.left + scroller.scrollLeft + a.width / 2
    const centerY = a.top - s.top + scroller.scrollTop + a.height / 2
    const channelOffsetX = (slidesInset - inspectorInset) / 2
    const channelOffsetY = (topBarH - bottomPanelsH) / 2
    scroller.scrollLeft = Math.max(0, centerX - scroller.clientWidth / 2 - channelOffsetX)
    scroller.scrollTop = Math.max(0, centerY - scroller.clientHeight / 2 - channelOffsetY)
  }, [zoom, slidesInset, inspectorInset, topBarH, bottomPanelsH])

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
      // Middle mouse button — pan the artboard regardless of active tool.
      // Mirrors the hand-tool drag below; pointermove + pointerup already
      // act on panRef without checking the tool, so this just needs to
      // seed the same state.
      if (e.button === 1) {
        const scroller = stageScrollRef.current
        if (scroller === null) return
        e.preventDefault()
        ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
        panRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          scrollLeft: scroller.scrollLeft,
          scrollTop: scroller.scrollTop,
        }
        setMiddlePanning(true)
        return
      }

      if (e.button !== 0) return

      // Spacebar held — left-click drags the artboard (Figma/Photoshop
      // convention). Reuses the hand-tool pan path.
      if (spaceHeldRef.current) {
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

      // P15: if a text overlay is in inline-edit mode, any pointerdown
      // that reaches the canvas (overlay stops propagation for clicks
      // on the editable itself) ends edit mode. Without this, after
      // focus has been parked in an Inspector keep-focus input, the
      // contenteditable's onBlur no longer fires on subsequent canvas
      // clicks, so edit mode would persist silently.
      if (editingTextId !== null) {
        endEdit()
      }
      // M29 Phase 2: same logic for table cell edit. The table editor
      // overlay stops propagation on clicks inside the contenteditable,
      // so any pointerdown that reaches the canvas means the user
      // clicked outside — exit edit mode so subsequent clicks behave
      // as ordinary canvas gestures.
      if (activeTableCell !== null && activeTableCell.editing) {
        endTableCellEdit()
      }

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

      // Path point-edit: clicking off the anchor dots exits the mode and
      // the click falls through as a regular selection gesture.
      if (pathPointsId !== null) {
        const target = e.target as HTMLElement | null
        const onHandle =
          target !== null && target.closest('[data-path-points-handle="true"]') !== null
        if (!onHandle) {
          exitPathPoints()
          // fall through to normal selection / marquee handling.
        } else {
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
        // P15: Text supports BOTH gestures — click to drop a default-
        // sized point-text box, or drag to define a sized text area.
        // The draft / commit path below handles both: a tiny drag
        // (< minSize threshold in pointerUp) falls back to defaults,
        // a real drag uses the bounding box. Same as Keynote / Figma.
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
          // Drop any cell-edit / drag-range state so the highlight
          // disappears and the inspector reverts to the slide-default
          // panel — leaving a stale range on an unselected table is
          // confusing.
          clearTableCellEdit()
          // Empty-canvas click also exits group isolation, mirroring
          // Figma's behaviour.
          if (enteredGroupId !== null) setEnteredGroupId(null)
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
      // Group isolation: while we've "entered" a group via dbl-click,
      // clicks on its own members select the single member instead of
      // promoting to the whole group. Clicks on objects OUTSIDE the
      // entered group exit isolation and behave normally.
      const inIsolation = enteredGroupId !== null && hitGroupId === enteredGroupId
      if (enteredGroupId !== null && hitGroupId !== enteredGroupId) {
        setEnteredGroupId(null)
      }
      const groupMembers: string[] = inIsolation
        ? [hitId]
        : hitGroupId !== undefined && hitGroupId !== ''
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

      // M29 Phase 3+: pointer over an already-selected table forks on
      // whether we're already in cell-edit mode (an active cell exists
      // on this table):
      //   NOT in cell mode → defer the gesture. Release under
      //     TAP_THRESHOLD_PX = tap, commits cell mode on the clicked
      //     cell. Past the threshold = promote to a normal object
      //     drag of the whole table. This is the Keynote "select
      //     once to grab, double-take to drill in" pattern.
      //   In cell mode → drag-select a cell range from this anchor.
      //     The first click already drilled in; now drags re-anchor
      //     and extend the selection like a spreadsheet does.
      // First click on the table is handled by the normal selection
      // path above — this branch only fires on subsequent pointerdowns.
      if (
        hitObj !== undefined &&
        hitObj.type === 'table' &&
        !inIsolation &&
        selectedIds.has(hitId)
      ) {
        const raw = hitTestTableCell(hitObj, x, y)
        if (raw !== null) {
          // Resolve merge continuation → origin so the cell anchor
          // lands on the visible (origin) cell.
          const target = hitObj.rows[raw.r]?.[raw.c]
          const r =
            target !== undefined && typeof target.mergeOriginR === 'number'
              ? target.mergeOriginR
              : raw.r
          const c =
            target !== undefined && typeof target.mergeOriginC === 'number'
              ? target.mergeOriginC
              : raw.c
          const inCellMode = activeTableCell !== null && activeTableCell.tableId === hitObj.id
          if (inCellMode) {
            // Already in cell mode — start a range drag from this
            // anchor. Re-seeding active here means tap-only also
            // works (1×1 range collapses to active-only in the range
            // setter), and drag-extends produce a fresh selection
            // rather than a confusing extend-from-prior-active.
            cellSelectionDragRef.current = {
              tableId: hitObj.id,
              startR: r,
              startC: c,
            }
            setTableCellActive({ tableId: hitObj.id, r, c })
          } else {
            // Not yet in cell mode — defer tap vs table-drag.
            pendingTableTapRef.current = {
              tableId: hitObj.id,
              r,
              c,
              startClientX: e.clientX,
              startClientY: e.clientY,
            }
          }
          ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
          return
        }
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

      // P15: Alt+drag duplicates instead of moving. Mirrors the Figma /
      // Keynote / Illustrator standard — pressing Alt at pointer-down
      // clones the dragged set in place; the copies become the drag set
      // and follow the cursor while the originals stay put.
      //
      // `object.duplicate` is ONE transaction (fresh ids, the sources'
      // relative z-order, a dragged group becomes its own new group), so
      // the clone and the drag writes that follow are one step on the undo
      // stack: the pointer gesture is (state/undoGestures.ts, opened before
      // this handler runs) — the same mechanism that makes a plain drag one
      // step. With a zero offset each copy starts exactly on its source,
      // crop rect included, so the copies' own snapshot (read back from the
      // document) is the drag's start frame.
      let activeDragIds = dragIds
      let activeInitialPositions = initialPositions
      const dragSlideId = activeSlideIdRef.current
      if (dragSlideId === null) return
      if (e.altKey && mutationCtx !== null && dragIds.length > 0) {
        const out = command.tryRun<{ objectIds: string[] }>('object.duplicate', {
          slide: dragSlideId,
          objects: dragIds,
          offset: { x: 0, y: 0 },
        })
        const copies = (out?.objectIds ?? []).flatMap((id) => {
          const map = mutationCtx.objects.toArray().find((m) => m.get('id') === id)
          return map === undefined ? [] : [yMapToPlainObject(map)]
        })
        if (copies.length > 0) {
          const newIds = copies.map((c) => c.id)
          const newPositions: typeof initialPositions = copies.map((c) => ({
            id: c.id,
            x: c.x,
            y: c.y,
          }))
          activeDragIds = newIds
          activeInitialPositions = newPositions
          selectMany(newIds)
        }
      }

      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      dragRef.current = {
        active: true,
        objectIds: activeDragIds,
        startX: e.clientX,
        startY: e.clientY,
        initialPositions: activeInitialPositions,
        slideId: dragSlideId,
      }
    },
    [
      activeTool,
      objects,
      mutationCtx,
      selectedIds,
      selectOne,
      toggle,
      clear,
      canvasInstance,
      cropImageId,
      exitCrop,
      pathPointsId,
      exitPathPoints,
      enteredGroupId,
      selectMany,
      editingTextId,
      endEdit,
      activeTableCell,
      endTableCellEdit,
      setTableCellActive,
      clearTableCellEdit,
      command,
      isViewer,
    ],
  )

  // ---------------------------------------------------------------------------
  // Object drag frame
  // ---------------------------------------------------------------------------
  //
  // Deliberately NOT object.move (which the nudge and the Inspector's
  // X/Y use): every frame writes ABSOLUTE positions derived from the
  // frozen pointer-down snapshot (`initialPositions`) with
  // `object.update`, whose crop rule carries a cropped picture along
  // by the frame's change against the live value. That makes each
  // frame idempotent — snapping can pull the selection back and forth
  // without drift, and a modifier change can replay the frame with the
  // pointer standing still (`useDragModifierReplay`) — whereas
  // object.move adds a delta to the live value, so a per-frame delta
  // would have to be computed against positions this closure only sees
  // a render late. The write stays one command (one LOCAL_ORIGIN
  // transaction, one Yjs update per frame for the whole selection at
  // 60 Hz), and the frames are one undo step because the pointer
  // gesture is (state/undoGestures.ts), however long the drag takes.
  const dragObjectsFrame = useCallback(
    (pointer: DragPointer) => {
      const drag = dragRef.current
      if (drag === null || !drag.active) return
      const writePositions = (positions: ReadonlyArray<{ id: string; x: number; y: number }>) => {
        command.tryRun('object.update', {
          slide: drag.slideId,
          updates: positions.map((p) => ({ object: p.id, patch: { x: p.x, y: p.y } })),
        })
      }

      // Pointer deltas are screen-px; divide by the current CSS zoom to
      // recover a slide-space delta so the object tracks the cursor 1:1
      // at any zoom level.
      const z = zoomRef.current || 1
      let dx = (pointer.clientX - drag.startX) / z
      let dy = (pointer.clientY - drag.startY) / z

      // Shift constrains the move to the dominant axis. Applies to plain
      // drags AND alt-duplicate drags (the duplicate is created on
      // pointerdown, this branch only moves it).
      if (pointer.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) {
          dy = 0
        } else {
          dx = 0
        }
      }

      // Snapping off for this frame (the toolbar toggle, or ⌘ / Ctrl held
      // against it): the selection follows the pointer freely — no
      // object, guide or grid snap — in whole slide px, so a free drag
      // does not scatter sub-pixel coordinates through the document.
      if (!snapsThisFrame(snappingEnabled, isModHeld(pointer))) {
        setSnapGuides([])
        const stepX = Math.round(dx)
        const stepY = Math.round(dy)
        writePositions(
          drag.initialPositions.map((init) => ({
            id: init.id,
            x: init.x + stepX,
            y: init.y + stepY,
          })),
        )
        return
      }

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
            .map((o) => ({ id: o.id, x: o.x, y: o.y, width: o.width, height: drawnHeightOf(o) }))

          const snapResult = computeSnap(
            {
              x: firstProposed.x,
              y: firstProposed.y,
              width: firstObj.width,
              height: drawnHeightOf(firstObj),
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

          writePositions(
            proposed.map((p) => ({ id: p.id, x: p.x + snapResult.dx, y: p.y + snapResult.dy })),
          )
          return
        }
      }

      writePositions(proposed)
    },
    [command, objects, snappingEnabled],
  )
  const dragModifierReplay = useDragModifierReplay(dragObjectsFrame)

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

      if (canvasCoords !== null && activeSlideIdRef.current !== null) {
        setCursor({
          x: canvasCoords.x,
          y: canvasCoords.y,
          slideId: activeSlideIdRef.current,
        })
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

      // M29 Phase 3+ — pending tap-vs-drag promotion. If the user
      // moved past the screen-space threshold, switch the gesture
      // from "tap → cell mode" to "drag → move the whole table" by
      // setting up dragRef in place; the regular drag branch below
      // takes it from here. Under the threshold we stay pending so
      // pointerup can still commit a cell tap.
      const pendingTap = pendingTableTapRef.current
      if (pendingTap !== null) {
        const sx = e.clientX - pendingTap.startClientX
        const sy = e.clientY - pendingTap.startClientY
        if (Math.hypot(sx, sy) <= TAP_THRESHOLD_PX) return
        const tableObj = objects.find((o) => o.id === pendingTap.tableId)
        pendingTableTapRef.current = null
        const tapSlideId = activeSlideIdRef.current
        if (tableObj === undefined || tableObj.locked === true || tapSlideId === null) return
        dragRef.current = {
          active: true,
          objectIds: [pendingTap.tableId],
          startX: pendingTap.startClientX,
          startY: pendingTap.startClientY,
          initialPositions: [{ id: pendingTap.tableId, x: tableObj.x, y: tableObj.y }],
          slideId: tapSlideId,
        }
        // Fall through — drag branch below now owns the move.
      }

      // M29 Phase 3 — cell-drag-select update. Hit-test the current
      // pointer position against the table's cell grid and write a
      // normalised range covering (startR/C) → (currentR/C). The
      // range setter collapses single-cell ranges to active-only so
      // a click without drag doesn't leave a stale 1×1 range.
      const cellDrag = cellSelectionDragRef.current
      if (cellDrag !== null && canvasCoords !== null) {
        const tableObj = objects.find((o) => o.id === cellDrag.tableId)
        if (tableObj !== undefined && tableObj.type === 'table') {
          const cell = hitTestTableCell(tableObj, canvasCoords.x, canvasCoords.y)
          if (cell !== null) {
            setTableCellRange({
              tableId: cellDrag.tableId,
              r0: cellDrag.startR,
              c0: cellDrag.startC,
              r1: cell.r,
              c1: cell.c,
            })
          }
        }
        return
      }
      // Object drag — see `dragObjectsFrame`.
      if (dragRef.current?.active !== true) return
      dragModifierReplay.track(e)
      dragObjectsFrame(e)
    },
    [objects, setCursor, setTableCellRange, dragObjectsFrame, dragModifierReplay],
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (panRef.current !== null) {
        panRef.current = null
        setMiddlePanning(false)
        return
      }

      // M29 Phase 3+ — tap commit. If the user pointed-down on an
      // already-selected table and released without crossing the
      // promotion threshold, treat it as a tap: enter cell-select
      // mode on the cell that was under the pointer at pointerdown.
      const pendingTap = pendingTableTapRef.current
      if (pendingTap !== null) {
        pendingTableTapRef.current = null
        setTableCellActive({ tableId: pendingTap.tableId, r: pendingTap.r, c: pendingTap.c })
        return
      }
      // M29 Phase 3 — cell-drag-select teardown. setTableCellRange
      // already collapsed single-cell ranges down to active-only, so
      // here we just clear the gesture state.
      if (cellSelectionDragRef.current !== null) {
        cellSelectionDragRef.current = null
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
        const drawSlideId = activeSlideIdRef.current
        if (drawSlideId !== null) {
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
          const colorDefaults =
            dr.tool === 'line' || dr.tool === 'arrow'
              ? objectDefaults.strokeDefaults
              : dr.tool === 'text'
                ? objectDefaults.textColorDefaults
                : dr.tool === 'table'
                  ? {}
                  : objectDefaults.fillDefaults
          const geometry =
            w < minSize && h < minSize
              ? { x: dr.startX, y: dr.startY }
              : dr.tool === 'line' || dr.tool === 'arrow'
                ? {
                    x,
                    y,
                    width: w,
                    height: h,
                    p1: { x: dr.startX - x, y: dr.startY - y },
                    p2: { x: cx - x, y: cy - y },
                  }
                : { x, y, width: w, height: h }
          const out = command.tryRun<{ objectId: string }>('object.create', {
            slide: drawSlideId,
            object: { type: dr.tool, ...geometry, ...colorDefaults },
          })
          // P15: select the freshly created object so the user can
          // immediately drag / resize / edit without re-clicking. Mirrors
          // Figma / Keynote behaviour after a tool-driven create.
          if (out !== null) {
            const created = { id: out.objectId }
            selectOne(created.id)
            // QoL: text dropped from the toolbar enters edit mode immediately —
            // matches Figma/Keynote, saves the otherwise-mandatory double-click.
            // selectAllOnEnter so the first keystroke replaces the placeholder.
            if (dr.tool === 'text') beginEdit(created.id, { selectAllOnEnter: true })
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
      dragModifierReplay.end()
      setSnapGuides([])
    },
    [
      objects,
      canvasInstance,
      selectedIds,
      selectMany,
      setTableCellActive,
      beginEdit,
      command,
      objectDefaults.fillDefaults,
      objectDefaults.strokeDefaults,
      objectDefaults.textColorDefaults,
      selectOne,
      setActiveTool,
    ],
  )

  // M8: Cursor leave — broadcast null (peer offline z canvasu)
  const handlePointerLeave = useCallback(() => {
    setCursor(null)
  }, [setCursor])

  // Clear remote cursor when the user switches slides — without this, the
  // last broadcast cursor (tagged with the previous slideId) lingers in
  // peers' awareness state until the next pointermove on the new slide.
  useEffect(() => {
    setCursor(null)
  }, [activeSlideId, setCursor])

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
      // Group isolation: dbl-click a member of a group we haven't
      // entered yet → "enter" the group and select that member, but
      // DO NOT fall through to the type-specific edit (which for
      // rectangles flattens to a path and would drop the member out
      // of the group). A second dbl-click while in isolation does
      // proceed to crop / point-edit / etc. as usual.
      const hitGroupId = hit.groupId !== undefined && hit.groupId !== '' ? hit.groupId : null
      if (hitGroupId !== null && hitGroupId !== enteredGroupId) {
        setEnteredGroupId(hitGroupId)
        selectOne(hitId)
        return
      }
      if (hit.type === 'text') {
        selectOne(hitId)
        // Page-number text fields render the live deck index; their
        // stored content is intentionally ignored. Block content edit
        // — styling still works through the inspector.
        if (hit.isSlideNumber === true) return
        beginEdit(hitId)
        return
      }
      if (hit.type === 'table') {
        if (isViewer) return
        selectOne(hitId)
        const raw = hitTestTableCell(hit, x, y)
        if (raw === null) return
        // Walk to the merge origin so a double-click anywhere inside
        // a merged cell opens the editor at the origin (where the
        // visible text lives), not on the now-hidden continuation
        // pointer cell.
        const target = hit.rows[raw.r]?.[raw.c]
        const r =
          target !== undefined && typeof target.mergeOriginR === 'number'
            ? target.mergeOriginR
            : raw.r
        const c =
          target !== undefined && typeof target.mergeOriginC === 'number'
            ? target.mergeOriginC
            : raw.c
        beginTableCellEdit({ tableId: hitId, r, c })
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
      if (hit.type === 'path') {
        // Figma-style point edit: dbl-click a path → show draggable
        // anchors. Mutating anchors needs editor permissions.
        if (isViewer) return
        selectOne(hitId)
        enterPathPoints(hitId)
        return
      }
      if (
        hit.type === 'rectangle' ||
        hit.type === 'ellipse' ||
        hit.type === 'triangle' ||
        hit.type === 'polygon'
      ) {
        // Figma "Edit Object" on a parametric shape → the same object as a
        // path tracing its outline (rounded corners and ellipses as bezier
        // arcs), then point-edit. It keeps its id, stacking place,
        // animations and paint; only corner radius / side count become
        // the path itself.
        const slideId = activeSlideIdRef.current
        if (isViewer || slideId === null) return
        const out = command.tryRun<{ objectId: string }>('object.path.fromShape', {
          slide: slideId,
          object: hit.id,
        })
        if (out !== null) {
          selectOne(out.objectId)
          enterPathPoints(out.objectId)
        }
        return
      }
    },
    [
      command,
      canvasInstance,
      objects,
      selectOne,
      beginEdit,
      beginTableCellEdit,
      enterCrop,
      enterPathPoints,
      isViewer,
      enteredGroupId,
    ],
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
      action: 'pen.commit',
      description: 'Commit pen path',
      handler: (e) => {
        const pen = penSessionRef.current
        // Only intercept Enter when a pen session is in progress.
        if (pen === null) return
        e.preventDefault()
        // The session's anchors are already in slide px (handles relative
        // to their anchor): object.path.create fits the box around them.
        const penSlideId = activeSlideIdRef.current
        if (pen.anchors.length >= 2 && penSlideId !== null) {
          command.tryRun('object.path.create', { slide: penSlideId, anchors: pen.anchors })
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
      action: 'selection.clear',
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
        // Path point-edit also wins over selection clearing.
        if (pathPointsId !== null) {
          exitPathPoints()
          return
        }
        // Group isolation also wins over selection clearing.
        if (enteredGroupId !== null) {
          setEnteredGroupId(null)
          return
        }
        // Clear canvas selection on Escape. No preventDefault — other
        // Escape handlers (dropdowns etc.) need to keep working.
        clear()
      },
    },
  ])

  // P15: Ctrl/Cmd + mousewheel zooms the artboard. React attaches
  // wheel listeners as passive, so `preventDefault` inside an
  // `onWheel` handler is silently ignored — the page scrolls under us
  // and the zoom feels broken. Native addEventListener with
  // `{ passive: false }` is the only way to block the page-zoom.
  // Attach to the scrollable stage so the wheel catches anywhere
  // inside the canvas area (backdrop padding included).
  useEffect(() => {
    const el = stageScrollRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      // deltaY is positive on wheel-down (typical zoom-out gesture).
      // Per-tick step roughly matches the zoomIn/Out 1.25× factor but
      // scales smoothly with the wheel delta so trackpad pinch feels
      // natural too. clamp to MIN_ZOOM..MAX_ZOOM.
      const prevZoom = zoomRef.current
      const factor = Math.exp(-e.deltaY / 200)
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prevZoom * factor))
      if (next === prevZoom) return

      // Capture the slide-space point under the cursor + the cursor's
      // viewport offset so the recentre-on-zoom useLayoutEffect can keep
      // that slide point anchored to the cursor instead of jumping to
      // the artboard centre. (Trackpad pinch-zoom expectation; keyboard
      // and button zoom paths leave the pivot ref null and keep the
      // recentre UX.)
      const aboardEl = canvasContainerRef.current
      if (aboardEl !== null) {
        const aboardRect = aboardEl.getBoundingClientRect()
        const scrollerRect = el.getBoundingClientRect()
        pendingZoomPivotRef.current = {
          slideX: (e.clientX - aboardRect.left) / prevZoom,
          slideY: (e.clientY - aboardRect.top) / prevZoom,
          cursorViewportX: e.clientX - scrollerRect.left,
          cursorViewportY: e.clientY - scrollerRect.top,
          targetZoom: next,
        }
      }
      setZoom(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setZoom])

  useShortcuts([
    // Zoom — works in any focused area except inputs (blocked by the
    // global-scope input check). Plain `+` covers `=` on most layouts;
    // include both so US keyboards (Shift+= → `+`) and direct numpad
    // `+` both fire. Mod+0 resets to 100%.
    {
      keys: ['+', '='],
      scope: 'global',
      preventDefault: true,
      action: 'view.zoomIn',
      description: 'Zoom in',
      handler: () => zoomIn(),
    },
    {
      keys: '-',
      scope: 'global',
      preventDefault: true,
      action: 'view.zoomOut',
      description: 'Zoom out',
      handler: () => zoomOut(),
    },
    {
      keys: 'Mod+0',
      scope: 'global',
      preventDefault: true,
      action: 'view.resetZoom',
      description: 'Reset zoom (100%)',
      handler: () => resetZoom(),
    },
    // Undo
    {
      keys: 'Mod+z',
      scope: 'global',
      preventDefault: true,
      action: 'history.undo',
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
      action: 'history.redo',
      description: 'Redo',
      handler: () => {
        redo()
      },
    },
    // Redo alternate — Ctrl+Y (non-mac)
    {
      keys: 'Ctrl+y',
      scope: 'global',
      action: 'history.redo',
      preventDefault: true,
      handler: () => {
        redo()
      },
    },
  ])

  /** The selected objects a person may change: locks are an editor-only guard. */
  const unlockedSelection = (): string[] =>
    [...selectedIds].filter((id) => objects.find((o) => o.id === id)?.locked !== true)

  // Arrow-key nudge (1 px, Shift 10 px). `object.move` is the one correct
  // way to move objects: it carries a cropped image's absolute `imageRect`
  // along with the frame, and it adds the delta to the live position, so
  // key-repeat faster than React re-renders cannot swallow steps. Locked
  // objects stay put.
  const nudgeSelection = (dx: number, dy: number): void => {
    const ids = unlockedSelection()
    if (ids.length === 0 || activeSlideId === null) return
    command.tryRun('object.move', { slide: activeSlideId, objects: ids, dx, dy })
  }

  /** Run a command on the selection, when there is one. */
  const onSelection = (commandId: string, input: Record<string, unknown> = {}): unknown => {
    if (selectedIds.size === 0 || activeSlideId === null) return null
    return command.tryRun(commandId, { slide: activeSlideId, objects: [...selectedIds], ...input })
  }

  // Canvas-scoped shortcuts — only fire when the artboard area has focus.
  useShortcuts([
    {
      keys: ['Delete', 'Backspace'],
      scope: 'canvas',
      action: 'object.delete',
      description: 'Delete selected object(s)',
      handler: () => {
        const ids = unlockedSelection()
        if (ids.length === 0 || activeSlideId === null) return
        const out = command.tryRun('object.delete', { slide: activeSlideId, objects: ids })
        if (out !== null) clear()
      },
    },
    {
      keys: 'Mod+d',
      scope: 'canvas',
      preventDefault: true,
      action: 'object.duplicate',
      description: 'Duplicate selected object(s)',
      handler: () => {
        // One command, one undo step; a selected group comes out as its
        // own new group instead of each copy handled on its own.
        const out = onSelection('object.duplicate', { offset: { x: 20, y: 20 } }) as {
          objectIds: string[]
        } | null
        if (out !== null && out.objectIds.length > 0) selectMany(out.objectIds)
      },
    },
    {
      keys: 'Mod+c',
      scope: 'canvas',
      action: 'object.copy',
      description: 'Copy selected object(s)',
      handler: () => {
        if (selectedIds.size === 0) return
        objectClipboard.copy([...selectedIds])
      },
    },
    {
      keys: 'Mod+v',
      scope: 'canvas',
      preventDefault: true,
      action: 'object.paste',
      description: 'Paste object(s)',
      handler: () => {
        if (!objectClipboard.canPaste()) return
        void objectClipboard.paste({ offset: { x: 10, y: 10 } }).then((ids) => {
          if (ids !== null && ids.length > 0) selectMany(ids)
        })
      },
    },
    {
      keys: 'Mod+g',
      scope: 'canvas',
      preventDefault: true,
      action: 'object.group',
      description: 'Group selected objects',
      handler: () => {
        if (selectedIds.size >= 2) onSelection('object.group')
      },
    },
    {
      keys: 'Mod+Shift+g',
      scope: 'canvas',
      preventDefault: true,
      action: 'object.ungroup',
      description: 'Ungroup selected objects',
      handler: () => {
        onSelection('object.ungroup')
      },
    },
    {
      keys: ']',
      scope: 'canvas',
      preventDefault: true,
      action: 'object.bringForward',
      description: 'Bring forward',
      handler: () => {
        onSelection('object.layer', { move: 'forward' })
      },
    },
    {
      keys: '[',
      scope: 'canvas',
      preventDefault: true,
      action: 'object.sendBackward',
      description: 'Send backward',
      handler: () => {
        onSelection('object.layer', { move: 'backward' })
      },
    },
    {
      keys: 'Mod+]',
      scope: 'canvas',
      preventDefault: true,
      action: 'object.bringToFront',
      description: 'Bring to front',
      handler: () => {
        onSelection('object.layer', { move: 'front' })
      },
    },
    {
      keys: 'Mod+[',
      scope: 'canvas',
      preventDefault: true,
      action: 'object.sendToBack',
      description: 'Send to back',
      handler: () => {
        onSelection('object.layer', { move: 'back' })
      },
    },
    {
      keys: 'Mod+a',
      scope: 'canvas',
      preventDefault: true,
      action: 'selection.all',
      description: 'Select all objects',
      handler: () => {
        selectMany(objects.map((o) => o.id))
      },
    },
    {
      keys: ['ArrowLeft', 'Shift+ArrowLeft'],
      scope: 'canvas',
      preventDefault: true,
      action: 'object.nudge',
      description: 'Nudge left (hold Shift for ×10)',
      handler: (e) => {
        const step = e.shiftKey ? 10 : 1
        nudgeSelection(-step, 0)
      },
    },
    {
      keys: ['ArrowRight', 'Shift+ArrowRight'],
      scope: 'canvas',
      preventDefault: true,
      action: 'object.nudge',
      description: 'Nudge right (hold Shift for ×10)',
      handler: (e) => {
        const step = e.shiftKey ? 10 : 1
        nudgeSelection(step, 0)
      },
    },
    {
      keys: ['ArrowUp', 'Shift+ArrowUp'],
      scope: 'canvas',
      preventDefault: true,
      action: 'object.nudge',
      description: 'Nudge up (hold Shift for ×10)',
      handler: (e) => {
        const step = e.shiftKey ? 10 : 1
        nudgeSelection(0, -step)
      },
    },
    {
      keys: ['ArrowDown', 'Shift+ArrowDown'],
      scope: 'canvas',
      preventDefault: true,
      action: 'object.nudge',
      description: 'Nudge down (hold Shift for ×10)',
      handler: (e) => {
        const step = e.shiftKey ? 10 : 1
        nudgeSelection(0, step)
      },
    },
  ])

  // Cheatsheet: Mod+/ — global so it works from anywhere in the editor.
  useShortcuts([
    {
      keys: 'Mod+/',
      scope: 'global',
      preventDefault: true,
      action: 'view.shortcuts',
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

  // Memoize the snap-target list — `objects` ref churns on Y.Doc batch
  // emissions but the filtered/mapped output is what gets passed to
  // TransformHandles + InstanceEditHandles as a prop. Without memo, every
  // render produces a fresh array reference and breaks downstream
  // memoization in TransformHandles (re-runs snap candidate compute on
  // every parent state tick — zoom, pan, marquee, drag draft).
  const otherBounds = useMemo(
    () =>
      objects
        .filter((o) => !selectedIds.has(o.id))
        .map((o) => ({ id: o.id, x: o.x, y: o.y, width: o.width, height: drawnHeightOf(o) })),
    // textLayoutTick: a growing box reflowed without a document change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objects, selectedIds, drawnHeightOf, textLayoutTick],
  )

  // Memoize the deck-guides derivation — same rationale as otherBounds.
  const extraGuides = useMemo(
    () => deckGuides.map((g) => ({ orientation: g.orientation, position: g.position })),
    [deckGuides],
  )

  // id → object lookup. Several JSX expressions below resolve a selected id
  // back to its object via objects.find(...). With N selected and M total
  // objects that's O(N·M) per render; the Map is O(M) once and O(1) per
  // lookup. Used by editableIds filter, aspectLock check, all-components
  // check, and several IIFE blocks below.
  const objectsById = useMemo(() => {
    const map = new Map<string, (typeof objects)[number]>()
    for (const o of objects) map.set(o.id, o)
    return map
  }, [objects])

  // Cursor style
  const canvasCursor = middlePanning
    ? 'grabbing'
    : spaceHeld
      ? panRef.current !== null
        ? 'grabbing'
        : 'grab'
      : activeTool === 'hand'
        ? panRef.current !== null
          ? 'grabbing'
          : 'grab'
        : activeTool === 'select'
          ? 'default'
          : 'crosshair'

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-background">
      {/* Transient messages (a paste that could not be done, …). Fixed,
          so it sits outside the zoomed artboard. */}
      <EditorNotice />
      {/* Canvas main column extends edge-to-edge underneath the
          panels (stacked first, z-0). Side panels are positioned
          absolutely on top with z-10 so their frosted-glass
          backdrop-filter actually has artboard / stage content
          behind to blur. The flex parent keeps Toolbar / Canvas /
          AnimationTimeline / SlideNotesPanel laid out vertically
          inside main exactly as before. */}

      {/* Left sidebar — slides panel, user-resizable (P3) +
          collapsible (P15). Width animates between collapsed (36 px)
          and the user's stored expanded width.
          masterMode: hidden entirely — masters are single-slide and
          the slides-panel affordances (add / reorder / delete) don't
          apply. */}
      {!masterMode && (
        <div
          data-shortcut-scope="slidePanel"
          className="absolute bottom-0 left-0 z-10 flex"
          style={{ top: topBarH }}
        >
          <ResizableSidebar
            storageKey="narrative:sidebarWidth"
            minWidth={180}
            maxWidth={420}
            defaultWidth={240}
            side="left"
            className="panel border-r border-border"
            collapsed={slidesCollapsed}
            onWidthChange={setSlidesWidth}
            collapsedContent={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSlidesCollapsed(false)}
                aria-label="Show slides panel"
                title="Show slides panel"
                className="mx-auto mt-2 h-7 w-7"
              >
                <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
              </Button>
            }
          >
            <SlidesPanel onCollapse={(): void => setSlidesCollapsed(true)} />
          </ResizableSidebar>
        </div>
      )}

      {/* Toolbar — full-width strip across the top of the editor,
          above the side panels. Sits above the canvas with the
          same frosted-glass `.panel` effect, so the artboard is
          visible behind it just like the side panels. z-20 so it
          covers the side panels (z-10) at their top edge. */}
      <div ref={topBarRef} className="pointer-events-none absolute inset-x-0 top-0 z-20 flex">
        <div className="pointer-events-auto w-full">
          <Toolbar masterMode={masterMode} />
        </div>
      </div>

      {/* Center: canvas area — fills the entire editor; the toolbar
          and bottom panels float above. */}
      <main className="relative z-0 flex flex-1 flex-col overflow-hidden">
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
            onMouseDown={(e) => {
              // Suppress the browser's middle-click autoscroll cursor.
              // Pointer events alone don't always cancel it.
              if (e.button === 1) e.preventDefault()
            }}
            onAuxClick={(e) => {
              if (e.button === 1) e.preventDefault()
            }}
          >
            {/* Scrollable stage: artboard has a fixed size, so the
              backdrop provides scrollbars when the window is smaller.
              P15: insets are PADDING (not margin) so the scroll
              surface itself stays full-bleed under the panels —
              that's what gives `.panel` something real to blur with
              backdrop-filter. Padding keeps the artboard's initial
              resting position in the visible channel between the
              side panels and below the toolbar; the user can still
              scroll the artboard across the full surface and it
              will travel behind the frosted-glass chrome.
              Top: clears the floating Toolbar. Bottom: clears the
              AnimationTimeline + SlideNotesPanel. Both driven by live
              ResizeObserver values so the stage content-box matches the
              visible channel exactly — this is what makes grid
              place-items:center land the artboard in the channel center
              rather than offset toward bottom-right. */}
            <div
              ref={stageScrollRef}
              className="scrollbar-hidden flex-1 overflow-auto"
              data-stage-scroll
              style={{
                paddingLeft: slidesInset,
                paddingRight: inspectorInset,
                paddingTop: topBarH,
                paddingBottom: bottomPanelsH,
              }}
            >
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
                    <Canvas
                      onReady={onCanvasReady}
                      bleedPx={400}
                      artboardSize={canvasSize}
                      zoom={zoom}
                    />

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
                      />
                    )}

                    {/* Marquee selection overlay */}
                    {marquee !== null && <MarqueeOverlay marquee={marquee} />}
                    {draft !== null && <DraftOverlay draft={draft} />}
                    {penSession !== null && <PenPreview anchors={penSession.anchors} />}

                    {/* M8: Peer selection highlights — dashed outlines ve barvách peerů */}
                    <PeerSelectionOverlays />

                    {/* Agentic A1: outline flashed around what an agent showed. */}
                    <EditorShowHighlight
                      highlight={editorShow.highlight}
                      onDone={editorShow.endHighlight}
                    />

                    {/* P5a: padlock badge over each locked object. */}
                    <LockBadges />
                    <AutofitHeights />

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
                      activeSlideId !== null &&
                      (() => {
                        // M16 P8 — while inside instance edit mode, the outer
                        // transform rig is suppressed for the active instance
                        // (the instance outer chrome becomes a faded dashed
                        // border via InstanceEditHandles below). Other selected
                        // objects that are NOT the active instance still get
                        // normal handles.
                        const editableIds = [...selectedIds].filter((sid) => {
                          const o = objectsById.get(sid)
                          if (o === undefined || o.locked === true) return false
                          // While in crop mode, the cropped image is
                          // driven by CropOverlay — suppress the normal
                          // 8-handle transform rig.
                          if (cropImageId !== null && sid === cropImageId) return false
                          // While point-edit is active on this path, hide
                          // the bounding-box handles so the anchor dots
                          // are unobstructed.
                          if (pathPointsId !== null && sid === pathPointsId) return false
                          return true
                        })
                        if (editableIds.length === 0) return null

                        if (editableIds.length === 1) {
                          const onlyId = editableIds[0]
                          const obj = onlyId !== undefined ? objectsById.get(onlyId) : undefined
                          if (obj !== undefined && (obj.type === 'line' || obj.type === 'arrow')) {
                            return <LineEndpointHandles object={obj} slideId={activeSlideId} />
                          }
                        }
                        // P15: aspect-ratio lock now lives on every object
                        // (BaseSlideObject.aspectLocked) and is toggled from
                        // a chain icon in the Inspector's Size section. If
                        // ANY selected object has it on, the resize is
                        // locked; Shift inverts the state mid-drag (XOR
                        // applied in TransformHandles).
                        const aspectLock = editableIds.some((sid) => {
                          const o = objectsById.get(sid)
                          return o?.aspectLocked === true
                        })
                        return (
                          <TransformHandles
                            objectIds={editableIds}
                            sceneGraph={canvasInstance.sceneGraph}
                            slideId={activeSlideId}
                            onSnapGuides={handleSnapGuides}
                            otherBounds={otherBounds}
                            forceAspectLock={aspectLock}
                            extraGuides={extraGuides}
                            objects={objects}
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
                      editingTextTarget !== null &&
                      (() => {
                        const obj = objects.find((o) => o.id === editingTextId)
                        if (obj === undefined || obj.type !== 'text') return null
                        return (
                          <TextEditOverlay obj={obj} target={editingTextTarget} onEnd={endEdit} />
                        )
                      })()}

                    {/* M29 Phase 2: per-cell editor for the first-class
                      TableObject. Mounts only when `tableEdit.active.editing`
                      is true; binds to the cell's Y.Text and handles
                      Tab/Enter navigation across cells. */}
                    {activeTableCell !== null &&
                      activeTableCell.editing &&
                      mutationCtx !== null &&
                      activeSlideId !== null &&
                      (() => {
                        const obj = objects.find((o) => o.id === activeTableCell.tableId)
                        if (obj === undefined || obj.type !== 'table') return null
                        return (
                          <TableCellEditor
                            table={obj}
                            slideId={activeSlideId}
                            mutationCtx={mutationCtx}
                          />
                        )
                      })()}

                    {/* M29 Phase 3: drag-selected cell range highlight. */}
                    <TableRangeHighlight />

                    {/* M29: faint blue grid guides on every cell boundary
                      of a selected table (always visible — survives
                      width-0 / white-on-white borders so the user can
                      always see the cell layout) + a brighter overlay
                      on whichever edges the inspector's border-preset
                      grid is targeting. Mirrors Keynote. */}
                    {selectedIds.size === 1 &&
                      (() => {
                        const onlyId = [...selectedIds][0]
                        if (onlyId === undefined) return null
                        const obj = objects.find((o) => o.id === onlyId)
                        if (obj === undefined || obj.type !== 'table') return null
                        return <TableBorderSelectionOverlay table={obj} />
                      })()}

                    {/* M29 Phase 5: Keynote-style chrome around the
                      selected table (axis bars + corner handles). */}
                    {selectedIds.size === 1 &&
                      activeSlideId !== null &&
                      (() => {
                        const onlyId = [...selectedIds][0]
                        if (onlyId === undefined) return null
                        const obj = objects.find((o) => o.id === onlyId)
                        if (obj === undefined || obj.type !== 'table') return null
                        return (
                          <TableChrome table={obj} slideId={activeSlideId} isViewer={isViewer} />
                        )
                      })()}
                    {/* P11: Keynote-style image crop overlay. */}
                    {cropImageId !== null &&
                      activeSlideId !== null &&
                      (() => {
                        const obj = objects.find((o) => o.id === cropImageId)
                        if (obj === undefined || obj.type !== 'image') return null
                        return <CropOverlay obj={obj} slideId={activeSlideId} />
                      })()}

                    {/* Path point-edit overlay — anchors as draggable dots. */}
                    {pathPointsId !== null &&
                      activeSlideId !== null &&
                      (() => {
                        const obj = objects.find((o) => o.id === pathPointsId)
                        if (obj === undefined || obj.type !== 'path') return null
                        return <PathPointsOverlay obj={obj} slideId={activeSlideId} />
                      })()}

                    {/* moveTo animation target overlay — silhouette + draggable
                        end-point handle when a moveTo step is selected. */}
                    {selectedAnimationId !== null &&
                      activeSlideId !== null &&
                      (() => {
                        const step = animations.find((a) => a.id === selectedAnimationId)
                        if (step === undefined || step.preset !== 'moveTo') return null
                        const obj = objects.find((o) => o.id === step.objectId)
                        if (obj === undefined) return null
                        return (
                          <MoveToTargetOverlay
                            obj={obj}
                            step={step}
                            slideId={activeSlideId}
                            readOnly={isViewer}
                          />
                        )
                      })()}
                  </div>
                </div>
              </div>
            </div>

            {/* StageBgPicker + ZoomControl moved to editor-root level
              (see below) so they can sit in a higher stacking context
              than the toolbar / bottom panels. */}
          </div>
        </EditorContextMenu>
      </main>

      {/* Bottom panels — absolute layer at the bottom of the inner
          channel between the side panels. Same frosted-glass effect,
          same compositing pattern as the toolbar above. */}
      <div
        ref={bottomPanelsRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col"
        style={{ paddingLeft: slidesInset, paddingRight: inspectorInset }}
      >
        <div className="pointer-events-auto w-full" data-shortcut-scope="timeline">
          <AnimationTimeline />
        </div>
        <div className="pointer-events-auto w-full">
          <SlideNotesPanel />
        </div>
      </div>

      {/* Floating canvas controls — StageBgPicker top-right, ZoomControl
          bottom-right. Rendered at editor-root level with z-30 so they
          sit above BOTH the canvas (z-0) and the toolbar / bottom
          panels (z-10). Right inset clears the Inspector. Bottom inset
          clears the SlideNotesPanel toolbar. */}
      <div
        className="pointer-events-none absolute z-30"
        style={{ right: inspectorInset + 12, top: topBarH + 12 }}
      >
        <div className="pointer-events-auto">
          <StageBgPicker />
        </div>
      </div>
      <div
        className="pointer-events-none absolute z-30"
        style={{ right: inspectorInset + 12, bottom: bottomPanelsH + 12 }}
      >
        <div className="pointer-events-auto">
          <ZoomControl
            stageScrollRef={stageScrollRef}
            viewportInsets={{
              top: topBarH,
              right: inspectorInset,
              bottom: bottomPanelsH,
              left: slidesInset,
            }}
          />
        </div>
      </div>

      {/* P15: custom overlay scrollbars — the stage scroll surface is
          full-bleed under the panels (so frosted-glass blur picks up
          artboard content), but the native scrollbars are hidden via
          .scrollbar-hidden. These overlays render thin tracks inside
          the visible channel:
            - Vertical sits flush against the inspector's left edge,
              from just below the toolbar to just above the bottom
              panels.
            - Horizontal sits just above the bottom panels, spanning
              the same x-range as the bottom panels (between the side
              panels).
          All three insets are live: collapsing the toolbar / bottom
          panels / either side panel reflows the scrollbars in the
          next frame via the ResizeObserver above. */}
      <OverlayScrollbarV
        scrollRef={stageScrollRef}
        start={topBarH}
        end={bottomPanelsH}
        perpendicular={inspectorInset}
      />
      <OverlayScrollbarH
        scrollRef={stageScrollRef}
        start={slidesInset}
        end={inspectorInset}
        perpendicular={bottomPanelsH}
      />

      {/* Right sidebar: inspector — collapsible (P15) with width
          animation. Reuses ResizableSidebar even though the user
          can't drag-resize it (min == max == defaultWidth) so the
          collapse animation comes for free. Sits over the canvas
          main column for the frosted-glass backdrop to read the
          artboard behind it. */}
      <div className="absolute bottom-0 right-0 z-10 flex" style={{ top: topBarH }}>
        <ResizableSidebar
          storageKey="narrative:inspectorWidth"
          minWidth={256}
          maxWidth={256}
          defaultWidth={256}
          side="right"
          className="panel border-l border-border"
          collapsed={inspectorCollapsed}
          collapsedContent={
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setInspectorCollapsed(false)}
              aria-label="Show inspector"
              title="Show inspector"
              className="mx-auto mt-2 h-7 w-7"
            >
              <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
            </Button>
          }
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Inspector
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setInspectorCollapsed(true)}
              aria-label="Hide inspector"
              title="Hide inspector"
              className="h-6 w-6"
            >
              <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
          <Inspector />
        </ResizableSidebar>
      </div>

      {import.meta.env.DEV && <DevMetricsOverlay />}

      {/* M11: Upload progress stack — fixed bottom-right, visible across the editor */}
      <UploadProgressStack />

      {/* P9: Keyboard shortcuts cheatsheet — triggered by Mod+/ */}
      <ShortcutsCheatsheet
        open={cheatsheetOpen}
        onClose={() => setCheatsheetOpen(false)}
        dragModifiers
      />

      {/* Agentic A1: an agent's `editor.show` parked while the user edits. */}
      <EditorShowNotice
        pending={editorShow.pending}
        onShow={editorShow.acceptPending}
        onDismiss={editorShow.dismissPending}
      />
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
