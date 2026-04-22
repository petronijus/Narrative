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
import type { AnimationStep, AnimationTrigger } from '@narrative/shared'
import { removeAnimation, updateAnimation } from '@narrative/slide-model'
import { createAnimationRuntime, type AnimationRuntime } from '@narrative/animation'
import { useAnimations } from '../state/useAnimations.js'
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

export function AnimationTimeline() {
  const { animations, animationsCtx } = useAnimations()
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
  const dragStateRef = useRef<{
    stepId: string
    mode: 'body' | 'resize'
    startPointerX: number
    anchorSec: number
    originalDelay: number
    originalDuration: number
    hasMoved: boolean
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
  const totalSec = useMemo(() => {
    // Minimum 3 s so the ruler always has something useful.
    return laidOut.reduce(
      (max, { step, startSec }) => Math.max(max, startSec + (step.duration ?? 0)),
      3,
    )
  }, [laidOut])

  const trackWidthPx = Math.ceil(totalSec * PX_PER_SEC) + 32
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

  /** Round to the nearest multiple of `step`, suppressed by holding Shift. */
  function quantize(valueSec: number, snap: number): number {
    if (snap <= 0) return valueSec
    return Math.round(valueSec / snap) * snap
  }

  /** Anchor time for step at index idx (the "0 delay" baseline on the timeline). */
  function anchorSecForIndex(idx: number): number {
    if (idx === 0) return 0
    const step = laidOut[idx]?.step
    if (step === undefined) return 0
    if (step.trigger === 'onEnter') return 0
    const prev = laidOut[idx - 1]
    if (prev === undefined) return 0
    if (step.trigger === 'withPrevious') return prev.startSec
    // afterPrevious | onClick → prev.endSec
    return prev.startSec + (prev.step.duration ?? 0)
  }

  const beginDrag = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      step: AnimationStep,
      rowIdx: number,
      mode: 'body' | 'resize',
    ) => {
      if (isViewer || animationsCtx === null) return
      e.currentTarget.setPointerCapture(e.pointerId)
      e.stopPropagation()
      dragStateRef.current = {
        stepId: step.id,
        mode,
        startPointerX: e.clientX,
        anchorSec: anchorSecForIndex(rowIdx),
        originalDelay: step.delay ?? 0,
        originalDuration: step.duration ?? 0,
        hasMoved: false,
      }
    },
    // laidOut closes over the latest snapshot; inline usage of anchorSecForIndex
    // therefore stays current. eslint-disable because that closure is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isViewer, animationsCtx, laidOut],
  )

  const handleDragMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragStateRef.current
      if (drag === null || animationsCtx === null) return
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return

      const dx = e.clientX - drag.startPointerX
      if (!drag.hasMoved && Math.abs(dx) < DRAG_THRESHOLD_PX) return
      drag.hasMoved = true

      const snap = e.shiftKey ? 0 : SNAP_SEC
      const deltaSec = dx / PX_PER_SEC

      if (drag.mode === 'body') {
        const newDelay = Math.max(0, quantize(drag.originalDelay + deltaSec, snap))
        updateAnimation(animationsCtx, drag.stepId, { delay: newDelay })
      } else {
        const newDuration = Math.max(
          MIN_DURATION_SEC,
          quantize(drag.originalDuration + deltaSec, snap),
        )
        updateAnimation(animationsCtx, drag.stepId, { duration: newDuration })
      }
    },
    [animationsCtx],
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
    }
  }, [])

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
    <div className="flex flex-shrink-0 flex-col border-t border-gray-800 bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Animations
          </span>
          <span className="text-[10px] text-gray-600">{animations.length} step(s)</span>
        </div>
        <div className="flex items-center gap-1">
          {!collapsed && !isViewer && (
            <>
              <button
                type="button"
                onClick={handlePlayPause}
                disabled={animations.length === 0 || canvasInstance === null}
                className="rounded px-2 py-0.5 text-[10px] text-gray-300 hover:bg-gray-800 hover:text-blue-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-300"
                aria-label={isPlaying ? 'Pause animations preview' : 'Play animations preview'}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button
                type="button"
                onClick={handleStop}
                disabled={runtimeRef.current === null && playheadSec === 0}
                className="rounded px-2 py-0.5 text-[10px] text-gray-300 hover:bg-gray-800 hover:text-blue-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-300"
                aria-label="Stop preview and reset canvas"
                title="Stop and reset canvas"
              >
                ■
              </button>
              <span className="ml-1 font-mono text-[10px] tabular-nums text-gray-500">
                {playheadSec.toFixed(2)}s
              </span>
            </>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            className="rounded px-2 py-0.5 text-[10px] text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            aria-label={collapsed ? 'Expand animations timeline' : 'Collapse animations timeline'}
          >
            {collapsed ? '▲ expand' : '▼ collapse'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div
          className="overflow-auto"
          style={{
            height: Math.min(220, RULER_HEIGHT + Math.max(laidOut.length, 1) * ROW_HEIGHT + 8),
          }}
        >
          {laidOut.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <p className="text-[11px] text-gray-600 italic">
                No animations on this slide. Add one from the Inspector.
              </p>
            </div>
          ) : (
            <div style={{ width: trackWidthPx, position: 'relative' }}>
              {/* Ruler — click/drag to scrub */}
              <div
                className="sticky top-0 z-10 cursor-col-resize border-b border-gray-800 bg-gray-900/95 backdrop-blur"
                style={{ height: RULER_HEIGHT, width: trackWidthPx }}
                onPointerDown={(e) => {
                  if (isViewer || canvasInstance === null || animations.length === 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  const bounds = e.currentTarget.getBoundingClientRect()
                  handleScrub((e.clientX - bounds.left) / PX_PER_SEC)
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                  const bounds = e.currentTarget.getBoundingClientRect()
                  handleScrub((e.clientX - bounds.left) / PX_PER_SEC)
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
                    style={{ left: i * PX_PER_SEC, transform: 'translateX(-50%)' }}
                  >
                    {i}s
                  </div>
                ))}
              </div>

              {/* Playhead — vertical line spanning all rows + a small chevron at the top */}
              <div
                className="pointer-events-none absolute top-0 z-20"
                style={{
                  left: Math.round(playheadSec * PX_PER_SEC),
                  height: RULER_HEIGHT + laidOut.length * ROW_HEIGHT,
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

              {/* Rows */}
              {laidOut.map(({ step, startSec }, rowIdx) => {
                const isSelected = selectedId === step.id
                const leftPx = Math.round(startSec * PX_PER_SEC)
                const widthPx = Math.max(Math.round((step.duration ?? 0) * PX_PER_SEC), 24)
                const dir =
                  (step.params as { direction?: string } | undefined)?.direction ?? undefined
                const label = dir !== undefined ? `${step.preset} (${dir})` : step.preset

                return (
                  <div
                    key={step.id}
                    className={[
                      'relative',
                      rowIdx % 2 === 0 ? 'bg-gray-900' : 'bg-gray-900/60',
                    ].join(' ')}
                    style={{ height: ROW_HEIGHT, width: trackWidthPx }}
                  >
                    {/* Row baseline — helps the eye align bars to the ruler. */}
                    <div
                      className="absolute left-0 right-0 border-t border-gray-800/50"
                      style={{ top: ROW_HEIGHT / 2 }}
                    />

                    <div
                      role="button"
                      tabIndex={0}
                      onPointerDown={(e) => beginDrag(e, step, rowIdx, 'body')}
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
                        top: BAR_TOP,
                        height: BAR_HEIGHT,
                        touchAction: 'none',
                      }}
                      title={`${label} • trigger: ${step.trigger} • ${(step.duration ?? 0).toFixed(2)}s • delay ${(step.delay ?? 0).toFixed(2)}s`}
                      aria-label={`Animation ${label}, trigger ${step.trigger}`}
                    >
                      <span
                        className={`flex-shrink-0 ${triggerColor(step.trigger)}`}
                        style={{ width: 4, height: BAR_HEIGHT }}
                      />
                      <span className="truncate px-1">{label}</span>
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
                      {/* Right-edge resize grip — drag to adjust step.duration.
                          Only shown for editors. Stops propagation so it
                          doesn't also trigger the body-drag. */}
                      {!isViewer && (
                        <span
                          aria-label={`Resize ${label}`}
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            beginDrag(e, step, rowIdx, 'resize')
                          }}
                          onPointerMove={handleDragMove}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                          className="absolute right-0 top-0 h-full w-2 cursor-ew-resize hover:bg-white/20"
                          style={{ touchAction: 'none' }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
