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

import { useCallback, useEffect, useRef, useState, type ComponentType, type SVGProps } from 'react'
import { useShortcuts } from '../state/useShortcuts.js'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  MousePointer2,
  Square,
  Circle,
  Type,
  Image as ImageIcon,
  Film,
  ImagePlus,
  Share2,
  LogOut,
  Play,
  Eye,
  Home,
  ArrowLeft,
  Hand,
  Undo2,
  Redo2,
  Triangle,
  Pentagon,
  Minus,
  MoveUpRight,
  ChevronDown,
  PenTool,
  Ruler,
  Component as ComponentIcon,
} from 'lucide-react'
import { nanoid } from 'nanoid'
import { ComponentPickerDrawer } from './ComponentPickerDrawer.js'
import { useFolderComponents } from '../state/useFolderComponents.js'
import { readMasterFullBbox, readMasterDoc } from '../state/readMasterDoc.js'
import { getComponentDoc } from '../state/componentDocCache.js'
import { addObject, seedInstanceTextCopy } from '@narrative/slide-model'
import type { ComponentInstanceObject } from '@narrative/shared'
import type { ComponentSummary } from '../api/client.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { useTool } from '../state/ToolContext.js'
import { useRulers } from '../state/RulersContext.js'
import type { ActiveTool } from '../state/ToolContext.js'
import { useUndoManager } from '../state/useUndoManager.js'
import { useDeckFontsOptional } from '../state/useDeckFonts.js'
import { AvatarChips } from './AvatarChips.js'
import { useAuth } from '../state/AuthContext.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { ShareDialog } from './ShareDialog.js'
import { useMediaUpload } from '../state/useMediaUpload.js'
import { useApi } from '../api/client.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useSelection } from '../state/SelectionContext.js'
import { createObjectOfType } from '@narrative/slide-model'
import type { UploadEntry } from '../state/useMediaUpload.js'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

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
  'pen',
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
  { tool: 'pen', label: 'Pen', shortcut: 'P', icon: PenTool },
]

// Default image drop position — slide centre in 1920×1080 world coords
const DEFAULT_IMAGE_X = 960
const DEFAULT_IMAGE_Y = 540

interface ToolbarProps {
  /** When true, hide affordances that don't apply to the component
   *  master editor: Present button, component picker (would create
   *  nested components — not allowed), share dialog. */
  masterMode?: boolean
}

