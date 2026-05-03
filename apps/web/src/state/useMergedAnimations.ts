/**
 * state/useMergedAnimations.ts
 *
 * M16 P8 — React hook that returns the slide's animation timeline merged
 * with each ComponentInstance's resolved master animations.
 *
 * What this exposes (engine side):
 *   - `steps`  — flat AnimationStep[] in playback order (slide-native first,
 *                then per-instance groups in slide z-order). Ready for
 *                `compileSteps` from @narrative/animation.
 *   - `groups` — AnimationGroup[] — per-instance descriptors so the timeline
 *                panel can render collapsible "Component" sections.
 *   - `nativeAnimations` / `animationsCtx` — passthrough so consumers don't
 *     need to call `useAnimations` separately.
 *
 * Re-render semantics:
 *   The hook subscribes to:
 *     - the active slide's `animations` Y.Array (via useAnimations)
 *     - the active slide's `objects` Y.Array (via useSlideObjects, used
 *       to find ComponentInstance nodes)
 *     - every UNIQUE master Y.Doc referenced by an instance on the slide,
 *       via componentDocCache.subscribeToComponentDoc — so a master edit
 *       triggers a re-merge without a slide-side mutation.
 *   The merge itself is pure and re-runs only when one of those changes,
 *   producing fresh `steps` + `groups`.
 *
 * Acquire/release:
 *   `acquireComponentDoc` is already called by the renderer for every
 *   instance on the slide (see componentInstanceRenderer.attachToComponent).
 *   This hook does NOT acquire — it piggy-backs on the renderer's lifecycle
 *   and reads through the cache. Acquire-without-render would race the
 *   renderer's release on slide switch.
 */

import { useEffect, useMemo, useState } from 'react'
import type { AnimationStep, ComponentInstanceObject, SlideObject } from '@narrative/shared'
import type { AnimationsMutationContext } from '@narrative/slide-model'
import { useAnimations } from './useAnimations.js'
import { useSlideObjects } from './useSlideObjects.js'
import {
  acquireComponentDoc,
  getComponentDoc,
  releaseComponentDoc,
  subscribeToComponentDoc,
} from './componentDocCache.js'
import { extractComponentSnapshot } from './extractComponentSnapshot.js'
import {
  buildMergedAnimationSteps,
  type AnimationGroup,
  type MergedAnimationSteps,
} from '../animation/buildMergedAnimationSteps.js'

export interface UseMergedAnimationsResult extends MergedAnimationSteps {
  /** Slide-native animations (Y.Array order) — passthrough for consumers
   *  that need to address the native vs. instance halves separately
   *  (e.g. the timeline UI's "native row" path). */
  nativeAnimations: AnimationStep[]
  /** Mutation context for the active slide's animation Y.Array. Null
   *  when no active slide. */
  animationsCtx: AnimationsMutationContext | null
}

/**
 * Collect the unique component ids referenced by ComponentInstance nodes
 * on the slide. Sorted for stable effect-dep equality across renders.
 */
function collectComponentIds(objects: readonly SlideObject[]): string[] {
  const ids = new Set<string>()
  for (const o of objects) {
    if (o.type === 'componentInstance') {
      ids.add((o as ComponentInstanceObject).componentId)
    }
  }
  return [...ids].sort()
}

export function useMergedAnimations(): UseMergedAnimationsResult {
  const { animations: nativeAnimations, animationsCtx } = useAnimations()
  const { objects } = useSlideObjects()

  // Bump counter whenever ANY referenced master doc changes. Using a
  // single counter instead of per-componentId state keeps the effect
  // graph simple — the merge re-runs once per frame (rAF debounce in
  // componentDocCache.subscribeToComponentDoc) regardless of how many
  // masters mutated together.
  const [masterStamp, setMasterStamp] = useState(0)

  const componentIds = useMemo(() => collectComponentIds(objects), [objects])

  // Re-subscribe when the set of referenced component ids changes (slide
  // switch, instance added / removed, master swap). The dependency on
  // a sorted, joined string keeps the effect from re-running on
  // unrelated `objects` changes (e.g. a rectangle resize).
  //
  // Acquire-on-mount is required even though the renderer also acquires
  // its own ref: present mode mounts this hook BEFORE
  // `componentInstanceRenderer.attachToComponent` fires (the renderer is
  // driven by Pixi's first paint, which lags by 1+ frames vs React
  // effects). Without acquiring here, `subscribeToComponentDoc` returns a
  // no-op when the cache slot doesn't exist yet — and we never re-fire
  // because `componentIds` doesn't change again. The cache is ref-counted
  // so double-acquire is safe and was the original design.
  const componentIdsKey = componentIds.join('|')
  useEffect(() => {
    if (componentIds.length === 0) return
    for (const cid of componentIds) acquireComponentDoc(cid)
    const unsubs = componentIds.map((cid) =>
      subscribeToComponentDoc(cid, () => {
        setMasterStamp((s) => s + 1)
      }),
    )
    // Ping the merge once on first sync so we don't ship empty animations
    // for one frame before the subscription's first delivery lands.
    setMasterStamp((s) => s + 1)
    return () => {
      for (const u of unsubs) u()
      for (const cid of componentIds) releaseComponentDoc(cid)
    }
    // componentIds is derived from componentIdsKey — listing both is
    // belt-and-braces for the lint rule.
  }, [componentIdsKey, componentIds])

  // Memoise the merge — pure function of (nativeAnimations, objects,
  // master snapshots). `masterStamp` ticks invalidate the cache when any
  // master mutates.
  const merged = useMemo<MergedAnimationSteps>(() => {
    return buildMergedAnimationSteps(nativeAnimations, objects, (componentId) => {
      const doc = getComponentDoc(componentId)
      if (doc === null) return null
      const snap = extractComponentSnapshot(doc)
      if (snap === null) return null
      return snap.animations
    })
    // masterStamp is read inside `getMasterAnimations` via the cache —
    // listing it here forces the memo to re-run on master mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeAnimations, objects, masterStamp])

  return {
    steps: merged.steps,
    groups: merged.groups,
    nativeAnimations,
    animationsCtx,
  }
}

// ---------------------------------------------------------------------------
// Re-exports for convenience — keeps callers off the schema-level type by
// default and lets the panel UI import everything it needs from one path.
// ---------------------------------------------------------------------------

export type { AnimationGroup }
