/**
 * slide-model/src/instanceOverrides.ts
 *
 * M16 P7 — Yjs mutation helpers for ComponentInstance overrides.
 *
 * Storage layout (mirrors scanTokenUsages.ts assumptions):
 *
 *   instanceMap (Y.Map)
 *     id            : string
 *     type          : 'componentInstance'
 *     componentId   : string
 *     ...
 *     overrides     : Y.Map
 *         leaves     : Y.Map<leafId, Y.Map>
 *             text      : string
 *             fill      : number | TokenRef
 *             stroke    : number | TokenRef
 *             transform : Y.Map { x, y }
 *         animations : Y.Map<stepId, Y.Map>
 *             trigger  : string
 *             delay    : number
 *             duration : number
 *             ease     : string
 *             disabled : true | undefined
 *
 * Why nested Y.Map (not a single plain JSON blob): sub-key writes from
 * different collaborators merge cleanly under CRDT semantics — author A
 * tweaks `leaves[L].text` while author B tweaks `leaves[L].fill` and
 * both writes land. A blob would make the second writer overwrite the
 * first. Per-key undo also becomes possible — the UndoManager scopes
 * per Y.Map / Y.Array, so editing fill then deleting it can be undone
 * one step at a time.
 *
 * All mutations go through `doc.transact(fn, LOCAL_ORIGIN)` so the
 * UndoManager treats them as a single user step.
 *
 * Pure-Yjs: no React, no Pixi.
 */

import * as Y from 'yjs'
import type { ObjectsMutationContext } from './mutations.js'
import { LOCAL_ORIGIN } from './mutations.js'
import type { SlideMutationContext } from './slideMutationContext.js'
import type { ComponentInstanceOverrides, LeafOverridePayload } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StoredLeafOverride = NonNullable<ComponentInstanceOverrides['leaves']>[string]
type StoredAnimationOverride = NonNullable<ComponentInstanceOverrides['animations']>[string]

/**
 * Patch shape for {@link setLeafOverride}. Mirrors the stored override
 * but every field also accepts `undefined` as an explicit "delete this
 * key" sentinel — the helper distinguishes "field missing from patch"
 * (leave existing value untouched) from "field set to undefined"
 * (delete the slot). `exactOptionalPropertyTypes` requires the `|
 * undefined` suffix to make the sentinel type-check.
 */
export type LeafOverridePatch = {
  [K in keyof StoredLeafOverride]?: StoredLeafOverride[K] | undefined
}

export type AnimationOverridePatch = {
  [K in keyof StoredAnimationOverride]?: StoredAnimationOverride[K] | undefined
}

/**
 * Generic leaf override patch — covers all overridable fields across all
 * leaf types. Wraps {@link LeafOverridePayload} with explicit `undefined`
 * sentinel support: a key set to `undefined` means "delete this override slot"
 * rather than "field absent from the patch".
 *
 * `exactOptionalPropertyTypes` requires the `| undefined` suffix to
 * type-check the sentinel intent.
 */
export type GenericLeafOverridePatch = {
  [K in keyof LeafOverridePayload]?: LeafOverridePayload[K] | undefined
}

// ---------------------------------------------------------------------------
// Internal helpers — find / lazy-create nested Y.Maps
// ---------------------------------------------------------------------------

function findInstanceMap(ctx: ObjectsMutationContext, instanceId: string): Y.Map<unknown> | null {
  for (let i = 0; i < ctx.objects.length; i++) {
    const yMap = ctx.objects.get(i)
    if (yMap.get('id') === instanceId) {
      if (yMap.get('type') !== 'componentInstance') return null
      return yMap
    }
  }
  return null
}

/** Returns instance.overrides Y.Map, creating it if missing. Caller MUST be inside a transact. */
function ensureOverridesMap(instanceMap: Y.Map<unknown>): Y.Map<unknown> {
  let overrides = instanceMap.get('overrides')
  if (overrides instanceof Y.Map) return overrides
  // Legacy slot (plain object literal from P5/P6) ⇒ start fresh. We don't
  // attempt to migrate the contents because P5/P6 never wrote anything in.
  overrides = new Y.Map()
  instanceMap.set('overrides', overrides)
  return overrides as Y.Map<unknown>
}

function ensureChildMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  let child = parent.get(key)
  if (child instanceof Y.Map) return child
  child = new Y.Map()
  parent.set(key, child)
  return child as Y.Map<unknown>
}