export function Toolbar({ masterMode = false }: ToolbarProps = {}) {
  const { activeTool, setActiveTool } = useTool()
  const navigate = useNavigate()
  const location = useLocation()
  const masterBackTarget =
    location.state &&
    typeof location.state === 'object' &&
    'from' in location.state &&
    typeof (location.state as { from: unknown }).from === 'string'
      ? (location.state as { from: string }).from
      : null
  const { id } = useParams<{ id: string }>()
  const { user, logout } = useAuth()
  const api = useApi()
  // Read the deck's folderId from the shared DeckRoleContext rather
  // than firing another `getDeck` from the toolbar — the provider
  // already fetched it. This lets the "+ Add component" button appear
  // as soon as the role is resolved, instead of after a redundant
  // 1-2 s round-trip.
  const { role, folderId } = useDeckRole()
  const [shareOpen, setShareOpen] = useState(false)
  const isViewer = role === 'viewer'
  const isOwner = role === 'owner'
  const { undo, redo, canUndo, canRedo } = useUndoManager()
  const { visible: rulersVisible, toggle: toggleRulers } = useRulers()
  const deckFontsCtx = useDeckFontsOptional()
  const deckFontCount = deckFontsCtx?.fonts.length ?? 0

  // Deck title — fetch once, edit inline. Master mode hides it (the
  // master editor has no deck context). Owner-only edit; viewers see
  // the title but the input is disabled.
  const [deckTitle, setDeckTitle] = useState<string | null>(null)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (masterMode || id === undefined) return
    let cancelled = false
    void api.getDeck(id).then(
      (d) => {
        if (!cancelled) setDeckTitle(d.title)
      },
      () => {
        /* swallow — toolbar shouldn't break on a 404 */
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, id, masterMode])
  useEffect(() => {
    if (titleEditing) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [titleEditing])
  const commitTitleRename = useCallback(() => {
    setTitleEditing(false)
    const trimmed = titleDraft.trim()
    if (id === undefined || trimmed === '' || trimmed === deckTitle) {
      setTitleDraft(deckTitle ?? '')
      return
    }
    setDeckTitle(trimmed)
    void api.renameDeck(id, trimmed).catch(() => {
      // On failure roll back; the user will see the rejected name disappear.
      setDeckTitle((prev) => prev)
    })
  }, [api, id, titleDraft, deckTitle])

  // M11: Upload hook + hidden file input ref
  const { startUpload } = useMediaUpload()
  const { objectsCtx } = useSlideObjects()
  const { selectOne } = useSelection()
  const imageFileInputRef = useRef<HTMLInputElement>(null)
  const videoFileInputRef = useRef<HTMLInputElement>(null)

  // M16 P6 — Component picker drawer
  const [pickerOpen, setPickerOpen] = useState(false)
  const folderComponents = useFolderComponents(folderId, { eager: true })
  // Batch-fetched usage counts for the drawer rows. One request on
  // every open instead of N (one per row) — avoids replaying every
  // deck doc N times for folders with many components.
  const [usageCounts, setUsageCounts] = useState<Record<string, number> | null>(null)
  const handleOpenPicker = useCallback(() => {
    setPickerOpen(true)
    // Re-fetch on open — promotions / deletions in another tab should land.
    void folderComponents.invalidate()
    // Fire one batch usage-count request; rows render synchronously
    // once the response lands.
    if (folderId !== null) {
      setUsageCounts(null)
      api
        .listComponentInstanceCounts(folderId)
        .then((counts) => setUsageCounts(counts))
        .catch(() => setUsageCounts({}))
    }
  }, [api, folderComponents, folderId])
  const handleClosePicker = useCallback(() => setPickerOpen(false), [])

  /**
   * Insert a component instance at (x, y), with size derived from the
   * master's bbox if the master doc is already cached. Falls back to
   * 400×300; the renderer (or a later cache-sync) will resize once the
   * doc syncs.
   */
  const insertComponentInstance = useCallback(
    async (component: ComponentSummary, _x: number, _y: number): Promise<void> => {
      if (objectsCtx === null) return
      void _x
      void _y
      // Await the master doc's first sync so the inserted instance lands
      // at the master's authored bbox on the *first* click (cold cache).
      // M16 P-flatten: components carry their canonical slide-space
      // position from the master. The instance lands at (bbox.x, bbox.y)
      // 1:1 with how the user authored the master — moving / resetting
      // is an explicit user action thereafter.
      const bbox = await readMasterFullBbox(component.id)
      const width = bbox !== null ? bbox.width : 400
      const height = bbox !== null ? bbox.height : 300
      const x = bbox !== null ? bbox.x : SLIDE_WIDTH / 2 - width / 2
      const y = bbox !== null ? bbox.y : SLIDE_HEIGHT / 2 - height / 2

      const instance: ComponentInstanceObject = {
        id: nanoid(),
        type: 'componentInstance',
        componentId: component.id,
        componentName: component.name,
        x,
        y,
        width,
        height,
        rotation: 0,
        opacity: 1,
      }
      addObject(objectsCtx, instance)

      // Seed text copy from the master at insert time so subsequent master
      // copy edits do NOT propagate to this instance's text leaves.
      // The master doc is already in the cache (we just awaited readMasterFullBbox).
      const masterDoc = getComponentDoc(component.id)
      if (masterDoc !== null) {
        const snap = readMasterDoc(masterDoc)
        if (snap !== null) {
          const masterTextLeaves = snap.objects
            .filter(
              (obj) => obj.type === 'text' && typeof (obj as { text?: unknown }).text === 'string',
            )
            .map((obj) => ({ id: obj.id, text: (obj as { text: string }).text }))
          if (masterTextLeaves.length > 0) {
            seedInstanceTextCopy(objectsCtx, instance.id, masterTextLeaves)
          }
        }
      }

      // Replace any prior selection with the freshly-inserted instance.
      // Matches Figma: dropping a component from the picker drops the
      // user straight into "edit transform of the new instance" rather
      // than leaving stale selection chrome on whatever was selected.
      selectOne(instance.id)
    },
    [objectsCtx, selectOne],
  )

  const handlePickComponent = useCallback(
    (component: ComponentSummary) => {
      // Close the drawer immediately — the master-bbox await happens
      // in the background and would otherwise hold the picker open
      // for the duration of the WS sync round-trip.
      setPickerOpen(false)
      void insertComponentInstance(component, SLIDE_WIDTH / 2, SLIDE_HEIGHT / 2)
    },
    [insertComponentInstance],
  )

  function handleMediaUploadDone(entry: UploadEntry) {
    if (entry.status !== 'done') return
    if (objectsCtx === null) return
    if (entry.assetId === undefined || entry.assetId === '') return
    if (entry.mimeType.startsWith('video/')) {
      const w = entry.width ?? 640
      const h = entry.height ?? 360
      createObjectOfType(objectsCtx, 'video', {
        assetId: entry.assetId,
        width: w,
        height: h,
        x: DEFAULT_IMAGE_X - w / 2,
        y: DEFAULT_IMAGE_Y - h / 2,
        autoplay: false,
        loop: false,
        muted: true,
      })
      return
    }
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
      startUpload(file, { onDone: handleMediaUploadDone })
    }
    e.target.value = ''
  }

  // P9: tool + present-mode shortcuts via centralised registry.
  useShortcuts([
    {
      keys: 'Mod+Enter',
      scope: 'global',
      preventDefault: true,
      description: 'Start presenting',
      handler: () => {
        navigate(`/deck/${id ?? ''}/present`)
      },
    },
    {
      keys: 'v',
      scope: 'global',
      description: 'Select tool',
      handler: () => {
        setActiveTool('select')
      },
    },
    {
      keys: 'h',
      scope: 'global',
      description: 'Hand / pan tool',
      handler: () => {
        setActiveTool('hand')
      },
    },
    {
      keys: 't',
      scope: 'global',
      description: 'Text tool',
      handler: () => {
        setActiveTool('text')
      },
    },
    {
      keys: 'r',
      scope: 'global',
      description: 'Rectangle tool',
      handler: () => {
        setActiveTool('rectangle')
      },
    },
    {
      keys: 'o',
      scope: 'global',
      description: 'Ellipse tool',
      handler: () => {
        setActiveTool('ellipse')
      },
    },
    {
      keys: 'l',
      scope: 'global',
      description: 'Line tool',
      handler: () => {
        setActiveTool('line')
      },
    },
    {
      keys: 'a',
      scope: 'global',
      description: 'Arrow tool',
      handler: () => {
        setActiveTool('arrow')
      },
    },
    {
      keys: 'p',
      scope: 'global',
      description: 'Pen tool',
      handler: () => {
        setActiveTool('pen')
      },
    },
    {
      keys: 'i',
      scope: 'global',
      description: 'Insert image',
      handler: () => {
        if (!isViewer) imageFileInputRef.current?.click()
      },
    },
  ])

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="panel flex items-center gap-1 border-b border-border px-3 py-1.5"
        role="toolbar"
        aria-label="Object tools"
      >
        {/* Home / back-to-presentation — when editing a master component, the
            home slot becomes a labelled blue pill that returns the user to the
            originating deck (or folder if the master URL was hit directly). */}
        {masterMode ? (
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              if (masterBackTarget !== null) {
                void navigate(masterBackTarget)
              } else if (folderId != null) {
                void navigate(`/folder/${folderId}`)
              } else {
                navigate(-1)
              }
            }}
            aria-label="Back to presentation"
            className="h-7 gap-1.5 rounded-full bg-blue-600 px-3 text-xs font-semibold text-white shadow-sm shadow-blue-500/30 hover:bg-blue-500"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to presentation
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate(folderId != null ? `/folder/${folderId}` : '/')}
                aria-label="Back to deck list"
                className="h-7 w-7"
              >
                <Home className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Back to deck list</TooltipContent>
          </Tooltip>
        )}

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

        {/* Editable deck title — owner can rename inline. Hidden in master
            mode (the back-to-presentation pill already conveys that we're
            outside a deck). */}
        {!masterMode && deckTitle !== null && (
          <div className="ml-1 mr-1 flex min-w-0 max-w-[260px] items-center">
            {titleEditing && !isViewer ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitTitleRename()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setTitleEditing(false)
                    setTitleDraft(deckTitle)
                  }
                }}
                onBlur={commitTitleRename}
                maxLength={200}
                className="min-w-0 max-w-full rounded-sm border border-border-strong bg-surface-1 px-1.5 py-0.5 text-xs font-medium text-foreground outline-none focus:ring-1 focus:ring-ring/40"
                aria-label="Deck title"
              />
            ) : (
              <button
                type="button"
                disabled={isViewer}
                onClick={() => {
                  if (isViewer) return
                  setTitleDraft(deckTitle)
                  setTitleEditing(true)
                }}
                title={isViewer ? deckTitle : 'Click to rename deck'}
                className="min-w-0 max-w-full truncate rounded-sm px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
              >
                {deckTitle}
              </button>
            )}
          </div>
        )}

        {/* Deck-specific font notice — shown when one or more fonts have
            been promoted from folder to deck scope (because a teammate
            deleted the font from folder settings while this deck still
            referenced it). The deck keeps rendering, the user just gets
            a quiet heads-up. */}
        {!masterMode && deckFontCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="ml-1 mr-1 inline-flex h-5 select-none items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-600 dark:text-amber-300"
                aria-label="Deck-specific fonts in use"
              >
                Deck font{deckFontCount > 1 ? 's' : ''} ×{deckFontCount}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              This deck uses {deckFontCount} font{deckFontCount > 1 ? 's' : ''} that no longer exist
              in the folder. Re-upload the file to folder settings to share it again.
            </TooltipContent>
          </Tooltip>
        )}

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

          {/* Insert Media — dropdown with Image + Video. Hidden for viewer role. */}
          {!isViewer && (
            <>
              <input
                ref={imageFileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={handleFileInputChange}
              />
              <input
                ref={videoFileInputRef}
                type="file"
                accept="video/*"
                multiple
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={handleFileInputChange}
              />
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Insert media"
                        className="h-7 w-7"
                      >
                        <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Insert media</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start" sideOffset={4} className="min-w-[8rem]">
                  <DropdownMenuItem onSelect={() => imageFileInputRef.current?.click()}>
                    <ImageIcon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                    Image
                    <span className="ml-auto text-xs opacity-60">I</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => videoFileInputRef.current?.click()}>
                    <Film className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                    Video
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {/* M16 P6 — "+ Add component" — opens the picker drawer.
              Always rendered for editors so it's part of the initial
              tool strip (was previously gated on a network-fetched
              component list, which made it pop in late). The drawer
              itself shows an empty-state CTA when the folder has no
              components yet. */}
          {!isViewer && folderId !== null && !masterMode && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleOpenPicker}
                  aria-label="Add component"
                  aria-haspopup="dialog"
                  aria-expanded={pickerOpen}
                  className="h-7 w-7"
                  data-testid="toolbar-add-component"
                >
                  <ComponentIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Add component</TooltipContent>
            </Tooltip>
          )}

          {/* P11: Rulers toggle — show/hide the editor ruler strips +
              drag-out guides. Default off (rulers can be visually busy).
              Lives at the right edge of the centered tool cluster, next
              to the components button. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={rulersVisible ? 'default' : 'ghost'}
                size="icon"
                onClick={toggleRulers}
                aria-label="Toggle rulers"
                aria-pressed={rulersVisible}
                className="h-7 w-7"
              >
                <Ruler className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle rulers</TooltipContent>
          </Tooltip>
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

        {/* Preview animations — deck only; masters have no presentation. */}
        {!masterMode && (
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
        )}

        {/* M16 P6 — Component picker drawer. Drag-out to canvas wired
            via custom dataTransfer mime; the editor canvas drop handler
            reads it and inserts at the drop point. */}
        <ComponentPickerDrawer
          open={pickerOpen}
          onClose={handleClosePicker}
          components={folderComponents.components}
          loading={folderComponents.loading}
          usageCounts={usageCounts}
          onPick={handlePickComponent}
          onDragStartComponent={(component, e) => {
            const payload = JSON.stringify({ componentId: component.id })
            e.dataTransfer.setData('application/x-narrative-component', payload)
            e.dataTransfer.effectAllowed = 'copy'
          }}
        />

        {/* Present button — deck only. */}
        {!masterMode && (
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
        )}
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
            size="sm"
            onClick={() => {
              if (!isActive) setActiveTool(lastShape.tool)
              setOpen((v) => !v)
            }}
            aria-label="Shapes"
            aria-haspopup="menu"
            aria-expanded={open}
            className="flex h-7 items-center gap-0.5 px-1.5"
          >
            <TriggerIcon className="h-3.5 w-3.5" aria-hidden="true" />
            <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Shapes</TooltipContent>
      </Tooltip>
      {open && (
        <div
          role="menu"
          className="absolute left-1/2 top-9 z-50 -translate-x-1/2 rounded-md border border-border bg-popover shadow-lg"
          style={{ padding: 8 }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 36px)',
              gap: 6,
            }}
          >
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
                    'flex items-center justify-center rounded-md transition ' +
                    (selected
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-surface-2')
                  }
                  style={{ height: 36, width: 36 }}
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
