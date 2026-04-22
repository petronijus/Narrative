/**
 * ui/SlideNotesPanel.tsx
 *
 * M19 phase 2: per-slide speaker notes with Tiptap rich text, bound to the
 * slide's Y.XmlFragment via y-prosemirror (Tiptap's Collaboration extension).
 *
 * Supported formatting out of the box (StarterKit):
 *   - bold, italic, strike, code
 *   - headings (levels 1–3)
 *   - bullet + ordered lists
 *   - blockquote, horizontal rule, hard break
 *
 * Collab is handled entirely by y-prosemirror — no onChange writes back to
 * the Y.Doc, the binding sees every ProseMirror transaction and emits Yjs
 * updates directly. Remote peers' edits stream in through the same fragment
 * observation loop.
 *
 * Viewer role gets a read-only editor (`editable={false}`).
 *
 * Phase 3 (next commit) will reuse useSlideNotes + a read-only Tiptap
 * instance to render notes inside a presenter view.
 */

import { useCallback, useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { useSlideNotes } from '../state/useSlideNotes.js'
import { useDeckRole } from '../state/DeckRoleContext.js'

const COLLAPSE_STORAGE_KEY = 'narrative:slideNotes:collapsed'

const EDITOR_CLASS = [
  'tiptap-notes',
  'prose prose-invert prose-sm max-w-none',
  'min-h-[72px] w-full rounded-md border border-input bg-surface-0/70',
  'px-2 py-1.5 text-xs text-foreground',
  'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20 focus:outline-none',
  '[&_p]:my-1 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs',
  '[&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:italic',
  '[&_code]:rounded [&_code]:bg-secondary [&_code]:px-1',
].join(' ')

const TOOLBAR_BTN = [
  'rounded-md px-1.5 py-0.5 text-[10px] text-foreground/75 transition-colors',
  'hover:bg-accent hover:text-foreground',
  'data-[active=true]:bg-primary/15 data-[active=true]:text-primary',
  'disabled:opacity-40 disabled:hover:bg-transparent',
].join(' ')

export function SlideNotesPanel() {
  const { fragment, text } = useSlideNotes()
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

  const editor = useEditor(
    {
      // StarterKit bundles ProseMirror undoRedo; y-prosemirror ships its
      // own UndoManager-backed history, so disable StarterKit's undoRedo
      // to avoid a double-stack where one undo pops local history while
      // Yjs still holds the change.
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        ...(fragment !== null ? [Collaboration.configure({ fragment })] : []),
      ],
      editable: !isViewer,
      editorProps: {
        attributes: {
          class: EDITOR_CLASS,
          'aria-label': 'Speaker notes editor',
        },
      },
    },
    [fragment, isViewer],
  )

  // Keep editable in sync if the role changes mid-session.
  useEffect(() => {
    editor?.setEditable(!isViewer)
  }, [editor, isViewer])

  return (
    <div className="panel flex flex-shrink-0 flex-col border-t border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Speaker notes
          </span>
          {text.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60">{text.length} chars</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!collapsed && editor !== null && !isViewer && (
            <div className="flex items-center gap-0.5 border-r border-border pr-1">
              <button
                type="button"
                className={TOOLBAR_BTN}
                data-active={editor.isActive('bold')}
                onClick={() => editor.chain().focus().toggleBold().run()}
                aria-label="Bold"
                title="Bold (⌘B)"
              >
                <strong>B</strong>
              </button>
              <button
                type="button"
                className={TOOLBAR_BTN}
                data-active={editor.isActive('italic')}
                onClick={() => editor.chain().focus().toggleItalic().run()}
                aria-label="Italic"
                title="Italic (⌘I)"
              >
                <em>I</em>
              </button>
              <button
                type="button"
                className={TOOLBAR_BTN}
                data-active={editor.isActive('strike')}
                onClick={() => editor.chain().focus().toggleStrike().run()}
                aria-label="Strikethrough"
                title="Strikethrough"
              >
                <s>S</s>
              </button>
              <button
                type="button"
                className={TOOLBAR_BTN}
                data-active={editor.isActive('code')}
                onClick={() => editor.chain().focus().toggleCode().run()}
                aria-label="Inline code"
                title="Inline code"
              >
                {'</>'}
              </button>
              <span className="mx-1 h-3 w-px bg-border" />
              <button
                type="button"
                className={TOOLBAR_BTN}
                data-active={editor.isActive('heading', { level: 2 })}
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                aria-label="Heading"
                title="Heading"
              >
                H
              </button>
              <button
                type="button"
                className={TOOLBAR_BTN}
                data-active={editor.isActive('bulletList')}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
                aria-label="Bullet list"
                title="Bullet list"
              >
                •
              </button>
              <button
                type="button"
                className={TOOLBAR_BTN}
                data-active={editor.isActive('orderedList')}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                aria-label="Ordered list"
                title="Ordered list"
              >
                1.
              </button>
              <button
                type="button"
                className={TOOLBAR_BTN}
                data-active={editor.isActive('blockquote')}
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
                aria-label="Blockquote"
                title="Blockquote"
              >
                “
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            className="rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label={collapsed ? 'Expand speaker notes' : 'Collapse speaker notes'}
          >
            {collapsed ? '▲ expand' : '▼ collapse'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="px-3 py-2">
          {fragment === null ? (
            <p className="text-[11px] italic text-muted-foreground">No slide selected.</p>
          ) : (
            <EditorContent editor={editor} />
          )}
        </div>
      )}
    </div>
  )
}
