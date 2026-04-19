/**
 * pages/DeckEditor.tsx
 *
 * Route /deck/:id — wrapper kolem EditorLayout.
 * Extrahuje deckId z URL a předá ho SlideDocProvider.
 * SlideDocProvider inicializuje HocuspocusProvider pro daný deck.
 */

import { useParams, Navigate } from 'react-router-dom'
import { SlideDocProvider } from '../state/SlideDocProvider.js'
import { SelectionProvider } from '../state/SelectionContext.js'
import { ToolProvider } from '../state/ToolContext.js'
import { EditorLayout } from '../components/EditorLayout.js'

export function DeckEditor() {
  const { id } = useParams<{ id: string }>()

  // Pokud id chybí (nemělo by nastat s React Router), redirect na home
  if (id === undefined || id === '') {
    return <Navigate to="/" replace />
  }

  return (
    <div className="h-screen w-screen overflow-hidden">
      <SlideDocProvider deckId={id}>
        <SelectionProvider>
          <ToolProvider>
            <EditorLayout />
          </ToolProvider>
        </SelectionProvider>
      </SlideDocProvider>
    </div>
  )
}
