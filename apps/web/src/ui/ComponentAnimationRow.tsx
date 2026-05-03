/**
 * ui/ComponentAnimationRow.tsx
 *
 * M16 P8 — Shared per-step animation row for a ComponentInstance.
 *
 * Same component is mounted by:
 *   - AnimationTimeline → as the rows inside a per-instance "Component"
 *     group above the slide-native steps.
 *   - Inspector (ComponentInstanceInspector) → as a sibling "Animations"
 *     section that mirrors the timeline group.
 *
 * Contract:
 *   - Reads master step values from `step` (already merged for display via
 *     `resolveInstanceAnimations` upstream).
 *   - Reads override slot from `override` (raw, used for the "Modified"
 *     badge + reset affordance).
 *   - Writes go via state-sync helpers (setAnimationOverride /
 *     clearAnimationOverride). The row never touches Y.Doc directly and
 *     never mutates the master.
 *   - Each control coalesces into a single Yjs transaction via the
 *     state-sync helper's transact wrapper — one gesture = one undo step.
 *
 * The row also exposes a `dragHandleProps` slot so the parent (timeline)
 * can attach the same drag handlers it uses for native steps. The
 * Inspector mounts the row without a drag handle (no use case: the
 * inspector list isn't a sequence editor).
 */

import { useMemo, useCallback } from 'react'
import { Clock, MousePointerClick } from 'lucide-react'
import type { AnimationStep, AnimationTrigger, ComponentInstanceOverrides } from '@narrative/shared'
import {
  setAnimationOverride,
  clearAnimationOverride,
  type ObjectsMutationContext,
} from '@narrative/slide-model'

type AnimationOverride = NonNullable<ComponentInstanceOverrides['animations']>[string]

export interface ComponentAnimationRowProps {
  /** The resolved (master + override) step — used for display values. */
  step: AnimationStep
  /** The raw per-step override slot, used for the "Modified" badge. */
  override: AnimationOverride | undefined
  /** ComponentInstance id; routed to setAnimationOverride. */
  instanceId: string
  /**
   * State-sync mutation context for the slide that hosts the instance.
   * Null when the user lacks write access — every control is then
   * disabled and writes are no-ops.
   */
  mutationCtx: ObjectsMutationContext | null
  /** Owner is a viewer / no folder access — disable every control. */
  disabled: boolean
  /** Optional drag-handle props from the parent reorder driver. */
  dragHandleProps?: React.HTMLAttributes<HTMLElement> & { 'data-drag-handle'?: string }
  /**
   * When true, the row is the one currently being dragged inside the
   * group. The parent visually de-emphasises it; the row reads the
   * flag for opacity / cursor only.
   */
  isDragging?: boolean
  /** Compact mode collapses some labels — used by the timeline group. */
  compact?: boolean
}

/**
 * Returns true when at least one override field is set on this step.
 * `disabled === true` counts (it's a meaningful override). `order` does
 * count — the user explicitly moved the row.
 */
function isModified(ov: AnimationOverride | undefined): boolean {
  if (ov === undefined) return false
  return (
    ov.trigger !== undefined ||
    ov.delay !== undefined ||
    ov.duration !== undefined ||
    ov.ease !== undefined ||
    ov.disabled === true ||
    ov.order !== undefined
  )
}

/** Trigger icon — Clock for time-driven, MousePointerClick for onClick. */
function TriggerGlyph({ trigger }: { trigger: AnimationTrigger }): JSX.Element {
  if (trigger === 'onClick') {
    return <MousePointerClick className="h-3 w-3" aria-hidden="true" />
  }
  return <Clock className="h-3 w-3" aria-hidden="true" />
}

/**
 * Stable label for a step — uses the step's name if present, else the
 * preset id. Matches the convention used by AnimationsSection in
 * Inspector.tsx (preset + direction parens) so authors see consistent
 * labels in both places.
 */
function stepLabel(step: AnimationStep): string {
  const direction = (step.params as { direction?: string } | undefined)?.direction
  if (typeof direction === 'string' && direction.length > 0) {
    return `${step.preset} (${direction})`
  }
  return step.preset
}

