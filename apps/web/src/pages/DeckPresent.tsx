/**
 * pages/DeckPresent.tsx
 *
 * M5: Present mode page. Route /deck/:id/present (child route pod DeckShell).
 *
 * SlideDocProvider je v parent DeckShell → Y.Doc je sdílená s editorem.
 * Žádný SelectionProvider / ToolProvider — present mode nemutuje state.
 * Renderuje PresentLayout s fullscreen slide view.
 */

import { PresentLayout } from '../components/PresentLayout.js'

export function DeckPresent() {
  return <PresentLayout />
}
