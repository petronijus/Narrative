/**
 * App.tsx
 *
 * M4: Přidán React Router.
 *   /          → Landing (list + create decks)
 *   /deck/:id  → EditorLayout s HocuspocusProvider pro konkrétní deck
 *
 * SlideDocProvider je nyní součástí deck route (ne wrap celé app)
 * protože potřebuje deckId z URL parametru.
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Landing } from './pages/Landing.js'
import { DeckEditor } from './pages/DeckEditor.js'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/deck/:id" element={<DeckEditor />} />
      </Routes>
    </BrowserRouter>
  )
}
