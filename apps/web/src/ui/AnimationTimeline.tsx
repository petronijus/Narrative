/**
 * ui/AnimationTimeline.tsx
 *
 * M14 phase 1: horizontal timeline panel for the active slide's animations.
 * Mounts below the canvas in EditorLayout.
 *
 * What this phase does:
 *   - Renders one row per AnimationStep in Y.Array order.
 *   - Each row shows a coloured bar positioned by (computed startSec,
 *     duration) on a px-per-second axis.
 *   - Time ruler at the top (1 s ticks).
 *   - Click a bar to select it (local editor state — not broadcast via
 *     awareness yet).
 *   - Row-local × button removes the step (delegates to removeAnimation).
 *   - Trigger is surfaced via a coloured left-edge chip on the bar.
 *   - Panel is collapsible; state persists in sessionStorage.
 *
 * Out of scope for this phase (follow-ups):
 *   - Drag-to-adjust delay (horizontal drag of bar left edge).
 *   - Drag-to-adjust duration (drag right edge).
 *   - Drag-to-reorder rows (affects afterPrevious chains).
 *   - Trigger dropdown inline — today trigger is edit-only via Inspector.
 *   - Play button + playhead + scrub — next commit.
 *
 * Layout math:
 *   Each step's startSec is derived from its trigger relative to the
 *   previous step (mirrors compileSteps in packages/animation/compiler.ts).
 *   The computed layout is a pure function of the steps array — see
 *   `layoutSteps` below. totalDurationSec drives the viewport width.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import type { AnimationStep, AnimationTrigger } from '@narrative/shared'
import { removeAnimation, reorderAnimations, updateAnimation } from '@narrative/slide-model'
import { createAnimationRuntime, type AnimationRuntime } from '@narrative/animation'
import { useAnimations } from '../state/useAnimations.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { createPixiTargetResolver } from '../animation/targetResolver.js'

// ---------------------------------------------------------------------------
// Layout math
// ---------------------------------------------------------------------------

interface LaidOutStep {
  step: AnimationStep
  startSec: number
}

/**
 * Computes the absolute start time (in seconds) of each step on a GSAP-style
 * timeline, mirroring compileSteps' resolvePosition logic:
 *   - i === 0 or trigger === 'onEnter' → start at 0 + step.delay
 *   - withPrevious                     → start at prev.startSec + step.delay
 *   - afterPrevious or onClick         → start at prev.endSec + step.delay
 *
 * onClick steps appear visually as if afterPrevious — there's no "wait for
 * user input" bar in the current UI (it'd need a separate primitive; this
 * phase keeps the view flat).
 */
export function layoutSteps(steps: AnimationStep[]): LaidOutStep[] {
  const out: LaidOutStep[] = []
  let prevStart = 0
  let prevEnd = 0
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step === undefined) continue
    const delay = step.delay ?? 0
    let startSec: number
    if (i === 0 || step.trigger === 'onEnter') {
      startSec = delay
    } else if (step.trigger === 'withPrevious') {
      startSec = prevStart + delay
    } else {
      // afterPrevious | onClick
      startSec = prevEnd + delay
    }
    out.push({ step, startSec })
    prevStart = startSec
    prevEnd = startSec + (step.duration ?? 0)
  }
  return out
}

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------

const PX_PER_SEC = 80
const ROW_HEIGHT = 28
const RULER_HEIGHT = 18
const BAR_TOP = 4
const BAR_HEIGHT = ROW_HEIGHT - 2 * BAR_TOP
/**
 * Vertical space from one stacked bar's top to the next. Two bars on the
 * same row whose times overlap get placed on separate lanes (computed
 * greedily) and the row grows to accommodate them.
 */
const LANE_GAP = 4
const LANE_STRIDE = BAR_HEIGHT + LANE_GAP

function rowHeightForLanes(lanes: number): number {
  const n = Math.max(1, lanes)
  return 2 * BAR_TOP + n * BAR_HEIGHT + (n - 1) * LANE_GAP
}
/**
 * Sticky left gutter on every row showing the object id (or truncated name).
 * Each row in the timeline corresponds to one SlideObject; its animations
 * all live on the same row, positioned by absolute start time. The label
 * column stays pinned as the track scrolls horizontally so you always know
 * which object's animations you're looking at.
 */
const TRACK_LABEL_WIDTH = 96
/** Legacy alias — the ruler / bar / scrub math refers to it. */
const GRIP_WIDTH = TRACK_LABEL_WIDTH

const COLLAPSE_STORAGE_KEY = 'narrative:animTimeline:collapsed'

function triggerColor(trigger: AnimationTrigger): string {
  switch (trigger) {
    case 'onEnter':
      return 'bg-emerald-500'
    case 'withPrevious':
      return 'bg-sky-500'
    case 'afterPrevious':
      return 'bg-violet-500'
    case 'onClick':
      return 'bg-amber-500'
  }
}

