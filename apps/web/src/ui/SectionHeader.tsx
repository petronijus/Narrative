/**
 * ui/SectionHeader.tsx
 *
 * Collapsible section header for the slides panel (P3).
 * Double-click / F2 to rename, three-dot menu for delete.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, MoreVertical, Trash2 } from 'lucide-react'
import type { DeckSection } from '@narrative/shared'

interface SectionHeaderProps {
  section: DeckSection
  slideCount: number
  readOnly?: boolean
  onToggleCollapsed: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}

export function SectionHeader({
  section,
  slideCount,
  readOnly = false,
  onToggleCollapsed,
  onRename,
  onDelete,
}: SectionHeaderProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(section.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editing) setDraft(section.title)
  }, [section.title, editing])

  useEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (el === null) return
    el.focus()
    el.select()
  }, [editing])

  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: PointerEvent) {
      const m = menuRef.current
      if (m !== null && m.contains(e.target as Node)) return
      setMenuOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const commit = useCallback(() => {
    onRename(section.id, draft)
    setEditing(false)
  }, [draft, section.id, onRename])

  return (
    <div
      className="group mx-2 flex items-center gap-1 rounded px-1 py-1 text-xs hover:bg-surface-2/40"
      data-section-id={section.id}
    >
      <button
        type="button"
        onClick={() => onToggleCollapsed(section.id)}
        aria-label={section.collapsed ? 'Expand section' : 'Collapse section'}
        className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={'h-3 w-3 transition-transform ' + (section.collapsed ? '' : 'rotate-90')}
          aria-hidden="true"
        />
      </button>

      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(section.title)
              setEditing(false)
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex-1 rounded border border-border bg-surface-1 px-1 py-0.5 text-xs text-foreground outline-none focus:border-border-strong"
        />
      ) : (
        <button
          type="button"
          onDoubleClick={() => {
            if (!readOnly) setEditing(true)
          }}
          onKeyDown={(e) => {
            if (!readOnly && e.key === 'F2') {
              e.preventDefault()
              setEditing(true)
            }
          }}
          className="flex-1 truncate rounded px-1 text-left font-medium text-foreground"
          title={section.title}
        >
          {section.title}
        </button>
      )}

      <span className="text-[10px] tabular-nums text-muted-foreground">{slideCount}</span>

      {!readOnly && (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Section options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-surface-2 hover:text-foreground"
          >
            <MoreVertical className="h-3 w-3" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-6 z-50 min-w-36 rounded border border-border bg-popover py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  setEditing(true)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-surface-2"
              >
                Rename
              </button>
              <div className="my-1 border-t border-border" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onDelete(section.id)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 hover:bg-surface-2 hover:text-red-300"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete section
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
