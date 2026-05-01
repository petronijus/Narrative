/**
 * ui/TokenColorInput.tsx
 *
 * Drop-in replacement for ColorInput inside the editor: auto-pulls the
 * folder palette (FolderDocProvider) + a "+" link to folder color
 * settings (DeckRoleContext + react-router) so the same picker UX shows
 * up everywhere without the host having to wire props.
 *
 * For non-token fields (stroke, shadow, gradient stop, etc.) the
 * default `onTokenSelect` resolves the picked token to its hex and
 * writes that — so the folder palette acts as a quick-pick swatch
 * globally even where the field's data model is hex-only.
 */

import { useNavigate } from 'react-router-dom'
import { ColorInput, type ColorInputProps } from './ColorInput.js'
import { useFolderTokensOptional } from '../state/FolderDocProvider.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import type { TokenRef } from '@narrative/slide-model'

export function TokenColorInput(props: ColorInputProps) {
  const folderSnapshot = useFolderTokensOptional()
  const { folderId } = useDeckRole()
  const navigate = useNavigate()

  const colorsList = folderSnapshot ? Object.values(folderSnapshot.colors) : undefined
  const tokenColors = props.tokenColors ?? colorsList
  const onOpenFolderSettings =
    props.onOpenFolderSettings ??
    (folderId !== null ? () => void navigate(`/folder/${folderId}/settings`) : undefined)

  // Default token-pick behaviour when host doesn't accept TokenRef:
  // write the resolved hex of the selected token via onChange + commit.
  const commit = props.onCommit ?? props.onChange
  const onTokenSelect: ((ref: TokenRef) => void) | undefined =
    props.onTokenSelect ??
    (tokenColors !== undefined
      ? (ref) => {
          const id = ref.$token.split('.')[1] ?? ''
          const found = tokenColors.find((c) => c.id === id)
          if (found) {
            props.onChange(found.value)
            commit(found.value)
          }
        }
      : undefined)

  return (
    <ColorInput
      {...props}
      tokenColors={tokenColors}
      onTokenSelect={onTokenSelect}
      onOpenFolderSettings={onOpenFolderSettings}
    />
  )
}
