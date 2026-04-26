/**
 * ui/SlidesPanelContextMenu.tsx
 *
 * P11 (round 4): single right-click menu for the whole slide panel.
 *
 * Replaces the per-row SlideRowContextMenu with a panel-level Radix Root
 * (avoids nested triggers — the same pattern that broke the editor's
 * canvas/object menus before P11d). On contextmenu we look for the
 * nearest `[data-slide-id]` ancestor:
 *   - hit  → 'row' mode: rename, duplicate, copy, paste-after, skip,
 *            delete.
 *   - miss → 'empty' mode: paste at end.
 *
 * Targets are stashed in a ref to dodge React-state batching (same race
 * we hit in EditorContextMenu).
 */

import { useRef, useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface SlidesPanelContextMenuProps {
  readOnly?: boolean
  /** Slide id ↔ skipped flag. */
  isSkipped: (id: string) => boolean
  onRename: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onToggleSkip: (id: string) => void
  onCopy: (id: string) => void
  /** Paste after the given slide id; null → paste at end. */
  onPaste: (afterSlideId: string | null) => void
  canPaste: boolean
  children: React.ReactNode
}

type Mode = 'row' | 'empty'

export function SlidesPanelContextMenu({
  readOnly = false,
  isSkipped,
  onRename,
  onDuplicate,
  onDelete,
  onToggleSkip,
  onCopy,
  onPaste,
  canPaste,
  children,
}: SlidesPanelContextMenuProps) {
  const [mode, setMode] = useState<Mode>('empty')
  const targetIdRef = useRef<string | null>(null)
  const targetSkippedRef = useRef<boolean>(false)

  if (readOnly) return <>{children}</>

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const t = e.target as Element | null
    const slideEl = t?.closest('[data-slide-id]') ?? null
    if (slideEl !== null) {
      const id = slideEl.getAttribute('data-slide-id')
      if (id !== null && id !== '') {
        targetIdRef.current = id
        targetSkippedRef.current = isSkipped(id)
        setMode('row')
        return
      }
    }
    targetIdRef.current = null
    targetSkippedRef.current = false
    setMode('empty')
  }

  const targetId = targetIdRef.current
  const targetSkipped = targetSkippedRef.current

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div onContextMenu={handleContextMenu} style={{ display: 'contents' }}>
          {children}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-48" data-mode={mode}>
        {mode === 'row' && targetId !== null && (
          <>
            <ContextMenuItem onSelect={() => onRename(targetId)}>Rename</ContextMenuItem>
            <ContextMenuItem onSelect={() => onDuplicate(targetId)}>Duplicate</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onCopy(targetId)}>Copy slide</ContextMenuItem>
            <ContextMenuItem disabled={!canPaste} onSelect={() => onPaste(targetId)}>
              Paste slide
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onToggleSkip(targetId)}>
              {targetSkipped ? 'Unskip in present' : 'Skip in present'}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => onDelete(targetId)}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </ContextMenuItem>
          </>
        )}

        {mode === 'empty' && (
          <ContextMenuItem disabled={!canPaste} onSelect={() => onPaste(null)}>
            Paste slide
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
