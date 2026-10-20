/**
 * pages/DeckEditor.tsx
 *
 * Route /deck/:id (child route pod DeckShell).
 *
 * M4: SlideDocProvider byl součástí tohoto souboru.
 * M5: SlideDocProvider přesunut do DeckShell (parent route), aby Y.Doc přežilo
 *     navigaci mezi editor a present mode bez WS reconnect.
 *     Tento soubor nyní jen wrapuje EditorLayout do edit-specific context providers
 *     (SelectionProvider, ToolProvider), které present mode nepotřebuje.
 *
 * M6: useOutletContext pro získání onCanvasReady callbacku z DeckShell.
 *     Callback je předán do EditorLayout → Canvas.onReady.
 */

import { useCallback, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { SelectionProvider } from '../state/SelectionContext.js'
import { ToolProvider } from '../state/ToolContext.js'
import { TextEditProvider } from '../state/TextEditContext.js'
import { TableEditProvider } from '../state/TableEditContext.js'
import { CropModeProvider } from '../state/CropModeContext.js'
import { PathPointsModeProvider } from '../state/PathPointsModeContext.js'
import { EditorLayout } from '../components/EditorLayout.js'
import type { DeckShellContextValue } from '../components/DeckShell.js'
import { preloadEditorParts } from '../ui/lazyEditorParts.js'
import { markEditorCanvasReady } from '../ui/editorReady.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'

export function DeckEditor() {
  const ctx = useOutletContext<DeckShellContextValue | null>()
  // The dialogs and overlays left out of the first paint (L2,
  // docs/plans/performance.md), loaded once the canvas drew the deck
  // (`markEditorCanvasReady`) and the editor is idle.
  useEffect(() => preloadEditorParts(), [])
  const parentOnCanvasReady = ctx?.onCanvasReady
  const onCanvasReady = useCallback(
    (instance: CanvasInstance | null) => {
      parentOnCanvasReady?.(instance)
      if (instance !== null) markEditorCanvasReady()
    },
    [parentOnCanvasReady],
  )

  return (
    <SelectionProvider>
      <ToolProvider>
        <TextEditProvider>
          <TableEditProvider>
            <CropModeProvider>
              <PathPointsModeProvider>
                <EditorLayout onCanvasReady={onCanvasReady} />
              </PathPointsModeProvider>
            </CropModeProvider>
          </TableEditProvider>
        </TextEditProvider>
      </ToolProvider>
    </SelectionProvider>
  )
}
