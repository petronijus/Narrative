/**
 * state/promoteSelectionToComponent.ts
 *
 * "Promote selection to component" — `component.promote` on the server.
 *
 * The server reads the deck live, builds the master from the selected
 * objects and copies the pictures and videos they show into the new
 * component (a component owns its media). The originals stay on the slide:
 * stamps are detached, so editing the master never touches placed objects.
 * Before asking, the editor waits until the server holds the slide's latest
 * changes (`whenSaved`) — a rename or a page-number flag set a moment
 * earlier must be in the master.
 *
 * Also fires a one-shot offscreen thumbnail render so the picker drawer and
 * the Components tab show the new master at once (the render worker takes
 * this over in A3). It renders the promoted objects as they are on the
 * slide — the master's copies of their pictures show the same images.
 */

import { promoteToComponent, type DeckMutationContext } from '@narrative/slide-model'
import { invalidateFolderComponentsCache } from './useFolderComponents.js'
import { createThumbnailRenderer } from '../renderer/thumbnails.js'
import type { ApiClient } from '../api/client.js'

export interface PromoteSelectionArgs {
  api: ApiClient
  deckId: string
  folderId: string
  deckCtx: DeckMutationContext
  /** `useSlideDoc().whenSaved`: resolves once the server holds every local change. */
  whenSaved: () => Promise<void>
  activeSlideId: string
  targetIds: string[]
  name: string
}

export async function promoteSelectionToComponent(
  args: PromoteSelectionArgs,
): Promise<{ componentId: string }> {
  const { api, deckId, folderId, deckCtx, activeSlideId, targetIds, name } = args
  // What the thumbnail shows, read before the request: the objects as the
  // user promoted them.
  const { masterTree } = promoteToComponent(deckCtx, activeSlideId, targetIds, folderId)
  await args.whenSaved()
  const promoted = await api.promoteComponent(deckId, {
    slideId: activeSlideId,
    objectIds: targetIds,
    name,
  })
  invalidateFolderComponentsCache(folderId)

  // Fire-and-forget initial thumbnail. Failures are swallowed: the master
  // editor re-uploads on its next render, and a missing thumbnail just
  // shows the ⌘ placeholder.
  void renderAndUploadInitialThumbnail(api, promoted.component.id, folderId, masterTree)

  return { componentId: promoted.component.id }
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
