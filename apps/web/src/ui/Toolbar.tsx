/**
 * ui/Toolbar.tsx
 *
 * Editor toolbar — tool buttons + top-right actions.
 *
 * P1 visual foundation: shadcn Button + Lucide icons replaced the hand-rolled
 * inline SVG / emoji chrome. Behaviour, data flow, keyboard shortcuts, test
 * IDs (aria-label names) unchanged.
 *
 * Keyboard shortcuts (outside input/textarea focus):
 *   V → select, R → rectangle, O → ellipse, T → text, I → insert image,
 *   Ctrl/Cmd+Enter → present mode.
 */

import { useEffect, useRef, useState, type ComponentType, type SVGProps } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  MousePointer2,
  Square,
  Circle,
  Type,
  Image as ImageIcon,
  Share2,
  LogOut,
  Play,
  Eye,
  Home,
  Hand,
  Undo2,
  Redo2,
  Triangle,
  Pentagon,
  Minus,
  MoveUpRight,
  ChevronDown,
} from 'lucide-react'
import { useTool } from '../state/ToolContext.js'
import type { ActiveTool } from '../state/ToolContext.js'
import { useUndoManager } from '../state/useUndoManager.js'
import { AvatarChips } from './AvatarChips.js'
import { useAuth } from '../state/AuthContext.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { ShareDialog } from './ShareDialog.js'
import { useMediaUpload } from '../state/useMediaUpload.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { createObjectOfType } from '@narrative/slide-model'
import type { UploadEntry } from '../state/useMediaUpload.js'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface ToolButton {
  tool: ActiveTool
  label: string
  shortcut: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

const SHAPE_TOOL_SET = new Set<ActiveTool>([
  'rectangle',
  'ellipse',
  'triangle',
  'polygon',
  'line',
  'arrow',
])

const TOOL_BUTTONS: ToolButton[] = [
  { tool: 'select', label: 'Select', shortcut: 'V', icon: MousePointer2 },
  { tool: 'hand', label: 'Hand', shortcut: 'H', icon: Hand },
  { tool: 'text', label: 'Text', shortcut: 'T', icon: Type },
]

const SHAPE_TOOLS: ToolButton[] = [
  { tool: 'rectangle', label: 'Rectangle', shortcut: 'R', icon: Square },
  { tool: 'ellipse', label: 'Ellipse', shortcut: 'O', icon: Circle },
  { tool: 'triangle', label: 'Triangle', shortcut: '', icon: Triangle },
  { tool: 'polygon', label: 'Polygon', shortcut: '', icon: Pentagon },
  { tool: 'line', label: 'Line', shortcut: 'L', icon: Minus },
  { tool: 'arrow', label: 'Arrow', shortcut: 'A', icon: MoveUpRight },
]

const SHORTCUT_MAP: Record<string, ActiveTool> = {
  v: 'select',
  h: 'hand',
  r: 'rectangle',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  t: 'text',
}

function isInputFocused(): boolean {
  const el = document.activeElement
  if (el === null) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable
}

// Default image drop position — slide centre in 1920×1080 world coords
const DEFAULT_IMAGE_X = 960
const DEFAULT_IMAGE_Y = 540

export function Toolbar() {
  const { activeTool, setActiveTool } = useTool()
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const { user, logout } = useAuth()
  const { role } = useDeckRole()
  const [shareOpen, setShareOpen] = useState(false)
  const isViewer = role === 'viewer'
  const isOwner = role === 'owner'
  const { undo, redo, canUndo, canRedo } = useUndoManager()

  // M11: Upload hook + hidden file input ref
  const { startUpload } = useMediaUpload()
  const { objectsCtx } = useSlideObjects()
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleImageUploadDone(entry: UploadEntry) {
    if (entry.status !== 'done') return
    if (objectsCtx === null) return
    if (entry.assetId === undefined || entry.assetId === '') return
    createObjectOfType(objectsCtx, 'image', {
      assetId: entry.assetId,
      width: entry.width ?? 400,
      height: entry.height ?? 300,
      x: DEFAULT_IMAGE_X - (entry.width ?? 400) / 2,
      y: DEFAULT_IMAGE_Y - (entry.height ?? 300) / 2,
    })
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    for (const file of files) {
      startUpload(file, { onDone: handleImageUploadDone })
    }
    e.target.value = ''
  }

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
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const tool = SHORTCUT_MAP[e.key.toLowerCase()]
      if (tool !== undefined) {
        e.preventDefault()
        setActiveTool(tool)
        return
      }

      if (e.key.toLowerCase() === 'i' && !isViewer) {
        e.preventDefault()
        fileInputRef.current?.click()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [id, navigate, setActiveTool, isViewer])

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="panel flex items-center gap-1 border-b border-border px-3 py-1.5"
        role="toolbar"
        aria-label="Object tools"
      >
        {/* Home — back to deck list */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/')}
              aria-label="Back to deck list"
              className="h-7 w-7"
            >
              <Home className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back to deck list</TooltipContent>
        </Tooltip>

        {/* Undo / Redo */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={undo}
              disabled={!canUndo}
              aria-label="Undo"
              className="h-7 w-7"
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Undo <span className="ml-2 opacity-60">Ctrl+Z</span>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={redo}
              disabled={!canRedo}
              aria-label="Redo"
              className="h-7 w-7"
            >
              <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Redo <span className="ml-2 opacity-60">Ctrl+Shift+Z</span>
          </TooltipContent>
        </Tooltip>

        {/* Centered tool cluster — icon-only, labels live in tooltips. */}
        <div className="flex flex-1 items-center justify-center gap-1">
          {!isViewer &&
            TOOL_BUTTONS.slice(0, 2).map(({ tool, label, shortcut, icon: Icon }) => {
              const isActive = activeTool === tool
              return (
                <Tooltip key={tool}>
                  <TooltipTrigger asChild>
                    <Button
                      variant={isActive ? 'default' : 'ghost'}
                      size="icon"
                      onClick={() => setActiveTool(tool)}
                      aria-label={`${label} (${shortcut})`}
                      aria-pressed={isActive}
                      className="h-7 w-7"
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {label} <span className="ml-2 opacity-60">{shortcut}</span>
                  </TooltipContent>
                </Tooltip>
              )
            })}

          {/* Shapes dropdown — collapses rectangle/ellipse/triangle/polygon/line/arrow
              behind a single button whose icon reflects the most-recently picked
              shape. */}
          {!isViewer && (
            <ShapesDropdown
              shapes={SHAPE_TOOLS}
              activeTool={activeTool}
              setActiveTool={setActiveTool}
            />
          )}

          {/* Text tool */}
          {!isViewer &&
            TOOL_BUTTONS.slice(2).map(({ tool, label, shortcut, icon: Icon }) => {
              const isActive = activeTool === tool
              return (
                <Tooltip key={tool}>
                  <TooltipTrigger asChild>
                    <Button
                      variant={isActive ? 'default' : 'ghost'}
                      size="icon"
                      onClick={() => setActiveTool(tool)}
                      aria-label={`${label} (${shortcut})`}
                      aria-pressed={isActive}
                      className="h-7 w-7"
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {label} <span className="ml-2 opacity-60">{shortcut}</span>
                  </TooltipContent>
                </Tooltip>
              )
            })}

          {/* M11: Insert Image button — hidden for viewer role */}
          {!isViewer && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={handleFileInputChange}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Insert image (I)"
                    className="h-7 w-7"
                  >
                    <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Insert image <span className="ml-2 opacity-60">I</span>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>

        {/* M8: Connected collaborators avatar chips */}
        <AvatarChips />

        {/* M10: Share button — owner only */}
        {isOwner && id !== undefined && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShareOpen(true)}
                  aria-label="Share deck"
                  className="gap-1.5"
                >
                  <Share2 className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Share</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Share deck</TooltipContent>
            </Tooltip>
            {shareOpen && <ShareDialog deckId={id} onClose={() => setShareOpen(false)} />}
          </>
        )}

        {/* M10: Signed-in user + sign-out */}
        {user !== null && (
          <div className="flex items-center gap-2 ml-1">
            <span
              className="hidden lg:block text-xs text-muted-foreground truncate max-w-[120px]"
              title={user.email ?? user.sub}
            >
              {user.name ?? user.email ?? user.sub.slice(0, 8)}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void logout()}
                  aria-label="Sign out"
                  className="h-7 w-7"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Sign out</TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Preview animations */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate(`/deck/${id ?? ''}/present?preview=1`)}
              aria-label="Preview animations"
              className="h-7 w-7"
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Preview animations</TooltipContent>
        </Tooltip>

        {/* Present button — brand gradient + accent glow */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              onClick={() => navigate(`/deck/${id ?? ''}/present`)}
              aria-label="Present (Ctrl+Enter)"
              className="btn-brand h-7 w-7"
            >
              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Present <span className="ml-2 opacity-60">Ctrl+Enter</span>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// Shapes dropdown
// ---------------------------------------------------------------------------

interface ShapesDropdownProps {
  shapes: ToolButton[]
  activeTool: ActiveTool
  setActiveTool: (tool: ActiveTool) => void
}

function ShapesDropdown({ shapes, activeTool, setActiveTool }: ShapesDropdownProps) {
  const [open, setOpen] = useState(false)
  const [lastShape, setLastShape] = useState<ToolButton>(() => shapes[0]!)
  const rootRef = useRef<HTMLDivElement>(null)

  // Track the most-recently picked shape so the trigger button's icon
  // reflects "what clicking will do". Updates when the active tool
  // becomes one of the shapes (e.g. via keyboard shortcut too).
  useEffect(() => {
    const match = shapes.find((s) => s.tool === activeTool)
    if (match !== undefined) setLastShape(match)
  }, [activeTool, shapes])

  // Outside-click + Escape close.
  useEffect(() => {
    if (!open) return
    function onDown(e: PointerEvent) {
      const r = rootRef.current
      if (r !== null && r.contains(e.target as Node)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const isActive = SHAPE_TOOL_SET.has(activeTool)
  const TriggerIcon = lastShape.icon

  const pick = (tool: ActiveTool) => {
    setActiveTool(tool)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isActive ? 'default' : 'ghost'}
            size="icon"
            onClick={() => {
              // Click activates the last-used shape AND opens the picker.
              if (!isActive) setActiveTool(lastShape.tool)
              setOpen((v) => !v)
            }}
            aria-label="Shapes"
            aria-haspopup="menu"
            aria-expanded={open}
            className="h-7 w-7"
          >
            <TriggerIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <ChevronDown
              className="absolute -right-0.5 -bottom-0.5 h-2 w-2 opacity-70"
              aria-hidden="true"
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Shapes</TooltipContent>
      </Tooltip>
      {open && (
        <div
          role="menu"
          className="absolute left-1/2 top-9 z-50 -translate-x-1/2 rounded border border-border bg-popover p-1 shadow-lg"
        >
          <div className="grid grid-cols-3 gap-1">
            {shapes.map(({ tool, label, shortcut, icon: Icon }) => {
              const selected = activeTool === tool
              return (
                <button
                  key={tool}
                  type="button"
                  role="menuitem"
                  onClick={() => pick(tool)}
                  aria-label={`${label}${shortcut === '' ? '' : ` (${shortcut})`}`}
                  aria-pressed={selected}
                  title={shortcut === '' ? label : `${label} (${shortcut})`}
                  className={
                    'flex h-8 w-8 items-center justify-center rounded transition ' +
                    (selected
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-surface-2')
                  }
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