function barBaseClass(selected: boolean, isViewer: boolean): string {
  return [
    'absolute flex items-center gap-1 rounded text-[11px] text-white shadow-sm',
    isViewer ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
    'select-none overflow-hidden',
    'bg-gray-700 hover:bg-gray-600 transition-colors',
    selected ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-gray-900' : '',
  ].join(' ')
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ROW_ORDER_KEY = (slideId: string) => `narrative:animTimeline:rowOrder:${slideId}`

function readRowOrder(slideId: string | null): string[] | null {
  if (slideId === null) return null
  try {
    const raw = sessionStorage.getItem(ROW_ORDER_KEY(slideId))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) return null
    return parsed as string[]
  } catch {
    return null
  }
}

function writeRowOrder(slideId: string | null, order: string[]): void {
  if (slideId === null) return
  try {
    sessionStorage.setItem(ROW_ORDER_KEY(slideId), JSON.stringify(order))
  } catch {
    // storage unavailable — in-memory only for this session
  }
}

export function AnimationTimeline() {
  const { animations, animationsCtx } = useAnimations()
  const { activeSlideId } = useActiveSlide()
  const { role } = useDeckRole()
  const canvasInstance = useCanvasInstance()
  const { objects: slideObjects } = useSlideObjects()
  const isViewer = role === 'viewer'

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Preview playback state. The runtime is created on demand from the current
  // animations snapshot and lives only for the preview session — destroyed on
  // stop/unmount/animations change/canvas swap.
  const runtimeRef = useRef<AnimationRuntime | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const [playheadSec, setPlayheadSec] = useState<number>(0)
  const [isPlaying, setIsPlaying] = useState<boolean>(false)

  // Drag-to-edit state. Two modes:
  //   'body'   → horizontal drag of the bar body adjusts step.delay so the
  //              bar relocates along the timeline relative to its trigger
  //              anchor (0 for onEnter, prev.startSec for withPrevious,
  //              prev.endSec for afterPrevious / onClick). Successors that
  //              chain off this step's end will cascade.
  //   'resize' → horizontal drag of the right-edge grip adjusts step.duration.
  // Writes flow through updateAnimation on each pointermove — Y.Doc is
  // local-first so React picks up the new snapshot immediately and the bar
  // follows the cursor in sync. The drag threshold (3 px) distinguishes
  // a click (→ select) from a drag.
  // Body drag uses the "Premiere mental model": absolute time on the
  // timeline is the source of truth. On first movement the step's trigger
  // is converted to 'onEnter' so delay equals the absolute start time —
  // dragging anywhere on the timeline then just writes delay = newAbsStart.
  // Array order is kept in sync with absolute-time order after every move,
  // so dragging a bar past a neighbour reorders them automatically.
  const dragStateRef = useRef<{
    stepId: string
    mode: 'body' | 'resize'
    startPointerX: number
    originalAbsStart: number
    originalDuration: number
    hasMoved: boolean
    converted: boolean
    /** The lane the dragged bar occupied at drag-start. Re-applied on every
     *  re-layout so the dragged bar doesn't hop lanes while it crosses
     *  neighbours — only the neighbours move out of its way. */
    originalLane: number
  } | null>(null)

  /** Lane assignment seen on the previous render, keyed by step id. Used to
   *  reconstruct the dragged bar's lane on drag-start (since at that point
   *  the drag hasn't produced a new layout yet). */
  const lastLanesRef = useRef<Record<string, number>>({})
  /** Triggers a re-render whenever drag state toggles, so memoised `rows`
   *  recomputes with / without the pinned-lane logic. */
  const [dragStamp, setDragStamp] = useState(0)

  // ---------------------------------------------------------------------------
  // Row-order preference — purely visual, per-slide, in sessionStorage.
  // Does NOT touch Y.Doc or animation semantics. Users can rearrange rows
  // so e.g. "title" row sits on top of "body" row. The compiler keeps
  // reading animations in Y.Array order; only the timeline DOM changes.
  // ---------------------------------------------------------------------------
  const [rowOrderPref, setRowOrderPref] = useState<string[] | null>(() =>
    readRowOrder(activeSlideId),
  )

  // Refresh preference whenever the active slide changes.
  useEffect(() => {
    setRowOrderPref(readRowOrder(activeSlideId))
  }, [activeSlideId])

  // Row-reorder drag state. Vertical drag of the row-grip moves the row in
  // `rowOrderPref` only. `reorderingObjectId` feeds the dragging-row opacity
  // and `dropRowIndex` drives the horizontal drop-indicator line.
  const [reorderingObjectId, setReorderingObjectId] = useState<string | null>(null)
  const [dropRowIndex, setDropRowIndex] = useState<number | null>(null)
  const rowReorderRef = useRef<{
    objectId: string
    startIdx: number
    startPointerY: number
    rowsElement: HTMLDivElement | null
  } | null>(null)

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        sessionStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // storage unavailable — in-memory only
      }
      return next
    })
  }, [])

  const laidOut = useMemo(() => layoutSteps(animations), [animations])

  // Group laidOut steps by objectId. Base order is "first-seen in the
  // current Y.Array". If the user has a saved preference for this slide,
  // apply it: keep preferred ids in their saved positions, then append any
  // new ids (objects that weren't in the pref) at the end, in their natural
  // first-seen order.
  //
  // Within each row, assign bars to lanes via a greedy interval-scheduling
  // sweep: each bar goes on the lowest-indexed lane whose previous bar has
  // already ended. Overlapping bars get separate lanes — the row grows
  // vertically so nothing is visually occluded. Lanes recompute on every
  // render, so dragging through an overlap restacks in real time.
  const rows = useMemo(() => {
    const buckets = new Map<string, LaidOutStep[]>()
    const naturalOrder: string[] = []
    for (const l of laidOut) {
      const oid = l.step.objectId
      const existing = buckets.get(oid)
      if (existing === undefined) {
        buckets.set(oid, [l])
        naturalOrder.push(oid)
      } else {
        existing.push(l)
      }
    }

    let finalOrder = naturalOrder
    if (rowOrderPref !== null) {
      const present = new Set(naturalOrder)
      const ordered = rowOrderPref.filter((id) => present.has(id))
      const appended = naturalOrder.filter((id) => !rowOrderPref.includes(id))
      finalOrder = [...ordered, ...appended]
    }

    const drag = dragStateRef.current
    const pinnedId = drag?.mode === 'body' && drag.hasMoved ? drag.stepId : null
    const pinnedLane = drag?.originalLane ?? 0

    const nextLaneMap: Record<string, number> = {}
    let cumTop = 0
    const result = finalOrder.map((oid) => {
      const items = buckets.get(oid) ?? []
      /** Intervals already claimed per lane — modelled as arrays because the
       *  pinned dragged bar can reserve a lane BEFORE other bars are
       *  processed, leaving gaps that a later bar (earlier in time) might
       *  still fit into. A single "laneEnds" scalar can't express that. */
      const laneIntervals: { start: number; end: number }[][] = []
      const laid: { step: LaidOutStep['step']; startSec: number; lane: number }[] = []

      const overlaps = (lane: number, s: number, e: number) => {
        const laneArr = laneIntervals[lane]
        if (laneArr === undefined) return false
        for (const iv of laneArr) {
          if (!(iv.end <= s + 1e-6 || iv.start >= e - 1e-6)) return true
        }
        return false
      }

      // Pass 1: pin the dragged bar (if any) to its pre-drag lane. Ensure
      // lower-index lanes exist (possibly empty) so the subsequent greedy
      // pass can still claim them.
      const sorted = [...items].sort((a, b) => a.startSec - b.startSec)
      const pinned = pinnedId !== null ? sorted.find((x) => x.step.id === pinnedId) : undefined
      if (pinned !== undefined) {
        while (laneIntervals.length <= pinnedLane) laneIntervals.push([])
        const end = pinned.startSec + (pinned.step.duration ?? 0)
        laneIntervals[pinnedLane]!.push({ start: pinned.startSec, end })
        laid.push({ step: pinned.step, startSec: pinned.startSec, lane: pinnedLane })
        nextLaneMap[pinned.step.id] = pinnedLane
      }

      // Pass 2: non-dragged bars, greedy lowest free lane (not considering
      // any prior preference — so a bar that got pushed up during a drag
      // drops back down the moment the dragged bar moves away).
      for (const it of sorted) {
        if (pinned !== undefined && it.step.id === pinned.step.id) continue
        const start = it.startSec
        const end = start + (it.step.duration ?? 0)
        let lane = -1
        for (let i = 0; i < laneIntervals.length; i++) {
          if (!overlaps(i, start, end)) {
            lane = i
            break
          }
        }
        if (lane === -1) {
          lane = laneIntervals.length
          laneIntervals.push([])
        }
        laneIntervals[lane]!.push({ start, end })
        laid.push({ step: it.step, startSec: start, lane })
        nextLaneMap[it.step.id] = lane
      }

      // Restore the per-time-order sort for downstream consumers that expect
      // items in startSec order.
      laid.sort((a, b) => a.startSec - b.startSec || a.lane - b.lane)

      const lanes = Math.max(1, laneIntervals.length)
      const height = rowHeightForLanes(lanes)
      const top = cumTop
      cumTop += height
      return { objectId: oid, items: laid, lanes, height, top }
    })

    // Stash the fresh lane map as a post-render side-effect. Using a ref is
    // safe across strict-mode double-invocation — the value is deterministic
    // per inputs.
    lastLanesRef.current = nextLaneMap
    return result
    // dragStamp is included so toggling the drag state forces a re-layout
    // without the pinned-lane pass, letting bumped bars drop back down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laidOut, rowOrderPref, dragStamp])

  const rowsTotalHeight = rows.reduce((acc, r) => acc + r.height, 0)
  /** Y-offsets of each row boundary — rows.length + 1 entries (0..total). */
  const rowBoundaries = useMemo(() => {
    const out: number[] = [0]
    let acc = 0
    for (const r of rows) {
      acc += r.height
      out.push(acc)
    }
    return out
  }, [rows])

  const totalSec = useMemo(() => {
    // Minimum 3 s so the ruler always has something useful.
    return laidOut.reduce(
      (max, { step, startSec }) => Math.max(max, startSec + (step.duration ?? 0)),
      3,
    )
  }, [laidOut])

  const trackWidthPx = GRIP_WIDTH + Math.ceil(totalSec * PX_PER_SEC) + 32
  const tickCount = Math.ceil(totalSec) + 1

  const handleRemove = useCallback(
    (stepId: string) => {
      if (animationsCtx === null) return
      removeAnimation(animationsCtx, stepId)
      setSelectedId((prev) => (prev === stepId ? null : prev))
    },
    [animationsCtx],
  )

  // ---------------------------------------------------------------------------
  // Drag to edit (body → delay, right-edge grip → duration)
  // ---------------------------------------------------------------------------

  const MIN_DURATION_SEC = 0.1
  const DRAG_THRESHOLD_PX = 3
  const SNAP_SEC = 0.05
  /** Magnetic snap threshold — a dragged edge within this many seconds of
   *  another bar's start or end (any row) locks onto it. 0.1 s ≈ 8 px at
   *  the current PX_PER_SEC. Hold Shift to disable. */
  const MAGNET_THRESHOLD_SEC = 0.1

  /** Round to the nearest multiple of `step`, suppressed by holding Shift. */
  function quantize(valueSec: number, snap: number): number {
    if (snap <= 0) return valueSec
    return Math.round(valueSec / snap) * snap
  }

  /**
   * Finds the closest candidate within `threshold` of `value`. Returns
   * `value` unchanged when no candidate is within range.
   */
  function magnetSnap(value: number, candidates: number[], threshold: number): number {
    let best = value
    let bestDist = threshold + 1
    for (const c of candidates) {
      const d = Math.abs(c - value)
      if (d < bestDist) {
        bestDist = d
        best = c
      }
    }
    return bestDist <= threshold ? best : value
  }

  const beginDrag = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      step: AnimationStep,
      absStart: number,
      mode: 'body' | 'resize',
    ) => {
      if (isViewer || animationsCtx === null) return
      e.currentTarget.setPointerCapture(e.pointerId)
      e.stopPropagation()
      dragStateRef.current = {
        stepId: step.id,
        mode,
        startPointerX: e.clientX,
        originalAbsStart: absStart,
        originalDuration: step.duration ?? 0,
        hasMoved: false,
        converted: false,
        originalLane: lastLanesRef.current[step.id] ?? 0,
      }
    },
    [isViewer, animationsCtx],
  )

  const handleDragMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragStateRef.current
      if (drag === null || animationsCtx === null) return
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return

      const dx = e.clientX - drag.startPointerX
      if (!drag.hasMoved && Math.abs(dx) < DRAG_THRESHOLD_PX) return
      if (!drag.hasMoved) {
        drag.hasMoved = true
        // Wake up the rows memo so pass-1 pinning engages.
        setDragStamp((s) => s + 1)
      }

      const snap = e.shiftKey ? 0 : SNAP_SEC
      const magnet = e.shiftKey ? 0 : MAGNET_THRESHOLD_SEC

      // Candidate snap points — start and end of every other bar (any row),
      // plus 0. Built from the flat `laidOut` snapshot (which lives in this
      // handler's deps) so the candidates stay fresh as bars move around.
      const candidates: number[] = magnet > 0 ? [0] : []
      if (magnet > 0) {
        for (const l of laidOut) {
          if (l.step.id === drag.stepId) continue
          candidates.push(l.startSec)
          candidates.push(l.startSec + (l.step.duration ?? 0))
        }
      }

      if (drag.mode === 'resize') {
        let newDuration = Math.max(
          MIN_DURATION_SEC,
          quantize(drag.originalDuration + dx / PX_PER_SEC, snap),
        )
        if (magnet > 0) {
          const rawEnd = drag.originalAbsStart + newDuration
          const snapped = magnetSnap(rawEnd, candidates, magnet)
          if (snapped !== rawEnd) {
            newDuration = Math.max(MIN_DURATION_SEC, snapped - drag.originalAbsStart)
          }
        }
        updateAnimation(animationsCtx, drag.stepId, { duration: newDuration })
        return
      }

      // 'body' mode — Premiere-like absolute-time positioning.
      let newAbsStart = Math.max(0, quantize(drag.originalAbsStart + dx / PX_PER_SEC, snap))

      // Magnetic snap: whichever edge (start or end) is closest to a
      // candidate wins. The other edge pulls along so the bar keeps its
      // duration.
      if (magnet > 0) {
        const dur = drag.originalDuration
        const rawStart = newAbsStart
        const rawEnd = newAbsStart + dur
        const startSnap = magnetSnap(rawStart, candidates, magnet)
        const endSnap = magnetSnap(rawEnd, candidates, magnet)
        const startDist = Math.abs(startSnap - rawStart)
        const endDist = Math.abs(endSnap - rawEnd)
        if (startDist <= endDist && startDist <= magnet) {
          newAbsStart = Math.max(0, startSnap)
        } else if (endDist <= magnet) {
          newAbsStart = Math.max(0, endSnap - dur)
        }
      }

      // First movement converts to onEnter so delay == absolute time. This
      // detaches the bar from any afterPrevious / withPrevious chain anchor
      // — subsequent drags are pure absolute writes. Chain-triggered
      // successors downstream may shift visually since their predecessor
      // changed; that's the accepted trade-off for the Premiere model.
      const draggedStep = animations.find((a) => a.id === drag.stepId)
      const patch: Partial<AnimationStep> = { delay: newAbsStart }
      if (!drag.converted && draggedStep !== undefined && draggedStep.trigger !== 'onEnter') {
        ;(patch as { trigger?: AnimationTrigger }).trigger = 'onEnter'
        drag.converted = true
      }
      updateAnimation(animationsCtx, drag.stepId, patch)

      // Sort Y.Array by effective absolute start to keep array order in
      // sync with visual order. Use current laidOut but replace the dragged
      // step's startSec with its new position.
      const currentIdx = animations.findIndex((a) => a.id === drag.stepId)
      if (currentIdx === -1) return
      const effective = laidOut.map((l, i) => ({
        id: l.step.id,
        start: i === currentIdx ? newAbsStart : l.startSec,
      }))
      // Stable sort by start time, preserving current array order for ties.
      const decorated = effective.map((e, i) => ({ ...e, i }))
      decorated.sort((a, b) => a.start - b.start || a.i - b.i)
      const newOrder = decorated.map((e) => e.id)
      const currentOrder = animations.map((a) => a.id)
      if (!newOrder.every((id, i) => id === currentOrder[i])) {
        reorderAnimations(animationsCtx, newOrder)
      }
    },
    [animationsCtx, animations, laidOut],
  )

  const endDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current
    if (drag === null) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    const wasDrag = drag.hasMoved
    dragStateRef.current = null
    // If the pointer never moved past the threshold, treat as click → select.
    if (!wasDrag) {
      setSelectedId(drag.stepId)
    } else {
      // Re-layout without pass-1 pinning so bumped bars drop back down.
      setDragStamp((s) => s + 1)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Row grip drag — vertical reorder of the ROW layout preference only.
  // ---------------------------------------------------------------------------

  const beginRowReorder = useCallback(
    (e: React.PointerEvent<HTMLElement>, objectId: string, startIdx: number) => {
      if (isViewer) return
      e.currentTarget.setPointerCapture(e.pointerId)
      e.stopPropagation()
      const rowsEl = (e.currentTarget as HTMLElement).closest('[data-rows-container]')
      rowReorderRef.current = {
        objectId,
        startIdx,
        startPointerY: e.clientY,
        rowsElement: rowsEl instanceof HTMLDivElement ? rowsEl : null,
      }
      setReorderingObjectId(objectId)
      setDropRowIndex(startIdx)
    },
    [isViewer],
  )

  const handleRowReorderMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const state = rowReorderRef.current
      if (state === null) return
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      const rowsEl = state.rowsElement
      if (rowsEl === null) return
      const bounds = rowsEl.getBoundingClientRect()
      const relY = e.clientY - bounds.top
      // Find the closest boundary (index 0..rows.length).
      let closest = 0
      let closestDist = Infinity
      for (let i = 0; i < rowBoundaries.length; i++) {
        const d = Math.abs(rowBoundaries[i]! - relY)
        if (d < closestDist) {
          closestDist = d
          closest = i
        }
      }
      setDropRowIndex(closest)
    },
    [rowBoundaries],
  )

  const endRowReorder = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const state = rowReorderRef.current
      if (state === null) return
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      const { objectId, startIdx } = state
      const target = dropRowIndex
      rowReorderRef.current = null
      setReorderingObjectId(null)
      setDropRowIndex(null)

      if (target === null) return

      const currentOrder = rows.map((r) => r.objectId)
      const [removed] = currentOrder.splice(startIdx, 1)
      if (removed !== objectId) return
      const adjusted = target > startIdx ? target - 1 : target
      currentOrder.splice(adjusted, 0, objectId)

      // No-op if order unchanged.
      if (currentOrder.every((id, i) => id === rows[i]?.objectId)) return

      setRowOrderPref(currentOrder)
      writeRowOrder(activeSlideId, currentOrder)
    },
    [activeSlideId, dropRowIndex, rows],
  )

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  const resetCanvasFromData = useCallback(() => {
    // Animations mutate Pixi container transforms directly; after preview we
    // want the editor canvas to reflect the committed Y.Doc state again.
    // SceneGraph.render does a full diff — for objects that still exist it
    // calls renderer.update(container, prev, next) which re-applies the
    // canonical transform props. That clears GSAP's lingering mutations.
    canvasInstance?.sceneGraph.render(slideObjects)
  }, [canvasInstance, slideObjects])

  const stopPlayheadLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  const startPlayheadLoop = useCallback(() => {
    stopPlayheadLoop()
    const tick = () => {
      const rt = runtimeRef.current
      if (rt === null) return
      setPlayheadSec(rt.time())
      if (rt.isPlaying()) {
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        // Natural end or external pause — stop looping but keep playhead where it is.
        rafIdRef.current = null
        setIsPlaying(false)
      }
    }
    rafIdRef.current = requestAnimationFrame(tick)
  }, [stopPlayheadLoop])

  const teardownRuntime = useCallback(() => {
    stopPlayheadLoop()
    const rt = runtimeRef.current
    if (rt !== null) {
      rt.destroy()
      runtimeRef.current = null
    }
  }, [stopPlayheadLoop])

  // Any time the animations or canvas changes, the current runtime is stale —
  // tear it down so the next Play recompiles against fresh containers.
  useEffect(() => {
    teardownRuntime()
    setIsPlaying(false)
    setPlayheadSec(0)
    // Intentionally NOT calling resetCanvasFromData here: we only want to
    // reset when the USER stops. An animation add/remove shouldn't visually
    // snap the scene if the user didn't ask for it.
  }, [animations, canvasInstance, teardownRuntime])

  useEffect(() => {
    return () => {
      teardownRuntime()
    }
  }, [teardownRuntime])

  const ensureRuntime = useCallback((): AnimationRuntime | null => {
    if (runtimeRef.current !== null) return runtimeRef.current
    if (canvasInstance === null) return null
    if (animations.length === 0) return null
    const resolver = createPixiTargetResolver(canvasInstance.sceneGraph)
    // No inputBridge — the preview treats onClick like afterPrevious by
    // auto-advancing. That's simpler than wiring a "click the canvas to
    // advance" hint; authors can still test onClick by using Present mode.
    const runtime = createAnimationRuntime(animations, { targetResolver: resolver })
    runtimeRef.current = runtime
    return runtime
  }, [animations, canvasInstance])

  const handlePlayPause = useCallback(() => {
    const rt = ensureRuntime()
    if (rt === null) return
    if (rt.isPlaying()) {
      rt.pause()
      stopPlayheadLoop()
      setIsPlaying(false)
      return
    }
    // If playhead is at end, rewind before playing.
    if (rt.time() >= rt.duration() - 0.001) {
      rt.seek(0)
    }
    rt.play()
    setIsPlaying(true)
    startPlayheadLoop()
  }, [ensureRuntime, startPlayheadLoop, stopPlayheadLoop])

  const handleStop = useCallback(() => {
    teardownRuntime()
    setIsPlaying(false)
    setPlayheadSec(0)
    resetCanvasFromData()
  }, [teardownRuntime, resetCanvasFromData])

  const handleScrub = useCallback(
    (timeSec: number) => {
      const rt = ensureRuntime()
      if (rt === null) return
      const clamped = Math.max(0, Math.min(timeSec, rt.duration()))
      if (rt.isPlaying()) {
        rt.pause()
        stopPlayheadLoop()
        setIsPlaying(false)
      }
      rt.seek(clamped)
      setPlayheadSec(clamped)
    },
    [ensureRuntime, stopPlayheadLoop],
  )

  return (
    <div className="flex flex-shrink-0 flex-col border-t border-border bg-surface-1">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Animations
          </span>
          <span className="text-[10px] text-muted-foreground/60">{animations.length} step(s)</span>
        </div>
        <div className="flex items-center gap-1">
          {!collapsed && !isViewer && (
            <>
              <button
                type="button"
                onClick={handlePlayPause}
                disabled={animations.length === 0 || canvasInstance === null}
                className="rounded-md px-2 py-0.5 text-[10px] text-foreground/80 hover:bg-accent hover:text-primary transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground/80"
                aria-label={isPlaying ? 'Pause animations preview' : 'Play animations preview'}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button
                type="button"
                onClick={handleStop}
                disabled={runtimeRef.current === null && playheadSec === 0}
                className="rounded-md px-2 py-0.5 text-[10px] text-foreground/80 hover:bg-accent hover:text-primary transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground/80"
                aria-label="Stop preview and reset canvas"
                title="Stop and reset canvas"
              >
                ■
              </button>
              <span className="ml-1 font-mono text-[10px] tabular-nums text-muted-foreground/80">
                {playheadSec.toFixed(2)}s
              </span>
            </>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand animations timeline' : 'Collapse animations timeline'}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : 'rotate-0'}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      <div className="collapsible" data-collapsed={collapsed ? 'true' : 'false'}>
        <div className="collapsible-body">
          {/* Scroll viewport separated from the collapsible-body so
              `overflow: hidden` (needed for the grid-rows animation)
              doesn't fight with `overflow: auto` on the same node. */}
          <div
            className="overflow-auto scrollbar-narrative"
            style={{
              height: Math.min(260, RULER_HEIGHT + Math.max(rowsTotalHeight, ROW_HEIGHT) + 8),
            }}
          >
            {laidOut.length === 0 ? (
              <div className="flex items-center justify-center py-6">
                <p className="text-[11px] text-muted-foreground italic">
                  No animations on this slide. Add one from the Inspector.
                </p>
              </div>
            ) : (
              <div style={{ width: trackWidthPx, position: 'relative' }}>
                {/* Ruler — click/drag to scrub */}
                <div
                  className="sticky top-0 z-10 cursor-col-resize border-b border-border bg-surface-1/90 backdrop-blur-glass"
                  style={{ height: RULER_HEIGHT, width: trackWidthPx }}
                  onPointerDown={(e) => {
                    if (isViewer || canvasInstance === null || animations.length === 0) return
                    e.currentTarget.setPointerCapture(e.pointerId)
                    const bounds = e.currentTarget.getBoundingClientRect()
                    handleScrub((e.clientX - bounds.left - GRIP_WIDTH) / PX_PER_SEC)
                  }}
                  onPointerMove={(e) => {
                    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                    const bounds = e.currentTarget.getBoundingClientRect()
                    handleScrub((e.clientX - bounds.left - GRIP_WIDTH) / PX_PER_SEC)
                  }}
                  onPointerUp={(e) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId)
                    }
                  }}
                  role="slider"
                  aria-label="Scrub animations timeline"
                  aria-valuemin={0}
                  aria-valuemax={totalSec}
                  aria-valuenow={playheadSec}
                >
                  {Array.from({ length: tickCount }, (_, i) => (
                    <div
                      key={i}
                      className="absolute flex h-full items-center text-[9px] text-gray-500"
                      style={{ left: GRIP_WIDTH + i * PX_PER_SEC, transform: 'translateX(-50%)' }}
                    >
                      {i}s
                    </div>
                  ))}
                </div>

                {/* Playhead — vertical line spanning all rows + a small chevron at the top */}
                <div
                  className="pointer-events-none absolute top-0 z-20"
                  style={{
                    left: GRIP_WIDTH + Math.round(playheadSec * PX_PER_SEC),
                    height: RULER_HEIGHT + rowsTotalHeight,
                    width: 1,
                    backgroundColor: 'rgb(239 68 68)', // red-500
                  }}
                >
                  <div
                    className="absolute"
                    style={{
                      top: 2,
                      left: -4,
                      width: 0,
                      height: 0,
                      borderLeft: '4px solid transparent',
                      borderRight: '4px solid transparent',
                      borderTop: '6px solid rgb(239 68 68)',
                    }}
                  />
                </div>

                {/* Rows — one per unique objectId (first-seen order + user
                  preference). All animations on an object share the row;
                  overlapping ones stack on separate lanes so nothing gets
                  hidden. */}
                <div className="relative" data-rows-container>
                  {/* Drop-indicator — horizontal guide at the prospective
                    insertion boundary during a row-grip drag. */}
                  {reorderingObjectId !== null && dropRowIndex !== null && (
                    <div
                      className="pointer-events-none absolute left-0 z-30 bg-blue-400"
                      style={{
                        top: (rowBoundaries[dropRowIndex] ?? 0) - 1,
                        height: 2,
                        width: trackWidthPx,
                      }}
                    />
                  )}

                  {rows.map(({ objectId, items, height }, rowIdx) => {
                    const isRowDragged = reorderingObjectId === objectId
                    return (
                      <div
                        key={objectId}
                        className={[
                          'relative border-b divider-soft',
                          rowIdx % 2 === 0 ? 'bg-surface-1' : 'bg-surface-2/50',
                          isRowDragged ? 'opacity-40' : '',
                        ].join(' ')}
                        style={{ height, width: trackWidthPx }}
                      >
                        {/* Sticky-left label column + reorder grip. Stays
                          pinned during horizontal scroll so the row-to-object
                          mapping is always visible. */}
                        <div
                          className="sticky left-0 z-10 flex h-full items-center border-r border-border bg-surface-1/90"
                          style={{ width: TRACK_LABEL_WIDTH }}
                          title={objectId}
                        >
                          {!isViewer && (
                            <div
                              role="button"
                              tabIndex={0}
                              aria-label={`Reorder row ${objectId}`}
                              onPointerDown={(e) => beginRowReorder(e, objectId, rowIdx)}
                              onPointerMove={handleRowReorderMove}
                              onPointerUp={endRowReorder}
                              onPointerCancel={endRowReorder}
                              className="flex h-full w-5 flex-shrink-0 cursor-grab items-center justify-center text-gray-500 hover:text-gray-200 active:cursor-grabbing"
                              style={{ touchAction: 'none' }}
                              title="Drag to reorder row"
                            >
                              <svg
                                aria-hidden="true"
                                width="8"
                                height="14"
                                viewBox="0 0 8 14"
                                fill="currentColor"
                              >
                                <circle cx="1.5" cy="2" r="1" />
                                <circle cx="6.5" cy="2" r="1" />
                                <circle cx="1.5" cy="7" r="1" />
                                <circle cx="6.5" cy="7" r="1" />
                                <circle cx="1.5" cy="12" r="1" />
                                <circle cx="6.5" cy="12" r="1" />
                              </svg>
                            </div>
                          )}
                          <span
                            className="truncate px-1 font-mono text-[10px] text-gray-400"
                            style={{ maxWidth: TRACK_LABEL_WIDTH - 24 }}
                          >
                            {objectId}
                          </span>
                        </div>

                        {/* Bars — one per animation on this object. */}
                        {items.map(({ step, startSec, lane }) => {
                          const isSelected = selectedId === step.id
                          const leftPx = GRIP_WIDTH + Math.round(startSec * PX_PER_SEC)
                          const widthPx = Math.max(
                            Math.round((step.duration ?? 0) * PX_PER_SEC),
                            24,
                          )
                          const dir =
                            (step.params as { direction?: string } | undefined)?.direction ??
                            undefined
                          const label = dir !== undefined ? `${step.preset} (${dir})` : step.preset
                          const barTop = BAR_TOP + lane * LANE_STRIDE

                          return (
                            <div
                              key={step.id}
                              role="button"
                              tabIndex={0}
                              onPointerDown={(e) => beginDrag(e, step, startSec, 'body')}
                              onPointerMove={handleDragMove}
                              onPointerUp={endDrag}
                              onPointerCancel={endDrag}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.stopPropagation()
                                  setSelectedId(step.id)
                                }
                              }}
                              className={barBaseClass(isSelected, isViewer)}
                              style={{
                                left: leftPx,
                                width: widthPx,
                                top: barTop,
                                height: BAR_HEIGHT,
                                touchAction: 'none',
                              }}
                              title={`${label} • trigger: ${step.trigger} • ${(step.duration ?? 0).toFixed(2)}s • delay ${(step.delay ?? 0).toFixed(2)}s`}
                              aria-label={`Animation ${label}, trigger ${step.trigger}`}
                            >
                              {/* Trigger chip — colour-coded by trigger; click
                                opens a native dropdown to switch onEnter /
                                withPrevious / afterPrevious / onClick. The
                                native <select> is used so we get accessible
                                keyboard + platform-appropriate popup without
                                building our own menu + outside-click logic. */}
                              <select
                                className={`flex-shrink-0 appearance-none cursor-pointer ${triggerColor(step.trigger)}`}
                                style={{
                                  width: 6,
                                  height: BAR_HEIGHT,
                                  border: 0,
                                  outline: 'none',
                                  fontSize: 0,
                                  color: 'transparent',
                                }}
                                value={step.trigger}
                                disabled={isViewer}
                                aria-label={`Trigger for ${label}`}
                                title={`Trigger: ${step.trigger}`}
                                onPointerDown={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  if (animationsCtx === null) return
                                  updateAnimation(animationsCtx, step.id, {
                                    trigger: e.target.value as AnimationTrigger,
                                  })
                                }}
                              >
                                <option value="onEnter">onEnter</option>
                                <option value="withPrevious">withPrevious</option>
                                <option value="afterPrevious">afterPrevious</option>
                                <option value="onClick">onClick</option>
                              </select>
                              <span className="truncate px-1">{label}</span>
                              {!isViewer && isSelected && (
                                <select
                                  className="flex-shrink-0 cursor-pointer rounded border border-transparent bg-black/30 px-1 text-[10px] text-gray-200 hover:border-gray-500"
                                  style={{ height: BAR_HEIGHT - 4 }}
                                  value={step.easing ?? 'power2.out'}
                                  aria-label={`Easing for ${label}`}
                                  title={`Easing: ${step.easing ?? 'power2.out'}`}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => {
                                    if (animationsCtx === null) return
                                    updateAnimation(animationsCtx, step.id, {
                                      easing: e.target.value,
                                    })
                                  }}
                                >
                                  <option value="none">linear</option>
                                  <option value="power1.out">power1 out</option>
                                  <option value="power2.out">power2 out</option>
                                  <option value="power2.inOut">power2 in/out</option>
                                  <option value="power3.inOut">power3 in/out</option>
                                  <option value="sine.inOut">sine in/out</option>
                                  <option value="back.out">back out</option>
                                  <option value="bounce.out">bounce out</option>
                                  <option value="elastic.out">elastic out</option>
                                </select>
                              )}
                              {!isViewer && isSelected && (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  aria-label={`Remove animation ${label}`}
                                  className="ml-auto flex h-full w-5 flex-shrink-0 items-center justify-center text-gray-300 hover:bg-red-600/40 hover:text-white"
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleRemove(step.id)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.stopPropagation()
                                      handleRemove(step.id)
                                    }
                                  }}
                                >
                                  ×
                                </span>
                              )}
                              {!isViewer && (
                                <span
                                  aria-label={`Resize ${label}`}
                                  onPointerDown={(e) => {
                                    e.stopPropagation()
                                    beginDrag(e, step, startSec, 'resize')
                                  }}
                                  onPointerMove={handleDragMove}
                                  onPointerUp={endDrag}
                                  onPointerCancel={endDrag}
                                  className="absolute right-0 top-0 h-full w-2 cursor-ew-resize hover:bg-white/20"
                                  style={{ touchAction: 'none' }}
                                />
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
