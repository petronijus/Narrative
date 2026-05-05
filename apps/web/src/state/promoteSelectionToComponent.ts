/**
 * state/promoteSelectionToComponent.ts
 *
 * "Promote selection to component" — stamps-only flow.
 *
 * Reads the selected objects, writes them as a new component master in
 * the folder, and leaves the originals on the slide untouched. Stamps
 * are detached: editing the master afterwards never affects already-
 * placed objects, so there's no reason to delete the originals.
 */

import { promoteToComponent } from '@narrative/slide-model'
import type { DeckMutationContext } from '@narrative/slide-model'
import { writeComponentMasterTree } from './writeComponentMasterTree.js'
import { invalidateFolderComponentsCache } from './useFolderComponents.js'
import type { ApiClient } from '../api/client.js'

export interface PromoteSelectionArgs {
  api: ApiClient
  folderId: string
  deckCtx: DeckMutationContext
  activeSlideId: string
  targetIds: string[]
  name: string
}

export async function promoteSelectionToComponent(
  args: PromoteSelectionArgs,
): Promise<{ componentId: string }> {
  const { api, folderId, deckCtx, activeSlideId, targetIds, name } = args
  const plan = promoteToComponent(deckCtx, activeSlideId, targetIds, folderId)

  const component = await api.createComponent(folderId, { id: plan.componentId, name })
  invalidateFolderComponentsCache(folderId)
  await writeComponentMasterTree({
    componentId: component.id,
    masterTree: plan.masterTree,
    masterAnimations: plan.masterAnimations,
  })

  return { componentId: component.id }
}
