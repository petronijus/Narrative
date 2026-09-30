/**
 * state/useStampComponent.ts — placing a folder component on the active
 * slide: `component.stamp` on the server (POST /decks/:id/stamp-component).
 *
 * The server stamps the master where it was drawn and copies the pictures
 * and videos it shows into this deck, so the stamp never shows media the
 * deck does not own. The stamp reaches the editor as a remote change, like
 * a paste from another deck: it is one server write, removed with Delete,
 * not with Ctrl+Z. The first stamped object is selected, as a paste selects
 * what it pasted. Used by the component picker (Toolbar) and by dragging a
 * component onto the canvas (UploadDropZone).
 */

import { useCallback } from 'react'
import { ApiError, useApi } from '../api/client.js'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'
import { useSelection } from './SelectionContext.js'
import { showEditorNotice } from './editorNotice.js'

function stampFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Only the folder's owner can place its components."
    if (err.status === 404) return 'The component or the slide no longer exists.'
    return `The component could not be placed: ${err.message}`
  }
  return 'The component could not be placed. Check your connection and try again.'
}

/**
 * Returns `stamp(componentId)`; it resolves to the stamped object ids (in
 * stacking order), or null when nothing was placed — no deck here (a
 * component master), no active slide, or a refusal the editor has shown.
 */
export function useStampComponent(): (componentId: string) => Promise<string[] | null> {
  const api = useApi()
  // A deck's document name is its id; a component master has none.
  const { documentName: deckId } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()
  const { selectOne } = useSelection()

  return useCallback(
    async (componentId: string): Promise<string[] | null> => {
      if (deckId === null || activeSlideId === null) return null
      try {
        const { objectIds } = await api.stampComponent(deckId, {
          componentId,
          slideId: activeSlideId,
        })
        if (objectIds.length > 0) selectOne(objectIds[0]!)
        return objectIds
      } catch (err) {
        console.warn('[stamp] failed', err)
        showEditorNotice(stampFailure(err))
        return null
      }
    },
    [api, deckId, activeSlideId, selectOne],
  )
}
