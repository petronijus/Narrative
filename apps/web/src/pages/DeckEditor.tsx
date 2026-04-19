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
 */

import { SelectionProvider } from '../state/SelectionContext.js'
import { ToolProvider } from '../state/ToolContext.js'
import { EditorLayout } from '../components/EditorLayout.js'

export function DeckEditor() {
  return (
    <SelectionProvider>
      <ToolProvider>
        <EditorLayout />
      </ToolProvider>
    </SelectionProvider>
  )
}
