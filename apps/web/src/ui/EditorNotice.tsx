/**
 * ui/EditorNotice.tsx — the editor's transient message (state/editorNotice.ts),
 * top right over the canvas, announced politely to screen readers.
 */

import { X } from 'lucide-react'
import { dismissEditorNotice, useEditorNotice } from '../state/editorNotice.js'

export function EditorNotice() {
  const notice = useEditorNotice()
  if (notice === null) return null
  return (
    <div
      key={notice.id}
      role="status"
      aria-live="polite"
      data-editor-notice="true"
      className="fixed top-14 right-4 z-50 flex max-w-sm items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground shadow-lg"
    >
      <span className="flex-1">{notice.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismissEditorNotice}
        className="rounded p-0.5 opacity-70 hover:opacity-100"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  )
}
