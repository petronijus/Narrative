/**
 * ui/SlideNotesFrame.tsx — the speaker-notes panel without its editor.
 *
 * The panel's Tiptap editor is a chunk of its own (`SlideNotesEditor.tsx`,
 * docs/plans/performance.md → L1): Tiptap and ProseMirror are ~130 kB gz the
 * editor's first paint no longer waits for. Until it arrives the panel
 * renders through this frame too (`SlideNotesPanel.tsx`), so its header, its
 * collapse state and its height are the same before and after — nothing in
 * the bottom panels moves when the editor lands.
 *
 * The body keeps at least the editor box's height in every state ("Add
 * speaker notes", "No slide selected", the editor): the panel used to grow
 * by ~55 px once the deck synced and the slide's notes editor replaced the
 * "No slide selected" line, which moved the canvas (the editor's layout shift,
 * CLS 0.12 in Lighthouse).
 */

import { useCallback, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useSlideNotes } from '../state/useSlideNotes.js'
import { useCommand } from '../state/useCommand.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import {
  NOTES_EDITOR_BOX_CLASS,
  requestNotesEditorFocus,
  useNotesCollapsed,
} from './slideNotesShared.js'

interface SlideNotesFrameProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Characters in the slide's notes (shown when there are any). */
  textLength: number
  /** The formatting buttons, left of the collapse button (the editor's). */
  toolbar?: ReactNode
  /** The pointer came over the panel, or the focus into it (the stand-in loads the editor). */
  onIntent?: () => void
  children: ReactNode
}

export function SlideNotesFrame({
  collapsed,
  onToggleCollapsed,
  textLength,
  toolbar,
  onIntent,
  children,
}: SlideNotesFrameProps) {
  return (
    <div
      className="panel flex flex-shrink-0 flex-col border-t border-border"
      onPointerEnter={onIntent}
      onFocus={onIntent}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Speaker notes
          </span>
          {textLength > 0 && (
            <span className="text-[10px] text-muted-foreground/60">{textLength} chars</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!collapsed && toolbar}
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand speaker notes' : 'Collapse speaker notes'}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : 'rotate-0'}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      <div className="collapsible" data-collapsed={collapsed ? 'true' : 'false'}>
        <div className="collapsible-body">
          <div className="px-3 py-2">
            <div className="min-h-[72px]">{children}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface SlideNotesBodyProps {
  /** The active slide has a notes fragment. */
  hasNotes: boolean
  hasSlide: boolean
  isViewer: boolean
  onStartNotes: () => void
  /** What shows the notes when there are some: the editor, or its stand-in. */
  notes: ReactNode
}

/** The body's states: start the notes, none to show, or the notes. */
export function SlideNotesBody({
  hasNotes,
  hasSlide,
  isViewer,
  onStartNotes,
  notes,
}: SlideNotesBodyProps) {
  if (!hasNotes && hasSlide && !isViewer) {
    return (
      <button
        type="button"
        onClick={onStartNotes}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Add speaker notes
      </button>
    )
  }
  if (!hasNotes) {
    return (
      <p className="text-[11px] italic text-muted-foreground">
        {hasSlide ? 'No speaker notes.' : 'No slide selected.'}
      </p>
    )
  }
  return <>{notes}</>
}

interface SlideNotesStandInProps {
  /** Load the editor now: the user is going for the notes. */
  onIntent?: () => void
}

/**
 * The panel until its editor's code arrived (`SlideNotesPanel.tsx` loads it
 * when the editor is idle, or on the first hover or focus): the notes as
 * plain text in the editor's box. A click or Tab into the box loads the
 * editor and hands it the focus when it mounts.
 */
export function SlideNotesStandIn({ onIntent }: SlideNotesStandInProps = {}) {
  const { fragment, hasSlide, text } = useSlideNotes()
  const { role } = useDeckRole()
  const isViewer = role === 'viewer'
  const command = useCommand()
  const { activeSlideId } = useActiveSlide()
  const startNotes = useCallback(() => {
    if (activeSlideId !== null) {
      requestNotesEditorFocus()
      onIntent?.()
      command.tryRun('slide.notes.set', { slide: activeSlideId, markdown: '' })
    }
  }, [command, activeSlideId, onIntent])
  const goForNotes = useCallback(() => {
    requestNotesEditorFocus()
    onIntent?.()
  }, [onIntent])
  const [collapsed, toggleCollapsed] = useNotesCollapsed()

  return (
    <SlideNotesFrame
      collapsed={collapsed}
      onToggleCollapsed={toggleCollapsed}
      textLength={text.length}
      {...(onIntent !== undefined ? { onIntent } : {})}
    >
      <SlideNotesBody
        hasNotes={fragment !== null}
        hasSlide={hasSlide}
        isViewer={isViewer}
        onStartNotes={startNotes}
        notes={
          <div
            className={`${NOTES_EDITOR_BOX_CLASS} whitespace-pre-wrap break-words`}
            aria-label="Speaker notes editor"
            aria-busy="true"
            {...(isViewer
              ? {}
              : {
                  role: 'textbox',
                  'aria-multiline': true,
                  tabIndex: 0,
                  onPointerDown: goForNotes,
                  onFocus: goForNotes,
                })}
          >
            {text}
          </div>
        }
      />
    </SlideNotesFrame>
  )
}
