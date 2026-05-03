/**
 * slide-model/src/resolveOverrides.ts
 *
 * M16 P7 — Pure override resolver.
 *
 * Given a master component snapshot (plain SlideObject[] from
 * extractComponentSnapshot) and an instance's sparse `overrides` payload,
 * produce a NEW array of plain objects ready for the renderer's
 * reconcileChildren pipeline. Same shape on the animation side.
 *
 * Why a dedicated module:
 *   - The renderer used to inline a tiny override-merge in P6
 *     (componentInstanceRenderer.ts:applyOverrides). P7 promotes that to
 *     a shared, fully-typed, fully-tested helper that the renderer AND
 *     the inspector preview pipeline can both use without duplicating
 *     merge rules.
 *   - The animation override path was missing entirely in P6. P7 adds
 *     resolveInstanceAnimations which honours per-step trigger / delay /
 *     duration / ease / disabled overrides.
 *
 * Design rules (do not break):
 *   1. Pure: no Yjs, no React, no Pixi imports. Inputs are plain JSON;
 *      outputs are plain JSON. The caller is free to memoise.
 *   2. Non-mutating: original master snapshot and override payload are
 *      never written to. Always produce new top-level objects when an
 *      override touches them, otherwise pass the master reference
 *      through unchanged so downstream identity-equality checks (e.g.
 *      reconcileChildren) can short-circuit.
 *   3. Dangling overrides preserved: if `overrides.leaves[id]` references
 *      a leaf that no longer exists in the master, we silently SKIP that
 *      override but leave it in the input untouched. Rationale: when a
 *      master temporarily loses a leaf (e.g. user is mid-edit) we don't
 *      want to drop the instance's customisation forever. The data-side
 *      cleanup is intentionally never automatic — only explicit user
 *      action (Reset overrides / Detach) clears the slot.
 *   4. Transform override is ADDITIVE on x/y only. The override's
 *      transform is interpreted as a delta added to the master values.
 *      P7 deliberately keeps this minimal — width/height/rotation are
 *      not user-overridable per leaf in this milestone (would break
 *      uniform-fit semantics on instance resize).
 */

import type {
  SlideObject,
  ComponentInstanceOverrides,
  AnimationStep,
  AnimationTrigger,
} from '@narrative/shared'
import { isAnimationTrigger } from '@narrative/shared'

// ---------------------------------------------------------------------------
// resolveInstanceTree
// ---------------------------------------------------------------------------

/**
 * Apply per-leaf overrides on top of a master snapshot.
 *
 * @param masterObjects  The master tree from `extractComponentSnapshot(...).objects`.
 *                       Plain JSON, Y.Text bodies already promoted to strings.
 * @param overrides      The instance's `overrides` payload (or undefined).
 * @returns A new array of plain SlideObjects. Master objects untouched by
 *          overrides are passed through by reference (identity preserved
 *          so downstream diff/reconcile can short-circuit).
 */
export function resolveInstanceTree(
  masterObjects: readonly SlideObject[],
  overrides: ComponentInstanceOverrides | undefined,
): SlideObject[] {
  const leafOverrides = overrides?.leaves
  if (leafOverrides === undefined || Object.keys(leafOverrides).length === 0) {
    // Nothing to do — return a shallow copy so callers can't accidentally
    // mutate the snapshot's array. Element identity is preserved.
    return masterObjects.slice()
  }

  return masterObjects.map((obj) => {
    const ov = leafOverrides[obj.id]
    if (ov === undefined) return obj
    return mergeLeafOverride(obj, ov)
  })
}

/**
 * Merge a single leaf override onto one master object. Returns a NEW object
 * if any field changed, otherwise returns the original by reference.
 *
 * Merge algorithm (field by field over the patch keys):
 *
 *   `text`           — replace. Applied only when the master object has a
 *                      `text` field (fail-safe for cross-type ports).
 *   `transform.x/y`  — ADDITIVE delta: finalX = master.x + override.transform.x.
 *                      Used for canvas-drag nudges. If the patch also carries
 *                      an absolute `x` or `y` key, the absolute value wins
 *                      and the additive transform is ignored for that axis.
 *   `x` / `y`        — ABSOLUTE: replaces master position directly. Takes
 *                      precedence over any `transform.x/y` in the same patch.
 *   all other keys   — replace wholesale (scalars, arrays, sub-objects).
 *
 * Dangling overrides: if `overrides.leaves[id]` references a leaf absent
 * from the master, the caller (resolveInstanceTree) skips that entry.
 * This function assumes the caller passes a matching master object.
 */