export function ComponentAnimationRow({
  step,
  override,
  instanceId,
  mutationCtx,
  disabled,
  dragHandleProps,
  isDragging,
  compact,
}: ComponentAnimationRowProps): JSX.Element {
  const modified = useMemo(() => isModified(override), [override])

  const writeOverride = useCallback(
    (patch: Parameters<typeof setAnimationOverride>[3]): void => {
      if (mutationCtx === null) return
      setAnimationOverride(mutationCtx, instanceId, step.id, patch)
    },
    [mutationCtx, instanceId, step.id],
  )

  const handleReset = useCallback(() => {
    if (mutationCtx === null) return
    clearAnimationOverride(mutationCtx, instanceId, step.id)
  }, [mutationCtx, instanceId, step.id])

  const handleTrigger = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      writeOverride({ trigger: e.target.value as AnimationTrigger })
    },
    [writeOverride],
  )

  const handleDelay = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value)
      if (!Number.isFinite(v) || v < 0) return
      writeOverride({ delay: v })
    },
    [writeOverride],
  )

  const handleDuration = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value)
      if (!Number.isFinite(v) || v <= 0) return
      writeOverride({ duration: v })
    },
    [writeOverride],
  )

  const label = stepLabel(step)

  return (
    <div
      data-testid={`component-anim-row-${instanceId}-${step.id}`}
      data-modified={modified ? 'true' : 'false'}
      className={[
        'flex items-center gap-1 rounded-md border border-border/60 bg-input/30 px-1.5 py-1',
        isDragging === true ? 'opacity-40' : '',
      ].join(' ')}
    >
      {/* Drag handle — only mounted when the parent passes drag props. */}
      {dragHandleProps !== undefined && (
        <span
          {...dragHandleProps}
          role="button"
          tabIndex={0}
          aria-label={`Reorder ${label}`}
          className="flex h-5 w-3 flex-shrink-0 cursor-grab items-center justify-center text-muted-foreground/50 hover:text-foreground active:cursor-grabbing"
          style={{ touchAction: 'none' }}
          title="Drag to reorder within this component"
        >
          <svg width="6" height="10" viewBox="0 0 6 10" fill="currentColor" aria-hidden="true">
            <circle cx="1" cy="1.5" r="0.7" />
            <circle cx="5" cy="1.5" r="0.7" />
            <circle cx="1" cy="5" r="0.7" />
            <circle cx="5" cy="5" r="0.7" />
            <circle cx="1" cy="8.5" r="0.7" />
            <circle cx="5" cy="8.5" r="0.7" />
          </svg>
        </span>
      )}

      {/* Trigger icon + select. The icon is a visual; the select sits over
          it so click expands the native dropdown. Mirrors the timeline
          bar's trigger slot. */}
      <span
        className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm text-foreground/80"
        aria-hidden="true"
      >
        <TriggerGlyph trigger={step.trigger} />
        <select
          value={step.trigger}
          disabled={disabled || mutationCtx === null}
          aria-label={`Trigger for ${label}`}
          onChange={handleTrigger}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          <option value="withPrevious">withPrevious</option>
          <option value="afterPrevious">afterPrevious</option>
          <option value="onClick">onClick</option>
        </select>
      </span>

      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground" title={label}>
        {label}
      </span>

      {!compact && (
        <>
          <label
            className="flex flex-shrink-0 items-center gap-1 text-[10px] text-muted-foreground/80"
            title="Delay (s)"
          >
            <span className="hidden sm:inline">D</span>
            <input
              type="number"
              min={0}
              step={0.05}
              value={step.delay}
              disabled={disabled || mutationCtx === null}
              aria-label={`Delay for ${label}`}
              onChange={handleDelay}
              data-testid={`component-anim-delay-${instanceId}-${step.id}`}
              className={[
                'h-5 w-12 rounded border border-input bg-background px-1 text-[10px] tabular-nums',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
              ].join(' ')}
            />
          </label>
          <label
            className="flex flex-shrink-0 items-center gap-1 text-[10px] text-muted-foreground/80"
            title="Duration (s)"
          >
            <span className="hidden sm:inline">L</span>
            <input
              type="number"
              min={0.05}
              step={0.05}
              value={step.duration}
              disabled={disabled || mutationCtx === null}
              aria-label={`Duration for ${label}`}
              onChange={handleDuration}
              data-testid={`component-anim-duration-${instanceId}-${step.id}`}
              className={[
                'h-5 w-12 rounded border border-input bg-background px-1 text-[10px] tabular-nums',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
              ].join(' ')}
            />
          </label>
        </>
      )}

      <span
        data-testid={`component-anim-badge-${instanceId}-${step.id}`}
        className={[
          'flex-shrink-0 rounded-sm px-1 py-0.5 text-[9px] uppercase tracking-wider',
          modified ? 'bg-amber-500/15 text-amber-600' : 'bg-muted/50 text-muted-foreground/70',
        ].join(' ')}
      >
        {modified ? 'Modified' : 'Linked'}
      </span>
      <button
        type="button"
        disabled={disabled || !modified || mutationCtx === null}
        onClick={handleReset}
        aria-label={`Reset ${label} to master`}
        title="Reset to master"
        data-testid={`component-anim-reset-${instanceId}-${step.id}`}
        className={[
          'flex-shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground',
          'hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40',
        ].join(' ')}
      >
        Reset
      </button>
    </div>
  )
}
