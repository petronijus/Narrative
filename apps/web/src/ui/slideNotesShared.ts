/**
 * ui/slideNotesShared.ts — what the speaker-notes panel's frame, its stand-in
 * and its lazily loaded editor share (ui/SlideNotesFrame.tsx).
 */

import { useCallback, useState } from 'react'

const COLLAPSE_STORAGE_KEY = 'narrative:slideNotes:collapsed'

/** The notes editor box; the body reserves its minimum height (`min-h-[72px]`) in every state. */
export const NOTES_EDITOR_BOX_CLASS = [
  'min-h-[72px] w-full rounded-md border border-input bg-surface-0/70',
  'px-2 py-1.5 text-xs text-foreground',
].join(' ')

/** Whether the panel is collapsed, kept for the tab (sessionStorage); the setter toggles. */
export function useNotesCollapsed(): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        sessionStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // storage unavailable — in-memory only
      }
      return next
    })
  }, [])
  return [collapsed, toggle] as const
}

let focusRequested = false

/**
 * The user went for the notes (clicked or tabbed into the stand-in) before
 * the editor's code arrived: the editor takes the focus when it mounts.
 */
export function requestNotesEditorFocus(): void {
  focusRequested = true
}

/** Whether a focus was requested since the last call (the editor asks once, on mount). */
export function takeNotesEditorFocusRequest(): boolean {
  const requested = focusRequested
  focusRequested = false
  return requested
}
