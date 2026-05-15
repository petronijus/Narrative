/**
 * animation/buildMergedAnimationSteps.ts
 *
 * Was: a merger that flattened slide-native AnimationStep[] together with
 * per-instance master animations resolved through the override layer.
 *
 * Components are now stamps — there is no instance/master split, every
 * animation lives directly on the slide. The merger collapses to a thin
 * pass-through that the timeline UI and present-mode compiler still call
 * through (kept as one function for a tighter blast radius around the
 * type rip; later passes can inline it).
 */

import type { AnimationStep, SlideObject } from '@narrative/shared'

export interface AnimationGroup {
  id: string
  kind: 'componentInstance'
  instanceId: string
  componentId: string
  label: string
  steps: AnimationStep[]
  masterStepIds: string[]
}

export interface MergedAnimationSteps {
  steps: AnimationStep[]
  /** Always empty — kept for call-site stability. */
  groups: AnimationGroup[]
}

export interface MasterAnimationsLookup {
  (componentId: string): readonly AnimationStep[] | null
}

/**
 * Pass-through: returns the slide's native animation steps as-is.
 * Components are stamped onto the slide, so master animations are
 * already part of `slideAnimations` and there is nothing to merge.
 */
export function buildMergedAnimationSteps(
  slideAnimations: readonly AnimationStep[],
  _slideObjects: readonly SlideObject[],
  _getMasterAnimations: MasterAnimationsLookup,
): MergedAnimationSteps {
  return { steps: slideAnimations.slice(), groups: [] }
}

export function parseMergedStepId(
  _mergedId: string,
): { instanceId: string; masterStepId: string } | null {
  return null
}

export function indexGroupsByInstance(
  groups: readonly AnimationGroup[],
): Map<string, AnimationGroup> {
  const out = new Map<string, AnimationGroup>()
  for (const g of groups) out.set(g.instanceId, g)
  return out
}
