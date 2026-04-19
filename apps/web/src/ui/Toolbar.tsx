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
 */

import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTool } from '../state/ToolContext.js'
import type { ActiveTool } from '../state/ToolContext.js'
import { AvatarChips } from './AvatarChips.js'

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
      {/* Tool buttons */}
      {TOOL_BUTTONS.map(({ tool, label, shortcut, icon }) => {
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
