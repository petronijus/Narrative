/**
 * ui/SlideNotesPanel.tsx
 *
 * The editor's speaker-notes panel (M19 phase 2). Its rich-text editor —
 * Tiptap bound to the slide's notes fragment — is `SlideNotesEditor.tsx`, a
 * chunk of its own loaded once the editor drew the deck and settled
 * (ui/editorReady.ts), or as soon as the pointer
 * or the focus comes to the panel (docs/plans/performance.md → L1: Tiptap and
 * ProseMirror are ~130 kB gz that nothing else on the editor's first paint
 * uses).
 *
 * Until it arrives the panel is already there in its final shape — the same
 * frame, header, collapse state and height — with the notes as plain text,
 * and "Add speaker notes" already works: nothing moves when the editor
 * replaces the stand-in.
 */

import { useCallback, useEffect, useState } from 'react'
import { lazyPart } from './lazyPart.js'
import { SlideNotesStandIn } from './SlideNotesFrame.js'
import { whenEditorSettled } from './editorReady.js'

const SlideNotesEditor = lazyPart(
  () => import('./SlideNotesEditor.js'),
  (m) => m.SlideNotesEditor,
  SlideNotesStandIn,
)

export function SlideNotesPanel() {
  // The stand-in until the editor settled (ui/editorReady.ts), or the user
  // goes for the notes: fetching and starting Tiptap right after the first
  // paint delayed the slide thumbnails (the editor's LCP) by ~0.4 s.
  const [wanted, setWanted] = useState(false)
  const want = useCallback(() => setWanted(true), [])
  useEffect(() => {
    if (wanted) return
    return whenEditorSettled([{ preload: async () => want() }])
  }, [wanted, want])
  return wanted ? <SlideNotesEditor /> : <SlideNotesStandIn onIntent={want} />
}
