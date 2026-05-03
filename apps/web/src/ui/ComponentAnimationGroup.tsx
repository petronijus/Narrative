/**
 * ui/ComponentAnimationGroup.tsx
 *
 * M16 P8 — Per-instance group of animation step rows.
 *
 * Rendered both by AnimationTimeline (collapsible group above slide-native
 * steps) and by Inspector.tsx → ComponentInstanceInspector (sibling
 * "Animations" section). Both surfaces share the same row component
 * (ComponentAnimationRow); this group adds:
 *   - Header chrome: ⌘ icon + master name + step count + collapse caret.
 *   - Master subscription via useInstanceMasterSnapshot.
 *   - Reorder driver (pointer drag on the row's drag handle) that writes
 *     `order` overrides for the affected steps within ONE Yjs transaction
 *     per gesture. The master's natural order stays untouched.
 *   - "Missing component" placeholder when the master can't resolve.
 *
 * Persistence:
 *   The expanded/collapsed flag is per-instance + per-component, kept in
 *   sessionStorage. NOT in Yjs — it's a local view preference, identical
 *   semantics to Inspector's <Section> collapse keys.
 */

import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { ChevronDown, Layers } from 'lucide-react'
import type { ComponentInstanceObject, AnimationStep } from '@narrative/shared'
import {
  resolveInstanceAnimations,
  setAnimationOverride,
  type ObjectsMutationContext,
} from '@narrative/slide-model'
import { useInstanceMasterSnapshot } from '../state/useInstanceMasterSnapshot.js'
import { ComponentAnimationRow } from './ComponentAnimationRow.js'

const EXPANDED_STORAGE_PREFIX = 'narrative:componentAnimGroup:expanded:'

function readExpanded(instanceId: string, fallback: boolean): boolean {
  try {
    const raw = sessionStorage.getItem(EXPANDED_STORAGE_PREFIX + instanceId)
    if (raw === null) return fallback
    return raw === '1'
  } catch {
    return fallback
  }
}

function writeExpanded(instanceId: string, value: boolean): void {
  try {
    sessionStorage.setItem(EXPANDED_STORAGE_PREFIX + instanceId, value ? '1' : '0')
  } catch {
    // storage unavailable — best effort
  }
}

export interface ComponentAnimationGroupProps {
  instance: ComponentInstanceObject
  /**
   * State-sync mutation context for the slide that hosts the instance.
   * Null when read-only.
   */
  mutationCtx: ObjectsMutationContext | null
  disabled: boolean
  /** Compact row layout (timeline gutter has limited horizontal room). */
  compact?: boolean
  /**
   * When provided, the component delegates expanded/collapsed state to
   * the parent. Otherwise the group manages its own sessionStorage key.
   * The Inspector uses this so the "Animations" section's collapse maps
   * to its own <Section> rather than each instance owning a duplicate.
   */
  controlledExpanded?: boolean
  onExpandedChange?: (next: boolean) => void
  /** Hide the group header (Inspector renders its own <Section> header). */
  hideHeader?: boolean
}

