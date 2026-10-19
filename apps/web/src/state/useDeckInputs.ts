/**
 * state/useDeckInputs.ts — what a complete picture of the deck still waits
 * for, by name: the deck document, its folder, the folder's and the deck's
 * font lists, the folder's tokens. A slide painted before them paints with
 * stand-ins (no face, fallback colours) and paints again when they come.
 *
 * The render page (pages/DeckRender.tsx) waits for them before it settles a
 * slide; present mode (components/PresentLayout.tsx) before it prepares the
 * deck — a slide prepared with a stand-in would be prepared again.
 */

import { useMemo } from 'react'
import { useDeckRole } from './DeckRoleContext.js'
import { useDeckFontsOptional } from './useDeckFonts.js'
import { useFolderFontsOptional } from './useFolderFonts.js'
import { useFolderTokensSettled } from './FolderDocProvider.js'
import { useSlideDoc } from './useSlideDoc.js'

/**
 * The names of the inputs not loaded yet; empty when the deck can be painted
 * whole. `folderOptional`: a deck the server names no folder for (or whose
 * lookup failed) has no folder fonts or tokens to wait for — present mode
 * goes on without them; the render page (the default) waits for its folder.
 */
export function useDeckInputsWaitingFor(opts: { folderOptional?: boolean } = {}): string[] {
  const folderOptional = opts.folderOptional === true
  const { synced } = useSlideDoc()
  const { folderId, isLoading: roleLoading } = useDeckRole()
  const folderFonts = useFolderFontsOptional()
  const deckFonts = useDeckFontsOptional()
  const tokensSettled = useFolderTokensSettled()
  return useMemo(() => {
    const out: string[] = []
    if (!synced) out.push('deck document')
    const noFolder = folderOptional && !roleLoading && folderId === null
    if (roleLoading || (folderId === null && !noFolder)) out.push('deck folder')
    else if (
      !noFolder &&
      (folderFonts === null || folderFonts.folderId !== folderId || folderFonts.loading)
    )
      out.push('folder fonts')
    if (deckFonts?.loading === true) out.push('deck fonts')
    if (!tokensSettled && !noFolder) out.push('folder tokens')
    return out
  }, [
    synced,
    roleLoading,
    folderId,
    folderFonts,
    deckFonts?.loading,
    tokensSettled,
    folderOptional,
  ])
}
