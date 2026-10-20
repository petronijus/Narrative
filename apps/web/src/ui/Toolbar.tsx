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

import { downloadBlob, safeFilename } from '../lib/download.js'
import { attachmentFilename } from '../api/client.js'
import { API_URL } from '../lib/endpoints.js'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from 'react'
import { formatKeyCombo, useShortcuts } from '../state/useShortcuts.js'
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
  FileDown,
  Loader2,
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
  Magnet,
  Table2,
  Component as ComponentIcon,
} from 'lucide-react'
import { ComponentPickerDrawer } from './lazyEditorParts.js'
import { useFolderComponents } from '../state/useFolderComponents.js'
import { useStampComponent } from '../state/useStampComponent.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useCommand, type CommandDispatch } from '../state/useCommand.js'
import type { AgentRunTarget, ComponentSummary } from '../api/client.js'
import { useTool } from '../state/ToolContext.js'
import { useRulers } from '../state/RulersContext.js'
import { useSnapping } from '../state/SnappingContext.js'
import type { ActiveTool } from '../state/ToolContext.js'
import type { ActionId } from '../actions/catalog.js'
import { useUndoManager } from '../state/useUndoManager.js'
import { useDeckFontsOptional } from '../state/useDeckFonts.js'
import { AvatarChips } from './AvatarChips.js'
import { AgentActivityButton } from './AgentActivityPopover.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { ShareDialog } from './lazyEditorParts.js'
import { useMediaUpload } from '../state/useMediaUpload.js'
import { useApi } from '../api/client.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { listSlides } from '@narrative/slide-model'
import { ExportPptxDialog } from './lazyEditorParts.js'
import { exportDeckPdfInBrowser } from '../state/browserDeckPdf.js'
import { MAX_PDF_SLIDES } from '@narrative/commands'
import { dismissEditorNotice, showEditorNotice } from '../state/editorNotice.js'
import { SlideRenderRefused } from '../state/browserSlideExport.js'
import type { Slide } from '@narrative/shared'
import { useSelection } from '../state/SelectionContext.js'
import type { UploadEntry } from '../state/useMediaUpload.js'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

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
  { tool: 'table', label: 'Table', shortcut: 'K', icon: Table2 },
]

/** The catalog action of a tool button (actions/catalog.ts). */
function toolAction(tool: ActiveTool): ActionId {
  switch (tool) {
    case 'select':
      return 'tool.select'
    case 'hand':
      return 'tool.hand'
    case 'text':
      return 'tool.text'
    case 'table':
      return 'tool.table'
    case 'pen':
      return 'tool.pen'
    default:
      return 'tool.shape'
  }
}

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

