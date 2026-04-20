/**
 * ui/Toolbar.tsx
 *
 * Toolbar s tlačítky pro vytváření objektů + select tool.
 *
 * Keyboard shortcuts (jen mimo input/textarea focus):
 * - V → select
 * - R → rectangle
 * - O → ellipse
 * - T → text
 *
 * M5: Přidán "Present" button vpravo (▶).
 * - Klik → naviguje na /deck/:id/present
 * - Keyboard: Ctrl/Cmd+Enter → present mode
 *
 * M10: Auth-aware toolbar.
 * - Tool creation buttons hidden for viewer role.
 * - Share button (owner-only) opens ShareDialog.
 * - Signed-in user display + sign-out in top-right.
 */

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTool } from '../state/ToolContext.js'
import type { ActiveTool } from '../state/ToolContext.js'
import { AvatarChips } from './AvatarChips.js'
import { useAuth } from '../state/AuthContext.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { ShareDialog } from './ShareDialog.js'

interface ToolButton {
  tool: ActiveTool
  label: string
  shortcut: string
  icon: string
}

const TOOL_BUTTONS: ToolButton[] = [
  { tool: 'select', label: 'Select', shortcut: 'V', icon: '▲' },
  { tool: 'rectangle', label: 'Rectangle', shortcut: 'R', icon: '▭' },
  { tool: 'ellipse', label: 'Ellipse', shortcut: 'O', icon: '◯' },
  { tool: 'text', label: 'Text', shortcut: 'T', icon: 'T' },
]

const SHORTCUT_MAP: Record<string, ActiveTool> = {
  v: 'select',
  r: 'rectangle',
  o: 'ellipse',
  t: 'text',
}

function isInputFocused(): boolean {
  const el = document.activeElement
  if (el === null) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable
}

export function Toolbar() {
  const { activeTool, setActiveTool } = useTool()
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const { user, logout } = useAuth()
  const { role } = useDeckRole()
  const [shareOpen, setShareOpen] = useState(false)
  const isViewer = role === 'viewer'
  const isOwner = role === 'owner'

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Present mode: Ctrl/Cmd+Enter
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (isInputFocused()) return
        e.preventDefault()
        navigate(`/deck/${id ?? ''}/present`)
        return
      }

      if (isInputFocused()) return
      // Neinterceptovat modifier combos
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const tool = SHORTCUT_MAP[e.key.toLowerCase()]
      if (tool !== undefined) {
        e.preventDefault()
        setActiveTool(tool)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [id, navigate, setActiveTool])

  return (
    <div
      className="flex items-center gap-1 border-b border-gray-800 bg-gray-900 px-3 py-1.5"
      role="toolbar"
      aria-label="Object tools"
    >
      {/* Tool buttons — hidden for viewer role */}
      {!isViewer &&
        TOOL_BUTTONS.map(({ tool, label, shortcut, icon }) => {
          const isActive = activeTool === tool
          return (
            <button
              key={tool}
              type="button"
              onClick={() => setActiveTool(tool)}
              aria-label={`${label} (${shortcut})`}
              aria-pressed={isActive}
              title={`${label} — ${shortcut}`}
              className={[
                'flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
              ].join(' ')}
            >
              <span aria-hidden="true" className="text-base leading-none">
                {icon}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </button>
          )
        })}

      {/* Spacer */}
      <div className="flex-1" aria-hidden="true" />

      {/* M8: Connected collaborators avatar chips */}
      <AvatarChips />

      {/* M10: Share button — owner only */}
      {isOwner && id !== undefined && (
        <>
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            aria-label="Share deck"
            title="Share"
            className={[
              'flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
              'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
            ].join(' ')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            <span className="hidden sm:inline">Share</span>
          </button>

          {shareOpen && <ShareDialog deckId={id} onClose={() => setShareOpen(false)} />}
        </>
      )}

      {/* M10: Signed-in user + sign-out */}
      {user !== null && (
        <div className="flex items-center gap-2 ml-1">
          <span
            className="hidden lg:block text-xs text-gray-500 truncate max-w-[120px]"
            title={user.email ?? user.sub}
          >
            {user.name ?? user.email ?? user.sub.slice(0, 8)}
          </span>
          <button
            type="button"
            onClick={() => void logout()}
            aria-label="Sign out"
            title="Sign out"
            className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-800 hover:text-gray-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            Sign out
          </button>
        </div>
      )}

      {/* Preview animations button — naviguje do present mode s ?preview=1 */}
      <button
        type="button"
        onClick={() => navigate(`/deck/${id ?? ''}/present?preview=1`)}
        aria-label="Preview animations"
        title="Preview animations"
        className={[
          'flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
          'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
        ].join(' ')}
      >
        <span aria-hidden="true" className="text-base leading-none">
          ▷
        </span>
        <span className="hidden sm:inline">Preview</span>
      </button>

      {/* Present button */}
      <button
        type="button"
        onClick={() => navigate(`/deck/${id ?? ''}/present`)}
        aria-label="Present (Ctrl+Enter)"
        title="Present — Ctrl+Enter"
        className={[
          'flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
          'bg-green-700 text-white hover:bg-green-600',
        ].join(' ')}
      >
        <span aria-hidden="true" className="text-base leading-none">
          ▶
        </span>
        <span className="hidden sm:inline">Present</span>
      </button>
    </div>
  )
}
