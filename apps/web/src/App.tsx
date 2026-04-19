/**
 * App.tsx
 *
 * M4: Přidán React Router.
 *   /          → Landing (list + create decks)
 *   /deck/:id  → EditorLayout s HocuspocusProvider pro konkrétní deck
 *
 * M5: Present mode route + shared Y.Doc přes DeckShell.
 *   /deck/:id         → DeckEditor (edit mode)
 *   /deck/:id/present → DeckPresent (present mode)
 *
 *   Oba sdílejí SlideDocProvider přes DeckShell parent route — Y.Doc + WebSocket
 *   přežijí navigaci editor ↔ present bez reconnect.
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Landing } from './pages/Landing.js'
import { DeckEditor } from './pages/DeckEditor.js'
import { DeckPresent } from './pages/DeckPresent.js'
import { DeckShell } from './components/DeckShell.js'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/deck/:id" element={<DeckShell />}>
          <Route index element={<DeckEditor />} />
          <Route path="present" element={<DeckPresent />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
