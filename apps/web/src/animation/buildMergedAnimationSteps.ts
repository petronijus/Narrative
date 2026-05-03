/**
 * animation/buildMergedAnimationSteps.ts
 *
 * M16 P8 — Merge slide-native animation steps with per-instance master
 * animations into ONE list the GSAP compiler can consume verbatim.
 *
 * Why a separate module:
 *   The compiler in @narrative/animation is target-id-keyed and stateless
 *   — it doesn't know about ComponentInstances, masters, or per-instance
 *   overrides. P8's whole job is to flatten the two sources into a single
 *   AnimationStep[] with re-mapped target ids, then hand that off to the
 *   existing compiler. Keeping the merge logic in /animation (not in the
 *   compiler package) means @narrative/animation stays
 *   framework-agnostic; the merger lives in /apps/web because it depends
 *   on the master-doc cache and renderer plumbing.
 *
 * Merge order (deterministic — present mode and editor see the same play
 * order):
 *   1. All slide-native AnimationStep[] in their Y.Array order.
 *   2. For each ComponentInstance on the slide IN SLIDE Z-ORDER (i.e. the
 *      Y.Array order of slide.objects), the resolved master animations
 *      (master order, optionally re-sorted by per-instance `order`
 *      override). Each step's objectId is rewritten to the synthetic
 *      `instance:<instanceId>:<leafId>` form.
 *
 * Group descriptor:
 *   For every instance we emit one AnimationGroup so the timeline UI can
 *   render a collapsible "Component: <name>" group with one row per step.
 *   Groups are pure metadata — they never reach the compiler. The group's
 *   `steps` reference the SAME AnimationStep[] entries that appear in the
 *   merged list, so panel selection / drag / etc. share identity.
 *
 * Purity:
 *   - No Yjs, no Pixi, no React.
 *   - No mutation of the inputs. Master snapshot arrays / override
 *     payloads are read-only.
 *   - The MASTER Y.Doc is never written to from this path — overrides
 *     live on the instance, the master is read-only here.
 *   - O(N + I*M) where N = slide-native steps, I = instances, M = avg
 *     steps per master. No per-leaf scan.
 */

import type {
  AnimationStep,
  ComponentInstanceObject,
  ComponentInstanceOverrides,
  SlideObject,
} from '@narrative/shared'
import { resolveInstanceAnimations } from '@narrative/slide-model'
import { makeInstanceLeafTargetId } from './instanceTargetIds.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Metadata for one ComponentInstance group surfaced in the slide
 * animation panel. The UI renders this as a collapsible group with the
 * master's display name and one row per resolved step.
 */
export interface AnimationGroup {
  /** Stable id for the group — equal to the instance id. */
  id: string
  /**
   * Discriminator. Currently only `'componentInstance'`; future kinds
   * (e.g. `'video'`) would land here without breaking the union shape.
   */
  kind: 'componentInstance'
  /** Slide-side instance id — used by the UI to write override patches. */
  instanceId: string
  /** Master component id — used by the UI to fetch the master's display name. */
  componentId: string
  /**
   * Display label for the group header. Pulled from the instance's
   * denormalized `componentName` field at merge time. Falls back to
   * "Component" when missing — matches the placeholder copy.
   */
  label: string
  /**
   * Resolved + remapped steps for THIS instance, in playback order
   * (master order with per-instance `order` overrides applied). Steps
   * here are the SAME references that appear in the flat `steps[]` of
   * the merge result, so identity-equality lookups in the timeline UI
   * work without an extra map.
   */
  steps: AnimationStep[]
  /**
   * The master step ids that backed each entry in `steps`, parallel to
   * `steps`. The compiler doesn't care about these (target ids are
   * remapped), but the override editor needs them to address the right
   * stepId in `instance.overrides.animations`. We store them parallel
   * rather than mutating the AnimationStep's id so master step ids stay
   * intact for any downstream introspection.
   */
  masterStepIds: string[]
}

/**
 * Result of merging slide-native steps with per-instance master steps.
 */
export interface MergedAnimationSteps {
  /**
   * Flat, ordered list ready for `compileSteps`. Slide-native first,
   * then per-instance groups in slide z-order.
   */
  steps: AnimationStep[]
  /**
   * Group metadata for the timeline panel. Empty when the slide has no
   * ComponentInstances (or none with master animations).
   */
  groups: AnimationGroup[]
}

// ---------------------------------------------------------------------------
// Master-snapshot accessor (dependency injected so the merger stays pure
// and the test path can stub the cache).
// ---------------------------------------------------------------------------

/**
 * Minimal snapshot shape consumed by the merger. Mirrors the exported
 * `ComponentSnapshot` from `extractComponentSnapshot.ts` but only the
 * `animations` array — we don't need the master's `objects` or `bbox`
 * here. Using a structural type keeps the merger free of a hard
 * dependency on the renderer-side snapshot cache.
 */