// ---------------------------------------------------------------------------
// Leaf overrides
// ---------------------------------------------------------------------------

/**
 * Generic write adapter for leaf overrides. Accepts any `Partial<SlideObject>`
 * patch (minus `id`, `type`, `groupId`) and writes each present key into the
 * leaf's Y.Map override slot.
 *
 * Storage rules:
 *   - `transform` — stored as a nested Y.Map (x/y are separate keys so
 *     concurrent writes on different axes merge cleanly). Pass `undefined`
 *     to delete the slot entirely; pass a partial `{ x, y }` to update only
 *     the named axes.
 *   - All other nested-object fields (`shadow`, `fillStyle`, `imageRect`,
 *     `mask`, etc.) — stored as plain JSON values via `map.set(key, value)`.
 *     They are atomic: setting one replaces the whole sub-object. CRDT merge
 *     semantics aren't needed at sub-property granularity.
 *   - Scalar and array fields — stored directly via `map.set(key, value)`.
 *   - Explicit `undefined` value — deletes the key (sentinel semantics,
 *     same as {@link setLeafOverride}).
 *
 * Single Yjs transaction so the UndoManager rolls back the whole patch in
 * one step (including any newly-created nested Y.Maps).
 */
export function setLeafOverridePatch(
  ctx: ObjectsMutationContext,
  instanceId: string,
  leafId: string,
  patch: GenericLeafOverridePatch,
): void {
  ctx.doc.transact(() => {
    const instanceMap = findInstanceMap(ctx, instanceId)
    if (instanceMap === null) return
    const overrides = ensureOverridesMap(instanceMap)
    const leaves = ensureChildMap(overrides, 'leaves')
    const leaf = ensureChildMap(leaves, leafId)

    for (const key of Object.keys(patch) as (keyof GenericLeafOverridePatch)[]) {
      const value = patch[key]
      if (key === 'transform') {
        // transform gets its own nested Y.Map for per-axis CRDT merge.
        writeTransform(leaf, value as LeafOverridePatch['transform'])
      } else {
        // All other keys (scalars, arrays, sub-objects) stored as plain JSON.
        writeOrDelete(leaf, key as string, value)
      }
    }
  }, LOCAL_ORIGIN)
}

/**
 * Write into `instance.overrides.leaves[leafId]`. Existing keys not in the
 * patch are left untouched. Pass `undefined` for a key to delete just that
 * key (e.g. `setLeafOverride(ctx, id, leaf, { fill: undefined })` removes
 * the fill override but keeps the text override).
 *
 * Single Yjs transaction so the UndoManager rolls back the whole patch
 * (including any newly-created nested Y.Maps) in one step.
 *
 * @deprecated Prefer {@link setLeafOverridePatch} for new callers. This
 * function now delegates to it and is kept for backwards compatibility.
 */
export function setLeafOverride(
  ctx: ObjectsMutationContext,
  instanceId: string,
  leafId: string,
  patch: LeafOverridePatch,
): void {
  // Delegate to the generic adapter. The narrow LeafOverridePatch is a
  // structural subset of GenericLeafOverridePatch so the cast is safe.
  setLeafOverridePatch(ctx, instanceId, leafId, patch as GenericLeafOverridePatch)
}

/**
 * Seed text copy from the master's leaves into the instance's override slot
 * at creation time. Call this immediately after inserting a new
 * ComponentInstanceObject to "freeze" the master copy on this instance
 * forever — subsequent master text edits won't propagate.
 *
 * Idempotent: if a leaf already has a `text` override, this call is a no-op
 * for that leaf. This makes it safe to call multiple times (e.g. after a
 * doc reconnect) without wiping user edits.
 *
 * @param ctx              ObjectsMutationContext for the slide containing the instance.
 * @param instanceId       The id of the ComponentInstanceObject.
 * @param masterTextLeaves Array of `{ id, text }` pairs from the master's text objects.
 *                         The caller is responsible for reading the master doc and
 *                         collecting these (slide-model cannot import app-layer code).
 */
