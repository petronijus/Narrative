/**
 * slide-model/src/components.ts
 *
 * M16 P5 — Component master helpers.
 *
 * Pure / data-only functions: no Yjs mutations happen here. The caller
 * (server-side AI client or web mutation handler) receives a PromoteToComponentPlan
 * and dispatches the writes itself inside a single Yjs transaction / REST POST.
 *
 * Design:
 *   - promoteToComponent   Pure plan factory. Given a deck context + slide id +
 *                          object ids, returns:
 *                            • masterTree   — deep clone of all promoted objects
 *                                            (groups recursively expanded) with
 *                                            stable leaf ids
 *                            • animations   — pruned to in-scope targets only
 *                            • instance     — the ComponentInstanceObject to place
 *                                            on the slide (bounding-box position)
 *                            • componentId  — nanoid(12) for the new component
 *   - getComponentDocName  Returns `component:<id>` — Hocuspocus doc name.
 *   - pruneAnimationsToScope  Filters animation steps to those whose objectId
 *                             is in the promoted leaf set.
 */

import { nanoid } from 'nanoid'
import type * as Y from 'yjs'
import type { SlideObject, AnimationStep, TableCell } from '@narrative/shared'
import { yMapToPlainObject } from './bindings.js'
import { yMapToAnimationStep } from './animationBindings.js'

/**
 * Duck-type detect a Y.Text without importing yjs at runtime. We can't use
 * `instanceof Y.Text` here because we'd pull in the deck doc's yjs binding,
 * and the master tree may be built in the server-side Yjs client where the
 * canonical Y module is registered under a different identity.
 */
function isYTextLike(v: unknown): boolean {
  return v !== null && typeof v === 'object' && 'toString' in v && 'insert' in v
}

// ---------------------------------------------------------------------------
// getComponentDocName
// ---------------------------------------------------------------------------

/**
 * Returns the Hocuspocus document name for a component master.
 * Format: `component:<id>` — mirrors `deck:<id>` and `folder:<id>` conventions.
 */
export function getComponentDocName(componentId: string): string {
  return `component:${componentId}`
}

// ---------------------------------------------------------------------------
// pruneAnimationsToScope
// ---------------------------------------------------------------------------

/**
 * Filters an array of animation steps to those whose `objectId` (target) is
 * one of the promoted leaf ids.
 *
 * When promoting a selection, only the animations that directly reference
 * objects inside the selection travel into the master. Steps targeting
 * objects outside the selection remain on the slide and are not included.
 *
 * @param animations     All animation steps on the source slide.
 * @param scopedTargetIds  Set of object ids that are being promoted.
 * @returns A new array containing only the in-scope animation steps.
 */
export function pruneAnimationsToScope(
  animations: AnimationStep[],
  scopedTargetIds: ReadonlySet<string>,
): AnimationStep[] {
  return animations.filter((step) => scopedTargetIds.has(step.objectId))
}

// ---------------------------------------------------------------------------
// Internal: collect all object ids in a subtree (group-recursive)
// ---------------------------------------------------------------------------

/**
 * Collects the ids of a set of root objects and all their transitive group
 * children. Group membership is determined by the `groupId` field — objects
 * whose groupId matches the id of another selected or collected object are
 * pulled in recursively.
 *
 * This is intentionally a pure walk over plain objects (no Yjs access) so it
 * can be called after reading a slide snapshot.
 */
function collectSubtreeIds(rootIds: ReadonlySet<string>, allObjects: SlideObject[]): Set<string> {
  const collected = new Set<string>(rootIds)
  let changed = true

  // Iterate until stable — handles nested groups (group in group).
  // In practice at most 2 passes for a typical 2-level nesting.
  while (changed) {
    changed = false
    for (const obj of allObjects) {
      if (collected.has(obj.id)) continue
      // If this object belongs to a group that is already collected, include it.
      if ('groupId' in obj && typeof obj.groupId === 'string' && collected.has(obj.groupId)) {
        collected.add(obj.id)
        changed = true
      }
    }
  }

  return collected
}

// ---------------------------------------------------------------------------
// PromoteToComponentPlan — the return value of promoteToComponent
// ---------------------------------------------------------------------------

/**
 * The caller receives this plan and is responsible for dispatching:
 *   1. REST POST /folders/:folderId/components { id: componentId, name }
 *      to register the Postgres row.
 *   2. Write masterTree + masterAnimations into the component Y.Doc
 *      (via server-side Yjs client or web Hocuspocus connection).
 *   3. Inside the deck Y.Doc, in a single transaction:
 *      - Remove all objects in removedObjectIds from the slide.
 *      - Insert instanceObject at the appropriate z-order position.
 *
 * The plan is intentionally serializable (no Yjs types — pure plain objects).
 */
export interface PromoteToComponentPlan {
  /** Nanoid(12) that will be the new component's id. */
  componentId: string
  /** The master tree — all promoted objects with stable ids. */
  masterTree: SlideObject[]
  /** Animation steps pruned to the promoted subtree targets. */
  masterAnimations: AnimationStep[]
  /** Ids of the original objects to remove from the slide after writing the master. */
  removedObjectIds: string[]
}

// ---------------------------------------------------------------------------
// promoteToComponent
// ---------------------------------------------------------------------------

