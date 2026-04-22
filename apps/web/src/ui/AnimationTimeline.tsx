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

import { useState, useCallback, useMemo } from 'react'
import type { AnimationStep, AnimationTrigger } from '@narrative/shared'
import { removeAnimation } from '@narrative/slide-model'
import { useAnimations } from '../state/useAnimations.js'
import { useDeckRole } from '../state/DeckRoleContext.js'

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

function barBaseClass(selected: boolean): string {
  return [
    'absolute flex items-center gap-1 rounded text-[11px] text-white shadow-sm',
    'cursor-pointer select-none overflow-hidden',
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
  const isViewer = role === 'viewer'

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)

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
        <button
          type="button"
          onClick={toggleCollapsed}
          className="rounded px-2 py-0.5 text-[10px] text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          aria-label={collapsed ? 'Expand animations timeline' : 'Collapse animations timeline'}
        >
          {collapsed ? '▲ expand' : '▼ collapse'}
        </button>
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
              {/* Ruler */}
              <div
                className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/95 backdrop-blur"
                style={{ height: RULER_HEIGHT, width: trackWidthPx }}
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

                    <button
                      type="button"
                      onClick={() => setSelectedId(step.id)}
                      className={barBaseClass(isSelected)}
                      style={{
                        left: leftPx,
                        width: widthPx,
                        top: BAR_TOP,
                        height: BAR_HEIGHT,
                      }}
                      title={`${label} • trigger: ${step.trigger} • ${step.duration ?? 0}s • delay ${step.delay ?? 0}s`}
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
                    </button>
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