export function seedInstanceTextCopy(
  ctx: ObjectsMutationContext,
  instanceId: string,
  masterTextLeaves: Array<{ id: string; text: string }>,
): void {
  if (masterTextLeaves.length === 0) return
  ctx.doc.transact(() => {
    const instanceMap = findInstanceMap(ctx, instanceId)
    if (instanceMap === null) return
    const overrides = ensureOverridesMap(instanceMap)
    const leaves = ensureChildMap(overrides, 'leaves')

    for (const { id: leafId, text } of masterTextLeaves) {
      const leaf = ensureChildMap(leaves, leafId)
      // Idempotent — skip if a text override already exists.
      if (leaf.has('text')) continue
      leaf.set('text', text)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Drop the entire entry for `leafId` from `instance.overrides.leaves`.
 * No-op if the leaf has no override stored. Single Yjs transaction.
 */
export function clearLeafOverride(
  ctx: ObjectsMutationContext,
  instanceId: string,
  leafId: string,
): void {
  ctx.doc.transact(() => {
    const instanceMap = findInstanceMap(ctx, instanceId)
    if (instanceMap === null) return
    const overrides = instanceMap.get('overrides')
    if (!(overrides instanceof Y.Map)) return
    const leaves = overrides.get('leaves')
    if (!(leaves instanceof Y.Map)) return
    if (leaves.has(leafId)) leaves.delete(leafId)
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// Animation overrides
// ---------------------------------------------------------------------------

/**
 * Write into `instance.overrides.animations[stepId]`. Same patch semantics
 * as {@link setLeafOverride}: keys present in `patch` are written (or
 * deleted when their value is `undefined`); other keys stay put.
 */
export function setAnimationOverride(
  ctx: ObjectsMutationContext,
  instanceId: string,
  stepId: string,
  patch: AnimationOverridePatch,
): void {
  ctx.doc.transact(() => {
    const instanceMap = findInstanceMap(ctx, instanceId)
    if (instanceMap === null) return
    const overrides = ensureOverridesMap(instanceMap)
    const animations = ensureChildMap(overrides, 'animations')
    const step = ensureChildMap(animations, stepId)

    if ('trigger' in patch) writeOrDelete(step, 'trigger', patch.trigger)
    if ('delay' in patch) writeOrDelete(step, 'delay', patch.delay)
    if ('duration' in patch) writeOrDelete(step, 'duration', patch.duration)
    if ('ease' in patch) writeOrDelete(step, 'ease', patch.ease)
    if ('order' in patch) {
      // Drop non-finite values silently (mirrors the resolver's defensive
      // parse) so a stray NaN from a UI bug can't poison the Y.Doc.
      const v = patch.order
      if (typeof v === 'number' && Number.isFinite(v)) {
        step.set('order', v)
      } else if (step.has('order')) {
        step.delete('order')
      }
    }
    if ('disabled' in patch) {
      // `disabled` is `true | undefined` — only true is meaningful, anything
      // else clears the slot (so toggling off doesn't leave `false` lying around).
      if (patch.disabled === true) {
        step.set('disabled', true)
      } else {
        if (step.has('disabled')) step.delete('disabled')
      }
    }
  }, LOCAL_ORIGIN)
}

/**
 * Drop the entry for `stepId` from `instance.overrides.animations`.
 */
export function clearAnimationOverride(
  ctx: ObjectsMutationContext,
  instanceId: string,
  stepId: string,
): void {
  ctx.doc.transact(() => {
    const instanceMap = findInstanceMap(ctx, instanceId)
    if (instanceMap === null) return
    const overrides = instanceMap.get('overrides')
    if (!(overrides instanceof Y.Map)) return
    const animations = overrides.get('animations')
    if (!(animations instanceof Y.Map)) return
    if (animations.has(stepId)) animations.delete(stepId)
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// Reset all
// ---------------------------------------------------------------------------

/**
 * Clear every instance-level override EXCEPT the per-leaf seeded text
 * copy. Used by the inspector's "Reset overrides" button.
 *
 * Text rationale: `text` overrides are seeded from the master at
 * instance-creation time (see {@link seedInstanceTextCopy}) and
 * represent the user-authored content of THIS instance, not a styling
 * deviation from the master. Wiping them on reset would destroy the
 * instance's words — surprising and destructive. Every other override
 * (transform, fill, stroke, fontSize/Weight/family/color, opacity,
 * rotation, mask, etc., plus instance-level transform / bbox /
 * animation overrides) is cleared.
 *
 * Single transaction so undo restores the whole prior state.
 */
export function resetAllOverrides(ctx: ObjectsMutationContext, instanceId: string): void {
  ctx.doc.transact(() => {
    const instanceMap = findInstanceMap(ctx, instanceId)
    if (instanceMap === null) return
    const overrides = instanceMap.get('overrides')
    if (!(overrides instanceof Y.Map)) {
      // Either no overrides slot, or a stale plain-object slot from
      // P5/P6 — nothing useful to preserve. Drop it outright.
      if (instanceMap.has('overrides')) instanceMap.delete('overrides')
      return
    }
    // Strip instance-level keys (transform nudge, masterBboxOverride,
    // animation overrides) — none of these have anything to do with
    // text content.
    for (const key of [...overrides.keys()]) {
      if (key !== 'leaves') overrides.delete(key)
    }
    // Walk leaves and keep only `text` per leaf. Drop a leaf entry if
    // it has no text key after the strip; drop the `leaves` map if it
    // ends up empty.
    const leaves = overrides.get('leaves')
    if (leaves instanceof Y.Map) {
      for (const [leafId, leafEntry] of [...leaves.entries()]) {
        if (!(leafEntry instanceof Y.Map)) {
          leaves.delete(leafId)
          continue
        }
        for (const k of [...leafEntry.keys()]) {
          if (k !== 'text') leafEntry.delete(k)
        }
        if (leafEntry.size === 0) leaves.delete(leafId)
      }
      if (leaves.size === 0) overrides.delete('leaves')
    }
    if (overrides.size === 0) instanceMap.delete('overrides')
  }, LOCAL_ORIGIN)
}

/**
 * Atomically applies the auto-fit result on a component instance:
 * outer slide-space rect (x, y, width, height) AND the instance-level
 * `masterBboxOverride` that drives the renderer's letterbox math. The
 * critical detail is that we update fields on the existing `overrides`
 * Y.Map rather than replacing it — without that, subsequent
 * `setLeafOverridePatch` calls would discover a non-Y.Map at the
 * `overrides` slot and create a fresh empty Y.Map, dropping
 * `masterBboxOverride` and triggering visible drift on the next click.
 * `transform.x/y` is cleared as part of the same transaction since the
 * new outer rect already absorbs any prior offset.
 */
export function applyInstanceFit(
  ctx: ObjectsMutationContext,
  instanceId: string,
  outer: { x: number; y: number; width: number; height: number },
  masterBboxOverride: { x: number; y: number; width: number; height: number },
): void {
  ctx.doc.transact(() => {
    const instanceMap = findInstanceMap(ctx, instanceId)
    if (instanceMap === null) return
    instanceMap.set('x', outer.x)
    instanceMap.set('y', outer.y)
    instanceMap.set('width', outer.width)
    instanceMap.set('height', outer.height)
    const overrides = ensureOverridesMap(instanceMap)
    overrides.set('masterBboxOverride', { ...masterBboxOverride })
    if (overrides.has('transform')) overrides.delete('transform')
  }, LOCAL_ORIGIN)
}

/**
 * "Reset to master placement": snaps x/y back to the master's authored
 * origin and clears the instance-level `transform` nudge. Width/height
 * AND `masterBboxOverride` are intentionally preserved — width/height
 * because shrinking the bbox would orphan leaves moved outside the
 * master's authored bounds, and `masterBboxOverride` because it pins the
 * inner-fit scale to 1; clearing it while w/h is larger than the master
 * would make the renderer scale the master content up to fill. Same
 * Y.Map preservation invariant as {@link applyInstanceFit}.
 */
export function resetInstanceFit(
  ctx: ObjectsMutationContext,
  instanceId: string,
  outer: { x: number; y: number },
): void {
  ctx.doc.transact(() => {
    const instanceMap = findInstanceMap(ctx, instanceId)
    if (instanceMap === null) return
    instanceMap.set('x', outer.x)
    instanceMap.set('y', outer.y)
    const overrides = instanceMap.get('overrides')
    if (overrides instanceof Y.Map) {
      if (overrides.has('transform')) overrides.delete('transform')
    }
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// Cascade master delete
// ---------------------------------------------------------------------------

/**
 * Remove every `componentInstance` object whose `componentId` matches
 * `deletedComponentId` from ALL slides in a deck Y.Doc.
 *
 * Call this in the editor after `api.deleteComponent` succeeds. Runs one
 * Yjs transaction per slide that contains matching instances so each
 * slide's undo stack remains coherent.
 *
 * Design note: We chose the caller-invokes-after-delete approach (rather
 * than a renderer-level cascade) because:
 *   1. The renderer intentionally has no mutation access — adding one would
 *      violate the pure-render boundary.
 *   2. The "sweep all deck docs" approach in FolderSettings is impractical
 *      at delete time because deck docs may not be in memory. Instead, this
 *      function is called from the EDITOR context which always has the
 *      currently-open deck in memory. Decks that are closed when the delete
 *      fires will encounter a "master missing" placeholder on next open — a
 *      future migration pass or server-side cleanup handles those stragglers.
 *
 * @param deckCtx           Deck-level context (doc + slides Y.Array).
 * @param deletedComponentId The id of the component master that was deleted.
 */
export function removeComponentInstancesFromDoc(
  deckCtx: SlideMutationContext,
  deletedComponentId: string,
): void {
  const { doc, slides } = deckCtx
  for (let si = 0; si < slides.length; si++) {
    const slideMap = slides.get(si)
    const objectsArr = slideMap.get('objects') as Y.Array<Y.Map<unknown>> | undefined
    if (objectsArr === undefined || objectsArr.length === 0) continue

    // Collect indices to remove in a first pass (reverse order for safe splice).
    const toRemove: number[] = []
    for (let oi = 0; oi < objectsArr.length; oi++) {
      const objMap = objectsArr.get(oi)
      if (
        objMap.get('type') === 'componentInstance' &&
        objMap.get('componentId') === deletedComponentId
      ) {
        toRemove.push(oi)
      }
    }
    if (toRemove.length === 0) continue

    // Single transaction per slide so the UndoManager can roll back the
    // whole slide's removals in one step.
    doc.transact(() => {
      // Delete in reverse order so later indices remain valid after each delete.
      for (let ri = toRemove.length - 1; ri >= 0; ri--) {
        objectsArr.delete(toRemove[ri]!, 1)
      }
    }, LOCAL_ORIGIN)
  }
}

// ---------------------------------------------------------------------------
// Master-missing helper
// ---------------------------------------------------------------------------

/**
 * Minimal cache surface needed to decide whether an instance's master is
 * resolvable. Mirrors `apps/web/src/state/componentDocCache.ts` without
 * importing it (slide-model has no dep on app code).
 */
export interface MasterPresenceProbe {
  /** Hocuspocus sync status for `component:<id>`. */
  getStatus: (componentId: string) => 'pending' | 'synced'
  /** Returns true if a synced doc exists AND is non-empty (has slides). */
  hasMaster: (componentId: string) => boolean
}

/**
 * Returns true when an instance's master cannot be resolved — i.e. the
 * cache reports `synced` but no master content exists. The pending state
 * is intentionally NOT classified as missing here: the cache is still
 * working, the renderer handles its own timeout-to-missing flip
 * (see componentInstanceRenderer.ts:pickPlaceholderVariant).
 *
 * The renderer + inspector use this helper to branch consistently:
 *   - inspector hides the "Reset to master" affordance per-leaf when
 *     master is missing (since there's no master value to revert to);
 *   - the slide-model side stays out of automatic cleanup — overrides
 *     remain on the instance until the user picks Detach (P6) or
 *     re-targets the instance to another master (deferred).
 */
export function instanceMasterMissing(
  instance: { componentId?: string },
  cache: MasterPresenceProbe,
): boolean {
  const id = instance.componentId
  if (typeof id !== 'string' || id.length === 0) return true
  if (cache.getStatus(id) !== 'synced') return false
  return !cache.hasMaster(id)
}

// ---------------------------------------------------------------------------
// Internal write helpers
// ---------------------------------------------------------------------------

/**
 * Write `value` to `key` when defined, otherwise delete the key. Mirrors
 * the convention used in mutations.ts:updateObject so optional schema
 * fields don't persist as `undefined` (which would defeat
 * `exactOptionalPropertyTypes` downstream).
 */
function writeOrDelete(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    if (map.has(key)) map.delete(key)
  } else {
    map.set(key, value)
  }
}

/**
 * Transform is stored as a nested Y.Map so concurrent x / y writes merge.
 * Setting `transform` to `undefined` deletes the slot entirely; setting an
 * empty / partial patch updates only the named axes.
 */
function writeTransform(leaf: Y.Map<unknown>, transform: LeafOverridePatch['transform']): void {
  if (transform === undefined) {
    if (leaf.has('transform')) leaf.delete('transform')
    return
  }
  let tMap = leaf.get('transform')
  if (!(tMap instanceof Y.Map)) {
    tMap = new Y.Map()
    leaf.set('transform', tMap)
  }
  const t = tMap as Y.Map<unknown>
  if ('x' in transform) writeOrDelete(t, 'x', transform.x)
  if ('y' in transform) writeOrDelete(t, 'y', transform.y)
}