export interface MasterAnimationsLookup {
  (componentId: string): readonly AnimationStep[] | null
}

// ---------------------------------------------------------------------------
// Public entry-point
// ---------------------------------------------------------------------------

/**
 * Build the merged animation step list for a slide.
 *
 * @param slideAnimations  The slide's own animation steps in Y.Array order.
 * @param slideObjects     The slide's objects in z-order (Y.Array order).
 *                         Used to find ComponentInstance nodes and to
 *                         preserve slide z-order across groups.
 * @param getMasterAnimations  Resolves a master's animation steps. Returns
 *                         null when the master is mid-sync or missing —
 *                         the merger silently drops that instance from
 *                         the merged list (placeholder is already
 *                         visible to the user via the renderer).
 *
 * Pure & memoisable — given identical inputs, returns identical output.
 * Identity is preserved on the slide-native steps (no rewrite needed)
 * and on ANY instance step that didn't need an override merge — see
 * `resolveInstanceAnimations` for its identity contract. Steps emitted
 * with remapped target ids are always fresh objects (because objectId
 * rewriting must produce a new struct).
 */
export function buildMergedAnimationSteps(
  slideAnimations: readonly AnimationStep[],
  slideObjects: readonly SlideObject[],
  getMasterAnimations: MasterAnimationsLookup,
): MergedAnimationSteps {
  // Native slide steps come first. We don't rewrite them — their
  // targetResolver path is the existing SceneGraph lookup.
  const steps: AnimationStep[] = slideAnimations.slice()
  const groups: AnimationGroup[] = []

  for (const obj of slideObjects) {
    if (obj.type !== 'componentInstance') continue
    const instance = obj as ComponentInstanceObject
    const masterSteps = getMasterAnimations(instance.componentId)
    if (masterSteps === null) {
      // Master not yet synced or missing — skip silently. The renderer's
      // placeholder communicates the state to the user; we don't want
      // to crash compileSteps with a half-resolved instance.
      continue
    }

    const resolved = resolveInstanceAnimations(masterSteps, instance.overrides)
    if (resolved.length === 0) continue

    // Re-map each resolved step to the synthetic per-instance target id.
    // We always allocate a new step object — the targetId rewrite alone
    // would otherwise mutate the master snapshot through shared identity.
    const remapped: AnimationStep[] = []
    const masterStepIds: string[] = []
    for (const step of resolved) {
      const newTarget = makeInstanceLeafTargetId(instance.id, step.objectId)
      // Step id must be unique across the whole merged list, otherwise
      // two instances of the same master would collide in any ID-keyed
      // bookkeeping (selection, override editor, undo focus). We
      // namespace by instance id and keep the master step id intact in
      // the parallel `masterStepIds` array so the override editor can
      // still address the right slot.
      const namespacedId = `${instance.id}:${step.id}`
      const next: AnimationStep = {
        ...step,
        id: namespacedId,
        objectId: newTarget,
      }
      remapped.push(next)
      masterStepIds.push(step.id)
      steps.push(next)
    }

    groups.push({
      id: instance.id,
      kind: 'componentInstance',
      instanceId: instance.id,
      componentId: instance.componentId,
      label:
        typeof instance.componentName === 'string' && instance.componentName.length > 0
          ? instance.componentName
          : 'Component',
      steps: remapped,
      masterStepIds,
    })
  }

  return { steps, groups }
}

// ---------------------------------------------------------------------------
// Group lookup helpers (consumed by the timeline UI)
// ---------------------------------------------------------------------------

/**
 * Inverse of the namespace prefix written in `buildMergedAnimationSteps`.
 * Given a merged-step id of the form `<instanceId>:<masterStepId>`,
 * returns the (instanceId, masterStepId) pair. Returns null when the id
 * is a slide-native step (no colon) — UI code uses that as the
 * "native step" branch.
 *
 * Mirrors the parser in targetResolver.ts so the same colon convention
 * is used everywhere; if you change one, change both.
 */
export function parseMergedStepId(
  mergedId: string,
): { instanceId: string; masterStepId: string } | null {
  const colon = mergedId.indexOf(':')
  if (colon <= 0 || colon === mergedId.length - 1) return null
  return {
    instanceId: mergedId.slice(0, colon),
    masterStepId: mergedId.slice(colon + 1),
  }
}

/**
 * Build a quick lookup so a group click in the panel can find the
 * AnimationGroup for an instance id without re-scanning. Pure.
 */
export function indexGroupsByInstance(
  groups: readonly AnimationGroup[],
): Map<string, AnimationGroup> {
  const out = new Map<string, AnimationGroup>()
  for (const g of groups) out.set(g.instanceId, g)
  return out
}

// ---------------------------------------------------------------------------
// Re-exports — keeps callers off the schema-level type by default.
// ---------------------------------------------------------------------------

export type { ComponentInstanceOverrides }
