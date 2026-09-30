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
import { useShortcuts } from '../state/useShortcuts.js'
import { useSelection } from '../state/SelectionContext.js'
import {
  ChevronDown,
  Play,
  Pause,
  Square,
  Clock,
  MousePointerClick,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { AnimationStep, AnimationTrigger, VideoObject } from '@narrative/shared'
import { MAX_STEP_DELAY_S, MAX_STEP_DURATION_S, layoutAnimationSteps } from '@narrative/shared'
import { CommandError } from '@narrative/commands'
import { useCommand } from '../state/useCommand.js'
import { useVideoInfo } from '../state/useVideoInfo.js'
import { createAnimationRuntime, type AnimationRuntime } from '@narrative/animation'
import { getDefaultRenderScheduler } from '../renderer/RenderScheduler'
import { useAnimations } from '../state/useAnimations.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { createPixiTargetResolver } from '../animation/targetResolver.js'
import { triggerOptionsFor } from './animationTriggers.js'

// ---------------------------------------------------------------------------
// Layout math
// ---------------------------------------------------------------------------

interface LaidOutStep {
  step: AnimationStep
  startSec: number
}

/**
 * Each step's start on the timeline (seconds from the slide start) — the
 * shared layout (`layoutAnimationSteps`, @narrative/shared), which is also
 * what `animation.retime` places steps by and what the layout test in
 * packages/animation pins against the compiler. onClick steps are drawn as
 * if the click came when the previous step ended.
 */
function layoutSteps(steps: AnimationStep[]): LaidOutStep[] {
  return layoutAnimationSteps(steps).map(({ step, start }) => ({ step, startSec: start }))
}

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------

const DEFAULT_PX_PER_SEC = 80
const ZOOM_STORAGE_KEY = 'narrative:animTimeline:zoom'
const ZOOM_STEPS = [20, 30, 40, 60, 80, 120, 180, 240, 320] as const
const MIN_ZOOM: number = ZOOM_STEPS[0]
const MAX_ZOOM: number = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? ZOOM_STEPS[0]
const ROW_HEIGHT = 28
/** Width of the trigger icon slot in the bar chrome (px). */
const TRIGGER_ICON_WIDTH = 14
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

/**
 * Icon backdrop colour as an inline rgba string — a slightly-tinted version
 * of the trigger colour, matching the existing chip colour map.
 */
function triggerIconBg(trigger: AnimationTrigger): string {
  switch (trigger) {
    case 'onEnter':
      return 'rgba(16,185,129,0.85)' // emerald-500
    case 'withPrevious':
      return 'rgba(14,165,233,0.85)' // sky-500
    case 'afterPrevious':
      return 'rgba(139,92,246,0.85)' // violet-500
    case 'onClick':
      return 'rgba(245,158,11,0.85)' // amber-500
  }
}

/**
 * Returns the Lucide icon component for a given trigger.
 * auto / withPrevious / afterPrevious → Clock (time-driven)
 * onClick → MousePointerClick (user-driven)
 */
function TriggerIcon({ trigger }: { trigger: AnimationTrigger }) {
  if (trigger === 'onClick') {
    return <MousePointerClick className="h-full w-full" aria-hidden="true" />
  }
  return <Clock className="h-full w-full" aria-hidden="true" />
}

function barBaseClass(selected: boolean, isViewer: boolean): string {
  return [
    'absolute flex items-center gap-1 rounded text-[11px] text-white shadow-xs',
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

/**
 * Resolves the playback trigger for a video. Falls back to the legacy
 * boolean flags when the explicit `videoTrigger` field isn't set so
 * existing decks behave unchanged.
 */
function getVideoTrigger(v: VideoObject): 'onEnter' | 'withPrevious' | 'afterPrevious' | 'onClick' {
  if (v.videoTrigger !== undefined) return v.videoTrigger
  if (v.playOnClick === true) return 'onClick'
  if (v.autoplay === true) return 'onEnter'
  return 'afterPrevious'
}

/**
 * Where the video's clip block should sit on the timeline. Mirrors
 * `layoutSteps` for animations: anchored to the last animation step's
 * start (withPrevious) or end (afterPrevious / onClick), or to slide
 * enter (onEnter). Returns startSec in seconds.
 */
function computeVideoStartSec(v: VideoObject, laidOut: LaidOutStep[]): number {
  const trigger = getVideoTrigger(v)
  const delay = v.videoDelay ?? 0
  if (trigger === 'onEnter') return Math.max(0, delay)
  if (laidOut.length === 0) return Math.max(0, delay)
  const last = laidOut[laidOut.length - 1]!
  if (trigger === 'withPrevious') return Math.max(0, last.startSec + delay)
  return Math.max(0, last.startSec + (last.step.duration ?? 0) + delay)
}

interface VideoClipBarProps {
  video: VideoObject
  startSec: number
  pxPerSec: number
  laidOut: LaidOutStep[]
  slideId: string | null
  isViewer: boolean
  selected: boolean
  onSelect: () => void
  /** Publishes the resolved clip duration so the parent can extend its
   *  total track length to fit the video. Called whenever the loaded
   *  durationSec changes for this video. */
  onClipDuration: (videoId: string, clipDurationSec: number) => void
}

/**
 * Read-only-ish clip block for a video on the animation timeline. The
 * block's WIDTH is the clip duration (trim range or full duration);
 * dragging the BODY sets `videoDelay` (object.update) so the start can be
 * timed after another animation. Drag math mirrors the animation-bar drag:
 * pointer-down captures originalDelay + originalStartSec; pointermove
 * computes a new delay relative to the trigger anchor. The delay is never
 * negative (the object schema): the clip cannot start before its anchor.
 */
function VideoClipBar({
  video,
  startSec,
  pxPerSec,
  laidOut,
  slideId,
  isViewer,
  selected,
  onSelect,
  onClipDuration,
}: VideoClipBarProps) {
  const command = useCommand()
  const { info } = useVideoInfo(video.assetId !== '' ? video.assetId : null)
  const fullDur = info?.durationSec ?? 0
  const trimStart = video.trimStart ?? 0
  const trimEnd = video.trimEnd !== undefined && video.trimEnd > 0 ? video.trimEnd : fullDur
  const clipDur = trimEnd > trimStart ? trimEnd - trimStart : fullDur > 0 ? fullDur : 4

  // Publish the clip duration up so the timeline's totalSec extends
  // to cover the video. Without this the ruler / playhead can't reach
  // the video's tail.
  useEffect(() => {
    onClipDuration(video.id, clipDur)
  }, [video.id, clipDur, onClipDuration])

  const dragRef = useRef<{
    startPointerX: number
    originalDelay: number
    anchorSec: number
  } | null>(null)

  const trigger = getVideoTrigger(video)

  // Anchor (the t at which delay=0 lands the bar's left edge) — needed
  // to translate pointer dx → new delay during drag.
  const anchorSec = (() => {
    if (trigger === 'onEnter') return 0
    if (laidOut.length === 0) return 0
    const last = laidOut[laidOut.length - 1]!
    if (trigger === 'withPrevious') return last.startSec
    return last.startSec + (last.step.duration ?? 0)
  })()

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    if (isViewer || slideId === null) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    dragRef.current = {
      startPointerX: e.clientX,
      originalDelay: video.videoDelay ?? 0,
      anchorSec,
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || slideId === null) return
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const dxSec = (e.clientX - drag.startPointerX) / pxPerSec
    const nextDelay = Math.max(0, drag.originalDelay + dxSec)
    const patch: Record<string, unknown> = {
      videoDelay: nextDelay <= 0.0001 ? null : nextDelay,
    }
    // First drag also pins the trigger so the bar's anchor stops
    // shifting when the user re-orders the underlying animations.
    if (video.videoTrigger === undefined) patch['videoTrigger'] = trigger
    command.tryRun('object.update', { slide: slideId, object: video.id, patch })
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
  }

  const leftPx = GRIP_WIDTH + Math.round(startSec * pxPerSec)
  const widthPx = Math.max(48, Math.round(clipDur * pxPerSec))

  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onSelect}
      title={
        trigger === 'onClick'
          ? 'Video plays on click — drag to add a delay before the click cue'
          : `Video starts at ${startSec.toFixed(2)}s — drag to retime`
      }
      className={[
        'absolute flex items-center gap-1 overflow-hidden rounded text-[11px] text-white shadow-xs',
        'bg-blue-700/80 hover:bg-blue-700 transition-colors',
        isViewer ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
        'select-none',
        selected ? 'ring-2 ring-blue-300 ring-offset-1 ring-offset-gray-900' : '',
      ].join(' ')}
      style={{
        left: leftPx,
        top: BAR_TOP,
        width: widthPx,
        height: BAR_HEIGHT,
        touchAction: 'none',
      }}
    >
      <span
        aria-hidden="true"
        className="flex h-full items-center justify-center"
        style={{
          width: TRIGGER_ICON_WIDTH,
          background: triggerIconBg(trigger),
        }}
      >
        <TriggerIcon trigger={trigger} />
      </span>
      <span className="truncate px-1">{video.name ?? 'video'}</span>
    </div>
  )
}

