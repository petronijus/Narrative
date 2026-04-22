/**
 * ui/SlideNotesPanel.tsx
 *
 * M19 phase 1: per-slide speaker notes panel.
 *
 * Plain-text <textarea> bound to a Y.Text via useSlideNotes. All edits go
 * through the hook's setText, which wraps the Y.Text mutation in a single
 * doc.transact — so remote peers see one atomic change per keystroke batch
 * and the undo manager treats it as one step.
 *
 * Collapsible via a header toggle with state persisted to sessionStorage
 * (same pattern as the animation timeline).
 *
 * Not included here (follow-ups):
 *   - Tiptap rich text binding (bold, italic, lists, links) — phase 2.
 *   - Presenter view integration (notes + next slide + timer) — phase 3.
 */

import { useCallback, useState } from 'react'
import { useSlideNotes } from '../state/useSlideNotes.js'
import { useDeckRole } from '../state/DeckRoleContext.js'

const COLLAPSE_STORAGE_KEY = 'narrative:slideNotes:collapsed'

export function SlideNotesPanel() {
  const { text, yText, setText } = useSlideNotes()
  const { role } = useDeckRole()
  const isViewer = role === 'viewer'

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  const toggleCollapsed = useCallback(() => {
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

  return (
    <div className="flex flex-shrink-0 flex-col border-t border-gray-800 bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Speaker notes
          </span>
          {text.length > 0 && (
            <span className="text-[10px] text-gray-600">{text.length} chars</span>
          )}
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="rounded px-2 py-0.5 text-[10px] text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          aria-label={collapsed ? 'Expand speaker notes' : 'Collapse speaker notes'}
        >
          {collapsed ? '▲ expand' : '▼ collapse'}
        </button>
      </div>

      {!collapsed && (
        <div className="px-3 py-2">
          {yText === null ? (
            <p className="text-[11px] italic text-gray-600">No slide selected.</p>
          ) : (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={isViewer}
              placeholder={
                isViewer
                  ? 'Speaker notes (view only).'
                  : 'Presenter notes — visible in present mode. Markdown-ish plain text for now.'
              }
              className={[
                'block w-full resize-y rounded border border-gray-800 bg-gray-950 px-2 py-1.5',
                'text-xs text-gray-200 placeholder:text-gray-600',
                'focus:border-blue-500 focus:outline-none',
                'min-h-[72px]',
                isViewer ? 'cursor-default opacity-80' : '',
              ].join(' ')}
              spellCheck
            />
          )}
        </div>
      )}
    </div>
  )
}
