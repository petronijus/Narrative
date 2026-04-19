/**
 * pages/DeckPresent.tsx
 *
 * M5: Present mode page. Route /deck/:id/present (child route pod DeckShell).
 *
 * SlideDocProvider je v parent DeckShell → Y.Doc je sdílená s editorem.
 * Žádný SelectionProvider / ToolProvider — present mode nemutuje state.
 * Renderuje PresentLayout s fullscreen slide view.
 *
 * M6: useOutletContext pro získání onCanvasReady callbacku z DeckShell.
 *     Callback předán do PresentLayout → Canvas.onReady.
 */

import { useOutletContext } from 'react-router-dom'
import { PresentLayout } from '../components/PresentLayout.js'
import type { DeckShellContextValue } from '../components/DeckShell.js'

export function DeckPresent() {
  // useOutletContext může vrátit null pokud DeckPresent renderujeme mimo DeckShell
  // (např. v testech přímo). Optional chaining zajistí graceful degradaci.
  const ctx = useOutletContext<DeckShellContextValue | null>()
  return <PresentLayout onCanvasReady={ctx?.onCanvasReady} />
}