export function AnimationTimeline() {
  const { animations } = useAnimations()
  const { activeSlideId } = useActiveSlide()
  const command = useCommand()
  const { role } = useDeckRole()
  const canvasInstance = useCanvasInstance()
  const { objects: slideObjects } = useSlideObjects()
  const { selectOne, selectedAnimationId, setSelectedAnimationId } = useSelection()
  const isViewer = role === 'viewer'

  /**
   * Select a step + sync selection to the artboard so the inspector and
   * transform handles light up for the underlying object. Used by both
   * keyboard activation (Enter/Space on a bar) and pointer-down dragging.
   */
  const selectStep = useCallback(
    (step: AnimationStep) => {
      setSelectedId(step.id)
      selectOne(step.objectId)
    },
    [selectOne],
  )

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  const [pxPerSec, setPxPerSec] = useState<number>(() => {
    try {
      const raw = sessionStorage.getItem(ZOOM_STORAGE_KEY)
      const parsed = raw === null ? NaN : parseFloat(raw)
      if (!Number.isFinite(parsed) || parsed < MIN_ZOOM || parsed > MAX_ZOOM) {
        return DEFAULT_PX_PER_SEC
      }
      return parsed
    } catch {
      return DEFAULT_PX_PER_SEC
    }
  })
  useEffect(() => {
    try {
      sessionStorage.setItem(ZOOM_STORAGE_KEY, String(pxPerSec))
    } catch {
      // storage unavailable — in-memory only
    }
  }, [pxPerSec])
  const zoomIn = useCallback(() => {
    setPxPerSec((cur) => {
      const next: number | undefined = ZOOM_STEPS.find((s) => s > cur)
      return next ?? MAX_ZOOM
    })
  }, [])
  const zoomOut = useCallback(() => {
    setPxPerSec((cur) => {
      // Walk steps in reverse to find the largest one strictly less than cur.
      for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
        const s = ZOOM_STEPS[i]
        if (s !== undefined && s < cur) return s
      }
      return MIN_ZOOM
    })
  }, [])
  const zoomReset = useCallback(() => {
    setPxPerSec(DEFAULT_PX_PER_SEC)
  }, [])
  // Selection of the highlighted animation step is shared via SelectionContext
  // so the Inspector's per-object animations list highlights the same step
  // (and vice versa). Local aliases keep this file's existing call sites.
  const selectedId = selectedAnimationId
  const setSelectedId = setSelectedAnimationId

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
    /** Frozen absolute start of every step at drag-start. A body drag
     *  sends these for the bars it is not moving, so each frame's
     *  animation.retime is idempotent — the live layout would already
     *  carry the previous frame's write. */
    originalStarts: Record<string, number>
    /** Magnet snap targets: every OTHER bar's start and end at drag-start
     *  (plus 0). Frozen for the same reason — while an edge is resized,
     *  the steps after it move with it, and snapping to their live starts
     *  pulled the edge back to where the previous frame put it. */
    snapCandidates: number[]
  } | null>(null)

  /** Lane assignment seen on the previous render, keyed by step id. Used to
   *  reconstruct the dragged bar's lane on drag-start (since at that point
   *  the drag hasn't produced a new layout yet). */
  const lastLanesRef = useRef<Record<string, number>>({})
  /** Last computed row (per-objectId) order, captured every render. Lets us
   *  freeze the row layout during a body drag — even though dragging may
   *  reorder Y.Array, the visual swimlanes must NOT shuffle on their own.
   *  Manual reorder via the row grip is the only way to change row order. */
  const lastRowOrderRef = useRef<string[]>([])
  /** Frozen row order while a body drag is active. Set in beginDrag, cleared
   *  in endDrag. When set, the rows memo uses it instead of the natural
   *  Y.Array-derived order. */
  const frozenRowOrderRef = useRef<string[] | null>(null)
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

  // Legacy `onEnter` steps are displayed as they are, never rewritten on
  // open. The timeline used to "migrate" them to afterPrevious from an
  // effect, which meant opening the panel wrote to the deck: the rewrite
  // landed on the viewer's undo stack, went out to every collaborator,
  // and — because the new delay was clamped at 0 — moved any onEnter step
  // that starts before its predecessor ends, changing playback. The
  // compiler (packages/animation `resolvePosition`) anchors onEnter at the
  // slide start (position 0 + delay) at any index, and `layoutSteps`
  // mirrors that, so the bar already sits where playback puts it. The
  // trigger <select> offers onEnter only while a step still has it (see
  // `triggerOptionsFor`); the data changes when the user picks another
  // trigger or drags the bar.

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
    // Show every video object on the timeline even when it has no
    // animation steps — the row's trigger icon is the visual cue for
    // timing other animations against the video's start.
    for (const o of slideObjects) {
      if (o.type !== 'video') continue
      if (buckets.has(o.id)) continue
      buckets.set(o.id, [])
      naturalOrder.push(o.id)
    }

    let finalOrder = naturalOrder
    if (rowOrderPref !== null) {
      const present = new Set(naturalOrder)
      const ordered = rowOrderPref.filter((id) => present.has(id))
      const appended = naturalOrder.filter((id) => !rowOrderPref.includes(id))
      finalOrder = [...ordered, ...appended]
    }

    // While a body drag is active, freeze row order to the snapshot taken at
    // drag-start. The Y.Array may reorder mid-drag (so trigger relationships
    // can update), but per-object swimlanes must stay put — only the row
    // grip can move them.
    const frozen = frozenRowOrderRef.current
    if (frozen !== null) {
      const present = new Set(naturalOrder)
      const ordered = frozen.filter((id) => present.has(id))
      const appended = naturalOrder.filter((id) => !frozen.includes(id))
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
    lastRowOrderRef.current = finalOrder
    return result
    // dragStamp is included so toggling the drag state forces a re-layout
    // without the pinned-lane pass, letting bumped bars drop back down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laidOut, rowOrderPref, dragStamp, slideObjects])

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

  // Per-video clip duration cache (sec). Populated by VideoClipBar
  // children via the onClipDuration callback so the timeline's total
  // length can extend past the last animation step to cover the video.
  const [videoClipDurations, setVideoClipDurations] = useState<Record<string, number>>({})
  const onVideoClipDuration = useCallback((videoId: string, clipDurationSec: number) => {
    setVideoClipDurations((prev) =>
      prev[videoId] === clipDurationSec ? prev : { ...prev, [videoId]: clipDurationSec },
    )
  }, [])

  // When the playhead moves (manual scrub or programmatic), seek every
  // video on the slide to the matching frame inside its clip range.
  // Outside the clip: snap the videoEl to the trim edge so it shows
  // the right still. EditorVideoPreview publishes a seek() handle on
  // window.__narrative_video_currents that owns the actual seek call.
  useEffect(() => {
    type Reg = Record<string, { currentTime: number; seek?: (sec: number) => void }>
    const reg = (window as unknown as { __narrative_video_currents?: Reg })
      .__narrative_video_currents
    if (reg === undefined) return
    for (const o of slideObjects) {
      if (o.type !== 'video') continue
      const seek = reg[o.id]?.seek
      if (seek === undefined) continue
      const startSec = computeVideoStartSec(o, laidOut)
      const dur = videoClipDurations[o.id] ?? 0
      const trimStart = o.trimStart ?? 0
      const trimEnd =
        o.trimEnd !== undefined && o.trimEnd > 0 ? o.trimEnd : trimStart + (dur > 0 ? dur : 0)
      if (playheadSec < startSec) {
        seek(trimStart)
      } else if (dur > 0 && playheadSec > startSec + dur) {
        seek(trimEnd)
      } else {
        seek(trimStart + (playheadSec - startSec))
      }
    }
  }, [playheadSec, slideObjects, laidOut, videoClipDurations])

  const totalSec = useMemo(() => {
    // Visible track = last step's end + 5 s of headroom, with a 10 s
    // floor. Headroom lets the author scrub past the last animation
    // and drag steps further out without the ruler clipping.
    const animEnd = laidOut.reduce(
      (max, { step, startSec }) => Math.max(max, startSec + (step.duration ?? 0)),
      0,
    )
    // Extend to cover any video clip block — videoStart + clipDuration.
    let videoEnd = 0
    for (const o of slideObjects) {
      if (o.type !== 'video') continue
      const dur = videoClipDurations[o.id] ?? 0
      if (dur <= 0) continue
      videoEnd = Math.max(videoEnd, computeVideoStartSec(o, laidOut) + dur)
    }
    return Math.max(animEnd + 5, videoEnd + 5, 10)
  }, [laidOut, slideObjects, videoClipDurations])

  const trackWidthPx = GRIP_WIDTH + Math.ceil(totalSec * pxPerSec) + 32
  const tickCount = Math.ceil(totalSec) + 1

  const handleRemove = useCallback(
    (stepId: string) => {
      if (activeSlideId === null) return
      command.tryRun('animation.remove', { slide: activeSlideId, animations: [stepId] })
      setSelectedId((prev) => (prev === stepId ? null : prev))
    },
    [command, activeSlideId],
  )

  // P9: Delete / Backspace removes the selected step when the timeline has
  // focus. Scoped to 'timeline' so it does NOT fire when the user is
  // deleting text on the canvas or a slide in the slide panel.
  useShortcuts([
    {
      keys: ['Delete', 'Backspace'],
      scope: 'timeline',
      action: 'animation.delete',
      description: 'Delete selected animation step',
      handler: () => {
        if (selectedId !== null && !isViewer) handleRemove(selectedId)
      },
    },
  ])

  // ---------------------------------------------------------------------------
  // Drag to edit (body → delay, right-edge grip → duration)
  // ---------------------------------------------------------------------------

  const MIN_DURATION_SEC = 0.1
  const DRAG_THRESHOLD_PX = 3
  const SNAP_SEC = 0.05
  /** Magnetic snap threshold — a dragged edge within this many seconds of
   *  another bar's start or end (any row) locks onto it. 0.1 s ≈ 8 px at
   *  the current pxPerSec. Hold Shift to disable. */
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
      if (isViewer || activeSlideId === null) return
      e.currentTarget.setPointerCapture(e.pointerId)
      e.stopPropagation()
      const originalStarts: Record<string, number> = {}
      const snapCandidates: number[] = [0]
      for (const l of laidOut) {
        originalStarts[l.step.id] = l.startSec
        if (l.step.id === step.id) continue
        snapCandidates.push(l.startSec, l.startSec + (l.step.duration ?? 0))
      }
      dragStateRef.current = {
        stepId: step.id,
        mode,
        startPointerX: e.clientX,
        originalAbsStart: absStart,
        originalDuration: step.duration ?? 0,
        hasMoved: false,
        converted: false,
        originalLane: lastLanesRef.current[step.id] ?? 0,
        originalStarts,
        snapCandidates,
      }
      // Freeze visible row order for the duration of a body drag — the
      // Y.Array may reshuffle as the dragged bar passes neighbours, but
      // we don't want that to bubble up into row reordering.
      if (mode === 'body') {
        frozenRowOrderRef.current = [...lastRowOrderRef.current]
      }
    },
    [isViewer, activeSlideId, laidOut],
  )

  const handleDragMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragStateRef.current
      if (drag === null || activeSlideId === null) return
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

      // Snap points — start and end of every other bar (any row) and 0, as
      // they were at drag-start (see DragState.snapCandidates).
      const candidates = magnet > 0 ? drag.snapCandidates : []

      if (drag.mode === 'resize') {
        let newDuration = Math.max(
          MIN_DURATION_SEC,
          quantize(drag.originalDuration + dx / pxPerSec, snap),
        )
        if (magnet > 0) {
          const rawEnd = drag.originalAbsStart + newDuration
          const snapped = magnetSnap(rawEnd, candidates, magnet)
          if (snapped !== rawEnd) {
            newDuration = Math.max(MIN_DURATION_SEC, snapped - drag.originalAbsStart)
          }
        }
        command.tryRun('animation.update', {
          slide: activeSlideId,
          animation: drag.stepId,
          patch: { duration: Math.min(newDuration, MAX_STEP_DURATION_S) },
        })
        return
      }

      // 'body' mode — Premiere-like absolute-time positioning.
      let newAbsStart = Math.max(0, quantize(drag.originalAbsStart + dx / pxPerSec, snap))

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

      // A step waits at most MAX_STEP_DELAY_S; the dragged step's delay is
      // at most its start.
      newAbsStart = Math.min(newAbsStart, MAX_STEP_DELAY_S)

      // Premiere-like free drag: every bar is placed at an absolute time
      // with animation.retime, which derives the play order and each
      // step's trigger + delay from the times (dragging past a neighbour
      // reorders, overlapping makes withPrevious, onClick stays onClick).
      // Every OTHER bar is sent at its drag-start time, not its live one,
      // so each frame is absolute and idempotent: reading the live layout
      // would be stale-after-write, and dragging back restores the start.
      const timing = laidOut.map((l) => ({
        animation: l.step.id,
        start:
          l.step.id === drag.stepId ? newAbsStart : (drag.originalStarts[l.step.id] ?? l.startSec),
      }))
      try {
        command.run('animation.retime', { slide: activeSlideId, timing })
      } catch (err) {
        // A frame that would make some step wait longer than a step may
        // (only on timelines longer than MAX_STEP_DELAY_S), or a step a
        // collaborator just removed: skip the frame, the bar stays put.
        if (
          err instanceof CommandError &&
          (err.code === 'invalid_input' || err.code === 'not_found' || err.code === 'conflict')
        ) {
          console.warn(`[timeline] retime frame not applied: ${err.message}`)
          return
        }
        throw err
      }
    },
    [command, activeSlideId, laidOut],
  )

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragStateRef.current
      if (drag === null) return
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      const wasDrag = drag.hasMoved
      dragStateRef.current = null
      frozenRowOrderRef.current = null
      // If the pointer never moved past the threshold, treat as click → select.
      if (!wasDrag) {
        const step = animations.find((a) => a.id === drag.stepId)
        if (step !== undefined) selectStep(step)
        else setSelectedId(drag.stepId)
      } else {
        // Re-layout without pass-1 pinning so bumped bars drop back down.
        setDragStamp((s) => s + 1)
      }
    },
    [animations, selectStep],
  )

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
    // Drop orphan steps (objectId no longer on the slide) before
    // compiling so the compiler doesn't spam a warning per scrub for
    // every dangling reference. Real cleanup of orphans happens in
    // mutations.removeObject; this is the runtime safety net.
    const liveIds = new Set(slideObjects.map((o) => o.id))
    const compilable = animations.filter((s) => liveIds.has(s.objectId))
    if (compilable.length === 0) return null
    const resolver = createPixiTargetResolver(canvasInstance.sceneGraph)
    // No inputBridge — the preview treats onClick like afterPrevious by
    // auto-advancing. That's simpler than wiring a "click the canvas to
    // advance" hint; authors can still test onClick by using Present mode.
    // P12b: onTick wakes the render scheduler so GSAP-driven Pixi state
    // actually reaches the screen under autoStart:false.
    const scheduler = getDefaultRenderScheduler()
    const runtime = createAnimationRuntime(compilable, {
      targetResolver: resolver,
      ...(scheduler !== null ? { onTick: () => scheduler.markDirty() } : {}),
    })
    runtimeRef.current = runtime
    return runtime
  }, [animations, canvasInstance, slideObjects])

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
      // Playhead is clamped to the visible track (totalSec, includes
      // headroom). The GSAP runtime seek itself stays clamped to
      // rt.duration() — there's no animation past the last step, so
      // seeking further is a no-op for playback. Keeping the visual
      // playhead free lets authors drop new steps anywhere on the
      // ruler without fighting the cap.
      const rt = ensureRuntime()
      const visualTime = Math.max(0, Math.min(timeSec, totalSec))
      if (rt !== null) {
        if (rt.isPlaying()) {
          rt.pause()
          stopPlayheadLoop()
          setIsPlaying(false)
        }
        rt.seek(Math.min(visualTime, rt.duration()))
      }
      setPlayheadSec(visualTime)
    },
    [ensureRuntime, stopPlayheadLoop, totalSec],
  )

  return (
    <div className="panel flex flex-shrink-0 flex-col border-t border-border">
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
                className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/80 hover:bg-accent hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                aria-label={isPlaying ? 'Pause animations preview' : 'Play animations preview'}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? (
                  <Pause className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                ) : (
                  <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                onClick={handleStop}
                disabled={runtimeRef.current === null && playheadSec === 0}
                className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/80 hover:bg-accent hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                aria-label="Stop preview and reset canvas"
                title="Stop and reset canvas"
              >
                <Square className="h-3 w-3 fill-current" aria-hidden="true" />
              </button>
              <span className="ml-1 font-mono text-[10px] tabular-nums text-muted-foreground/80">
                {playheadSec.toFixed(2)}s
              </span>
              {/* Zoom controls — px/sec ladder. Double-click the % label to
                  reset to default. Persisted in sessionStorage. */}
              <div className="ml-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={zoomOut}
                  disabled={pxPerSec <= MIN_ZOOM}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/80 hover:bg-accent hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  aria-label="Zoom out timeline"
                  title="Zoom out"
                >
                  <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onDoubleClick={zoomReset}
                  className="font-mono text-[10px] tabular-nums text-muted-foreground/80 px-1 hover:text-foreground"
                  aria-label="Reset timeline zoom (double-click)"
                  title="Double-click to reset"
                >
                  {Math.round((pxPerSec / DEFAULT_PX_PER_SEC) * 100)}%
                </button>
                <button
                  type="button"
                  onClick={zoomIn}
                  disabled={pxPerSec >= MAX_ZOOM}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/80 hover:bg-accent hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  aria-label="Zoom in timeline"
                  title="Zoom in"
                >
                  <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
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
                    handleScrub((e.clientX - bounds.left - GRIP_WIDTH) / pxPerSec)
                  }}
                  onPointerMove={(e) => {
                    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                    const bounds = e.currentTarget.getBoundingClientRect()
                    handleScrub((e.clientX - bounds.left - GRIP_WIDTH) / pxPerSec)
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
                      style={{ left: GRIP_WIDTH + i * pxPerSec, transform: 'translateX(-50%)' }}
                    >
                      {i}s
                    </div>
                  ))}
                  {/* onClick markers — show one per onClick step on the ruler
                      so the author sees how many clicks the slide needs and
                      where each click lands in the timeline. The vertical
                      line extends down through all rows (rendered separately
                      below to escape the ruler's overflow). */}
                  {laidOut
                    .filter((l) => l.step.trigger === 'onClick')
                    .map((l, idx) => (
                      <div
                        key={`click-icon-${l.step.id}`}
                        className="pointer-events-none absolute top-0 z-20 flex items-center justify-center"
                        style={{
                          left: GRIP_WIDTH + l.startSec * pxPerSec,
                          height: RULER_HEIGHT,
                          width: 14,
                          transform: 'translateX(-50%)',
                        }}
                        title={`Click ${idx + 1}`}
                      >
                        <MousePointerClick className="h-3 w-3 text-white" aria-hidden="true" />
                      </div>
                    ))}
                </div>
                {/* onClick vertical guides — span the full row stack. Drawn
                    outside the ruler so the line escapes ruler overflow.
                    Thin white, low-opacity so it doesn't compete with the
                    red playhead. */}
                {laidOut
                  .filter((l) => l.step.trigger === 'onClick')
                  .map((l) => (
                    <div
                      key={`click-guide-${l.step.id}`}
                      className="pointer-events-none absolute z-10"
                      style={{
                        left: GRIP_WIDTH + Math.round(l.startSec * pxPerSec),
                        top: RULER_HEIGHT,
                        height: rowsTotalHeight,
                        width: 1,
                        backgroundColor: 'rgba(255, 255, 255, 0.35)',
                      }}
                    />
                  ))}

                {/* Playhead — vertical line spanning all rows + a small chevron at the top */}
                <div
                  className="pointer-events-none absolute top-0 z-20"
                  style={{
                    left: GRIP_WIDTH + Math.round(playheadSec * pxPerSec),
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
                          title={slideObjects.find((o) => o.id === objectId)?.name ?? objectId}
                        >
                          {!isViewer && (
                            <div
                              role="button"
                              tabIndex={0}
                              aria-label={`Reorder row ${slideObjects.find((o) => o.id === objectId)?.name ?? objectId}`}
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
                            className="truncate px-1 text-[11px] text-gray-300"
                            style={{ maxWidth: TRACK_LABEL_WIDTH - 24 }}
                          >
                            {(() => {
                              const o = slideObjects.find((x) => x.id === objectId)
                              return o?.name ?? o?.type ?? objectId
                            })()}
                          </span>
                          {/* Video trigger icon — shows the playback gate so
                            you can time other steps against the video. */}
                          {(() => {
                            const o = slideObjects.find((x) => x.id === objectId)
                            if (o?.type !== 'video') return null
                            if (o.playOnClick === true) {
                              return (
                                <MousePointerClick
                                  className="h-3 w-3 flex-shrink-0 text-amber-400"
                                  aria-label="Video plays on click"
                                />
                              )
                            }
                            if (o.autoplay === true) {
                              return (
                                <Play
                                  className="h-3 w-3 flex-shrink-0 text-emerald-400"
                                  aria-label="Video autoplays on slide enter"
                                />
                              )
                            }
                            return (
                              <Pause
                                className="h-3 w-3 flex-shrink-0 text-gray-500"
                                aria-label="Video starts paused"
                              />
                            )
                          })()}
                        </div>

                        {/* Video clip block — sequenced like an
                          animation step (anchored to onEnter / with /
                          afterPrevious / onClick + delay). Drag the
                          body to retime; selecting it picks the video
                          object on the canvas. */}
                        {(() => {
                          const o = slideObjects.find((x) => x.id === objectId)
                          if (o?.type !== 'video') return null
                          const startSec = computeVideoStartSec(o, laidOut)
                          return (
                            <VideoClipBar
                              video={o}
                              startSec={startSec}
                              pxPerSec={pxPerSec}
                              laidOut={laidOut}
                              slideId={activeSlideId}
                              isViewer={isViewer}
                              selected={selectedAnimationId === `video:${o.id}`}
                              onSelect={() => {
                                setSelectedAnimationId(`video:${o.id}`)
                                selectOne(o.id)
                              }}
                              onClipDuration={onVideoClipDuration}
                            />
                          )
                        })()}

                        {/* Bars — one per animation on this object. */}
                        {items.map(({ step, startSec, lane }) => {
                          const isSelected = selectedId === step.id
                          const leftPx = GRIP_WIDTH + Math.round(startSec * pxPerSec)
                          const widthPx = Math.max(Math.round((step.duration ?? 0) * pxPerSec), 24)
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
                                  selectStep(step)
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
                              {/* Trigger icon slot — 14 px wide, colour-coded
                                by trigger type. The icon is visual-only
                                (pointer-events: none); the invisible <select>
                                underneath captures the click and opens the
                                native platform dropdown. This replaces the
                                old 6 px colour chip while reusing the same
                                colour token map. */}
                              <div
                                className="relative flex-shrink-0"
                                style={{ width: TRIGGER_ICON_WIDTH, height: BAR_HEIGHT }}
                              >
                                {/* Invisible select — full-size, z-index above
                                  the icon, opacity 0 so only the icon shows. */}
                                <select
                                  className="absolute inset-0 appearance-none cursor-pointer"
                                  style={{
                                    width: TRIGGER_ICON_WIDTH,
                                    height: BAR_HEIGHT,
                                    border: 0,
                                    outline: 'none',
                                    opacity: 0,
                                    zIndex: 1,
                                  }}
                                  value={step.trigger}
                                  disabled={isViewer}
                                  aria-label={`Trigger for ${label}`}
                                  title={`Trigger: ${step.trigger}`}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => {
                                    if (activeSlideId === null) return
                                    command.tryRun('animation.update', {
                                      slide: activeSlideId,
                                      animation: step.id,
                                      patch: { trigger: e.target.value as AnimationTrigger },
                                    })
                                  }}
                                >
                                  {triggerOptionsFor(step.trigger).map((t) => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                                {/* Icon backdrop + icon — purely visual. */}
                                <div
                                  className="absolute inset-0 flex items-center justify-center rounded-l"
                                  style={{ backgroundColor: triggerIconBg(step.trigger) }}
                                >
                                  <div className="text-white" style={{ width: 9, height: 9 }}>
                                    <TriggerIcon trigger={step.trigger} />
                                  </div>
                                </div>
                              </div>
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
                                    if (activeSlideId === null) return
                                    command.tryRun('animation.update', {
                                      slide: activeSlideId,
                                      animation: step.id,
                                      patch: { easing: e.target.value },
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
