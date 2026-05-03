/**
 * state/promoteSelectionToComponent.ts
 *
 * Extracted from EditorContextMenu's `performPromote` so non-menu code
 * paths (e.g. the slide-number recommendation modal) can run the same
 * pipeline without duplicating bookkeeping.
 *
 * Pipeline (matches the original EditorContextMenu order):
 *   1. Build a serialisable plan via `promoteToComponent` (slide-model).
 *   2. Mint the Postgres row with the plan's `componentId`.
 *   3. Open a transient Hocuspocus connection to the new component doc
 *      and write masterTree + masterAnimations.
 *   4. In one slide-level Yjs transaction, remove the promoted objects
 *      and insert the instance node.
 *   5. Seed instance text copies so master text edits don't propagate.
 *   6. Select the instance.
 *
 * Returns the created instance id so callers can post-process selection.
 */

import {
  promoteToComponent,
  removeObject,
  addObject,
  seedInstanceTextCopy,
} from '@narrative/slide-model'
import type { ObjectsMutationContext, DeckMutationContext } from '@narrative/slide-model'
import { writeComponentMasterTree } from './writeComponentMasterTree.js'
import { invalidateFolderComponentsCache } from './useFolderComponents.js'
import type { ApiClient } from '../api/client.js'

export interface PromoteSelectionArgs {
  api: ApiClient
  folderId: string
  mutationCtx: ObjectsMutationContext
  deckCtx: DeckMutationContext
  activeSlideId: string
  targetIds: string[]
  name: string
  token: string | null
}

export async function promoteSelectionToComponent(
  args: PromoteSelectionArgs,
): Promise<{ instanceId: string }> {
  const { api, folderId, mutationCtx, deckCtx, activeSlideId, targetIds, name, token } = args
  const plan = promoteToComponent(deckCtx, activeSlideId, targetIds, folderId)

  const component = await api.createComponent(folderId, { id: plan.componentId, name })
  invalidateFolderComponentsCache(folderId)
  await writeComponentMasterTree({
    componentId: component.id,
    masterTree: plan.masterTree,
    masterAnimations: plan.masterAnimations,
    token,
  })

  mutationCtx.doc.transact(() => {
    for (const id of plan.removedObjectIds) removeObject(mutationCtx, id)
    addObject(mutationCtx, plan.instanceObject)
  })

  const masterTextLeaves = plan.masterTree
    .filter((obj) => obj.type === 'text' && typeof (obj as { text?: unknown }).text === 'string')
    .map((obj) => ({ id: obj.id, text: (obj as { text: string }).text }))
  if (masterTextLeaves.length > 0) {
    seedInstanceTextCopy(mutationCtx, plan.instanceObject.id, masterTextLeaves)
  }

  return { instanceId: plan.instanceObject.id }
}