export function ComponentAnimationGroup({
  instance,
  mutationCtx,
  disabled,
  compact,
  controlledExpanded,
  onExpandedChange,
  hideHeader,
}: ComponentAnimationGroupProps): JSX.Element {
  const master = useInstanceMasterSnapshot(instance.componentId)

  const [internalExpanded, setInternalExpanded] = useState<boolean>(() =>
    readExpanded(instance.id, true),
  )
  const expanded = controlledExpanded ?? internalExpanded
  const setExpanded = useCallback(
    (next: boolean) => {
      if (onExpandedChange !== undefined) {
        onExpandedChange(next)
      } else {
        setInternalExpanded(next)
        writeExpanded(instance.id, next)
      }
    },
    [instance.id, onExpandedChange],
  )

  // Resolved (master + override) steps. Identity-stable when neither side
  // changes — resolveInstanceAnimations short-circuits to a slice of the
  // master array when overrides are empty.
  const resolved: AnimationStep[] = useMemo(() => {
    if (master.snapshot === null) return []
    return resolveInstanceAnimations(master.snapshot.animations, instance.overrides)
  }, [master.snapshot, instance.overrides])

  const isMissing = master.status === 'missing'
  const isPending = master.status === 'pending'
  const masterName = instance.componentName ?? 'Component'

  // ---------------------------------------------------------------------
  // Drag-to-reorder within the group
  // ---------------------------------------------------------------------
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null)
  const dragRef = useRef<{
    startY: number
    startIdx: number
    /** Snapshot of resolved-step ids at drag start; the gesture sorts a
     *  copy of this and writes the resulting order back as overrides. */
    ids: string[]
    rowHeights: number[]
  } | null>(null)

  const beginRowDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, stepId: string, rowIdx: number) => {
      if (disabled || mutationCtx === null) return
      // Only react to the primary button. PointerEvent in some jsdom
      // versions leaves `button` undefined; treating that as primary
      // keeps RTL drag tests behaving like real browsers.
      if (e.button !== 0 && e.button !== undefined) return
      e.preventDefault()
      e.stopPropagation()
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        // jsdom / older browsers — capture is best-effort.
      }
      // Measure each row's height so the drop-index math is robust to
      // varying row heights (it isn't today, but cheap to future-proof).
      const container = (e.currentTarget as HTMLElement).closest('[data-anim-group-rows]')
      const heights: number[] = []
      if (container instanceof HTMLElement) {
        for (const child of container.querySelectorAll<HTMLElement>('[data-anim-group-row]')) {
          heights.push(child.getBoundingClientRect().height)
        }
      }
      dragRef.current = {
        startY: e.clientY,
        startIdx: rowIdx,
        ids: resolved.map((s) => s.id),
        rowHeights: heights,
      }
      setDraggingStepId(stepId)
    },
    [disabled, mutationCtx, resolved],
  )

  const handleRowDragMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (drag === null) return
    // hasPointerCapture is unreliable in jsdom — once dragRef is set
    // we trust the in-flight gesture. Real browsers honour the
    // capture set in beginRowDrag so cross-element move is fine.
    const dy = e.clientY - drag.startY
    // Convert pointer dy to an index delta. Use median row height as
    // a constant — keeps the math cheap, accuracy is not load-bearing
    // (the user sees the rows shuffle in real time).
    const avgH =
      drag.rowHeights.length > 0
        ? drag.rowHeights.reduce((acc, n) => acc + n, 0) / drag.rowHeights.length
        : 24
    const stepDelta = Math.round(dy / Math.max(12, avgH))
    const target = Math.max(0, Math.min(drag.ids.length - 1, drag.startIdx + stepDelta))
    // Local visual reorder is implicit through the order overrides
    // we'll commit on pointerup. We don't pre-write per move — that
    // would burn N undo entries. Just remember target and act on end.
    ;(drag as { previewTarget?: number }).previewTarget = target
  }, [])

  const endRowDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (drag === null) return
      try {
        if (
          typeof e.currentTarget.hasPointerCapture === 'function' &&
          e.currentTarget.hasPointerCapture(e.pointerId)
        ) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
      } catch {
        // jsdom — capture API may be missing entirely.
      }
      const target = (drag as { previewTarget?: number }).previewTarget ?? drag.startIdx
      dragRef.current = null
      setDraggingStepId(null)

      if (target === drag.startIdx) return
      if (mutationCtx === null) return

      // Build the new order: remove the dragged id from its old slot and
      // insert it at the target. Then write order overrides for ALL ids
      // — keeping them dense (0..N-1) keeps the ordering stable across
      // rounds of drags. The resolveInstanceAnimations sort handles ties
      // (stable on master order).
      const ids = [...drag.ids]
      const movedId = ids[drag.startIdx]
      if (movedId === undefined) return
      ids.splice(drag.startIdx, 1)
      ids.splice(target, 0, movedId)

      // Single transaction across all rows so the gesture is one undo step.
      mutationCtx.doc.transact(() => {
        for (let i = 0; i < ids.length; i++) {
          const stepId = ids[i]
          if (stepId === undefined) continue
          setAnimationOverride(mutationCtx, instance.id, stepId, { order: i })
        }
      })
    },
    [instance.id, mutationCtx],
  )

  // Cleanup capture on unmount mid-drag.
  useEffect(() => {
    return () => {
      dragRef.current = null
    }
  }, [])

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  if (isMissing) {
    return (
      <div
        data-testid={`component-anim-group-missing-${instance.id}`}
        className="rounded-md border border-border/40 bg-muted/30 px-2 py-1.5 opacity-60"
      >
        <div className="flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[11px] italic text-muted-foreground">
            Missing component
          </span>
        </div>
      </div>
    )
  }

  const stepCount = resolved.length

  return (
    <div
      data-testid={`component-anim-group-${instance.id}`}
      className="rounded-md border border-border/60 bg-input/20"
    >
      {hideHeader !== true && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-1.5 px-2 py-1 hover:bg-accent/30"
          data-testid={`component-anim-group-header-${instance.id}`}
        >
          <ChevronDown
            className={`h-3 w-3 flex-shrink-0 text-muted-foreground/70 transition-transform ${
              expanded ? 'rotate-0' : '-rotate-90'
            }`}
            aria-hidden="true"
          />
          <span
            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border border-[#6366f1]/40 bg-[#6366f1]/10 text-[9px] text-[#6366f1]"
            aria-hidden="true"
          >
            ⌘
          </span>
          <Layers className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-foreground">
            {masterName}
          </span>
          <span className="flex-shrink-0 text-[10px] text-muted-foreground/70">
            {stepCount} {stepCount === 1 ? 'step' : 'steps'}
          </span>
        </button>
      )}

      {expanded && (
        <div
          data-anim-group-rows
          className="flex flex-col gap-1 border-t border-border/40 px-1.5 py-1"
        >
          {isPending && (
            <p className="px-1 py-0.5 text-[10px] italic text-muted-foreground/70">
              Loading master…
            </p>
          )}
          {!isPending && stepCount === 0 && (
            <p className="px-1 py-0.5 text-[10px] italic text-muted-foreground/70">
              Master has no animations.
            </p>
          )}
          {resolved.map((step, idx) => {
            const ov = instance.overrides?.animations?.[step.id]
            const dragHandleProps =
              mutationCtx !== null && !disabled
                ? {
                    'data-drag-handle': 'true',
                    onPointerDown: (e: React.PointerEvent<HTMLElement>) =>
                      beginRowDrag(e, step.id, idx),
                    onPointerMove: handleRowDragMove,
                    onPointerUp: endRowDrag,
                    onPointerCancel: endRowDrag,
                  }
                : undefined
            return (
              <div key={step.id} data-anim-group-row>
                <ComponentAnimationRow
                  step={step}
                  override={ov}
                  instanceId={instance.id}
                  mutationCtx={mutationCtx}
                  disabled={disabled}
                  {...(dragHandleProps !== undefined ? { dragHandleProps } : {})}
                  isDragging={draggingStepId === step.id}
                  {...(compact === true ? { compact: true } : {})}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