function mergeLeafOverride(
  obj: SlideObject,
  ov: NonNullable<ComponentInstanceOverrides['leaves']>[string],
): SlideObject {
  const merged: Record<string, unknown> = { ...(obj as unknown as Record<string, unknown>) }
  let touched = false

  const ovRecord = ov as Record<string, unknown>
  const hasAbsoluteX = 'x' in ov
  const hasAbsoluteY = 'y' in ov

  for (const key of Object.keys(ovRecord)) {
    const value = ovRecord[key]

    if (key === 'transform') {
      // ADDITIVE delta on x/y. Absolute `x`/`y` keys in the same patch take
      // precedence — skip the additive path for axes already covered.
      const t = value as { x?: number; y?: number } | undefined
      if (t === undefined) continue
      if (!hasAbsoluteX && typeof t.x === 'number') {
        const baseX = typeof obj.x === 'number' ? obj.x : 0
        merged['x'] = baseX + t.x
        touched = true
      }
      if (!hasAbsoluteY && typeof t.y === 'number') {
        const baseY = typeof obj.y === 'number' ? obj.y : 0
        merged['y'] = baseY + t.y
        touched = true
      }
      continue
    }

    if (key === 'text') {
      // Text override only applies when the master object carries a text field.
      if ('text' in (obj as object) && value !== undefined) {
        merged['text'] = value
        touched = true
      }
      continue
    }

    // All other fields: replace. `undefined` values are treated as "no override"
    // (the schema uses optional keys, not explicit nulls, so undefined means absent).
    if (value !== undefined) {
      merged[key] = value
      touched = true
    }
  }

  if (!touched) return obj
  return merged as unknown as SlideObject
}

// ---------------------------------------------------------------------------
// resolveInstanceAnimations
// ---------------------------------------------------------------------------

/**
 * Apply per-animation-step overrides on top of master animation steps.
 *
 * Override semantics:
 *   - `disabled === true` ⇒ the step is dropped from the output.
 *   - `trigger` ⇒ replaces the step's trigger when it parses as a known
 *     AnimationTrigger; otherwise the override is ignored (defensive —
 *     a free-form string isn't allowed to corrupt the timeline).
 *   - `delay` / `duration` ⇒ numeric replace; non-finite or negative
 *     values are ignored.
 *   - `ease` ⇒ string replace into AnimationStep.easing. We accept any
 *     string here since the GSAP ease registry isn't exposed at this
 *     boundary; the animation engine validates downstream.
 *   - `order` (P8) ⇒ when at least one surviving step has a finite
 *     `order` override, the output is re-sorted: explicitly-ordered steps
 *     first (ascending by `order`, stable on ties), then the remaining
 *     steps in their master order. Steps with `order === undefined`
 *     (or absent) keep their relative master order — the user only
 *     reorders what they touched.
 *
 * Steps not referenced in the override map pass through untouched
 * (identity preserved).
 *
 * Dangling-id behaviour mirrors `resolveInstanceTree`: an override on a
 * stepId that no longer exists in the master is silently skipped; the
 * stored override is NOT mutated.
 */
export function resolveInstanceAnimations(
  masterAnimations: readonly AnimationStep[],
  overrides: ComponentInstanceOverrides | undefined,
): AnimationStep[] {
  const animOverrides = overrides?.animations
  if (animOverrides === undefined || Object.keys(animOverrides).length === 0) {
    return masterAnimations.slice()
  }

  // First pass: filter + apply field overrides, preserving master order.
  // Track each surviving step's order override (if any) for the optional
  // re-sort below. We capture order alongside the master index so the
  // sort stays stable for ties / unordered steps.
  interface Entry {
    step: AnimationStep
    masterIdx: number
    /** Finite override `order` value, or undefined when no order override. */
    order: number | undefined
  }
  const entries: Entry[] = []
  for (let i = 0; i < masterAnimations.length; i++) {
    const step = masterAnimations[i]
    if (step === undefined) continue
    const ov = animOverrides[step.id]
    if (ov === undefined) {
      entries.push({ step, masterIdx: i, order: undefined })
      continue
    }
    if (ov.disabled === true) continue
    const merged = mergeAnimationOverride(step, ov)
    const orderRaw = ov.order
    const order = typeof orderRaw === 'number' && Number.isFinite(orderRaw) ? orderRaw : undefined
    entries.push({ step: merged, masterIdx: i, order })
  }

  // Optional re-sort: only when at least one entry carries an explicit
  // `order`. Cheap escape — most slides will never trigger this path.
  const hasOrder = entries.some((e) => e.order !== undefined)
  if (hasOrder) {
    entries.sort((a, b) => {
      const ao = a.order
      const bo = b.order
      if (ao !== undefined && bo !== undefined) {
        if (ao !== bo) return ao - bo
        return a.masterIdx - b.masterIdx
      }
      // Ordered entries come first, then unordered (preserving master order).
      if (ao !== undefined) return -1
      if (bo !== undefined) return 1
      return a.masterIdx - b.masterIdx
    })
  }

  return entries.map((e) => e.step)
}

function mergeAnimationOverride(
  step: AnimationStep,
  ov: NonNullable<ComponentInstanceOverrides['animations']>[string],
): AnimationStep {
  let trigger: AnimationTrigger = step.trigger
  let delay: number = step.delay
  let duration: number = step.duration
  let easing: string = step.easing
  let touched = false

  if (typeof ov.trigger === 'string' && isAnimationTrigger(ov.trigger)) {
    trigger = ov.trigger
    touched = true
  }
  if (typeof ov.delay === 'number' && Number.isFinite(ov.delay) && ov.delay >= 0) {
    delay = ov.delay
    touched = true
  }
  if (typeof ov.duration === 'number' && Number.isFinite(ov.duration) && ov.duration > 0) {
    duration = ov.duration
    touched = true
  }
  if (typeof ov.ease === 'string' && ov.ease.length > 0) {
    easing = ov.ease
    touched = true
  }
  if (!touched) return step
  return { ...step, trigger, delay, duration, easing }
}
