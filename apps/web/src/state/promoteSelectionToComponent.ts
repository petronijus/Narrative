/**
 * state/promoteSelectionToComponent.ts
 *
 * "Promote selection to component" — stamps-only flow.
 *
 * Reads the selected objects, writes them as a new component master in
 * the folder, and leaves the originals on the slide untouched. Stamps
 * are detached: editing the master afterwards never affects already-
 * placed objects, so there's no reason to delete the originals.
 *
 * Also fires a one-shot offscreen thumbnail render so the picker drawer
 * + Components tab show the new master immediately. Done here instead
 * of in the master editor route because the user may never navigate to
 * the master editor.
 */

import { promoteToComponent } from '@narrative/slide-model'
import type { DeckMutationContext } from '@narrative/slide-model'
import { writeComponentMasterTree } from './writeComponentMasterTree.js'
import { invalidateFolderComponentsCache } from './useFolderComponents.js'
import { createThumbnailRenderer } from '../renderer/thumbnails.js'
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

  // Fire-and-forget initial thumbnail. Failures are swallowed: the
  // master editor would re-upload on next render, and a missing
  // thumbnail just shows the ⌘ placeholder.
  void renderAndUploadInitialThumbnail(api, component.id, folderId, plan.masterTree)

  return { componentId: component.id }
}

async function renderAndUploadInitialThumbnail(
  api: ApiClient,
  componentId: string,
  folderId: string,
  masterTree: ReturnType<typeof promoteToComponent>['masterTree'],
): Promise<void> {
  let renderer: Awaited<ReturnType<typeof createThumbnailRenderer>> | null = null
  try {
    renderer = await createThumbnailRenderer({ width: 200, resolution: 1 })
    const dataUrl = await renderer.renderSlide(masterTree)
    await api.uploadComponentThumbnail(componentId, dataUrl)
    invalidateFolderComponentsCache(folderId)
  } catch (err) {
    console.warn('[promote] initial component thumbnail failed', err)
  } finally {
    renderer?.destroy()
  }
}
