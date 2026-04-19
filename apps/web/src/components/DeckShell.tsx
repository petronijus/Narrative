/**
 * components/DeckShell.tsx
 *
 * M5: Shared layout wrapper pro /deck/:id a /deck/:id/present routes.
 *
 * Účel: vyhoupnout SlideDocProvider nad obě routes tak, aby Y.Doc + WebSocket
 * connection přežily navigaci editor ↔ present mode bez reconnect.
 *
 * Pattern:
 *   <Route path="/deck/:id" element={<DeckShell />}>
 *     <Route index element={<DeckEditor />} />
 *     <Route path="present" element={<DeckPresent />} />
 *   </Route>
 *
 * DeckEditor a DeckPresent dědí Y.Doc přes SlideDocContext — žádný reconnect
 * při navigaci mezi těmito dvěma child routes.
 */

import { useParams, Navigate, Outlet } from 'react-router-dom'
import { SlideDocProvider } from '../state/SlideDocProvider.js'

export function DeckShell() {
  const { id } = useParams<{ id: string }>()

  if (id === undefined || id === '') {
    return <Navigate to="/" replace />
  }

  return (
    <div className="h-screen w-screen overflow-hidden">
      <SlideDocProvider deckId={id}>
        <Outlet />
      </SlideDocProvider>
    </div>
  )
}