/**
 * Deck mutation context — the subset of fields we need from the deck Y.Doc.
 * Mirrors DeckMutationContext from slideMutationContext.ts but typed narrowly
 * so the helper doesn't depend on the whole deck module.
 */
export interface DeckCtxForPromote {
  doc: Y.Doc
  slides: Y.Array<Y.Map<unknown>>
}

/**
 * Builds a PromoteToComponentPlan from a deck context.
 *
 * Pure: reads from Yjs but makes NO mutations. The caller dispatches all writes.
 *
 * Stable leaf ids guarantee:
 *   Objects in the master keep the same ids they had on the slide. This is critical
 *   for P7 override targeting — if the master uses the same id as the original
 *   leaf, any future override keys already written by P7 will remain valid.
 *
 * Bounding-box positioning:
 *   The instance is placed at the top-left of the promoted selection's bounding
 *   box. The instance's width/height match the bounding box dimensions so the
 *   placeholder renders at the correct size.
 *
 * @param deckCtx    Deck-level Yjs context (doc + slides Y.Array).
 * @param slideId    Which slide the objects live on.
 * @param objectIds  The root object ids to promote. Groups are expanded.
 * @param folderId   The folder the new component belongs to (used to set folder scope).
 * @returns PromoteToComponentPlan — the caller dispatches the writes.
 * @throws If slideId is not found in the deck, or objectIds is empty.
 */
export function promoteToComponent(
  deckCtx: DeckCtxForPromote,
  slideId: string,
  objectIds: string[],
  _folderId: string,
): PromoteToComponentPlan {
  if (objectIds.length === 0) {
    throw new Error('promoteToComponent: objectIds must not be empty')
  }

  const { slides } = deckCtx

  // --- Find the slide ---
  let slideMap: Y.Map<unknown> | null = null
  for (let i = 0; i < slides.length; i++) {
    const s = slides.get(i)
    if (s.get('id') === slideId) {
      slideMap = s
      break
    }
  }
  if (slideMap === null) {
    throw new Error(`promoteToComponent: slide '${slideId}' not found`)
  }

  // --- Read all objects from the slide ---
  const objectsArr = slideMap.get('objects') as Y.Array<Y.Map<unknown>> | undefined
  const allObjects: SlideObject[] = []
  if (objectsArr) {
    for (let i = 0; i < objectsArr.length; i++) {
      try {
        allObjects.push(yMapToPlainObject(objectsArr.get(i)))
      } catch {
        // Malformed object — skip
      }
    }
  }

  // --- Read all animations from the slide ---
  const animationsArr = slideMap.get('animations') as Y.Array<Y.Map<unknown>> | undefined
  const allAnimations: AnimationStep[] = []
  if (animationsArr) {
    for (let i = 0; i < animationsArr.length; i++) {
      try {
        allAnimations.push(yMapToAnimationStep(animationsArr.get(i)))
      } catch {
        // Malformed animation — skip
      }
    }
  }

  // --- Expand selection to include group children ---
  const rootIdSet = new Set(objectIds)
  const subtreeIds = collectSubtreeIds(rootIdSet, allObjects)
  const promotedObjects = allObjects.filter((o) => subtreeIds.has(o.id))

  if (promotedObjects.length === 0) {
    throw new Error('promoteToComponent: none of the specified objectIds exist on the slide')
  }

  // --- Generate component id ---
  const componentId = nanoid(12)

  // --- Prune animations ---
  const masterAnimations = pruneAnimationsToScope(allAnimations, subtreeIds)

  // --- Build master tree (deep clone of plain objects, stable ids) ---
  // Plain objects are already detached from Yjs — we can spread them safely.
  // Y.Text values (text object bodies) are serialized to string for the master
  // doc — the component's Yjs client will promote them back to Y.Text on insert.
  // Tables need a deeper walk because their cell `text` Y.Texts live inside
  // rows[r][c].text and would otherwise leak references to the source deck doc
  // (causing Yjs writeAny stack overflows when the plan gets encoded into the
  // component doc).
  const masterTree: SlideObject[] = promotedObjects.map((obj) => {
    const clone: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as unknown as Record<string, unknown>)) {
      if (isYTextLike(v)) {
        clone[k] = (v as { toString(): string }).toString()
      } else {
        clone[k] = v
      }
    }
    if (clone['type'] === 'table' && Array.isArray(clone['rows'])) {
      clone['rows'] = (clone['rows'] as TableCell[][]).map((row) =>
        row.map((cell) => {
          const cellOut: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(cell as unknown as Record<string, unknown>)) {
            if (isYTextLike(v)) {
              cellOut[k] = (v as { toString(): string }).toString()
            } else if (v !== null && typeof v === 'object') {
              // border / padding sub-objects — shallow clone is enough.
              cellOut[k] = { ...(v as Record<string, unknown>) }
            } else {
              cellOut[k] = v
            }
          }
          if (typeof cellOut['text'] !== 'string') cellOut['text'] = ''
          return cellOut as unknown as TableCell
        }),
      )
    }
    return clone as unknown as SlideObject
  })

  return {
    componentId,
    masterTree,
    masterAnimations,
    removedObjectIds: Array.from(subtreeIds),
  }
}