function ToolbarImpl({ masterMode = false }: ToolbarProps = {}) {
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
  // `id` on the deck route; `componentId` on the component master editor's
  // route (/folder/:folderId/component/:componentId), where masterMode is set.
  const { id, componentId } = useParams<{ id: string; componentId: string }>()
  const api = useApi()
  // M28: in-flight state for the Export button. We use fetch+blob (not a
  // plain location nav) so the user gets a spinner during the ~1-2 s pptx
  // build and any server error surfaces as a transient banner instead of a
  // confusing empty download.
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  // D2 — pre-export compatibility-warning dialog. Opens on Export click;
  // contains a `Slide[]` snapshot the scanner walks for known losses.
  const [exportDialogSlides, setExportDialogSlides] = useState<Slide[] | null>(null)
  const slideDoc = useSlideDoc()
  // Auto-dismiss the export-error banner after a few seconds — feels nicer
  // than leaving a stale message lying around.
  useEffect(() => {
    if (exportError === null) return
    const t = setTimeout(() => setExportError(null), 5_000)
    return () => clearTimeout(t)
  }, [exportError])

  // Read the deck's folderId from the shared DeckRoleContext rather
  // than firing another `getDeck` from the toolbar — the provider
  // already fetched it. This lets the "+ Add component" button appear
  // as soon as the role is resolved, instead of after a redundant
  // 1-2 s round-trip.
  const { role, folderId } = useDeckRole()
  const [shareOpen, setShareOpen] = useState(false)
  const isViewer = role === 'viewer'
  const isOwner = role === 'owner'
  const agentRunTarget = useMemo<AgentRunTarget | null>(() => {
    if (masterMode) return componentId === undefined ? null : { componentId }
    return id === undefined ? null : { deckId: id }
  }, [masterMode, componentId, id])
  const { undo, redo, canUndo, canRedo } = useUndoManager()
  const { visible: rulersVisible, toggle: toggleRulers } = useRulers()
  const { enabled: snappingEnabled, toggle: toggleSnapping } = useSnapping()
  const deckFontsCtx = useDeckFontsOptional()
  const deckFontCount = deckFontsCtx?.fonts.length ?? 0

  // Deck title — fetch once, edit inline. Master mode hides it (the
  // master editor has no deck context). Owner-only edit; viewers see
  // the title but the input is disabled.
  const [deckTitle, setDeckTitle] = useState<string | null>(null)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  /** Export → PDF: built here, the server's route when this browser cannot render (A5.6). */
  const exportPdf = useCallback(async () => {
    if (id === undefined || slideDoc === null || slideDoc.deckCtx === undefined) return
    const deckCtx = slideDoc.deckCtx
    // Skipped slides are left out, as presenting leaves them out.
    const slideIds = listSlides(deckCtx)
      .filter((s) => s.skipped !== true)
      .map((s) => s.id)
    if (slideIds.length === 0) {
      setExportError('Every slide is skipped: there is nothing to export')
      return
    }
    setExportError(null)
    setExporting(true)
    const title = deckTitle ?? 'deck'
    try {
      const blob = await exportDeckPdfInBrowser({
        deckId: id,
        doc: deckCtx.doc,
        slideIds,
        title,
        onProgress: (done, total) => showEditorNotice(`Exporting the PDF… ${done} of ${total}`),
      }).catch(async (err: unknown) => {
        if (err instanceof SlideRenderRefused) throw err
        // The server makes at most MAX_PDF_SLIDES pages in one go.
        if (slideIds.length > MAX_PDF_SLIDES)
          throw new Error(
            `this browser could not render it, and the server makes PDFs of at most ${MAX_PDF_SLIDES} slides ` +
              `(this deck has ${slideIds.length})`,
          )
        console.warn('[export] building the PDF in the browser failed; asking the server', err)
        showEditorNotice('Exporting the PDF on the server…')
        return (
          await api.exportDeckPdf(id, (done, total) =>
            showEditorNotice(
              total > 0
                ? `Exporting the PDF on the server… ${done} of ${total}`
                : 'Exporting the PDF on the server…',
            ),
          )
        ).blob
      })
      dismissEditorNotice()
      downloadBlob(blob, `${safeFilename(title)}.pdf`)
    } catch (err) {
      dismissEditorNotice()
      setExportError(
        `Could not export the PDF: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setExporting(false)
    }
  }, [api, deckTitle, id, slideDoc])
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
  const { activeSlideId } = useActiveSlide()
  const command = useCommand()
  const { selectOne } = useSelection()
  const imageFileInputRef = useRef<HTMLInputElement>(null)
  const videoFileInputRef = useRef<HTMLInputElement>(null)

  // M16 P6 — Component picker drawer
  const [pickerOpen, setPickerOpen] = useState(false)
  const folderComponents = useFolderComponents(folderId, { eager: true })
  const handleOpenPicker = useCallback(() => {
    setPickerOpen(true)
    // Re-fetch on open — promotions / deletions in another tab should land.
    void folderComponents.invalidate()
  }, [folderComponents])
  const handleClosePicker = useCallback(() => setPickerOpen(false), [])

  // Picking a component stamps it onto the active slide, on the server.
  const stampComponent = useStampComponent()

  const handlePickComponent = useCallback(
    (component: ComponentSummary) => {
      // Close the drawer at once; the server round trip runs in the background.
      setPickerOpen(false)
      void stampComponent(component.id)
    },
    [stampComponent],
  )

  // The slide the upload was started on: the object lands there even if
  // the user moved to another slide while the file uploaded.
  function handleMediaUploadDone(entry: UploadEntry) {
    if (entry.status !== 'done') return
    if (activeSlideId === null) return
    if (entry.assetId === undefined || entry.assetId === '') return
    if (entry.mimeType.startsWith('video/')) {
      const w = entry.width ?? 640
      const h = entry.height ?? 360
      command.tryRun('object.create', {
        slide: activeSlideId,
        object: {
          type: 'video',
          assetId: entry.assetId,
          width: w,
          height: h,
          x: DEFAULT_IMAGE_X - w / 2,
          y: DEFAULT_IMAGE_Y - h / 2,
          autoplay: false,
          loop: false,
          muted: true,
        },
      })
      return
    }
    const w = entry.width ?? 400
    const h = entry.height ?? 300
    command.tryRun('object.create', {
      slide: activeSlideId,
      object: {
        type: 'image',
        assetId: entry.assetId,
        width: w,
        height: h,
        x: DEFAULT_IMAGE_X - w / 2,
        y: DEFAULT_IMAGE_Y - h / 2,
      },
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
      action: 'present.start',
      description: 'Start presenting',
      handler: () => {
        navigate(`/deck/${id ?? ''}/present`)
      },
    },
    {
      keys: 'v',
      scope: 'global',
      action: 'tool.select',
      description: 'Select tool',
      handler: () => {
        setActiveTool('select')
      },
    },
    {
      keys: 'h',
      scope: 'global',
      action: 'tool.hand',
      description: 'Hand / pan tool',
      handler: () => {
        setActiveTool('hand')
      },
    },
    {
      keys: 't',
      scope: 'global',
      action: 'tool.text',
      description: 'Text tool',
      handler: () => {
        setActiveTool('text')
      },
    },
    {
      keys: 'k',
      scope: 'global',
      action: 'tool.table',
      description: 'Table tool',
      handler: () => {
        setActiveTool('table')
      },
    },
    {
      keys: 'r',
      scope: 'global',
      action: 'tool.shape',
      description: 'Rectangle tool',
      handler: () => {
        setActiveTool('rectangle')
      },
    },
    {
      keys: 'o',
      scope: 'global',
      action: 'tool.shape',
      description: 'Ellipse tool',
      handler: () => {
        setActiveTool('ellipse')
      },
    },
    {
      keys: 'l',
      scope: 'global',
      action: 'tool.shape',
      description: 'Line tool',
      handler: () => {
        setActiveTool('line')
      },
    },
    {
      keys: 'a',
      scope: 'global',
      action: 'tool.shape',
      description: 'Arrow tool',
      handler: () => {
        setActiveTool('arrow')
      },
    },
    {
      keys: 'p',
      scope: 'global',
      action: 'tool.pen',
      description: 'Pen tool',
      handler: () => {
        setActiveTool('pen')
      },
    },
    {
      keys: 'i',
      scope: 'global',
      action: 'media.insertImage',
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
        /* Which tool is armed, in one place a test can read: the shape tools
           moved behind a dropdown, so "the pressed toolbar button" no longer
           identifies the active tool from the DOM. */
        data-active-tool={activeTool}
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
            data-action="deck.backToPresentation"
            aria-label="Back to presentation"
            className="h-7 gap-1.5 rounded-full bg-blue-600 px-3 text-xs font-semibold text-white shadow-xs shadow-blue-500/30 hover:bg-blue-500"
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
                data-action="deck.backToList"
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
              data-action="history.undo"
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
              data-action="history.redo"
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
                className="min-w-0 max-w-full rounded-xs border border-border-strong bg-surface-1 px-1.5 py-0.5 text-xs font-medium text-foreground outline-none focus:ring-1 focus:ring-ring/40"
                aria-label="Deck title"
              />
            ) : (
              <button
                type="button"
                data-action="deck.rename"
                disabled={isViewer}
                onClick={() => {
                  if (isViewer) return
                  setTitleDraft(deckTitle)
                  setTitleEditing(true)
                }}
                title={isViewer ? deckTitle : 'Click to rename deck'}
                className="min-w-0 max-w-full truncate rounded-xs px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
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
                      data-action={toolAction(tool)}
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

          {/* Text tool — index 2 in TOOL_BUTTONS, simple onClick toggle. */}
          {!isViewer &&
            (() => {
              const t = TOOL_BUTTONS[2]
              if (t === undefined) return null
              const { tool, label, shortcut, icon: Icon } = t
              const isActive = activeTool === tool
              return (
                <Tooltip key={tool}>
                  <TooltipTrigger asChild>
                    <Button
                      variant={isActive ? 'default' : 'ghost'}
                      size="icon"
                      onClick={() => setActiveTool(tool)}
                      data-action={toolAction(tool)}
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
            })()}

          {/* Table tool — opens a Word-style grid picker. Hover the
              cells to size the table; clicking commits + drops the
              table on the active slide. The legacy `K` shortcut still
              activates click-to-place mode for keyboard users. */}
          {!isViewer && activeSlideId !== null && (
            <TableGridButton
              slideId={activeSlideId}
              command={command}
              setActiveTool={setActiveTool}
              selectOne={selectOne}
              activeTool={activeTool}
            />
          )}

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
                        data-action="media.insertMenu"
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
                  <DropdownMenuItem
                    action="media.insertImage"
                    onSelect={() => imageFileInputRef.current?.click()}
                  >
                    <ImageIcon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                    Image
                    <span className="ml-auto text-xs opacity-60">I</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    action="media.insertVideo"
                    onSelect={() => videoFileInputRef.current?.click()}
                  >
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
                  data-action="component.picker"
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
                data-action="view.toggleRulers"
                aria-label="Toggle rulers"
                aria-pressed={rulersVisible}
                className="h-7 w-7"
              >
                <Ruler className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle rulers</TooltipContent>
          </Tooltip>

          {/* Snapping toggle — whether drags and resizes snap to other
              objects, the deck's guides and the grid. Default on; holding
              ⌘ / Ctrl during a drag inverts it for that moment. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={snappingEnabled ? 'default' : 'ghost'}
                size="icon"
                onClick={toggleSnapping}
                data-action="view.toggleSnapping"
                aria-label="Toggle snapping"
                aria-pressed={snappingEnabled}
                className="h-7 w-7"
                data-testid="toolbar-snapping"
              >
                <Magnet className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {snappingEnabled ? 'Snapping on' : 'Snapping off'} · hold {formatKeyCombo('Mod')}{' '}
              while dragging to {snappingEnabled ? 'move freely' : 'snap'}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* M8: Connected collaborators avatar chips */}
        <AvatarChips />

        {/* Agentic A1: recent agent runs on this deck — or on this component
            master in the master editor, since agents edit masters too — +
            Revert. Editors and owners only: reverting is an edit, and the
            run list is editor-scoped on the server too. */}
        {agentRunTarget !== null && (role === 'editor' || role === 'owner') && (
          <AgentActivityButton target={agentRunTarget} />
        )}

        {/* M10: Share button — owner only */}
        {isOwner && id !== undefined && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShareOpen(true)}
                  data-action="deck.share"
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

        {/* Export: PowerPoint for owners (M28: a compatibility dialog lists
            what will not survive the round-trip, the file is fetched when
            the user confirms in it) and PDF for every reader (A5.6: built in
            this browser from the render page, the server's route when the
            browser cannot render). Failures surface as a transient toolbar
            banner. */}
        {!masterMode && id !== undefined && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={exporting}
                    data-action="deck.exportMenu"
                    aria-label="Export"
                    aria-busy={exporting}
                    className="gap-1.5"
                  >
                    {exporting ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <FileDown className="h-4 w-4" aria-hidden="true" />
                    )}
                    {/* The label stays "Export" while the file builds — the
                        spinner and the disabled state say it is busy. */}
                    <span className="hidden sm:inline">Export</span>
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Download the deck as a file</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-[10rem]">
              {isOwner && (
                <DropdownMenuItem
                  action="deck.exportPptx"
                  onSelect={() => {
                    const slides =
                      slideDoc !== null && slideDoc.deckCtx !== undefined
                        ? listSlides(slideDoc.deckCtx)
                        : []
                    setExportError(null)
                    setExportDialogSlides(slides)
                  }}
                >
                  Export to PowerPoint
                </DropdownMenuItem>
              )}
              <DropdownMenuItem action="deck.exportPdf" onSelect={() => void exportPdf()}>
                Export to PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {exportDialogSlides !== null && id !== undefined && (
          <ExportPptxDialog
            slides={exportDialogSlides}
            onClose={() => setExportDialogSlides(null)}
            onExport={async () => {
              setExporting(true)
              try {
                const res = await fetch(`${API_URL}/decks/${id}/export.pptx`, {
                  credentials: 'include',
                })
                if (!res.ok) {
                  let msg = `Export failed (HTTP ${res.status})`
                  try {
                    const body = (await res.json()) as { error?: string }
                    if (typeof body.error === 'string') msg = body.error
                  } catch {
                    /* non-JSON body */
                  }
                  setExportError(msg)
                  throw new Error(msg)
                }
                downloadBlob(await res.blob(), attachmentFilename(res, 'deck.pptx'))
                setExportDialogSlides(null)
              } finally {
                setExporting(false)
              }
            }}
          />
        )}

        {/* Preview animations — deck only; masters have no presentation. */}
        {!masterMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate(`/deck/${id ?? ''}/present?preview=1`)}
                data-action="present.preview"
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
          onPick={handlePickComponent}
          onDragStartComponent={(component, e) => {
            const payload = JSON.stringify({ componentId: component.id })
            e.dataTransfer.setData('application/x-narrative-component', payload)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          onDropComplete={() => setPickerOpen(false)}
          {...(folderId !== null
            ? {
                onOpenSettings: () => {
                  setPickerOpen(false)
                  void navigate(`/folder/${folderId}/settings?tab=components`)
                },
              }
            : {})}
        />

        {/* Present button — deck only. */}
        {!masterMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                onClick={() => navigate(`/deck/${id ?? ''}/present`)}
                data-action="present.start"
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
      {exportError !== null && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-14 right-4 z-50 max-w-sm rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground shadow-lg"
        >
          {exportError}
        </div>
      )}
    </TooltipProvider>
  )
}

/**
 * Its only prop is a boolean, so a re-render of the editor around it (every
 * pointer move of a drag commits several times) renders the toolbar's ~20
 * tooltip-wrapped buttons for nothing: memoised, it renders when its own
 * hooks (selection, tool, role, …) say so.
 */
export const Toolbar = memo(ToolbarImpl)

// ---------------------------------------------------------------------------
// Table grid picker — Word / PowerPoint / LibreImpress-style popover where
// the user hovers a 10×10 grid to size the table, then clicks to drop it
// on the active slide at its chosen dimensions.
// ---------------------------------------------------------------------------

interface TableGridButtonProps {
  /** The slide the table goes on. */
  slideId: string
  command: CommandDispatch
  setActiveTool: (tool: ActiveTool) => void
  selectOne: (id: string) => void
  activeTool: ActiveTool
}

function TableGridButton({
  slideId,
  command,
  setActiveTool,
  selectOne,
  activeTool,
}: TableGridButtonProps) {
  const [open, setOpen] = useState(false)
  const isActive = activeTool === 'table'
  const commit = (rows: number, cols: number): void => {
    // Per-cell dimensions match the registry's defaultProps fallback
    // (3×3 → 400×200 ⇒ ~133×67 per cell), rounded to a tidy 120×60.
    // The user can resize after — the picker just sets the initial
    // proportions to match the chosen grid.
    const colW = 120
    const rowH = 60
    const out = command.tryRun<{ objectId: string }>('table.insert', {
      slide: slideId,
      x: 100,
      y: 100,
      width: cols * colW,
      height: rows * rowH,
      rows,
      cols,
    })
    if (out !== null) selectOne(out.objectId)
    setOpen(false)
    // Stay on Select afterwards — the table is already placed, there's
    // nothing else for the user to do with the Table tool.
    setActiveTool('select')
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant={isActive ? 'default' : 'ghost'}
              size="icon"
              data-action="tool.table"
              aria-label="Insert table (K)"
              aria-pressed={isActive}
              className="h-7 w-7"
            >
              <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Insert table <span className="ml-2 opacity-60">K</span>
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="center" side="bottom" sideOffset={6} className="w-auto p-2">
        <TableGridPicker onCommit={commit} />
      </PopoverContent>
    </Popover>
  )
}

interface TableGridPickerProps {
  onCommit: (rows: number, cols: number) => void
}

function TableGridPicker({ onCommit }: TableGridPickerProps) {
  const MAX = 10
  // `null` = pointer hasn't entered the grid yet, show the placeholder
  // label. After first hover, `hover` tracks the selected size.
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null)
  const label = hover === null ? 'Insert table' : `${hover.col + 1} × ${hover.row + 1}`
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-center text-[11px] tabular-nums text-muted-foreground">{label}</div>
      <div
        className="grid gap-0.5"
        style={{
          gridTemplateColumns: `repeat(${MAX}, 14px)`,
          gridTemplateRows: `repeat(${MAX}, 14px)`,
        }}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: MAX * MAX }, (_, i) => {
          const row = Math.floor(i / MAX)
          const col = i % MAX
          const inside = hover !== null && row <= hover.row && col <= hover.col
          return (
            <button
              key={i}
              type="button"
              onMouseEnter={() => setHover({ row, col })}
              onClick={() => onCommit(row + 1, col + 1)}
              data-action="tool.table"
              aria-label={`${col + 1} columns by ${row + 1} rows`}
              className={[
                'h-3.5 w-3.5 rounded-[2px] border transition-colors',
                inside
                  ? 'border-primary bg-primary'
                  : 'border-input bg-background hover:border-primary/40',
              ].join(' ')}
            />
          )
        })}
      </div>
    </div>
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
            data-action="tool.shape"
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
                  data-action={toolAction(tool)}
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
