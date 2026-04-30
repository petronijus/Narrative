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

import { useOutletContext } from 'react-router-dom'
import { SelectionProvider } from '../state/SelectionContext.js'
import { ToolProvider } from '../state/ToolContext.js'
import { TextEditProvider } from '../state/TextEditContext.js'
import { CropModeProvider } from '../state/CropModeContext.js'
import { PathPointsModeProvider } from '../state/PathPointsModeContext.js'
import { EditorLayout } from '../components/EditorLayout.js'
import type { DeckShellContextValue } from '../components/DeckShell.js'

export function DeckEditor() {
  const ctx = useOutletContext<DeckShellContextValue | null>()

  return (
    <SelectionProvider>
      <ToolProvider>
        <TextEditProvider>
          <CropModeProvider>
            <PathPointsModeProvider>
              <EditorLayout onCanvasReady={ctx?.onCanvasReady} />
            </PathPointsModeProvider>
          </CropModeProvider>
        </TextEditProvider>
      </ToolProvider>
    </SelectionProvider>
  )
}
