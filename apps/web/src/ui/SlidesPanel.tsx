/**
 * ui/SlidesPanel.tsx
 *
 * Left sidebar slide panel (Keynote-style outline).
 *
 * - Each slide carries an `indent` level (0 = top). Parent = nearest
 *   preceding slide with smaller indent.
 * - Parents may be `collapsed`; descendants smoothly collapse to
 *   height 0 in the panel. Present mode ignores collapse.
 * - Drag reorders (vertical) AND re-indents (horizontal) in one gesture.
 *   Dragging a parent drags all its descendants as one block.
 * - Shift-click extends selection; plain click replaces it. Dragging
 *   any selected slide drags the whole selection (with descendants).
 * - Dropping a `.pptx` from the desktop imports it INTO this deck at the
 *   gap the pointer is over (see `usePptxDropIntoDeck`). That is a
 *   different gesture from the reorder drag above — files arrive as HTML5
 *   drag events, slides move by pointer events — so the two share only the
 *   drop indicator they draw.
 */

import { dismissEditorNotice, showEditorNotice } from '../state/editorNotice.js'
import { downloadBlob, safeFilename } from '../lib/download.js'
import {
  Fragment,
  memo,
  useRef,
  useState,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import { useStableHandler } from './useStableHandler.js'
import { useSlidesSelector } from '../state/useSlides.js'
import { sameArray } from '../state/useDeckStore.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import {
  closeBrowserSlideExport,
  exportSlidePngInBrowser,
  SlideRenderRefused,
} from '../state/browserSlideExport.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSelection } from '../state/SelectionContext.js'
import { useSlideThumbnailStore, useThumbnailUrl } from '../state/useSlideThumbnails.js'
import type { ThumbnailStore } from '../renderer/thumbnailStore.js'
import { thumbnailDataUrl } from '../renderer/thumbnailImages.js'
import { useVisibleSlideRows, type RowVisibility } from './useVisibleSlideRows.js'
import { setDeckThumbnail } from '../state/deckThumbnailCache.js'
import { ApiError, useApi } from '../api/client.js'
import { useParams } from 'react-router-dom'
import { useShortcuts } from '../state/useShortcuts.js'
import { MAX_SLIDE_INDENT, maxLevelBelow } from '@narrative/commands'
import { useCommand } from '../state/useCommand.js'
import { SlidesPanelContextMenu } from './SlidesPanelContextMenu.js'
import {
  setSlideClipboard,
  hasSlideClipboard,
  readSlideClipboard,
} from '../state/slideClipboard.js'
import type { Slide } from '@narrative/shared'
import { SlideItemMenu } from './SlideItemMenu.js'
import { usePptxDropIntoDeck } from './usePptxDropIntoDeck.js'
import { PptxImportRow } from './PptxImportRow.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { useFolderTokensSettled } from '../state/FolderDocProvider.js'
import { Plus, EyeOff, ChevronRight, PanelLeftClose } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLACEHOLDER_COLOURS = ['#1e293b', '#1c2b3a', '#1e1e2e', '#1a1a2e', '#16213e', '#0f3460']

function placeholderColour(index: number): string {
  return PLACEHOLDER_COLOURS[index % PLACEHOLDER_COLOURS.length] ?? '#1e293b'
}

const INDENT_STEP_PX = 24
const INDENT_VISUAL_PX = 16

// PERF-1: stable no-op so the memoised SlideItem's `onPointerDown` prop keeps
// the same identity across renders in read-only (viewer) mode. An inline
// `() => {}` at the call site would allocate a fresh function every render and
// defeat React.memo for every row.
const NOOP_POINTER_DOWN = (): void => {}
const COLLAPSE_MS = 180
/** Pointer travel (px) past which a gesture counts as a drag, not a click. */
const DRAG_CLICK_THRESHOLD_PX = 4

// ---------------------------------------------------------------------------
// Outline helpers
// ---------------------------------------------------------------------------

/**
 * What the panel shows of a slide. Selected from the deck store as such, so
 * an edit inside a slide — every pointer move of a drag, every keystroke —
 * re-renders neither the panel nor its rows (the thumbnail is the
 * thumbnail hook's: it watches the objects itself).
 */
type PanelSlide = Pick<Slide, 'id' | 'name' | 'skipped' | 'indent' | 'collapsed'>

function samePanelSlide(a: PanelSlide, b: Slide | PanelSlide): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.skipped === b.skipped &&
    a.indent === b.indent &&
    a.collapsed === b.collapsed
  )
}

function slideIndent(s: PanelSlide): number {
  return s.indent ?? 0
}

/**
 * Returns the ids of the slide at `fromIndex` plus every following slide
 * that belongs to its outline subtree (consecutive slides with a deeper
 * indent).
 */
function subtreeIds(slides: PanelSlide[], fromIndex: number): string[] {
  const root = slides[fromIndex]
  if (root === undefined) return []
  const out: string[] = [root.id]
  const rootIndent = slideIndent(root)
  for (let i = fromIndex + 1; i < slides.length; i++) {
    const s = slides[i]
    if (s === undefined) break
    if (slideIndent(s) <= rootIndent) break
    out.push(s.id)
  }
  return out
}

/** What to tell the user when the server refuses a cross-deck paste. */
function pasteFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'You can only view the deck these slides come from, so they cannot be copied out of it.'
    }
    if (err.status === 404) return 'The copied slides, or the deck they come from, no longer exist.'
    return err.message
  }
  return 'The slides could not be pasted. Check your connection and try again.'
}

/**
 * Which selection gesture a click carries. Plain click replaces the
 * selection, shift extends it to a contiguous range from the anchor, and
 * cmd/ctrl toggles the one slide — the convention every file manager and
 * both presentation apps share, so it is what the hand already expects.
 */
interface ActivateModifiers {
  shift?: boolean
  toggle?: boolean
}

// ---------------------------------------------------------------------------
// Drag state
// ---------------------------------------------------------------------------

interface DragState {
  /** Ids being dragged, in array order. */
  slideIds: string[]
  /** Array index of the first dragged slide. */
  fromIndex: number
  fromIndent: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  /** Target insertion index (in pre-move array). */
  insertAt: number
  /** Final indent of the FIRST dragged slide after clamp. */
  indent: number
}

// ---------------------------------------------------------------------------
// SlideThumbnail
// ---------------------------------------------------------------------------

interface SlideThumbnailProps {
  slideId: string
  index: number
  thumbnails: ThumbnailStore
  visibility: RowVisibility
}

/**
 * A row's picture, or its placeholder colour while it has none — and while
 * the row is off screen (performance.md → B3): there it mounts no `<img>` and
 * does not re-render when its picture lands. The picture is drawn at idle
 * all the same, so it is there when the row scrolls near. Its own component,
 * so a picture landing or a row scrolling in renders this and not the row
 * (a smooth scroll through a 300-slide panel commits a few of these a frame).
 */
function SlideThumbnailImpl({ slideId, index, thumbnails, visibility }: SlideThumbnailProps) {
  const nearView = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => visibility.subscribe(slideId, onChange),
      [visibility, slideId],
    ),
    () => visibility.has(slideId),
  )
  const url = useThumbnailUrl(thumbnails, nearView ? slideId : undefined)
  return url !== undefined ? (
    <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
  ) : (
    <div className="h-full w-full" style={{ backgroundColor: placeholderColour(index) }} />
  )
}

const SlideThumbnail = memo(SlideThumbnailImpl)

// ---------------------------------------------------------------------------
// SlideItem
// ---------------------------------------------------------------------------

interface SlideItemProps {
  slide: PanelSlide
  index: number
  indent: number
  hasChildren: boolean
  collapsed: boolean
  hidden: boolean
  isActive: boolean
  isActiveDescendant: boolean
  isSelected: boolean
  isDragging: boolean
  dropIndicatorAbove: boolean
  dropIndicatorBelow: boolean
  /** The panel's thumbnails: the row's picture reads its own (SlideThumbnail). */
  thumbnails: ThumbnailStore
  /** Which rows are near the view: a row off screen shows no picture (B3). */
  visibility: RowVisibility
  readOnly?: boolean
  onActivate: (id: string, mods?: ActivateModifiers) => void
  onToggleCollapsed: (id: string) => void
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, id: string, index: number) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onTransition: (id: string) => void
  onRename: (id: string, name: string) => void
  onToggleSkip: (id: string) => void
  onExportPng: (id: string) => void
  /** When set to this slide's id, it enters edit mode on next render.
   *  Used by the panel-level context menu's "Rename" action so it can
   *  reach into the row from outside. The row clears the request via
   *  onConsumeEditRequest after entering edit mode. */
  editRequestId: string | null
  onConsumeEditRequest: () => void
}

function SlideItemImpl({
  slide,
  index,
  indent,
  hasChildren,
  collapsed,
  hidden,
  isActive,
  isActiveDescendant,
  isSelected,
  isDragging,
  dropIndicatorAbove,
  dropIndicatorBelow,
  thumbnails,
  visibility,
  readOnly = false,
  onActivate,
  onToggleCollapsed,
  onPointerDown,
  onDuplicate,
  onDelete,
  onTransition,
  onRename,
  onToggleSkip,
  onExportPng,
  editRequestId,
  onConsumeEditRequest,
}: SlideItemProps) {
  const labelId = `slide-item-label-${slide.id}`
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(slide.name ?? '')
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) return
    setDraftName(slide.name ?? '')
  }, [slide.name, editing])

  useEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (el === null) return
    el.focus()
    el.select()
  }, [editing])

  // Panel-level context menu requested rename of this row.
  useEffect(() => {
    if (editRequestId === slide.id && !editing) {
      setEditing(true)
      onConsumeEditRequest()
    }
  }, [editRequestId, slide.id, editing, onConsumeEditRequest])

  const commit = useCallback(() => {
    onRename(slide.id, draftName)
    setEditing(false)
  }, [draftName, slide.id, onRename])

  const displayName = slide.name ?? `Slide ${index + 1}`

  // Animated show/hide: we render a wrapper that uses grid-template-rows
  // 0fr ↔ 1fr to smoothly collapse a row to zero without measuring.
  //
  // Ring priority (strongest → weakest):
  //   1. isActive            — bold blue ring, the slide shown in the editor.
  //   2. isSelected          — multi-select ring (lighter, dashed feel).
  //   3. isActiveDescendant  — faint tint so a parent selection visually
  //                            claims its subtree without stealing the eye
  //                            from the real active slide.
  //
  // The ring can't live on the card element itself — the <img> child with
  // object-cover sits on top of the inset box-shadow, and the outer
  // `overflow-hidden` wrapper (required by the grid-rows collapse animation)
  // clips any outside ring. Instead we render a dedicated absolute overlay
  // sibling on top of the thumbnail so the outline is painted above the img.
  let overlayBorder: string | null
  if (isActive) {
    overlayBorder = 'border-2 border-blue-500'
  } else if (isSelected) {
    overlayBorder = 'border-2 border-blue-400/80'
  } else if (isActiveDescendant) {
    overlayBorder = 'border-2 border-blue-400/50'
  } else {
    overlayBorder = null
  }

  return (
    <>
      <div
        role="option"
        aria-selected={isActive}
        aria-labelledby={labelId}
        data-slide-id={slide.id}
        data-slide-index={index}
        aria-hidden={hidden || undefined}
        className="group relative"
        style={{
          display: 'grid',
          gridTemplateRows: hidden ? '0fr' : '1fr',
          transition: `grid-template-rows ${COLLAPSE_MS}ms ease, opacity ${COLLAPSE_MS}ms ease`,
          opacity: hidden ? 0 : 1,
          pointerEvents: hidden ? 'none' : 'auto',
          // Lift this row above siblings while its three-dot menu is
          // open so the dropdown isn't covered by the following slide.
          zIndex: menuOpen ? 40 : undefined,
        }}
      >
        {/* Drop indicators live on the OUTER wrapper so they escape the
          inner overflow:hidden (which is required for the grid-rows
          collapse animation). */}
        {dropIndicatorAbove && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-1 left-2 right-2 z-10 h-0.5 rounded-full bg-blue-400"
          />
        )}
        {dropIndicatorBelow && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-1 left-2 right-2 z-10 h-0.5 rounded-full bg-blue-400"
          />
        )}
        <div
          style={{
            overflow: 'hidden',
            paddingLeft: indent * INDENT_VISUAL_PX,
          }}
          className={['relative flex-shrink-0', isDragging ? 'opacity-40' : ''].join(' ')}
        >
          {/* Skipped slides keep full width and just clip the bottom of
            the thumbnail — the outer wrapper transitions max-height,
            the inner card keeps its 16:9 aspectRatio so width never
            collapses with the animation. */}
          <div
            className="mx-2 overflow-hidden rounded transition-[max-height,opacity] duration-200 ease"
            style={{
              maxHeight: slide.skipped === true ? 36 : 1000,
              opacity: slide.skipped === true ? 0.65 : 1,
            }}
          >
            <div
              className={[
                'relative cursor-pointer rounded ring-1 ring-inset ring-gray-700 hover:ring-gray-500',
              ].join(' ')}
              style={{ aspectRatio: '16/9', width: '100%' }}
              onPointerDown={(e) => onPointerDown(e, slide.id, index)}
              onClick={(e) =>
                onActivate(slide.id, {
                  shift: e.shiftKey,
                  // Cmd on macOS, Ctrl elsewhere — the same key that toggles
                  // one item in Finder, Explorer, Keynote and PowerPoint.
                  toggle: e.metaKey || e.ctrlKey,
                })
              }
              aria-hidden="true"
            >
              <SlideThumbnail
                slideId={slide.id}
                index={index}
                thumbnails={thumbnails}
                visibility={visibility}
              />

              <span
                id={labelId}
                className="absolute bottom-1 left-1.5 rounded bg-black/50 px-1 text-[10px] font-medium text-white/80 select-none"
              >
                {index + 1}
              </span>

              {slide.skipped === true && (
                <span
                  aria-label="Skipped in present mode"
                  className="absolute right-1 bottom-1 rounded bg-black/55 p-0.5 text-white/80"
                >
                  <EyeOff className="h-3 w-3" aria-hidden="true" />
                </span>
              )}

              {/* Selection / active-descendant outline — rendered as a sibling
                on top of the thumbnail so the <img> can't occlude it. */}
              {overlayBorder !== null && (
                <div
                  aria-hidden="true"
                  className={['pointer-events-none absolute inset-0 rounded', overlayBorder].join(
                    ' ',
                  )}
                />
              )}
            </div>
          </div>

          {/* Name row — chevron + label, inline */}
          <div className="mx-2 mt-1 flex items-center gap-0.5 text-[11px] text-muted-foreground">
            {hasChildren ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleCollapsed(slide.id)
                }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label={collapsed ? 'Expand children' : 'Collapse children'}
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  className={'h-3 w-3 transition-transform ' + (collapsed ? '' : 'rotate-90')}
                  aria-hidden="true"
                />
              </button>
            ) : (
              <span className="inline-block h-4 w-4 flex-shrink-0" aria-hidden="true" />
            )}

            {editing ? (
              <input
                ref={inputRef}
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commit()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setDraftName(slide.name ?? '')
                    setEditing(false)
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                placeholder={`Slide ${index + 1}`}
                className="flex-1 rounded border border-border bg-surface-1 px-1 py-0.5 text-[11px] text-foreground outline-none focus:border-border-strong"
              />
            ) : (
              <button
                type="button"
                onDoubleClick={() => {
                  if (readOnly) return
                  setEditing(true)
                }}
                onKeyDown={(e) => {
                  if (!readOnly && e.key === 'F2') {
                    e.preventDefault()
                    setEditing(true)
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className="block flex-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-surface-2/60"
                title={displayName}
              >
                {displayName}
              </button>
            )}
          </div>
        </div>

        {/* Three-dot menu — placed OUTSIDE the inner overflow:hidden
          wrapper so its dropdown isn't clipped by the collapse-animation
          container. Sits absolute against the outer row instead. */}
        {!readOnly && (
          <div className="absolute right-3 top-1">
            <SlideItemMenu
              slideId={slide.id}
              skipped={slide.skipped === true}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              onTransition={onTransition}
              onRename={() => setEditing(true)}
              onToggleSkip={onToggleSkip}
              onExportPng={onExportPng}
              onOpenChange={setMenuOpen}
            />
          </div>
        )}
      </div>
    </>
  )
}

/**
 * PERF-1: memoised so a render of the parent SlidesPanel doesn't re-render
 * every row in the `.map`. With React.memo the row only re-renders when one
 * of its own props changes by shallow comparison — all handler props are
 * `useCallback`-stable and the remaining props are primitives.
 *
 * The `slide` prop is the panel's view of the slide (`PanelSlide`), which
 * keeps its identity until the slide's name, skipped, indent or collapsed
 * flag changes — so an edit inside a slide renders no row.
 */
const SlideItem = memo(SlideItemImpl)

// ---------------------------------------------------------------------------
// SlidesPanel
// ---------------------------------------------------------------------------

interface SlidesPanelProps {
  /** P15: triggered by the collapse button in the header. Optional —
   *  callers that don't manage collapse state can omit it. */
  onCollapse?: () => void
}

export function SlidesPanel({ onCollapse }: SlidesPanelProps = {}): ReactElement {
  // One view object per slide, kept while its fields are the same: the row
  // memo below compares it by identity.
  const viewCache = useRef(new Map<string, PanelSlide>())
  const slides = useSlidesSelector((all) => {
    const cache = viewCache.current
    const next = new Map<string, PanelSlide>()
    const views = all.map((s) => {
      const prev = cache.get(s.id)
      if (prev !== undefined && samePanelSlide(prev, s)) {
        next.set(s.id, prev)
        return prev
      }
      const view: PanelSlide = {
        id: s.id,
        ...(s.name !== undefined ? { name: s.name } : {}),
        ...(s.skipped !== undefined ? { skipped: s.skipped } : {}),
        ...(s.indent !== undefined ? { indent: s.indent } : {}),
        ...(s.collapsed !== undefined ? { collapsed: s.collapsed } : {}),
      }
      next.set(s.id, view)
      return view
    })
    viewCache.current = next
    return views
  }, sameArray)
  const { activeSlideId, setActiveSlideId } = useActiveSlide()
  const command = useCommand()
  const { clear: clearSelection } = useSelection()
  const listRef = useRef<HTMLUListElement>(null)
  const headerId = useId()
  const { role, folderId, isLoading: roleLoading } = useDeckRole()
  const isViewer = role === 'viewer'
  // A preview painted before the folder's tokens arrived shows token colours
  // black: upload only once they are final — the folder document synced or
  // refused, or the deck has no folder.
  const folderTokensSettled = useFolderTokensSettled()
  const tokensFinal = !roleLoading && (folderId === null || folderTokensSettled)

  const allSlideIds = slides.map((s) => s.id)
  const thumbnails = useSlideThumbnailStore(allSlideIds, { liveActiveSlide: true })
  // The rows on screen are drawn first, the rest of the deck at idle.
  const rowVisibility = useVisibleSlideRows(listRef, thumbnails, allSlideIds.join('|'))

  // P13: persist the first-slide thumbnail to localStorage so the home
  // page can show a deck preview without re-opening every deck. The
  // deckId comes from the route — `/deck/:id` mounts this panel.
  const { id: deckId } = useParams<{ id: string }>()
  const { deckCtx } = useSlideDoc()
  const firstSlideId = allSlideIds[0]
  // An object URL (renderer/thumbnailImages.ts): the same one for the same picture.
  const firstSlideThumb = useThumbnailUrl(thumbnails, firstSlideId)
  const api = useApi()
  // Trailing-edge debounce of the server-side upload:
  //   - Each new firstSlideThumb stashes itself into pendingRef.
  //   - A single setTimeout (kept in a ref so it survives React effect
  //     cleanups, which would otherwise kill the timer mid-flight) reads
  //     pendingRef when it fires and PUTs whatever is the latest thumbnail.
  // Net effect: rapid edits coalesce into one upload ~1.5 s after typing
  // stops, AND the latest content is always what gets uploaded — fixes
  // the "second visit needed" symptom from the leading-edge variant.
  const lastUploadedRef = useRef<string | null>(null)
  const pendingRef = useRef<{ deckId: string; thumb: string } | null>(null)
  const flushTimerRef = useRef<number | null>(null)
  const apiRef = useRef(api)
  apiRef.current = api
  const isViewerRef = useRef(isViewer)
  isViewerRef.current = isViewer
  useEffect(() => {
    if (deckId !== undefined && deckId !== '' && firstSlideThumb !== undefined) {
      // Kept across reloads: as a data URL (an object URL dies with the page).
      thumbnailDataUrl(firstSlideThumb)
        .then((dataUrl) => setDeckThumbnail(deckId, dataUrl))
        .catch(() => {
          /* Replaced (and revoked) before it was read: the next one is stored. */
        })
    }
    if (
      deckId === undefined ||
      deckId === '' ||
      firstSlideThumb === undefined ||
      !tokensFinal ||
      isViewerRef.current ||
      lastUploadedRef.current === firstSlideThumb
    ) {
      return
    }
    pendingRef.current = { deckId, thumb: firstSlideThumb }
    if (flushTimerRef.current !== null) return
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      const p = pendingRef.current
      if (p === null) return
      if (lastUploadedRef.current === p.thumb) return
      lastUploadedRef.current = p.thumb
      pendingRef.current = null
      thumbnailDataUrl(p.thumb)
        .then((dataUrl) => apiRef.current.uploadDeckThumbnail(p.deckId, dataUrl))
        .catch((err: unknown) => {
          // Non-fatal — drop the marker so a future render can retry.
          lastUploadedRef.current = null
          console.warn('[deck-thumb] PUT failed', err)
        })
    }, 1500)
  }, [deckId, firstSlideThumb, tokensFinal])

  const [dragState, setDragState] = useState<DragState | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  // Set true once a pointer gesture moves past DRAG_CLICK_THRESHOLD_PX so the
  // trailing synthetic `click` (which fires on the captured origin row) can be
  // suppressed — otherwise reordering a multi-selection collapses it to one.
  const didDragRef = useRef(false)

  // Panel-level multi-select (separate from the canvas SelectionContext).
  // Always contains activeSlideId when not empty.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
    activeSlideId !== null ? new Set([activeSlideId]) : new Set(),
  )
  /**
   * The slide a shift-click measures its range from: wherever the current
   * selection gesture started. A plain or cmd click moves it; a shift-click
   * deliberately does not, so dragging the far end of a range up and down
   * resizes that one range rather than ratcheting a new one each time.
   */
  const anchorIdRef = useRef<string | null>(activeSlideId)

  // Keep selection in sync when the active slide changes externally
  // (e.g. keyboard nav, Enter, remote peer).
  useEffect(() => {
    if (activeSlideId === null) return
    setSelectedIds((prev) => {
      if (prev.has(activeSlideId) && prev.size === 1) return prev
      return new Set([activeSlideId])
    })
    // The active slide moved, so the next shift-click measures from here —
    // otherwise it would span back to wherever the last gesture started.
    anchorIdRef.current = activeSlideId
  }, [activeSlideId])

  // Prune stale ids when the slide list shrinks.
  useEffect(() => {
    setSelectedIds((prev) => {
      const live = new Set(slides.map((s) => s.id))
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [slides])

  // ---------------------------------------------------------------------------
  // Activation / selection
  // ---------------------------------------------------------------------------

  const handleActivate = useCallback(
    (id: string, mods: ActivateModifiers = {}) => {
      // Suppress the click that trails a drag gesture — without this, a
      // reorder drag of a multi-selection ends with a plain click that
      // collapses the selection to the single dragged slide.
      if (didDragRef.current) {
        didDragRef.current = false
        return
      }

      // Shift extends to a contiguous range from the anchor — the first
      // slide of the current selection gesture. Shift used to toggle the one
      // clicked slide, which meant "click the first, shift-click the last"
      // selected exactly those two and nothing between them.
      if (mods.shift === true) {
        const anchor = anchorIdRef.current ?? activeSlideId ?? id
        const from = slides.findIndex((s) => s.id === anchor)
        const to = slides.findIndex((s) => s.id === id)
        if (from === -1 || to === -1) {
          setSelectedIds(new Set([id]))
          anchorIdRef.current = id
          return
        }
        const lo = Math.min(from, to)
        const hi = Math.max(from, to)
        // Everything in the index range, including rows hidden under a
        // collapsed parent: they are part of the run being selected, and
        // leaving them out would delete a parent and orphan its children.
        setSelectedIds(new Set(slides.slice(lo, hi + 1).map((s) => s.id)))
        // The anchor stays put, so dragging the shift-click up and down
        // grows and shrinks one range instead of ratcheting.
        return
      }

      // Cmd/Ctrl toggles the one slide, and moves the anchor to it. Removing
      // the last selected slide is not allowed to empty the panel selection.
      if (mods.toggle === true) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) {
            if (next.size > 1) next.delete(id)
          } else {
            next.add(id)
          }
          return next
        })
        anchorIdRef.current = id
        return
      }

      setSelectedIds(new Set([id]))
      anchorIdRef.current = id
      setActiveSlideId(id)
      clearSelection()
    },
    [slides, activeSlideId, setActiveSlideId, clearSelection],
  )

  const handleAdd = useCallback(() => {
    const { slideId } = command.run<{ slideId: string }>('slide.add', {})
    setActiveSlideId(slideId)
    setSelectedIds(new Set([slideId]))
    clearSelection()
  }, [command, setActiveSlideId, clearSelection])

  /**
   * The slides an action aimed at `slideId` should apply to: the whole
   * panel selection when the target is part of it, otherwise just the
   * target — the rule `handleCopy` already used, now shared, because a
   * Delete that took only the right-clicked slide made a multi-selection
   * look broken the moment you tried to use one.
   *
   * Returned in slide-list order, which is what every caller wants.
   */
  const actionTargets = useCallback(
    (slideId: string): string[] => {
      if (!selectedIds.has(slideId) || selectedIds.size <= 1) return [slideId]
      return slides.filter((s) => selectedIds.has(s.id)).map((s) => s.id)
    },
    [slides, selectedIds],
  )

  const handleDuplicate = useCallback(
    (slideId: string) => {
      const targets = actionTargets(slideId)
      // Each copy lands right after its original, all as one undo step.
      const copies = command.group((run) =>
        targets.map((id) => run<{ slideId: string }>('slide.duplicate', { slide: id }).slideId),
      )
      const lastNewId = copies?.at(-1)
      if (lastNewId !== undefined) {
        setActiveSlideId(lastNewId)
        clearSelection()
      }
    },
    [command, actionTargets, setActiveSlideId, clearSelection],
  )

  const handleDelete = useCallback(
    (slideId: string) => {
      const targets = actionTargets(slideId)
      // slide.delete names where to land: the nearest survivor above the
      // block, or the first one below it when the block starts at the top
      // (deleting every slide leaves one fresh empty slide behind).
      const out = command.tryRun<{ landOn: string }>('slide.delete', { slides: targets })
      if (out === null) return
      const nextActiveId =
        activeSlideId === null || targets.includes(activeSlideId) ? out.landOn : activeSlideId

      // Keep the panel's invariant: when the selection is not empty it holds
      // the active slide. Leaving the deleted ids in it would ring rows that
      // no longer exist until the prune effect caught up.
      if (nextActiveId !== null) {
        setActiveSlideId(nextActiveId)
        setSelectedIds(new Set([nextActiveId]))
        anchorIdRef.current = nextActiveId
      } else {
        setSelectedIds(new Set())
        anchorIdRef.current = null
      }
      clearSelection()
    },
    [command, activeSlideId, actionTargets, setActiveSlideId, clearSelection],
  )

  /** Panel-level rename request — set by the context menu's Rename
   *  action; the matching SlideItem consumes it on next render and
   *  clears it via onConsumeEditRequest. */
  const [editRequestId, setEditRequestId] = useState<string | null>(null)
  const consumeEditRequest = useCallback(() => setEditRequestId(null), [])

  // ---------------------------------------------------------------------------
  // Slides arriving from the server — a .pptx dropped from the desktop, or
  // slides pasted from another deck — land at the gap they were aimed at
  // ---------------------------------------------------------------------------

  /**
   * The imported slides arrive over Yjs, so the panel learns about them the
   * same way it learns about a peer's edit: the array grows. All the import
   * itself can tell us is the index they landed at, which is what selects
   * them — but only once the array has actually caught up, hence the ref and
   * the effect rather than a `setActiveSlideId` in the completion callback.
   */
  const pendingImportFocusRef = useRef<number | null>(null)
  const handleImported = useCallback((insertedAt: number) => {
    pendingImportFocusRef.current = insertedAt
  }, [])

  const pptxDrop = usePptxDropIntoDeck({
    deckId,
    listRef,
    slideCount: slides.length,
    disabled: isViewer,
    onImported: handleImported,
  })

  useEffect(() => {
    const target = pendingImportFocusRef.current
    if (target === null) return
    const slide = slides[target]
    if (slide === undefined) return
    pendingImportFocusRef.current = null
    setActiveSlideId(slide.id)
    setSelectedIds(new Set([slide.id]))
  }, [slides, setActiveSlideId])

  // P11: cross-deck slide clipboard. canPaste is reactive — bumps a tick
  // whenever copy or paste runs so the menu's disabled state updates
  // without a global storage event listener.
  const [clipboardTick, setClipboardTick] = useState(0)
  const canPaste = clipboardTick >= 0 && hasSlideClipboard()
  const _trackClipboard = clipboardTick // keep dep referenced

  const handleCopy = useCallback(
    (slideId: string) => {
      if (deckId === undefined || deckId === '') return
      // actionTargets answers in deck order already.
      setSlideClipboard(deckId, actionTargets(slideId))
      setClipboardTick((t) => t + 1)
    },
    [deckId, actionTargets],
  )

  // Rendered on the server from the live deck (the render worker): a few
  // seconds, so say so first.
  // "Export as PNG": rendered in this browser (state/browserSlideExport.ts) —
  // exactly what the editor shows, edits of a moment ago included. If that
  // cannot work here (no WebGL, the hidden frame failed), the render worker
  // does it instead; a slide the page refuses (gone, no access) is not
  // retried.
  const handleExportPng = useCallback(
    (slideId: string) => {
      if (deckId === undefined || deckId === '') return
      const index = slides.findIndex((s) => s.id === slideId)
      showEditorNotice('Exporting the slide as PNG…')
      const title = api.getDeck(deckId).then(
        (deck) => deck.title,
        () => 'slide',
      )
      exportSlidePngInBrowser({ deckId, slideId, doc: deckCtx.doc })
        .catch(async (err: unknown) => {
          if (err instanceof SlideRenderRefused) throw err
          console.warn('[export] rendering in the browser failed; asking the server', err)
          return (await api.exportSlidePng(deckId, slideId)).blob
        })
        .then(
          async (blob) => {
            dismissEditorNotice()
            downloadBlob(blob, `${safeFilename(await title)} - slide ${index + 1}.png`)
          },
          (err: unknown) =>
            showEditorNotice(
              `Could not export the slide: ${err instanceof Error ? err.message : String(err)}`,
            ),
        )
    },
    [api, deckId, deckCtx, slides],
  )
  // The hidden export frame belongs to this deck.
  useEffect(() => closeBrowserSlideExport, [deckId])

  const { enqueueInsert, reportError } = pptxDrop
  const handlePaste = useCallback(
    (afterSlideId: string | null) => {
      const clip = readSlideClipboard()
      if (clip === null || deckId === undefined || deckId === '') return
      // afterSlideId === null → paste at end (used by panel-empty-area menu).
      const afterIdx = afterSlideId === null ? -1 : slides.findIndex((s) => s.id === afterSlideId)
      const insertAt = afterIdx === -1 ? slides.length : afterIdx + 1
      const count = clip.slideIds.length
      const label = count === 1 ? '1 slide' : `${count} slides`

      if (clip.deckId === deckId) {
        const present = new Set(slides.map((s) => s.id))
        const still = clip.slideIds.filter((id) => present.has(id))
        if (still.length === 0) {
          reportError({
            label,
            at: insertAt,
            error: 'The copied slides have been deleted since they were copied.',
          })
          return
        }
        const out = command.tryRun<{ slideIds: string[] }>('slide.copyTo', {
          slides: still,
          index: insertAt,
        })
        const first = out?.slideIds[0]
        if (out !== null && first !== undefined) {
          setActiveSlideId(first)
          setSelectedIds(new Set(out.slideIds))
        }
        return
      }

      // From another deck: the server copies the slides and their media.
      enqueueInsert({
        label: `${label} from another deck`,
        at: insertAt,
        run: async (at) => {
          try {
            const out = await apiRef.current.insertSlidesFromDeck(deckId, {
              sourceDeckId: clip.deckId,
              slideIds: clip.slideIds,
              at,
            })
            return { insertedAt: out.insertedAt, count: out.slideIds.length }
          } catch (err) {
            throw new Error(pasteFailureMessage(err))
          }
        },
      })
    },
    [deckId, slides, command, enqueueInsert, reportError, setActiveSlideId],
  )

  const handleTransition = useCallback(
    (slideId: string) => {
      handleActivate(slideId)
    },
    [handleActivate],
  )

  const handleRename = useCallback(
    (slideId: string, name: string) => {
      command.tryRun('slide.rename', { slide: slideId, name })
    },
    [command],
  )

  const handleToggleSkip = useCallback(
    (slideId: string) => {
      const s = slides.find((x) => x.id === slideId)
      if (s === undefined) return
      command.tryRun('slide.skip', { slide: slideId, skipped: s.skipped !== true })
    },
    [command, slides],
  )

  const handleToggleCollapsed = useCallback(
    (slideId: string) => {
      const s = slides.find((x) => x.id === slideId)
      if (s === undefined) return
      command.tryRun('slide.collapse', { slide: slideId, collapsed: s.collapsed !== true })
    },
    [command, slides],
  )

  // ---------------------------------------------------------------------------
  // Derived outline state
  // ---------------------------------------------------------------------------

  const outline = useMemo(() => {
    const hasChildrenMap = new Map<string, boolean>()
    const hiddenIds = new Set<string>()
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i]
      if (s === undefined) continue
      const next = slides[i + 1]
      hasChildrenMap.set(s.id, next !== undefined && slideIndent(next) > slideIndent(s))
    }
    let suppressingIndent: number | null = null
    for (const s of slides) {
      const i = slideIndent(s)
      if (suppressingIndent !== null && i > suppressingIndent) {
        hiddenIds.add(s.id)
      } else {
        suppressingIndent = null
      }
      if (s.collapsed === true && suppressingIndent === null) {
        suppressingIndent = i
      }
    }
    return { hasChildrenMap, hiddenIds }
  }, [slides])

  // Descendants of the active slide — used to tint the thumbnails of the
  // active subtree so a parent selection visually claims its children.
  const activeDescendants = useMemo(() => {
    if (activeSlideId === null) return new Set<string>()
    const idx = slides.findIndex((s) => s.id === activeSlideId)
    if (idx < 0) return new Set<string>()
    const ids = subtreeIds(slides, idx)
    return new Set<string>(ids.slice(1))
  }, [slides, activeSlideId])

  // ---------------------------------------------------------------------------
  // Drag math
  // ---------------------------------------------------------------------------

  /**
   * The insertion point under the pointer, from the rows as they are on
   * screen now: before the first row whose middle is below the pointer, the
   * rows being dragged left out (they are lifted out of the list). Reading
   * the rows' own positions keeps the drop under the pointer whatever moved
   * the list since the press — the wheel or a trackpad scrolling it, the
   * gaps between thumbnails, collapsed rows of zero height. (It used to be
   * the pointer's travel divided by a row height, which lagged behind as
   * soon as the panel scrolled.)
   */
  const insertionUnderPointer = useCallback(
    (clientY: number, dragged: ReadonlySet<string>): number => {
      const list = listRef.current
      if (list === null) return slides.length
      const index = new Map(slides.map((s, i) => [s.id, i]))
      for (const row of list.querySelectorAll<HTMLElement>('[data-slide-id]')) {
        const id = row.dataset['slideId']
        if (id === undefined || dragged.has(id)) continue
        const box = row.getBoundingClientRect()
        if (box.height < 1) continue // collapsed under its parent
        if (clientY < box.top + box.height / 2) return index.get(id) ?? slides.length
      }
      return slides.length
    },
    [slides],
  )

  /**
   * Clamps a proposed indent against the post-move previous slide. An
   * ancestor of the moving block cannot jump more than one level deeper
   * than the slide immediately preceding its insertion point.
   */
  const clampIndent = useCallback(
    (proposed: number, insertAt: number, movingIds: string[]): number => {
      // The slide the block will sit under once it is lifted out: the last
      // slide before `insertAt` (a position in the deck BEFORE the move)
      // that is not itself being moved. slide.move applies the same rule.
      const movingSet = new Set(movingIds)
      let prev: PanelSlide | undefined
      for (let i = Math.min(insertAt, slides.length) - 1; i >= 0; i--) {
        const s = slides[i]
        if (s !== undefined && !movingSet.has(s.id)) {
          prev = s
          break
        }
      }
      const maxAllowed = maxLevelBelow(prev === undefined ? undefined : slideIndent(prev))
      return Math.max(0, Math.min(MAX_SLIDE_INDENT, proposed, maxAllowed))
    },
    [slides],
  )

  const computeDragOutcome = useCallback(
    (ds: DragState): { insertAt: number; indent: number } => {
      const ownIds = new Set(ds.slideIds)
      const deltaX = ds.currentX - ds.startX
      let insertAt = insertionUnderPointer(ds.currentY, ownIds)
      // Between the dragged slides themselves (the block's own place) is
      // where it already is: no move.
      const lo = Math.min(insertAt, ds.fromIndex)
      const hi = Math.max(insertAt, ds.fromIndex)
      if (slides.slice(lo, hi).every((s) => ownIds.has(s.id))) insertAt = ds.fromIndex
      const rawIndent = ds.fromIndent + Math.round(deltaX / INDENT_STEP_PX)
      const indent = clampIndent(rawIndent, insertAt, ds.slideIds)

      // Don't let the drop split someone else's subtree. If the slide
      // about to be pushed down by the insertion is at a DEEPER indent
      // than the dropped block, walk past the whole run of deeper
      // slides so the foreign subtree stays intact. The dragged slides
      // themselves are skipped — they're "lifted out" during the drag.
      while (insertAt < slides.length) {
        const next = slides[insertAt]
        if (next === undefined) break
        if (ownIds.has(next.id)) {
          insertAt++
          continue
        }
        if (slideIndent(next) > indent) {
          insertAt++
          continue
        }
        break
      }

      return { insertAt, indent }
    },
    [slides, insertionUnderPointer, clampIndent],
  )

  // ---------------------------------------------------------------------------
  // Pointer handlers
  // ---------------------------------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, slideId: string, _index: number) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('[data-slide-menu]') !== null) return

      // Fresh gesture — assume it's a click until movement proves otherwise.
      didDragRef.current = false

      // Determine the ids that should travel together:
      // - If the slide is part of a multi-select, bring the whole
      //   selection plus each member's outline descendants.
      // - Otherwise, bring the clicked slide plus its descendants.
      const membership = selectedIds.has(slideId) && selectedIds.size > 1
      const baseIds: string[] = membership ? [...selectedIds] : [slideId]

      const allIds = new Set<string>()
      for (const id of baseIds) {
        const idx = slides.findIndex((s) => s.id === id)
        if (idx === -1) continue
        for (const childId of subtreeIds(slides, idx)) {
          allIds.add(childId)
        }
      }

      // Drag ids in array order for deterministic insertion.
      const orderedIds: string[] = slides.filter((s) => allIds.has(s.id)).map((s) => s.id)
      if (orderedIds.length === 0) return

      const firstIdx = slides.findIndex((s) => s.id === orderedIds[0])
      const firstSlide = slides[firstIdx]
      if (firstSlide === undefined) return

      e.currentTarget.setPointerCapture(e.pointerId)

      const state: DragState = {
        slideIds: orderedIds,
        fromIndex: firstIdx,
        fromIndent: slideIndent(firstSlide),
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
        insertAt: firstIdx,
        indent: slideIndent(firstSlide),
      }
      dragStateRef.current = state
      setDragState({ ...state })
      // Click suppression after a drag is handled via didDragRef (set in
      // handlePointerMove, consumed in handleActivate).
    },
    [slides, selectedIds],
  )

  /** Take `next` as the drag's state, its drop recomputed. */
  const updateDrag = useCallback(
    (next: DragState) => {
      const outcome = computeDragOutcome(next)
      const state: DragState = { ...next, insertAt: outcome.insertAt, indent: outcome.indent }
      dragStateRef.current = state
      setDragState(state)
    },
    [computeDragOutcome],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const ds = dragStateRef.current
      if (ds === null) return
      // Past the threshold this is a drag, not a click — flag it so the
      // trailing click is suppressed (4px tolerates pointer jitter).
      if (
        Math.abs(e.clientX - ds.startX) > DRAG_CLICK_THRESHOLD_PX ||
        Math.abs(e.clientY - ds.startY) > DRAG_CLICK_THRESHOLD_PX
      ) {
        didDragRef.current = true
      }
      updateDrag({ ...ds, currentX: e.clientX, currentY: e.clientY })
    },
    [updateDrag],
  )

  // Scrolling the list under a still pointer (the wheel, a trackpad) moves
  // the rows, not the pointer: recompute the drop for the same pointer.
  const dragging = dragState !== null
  useEffect(() => {
    const list = listRef.current
    if (!dragging || list === null) return
    const onScroll = () => {
      const ds = dragStateRef.current
      if (ds !== null) updateDrag(ds)
    }
    list.addEventListener('scroll', onScroll, { passive: true })
    return () => list.removeEventListener('scroll', onScroll)
  }, [dragging, updateDrag])

  const handlePointerUp = useCallback(
    (_e: React.PointerEvent<HTMLElement>) => {
      const ds = dragStateRef.current
      if (ds === null) return
      dragStateRef.current = null
      setDragState(null)

      const movedPosition = ds.insertAt !== ds.fromIndex
      const movedIndent = ds.indent !== ds.fromIndent
      if (!movedPosition && !movedIndent) return

      // One command: the block moves and, with `level`, its subtree shifts
      // by the same amount (slide.move keeps the outline well formed).
      command.tryRun('slide.move', {
        slides: ds.slideIds,
        toIndex: ds.insertAt,
        ...(movedIndent ? { level: ds.indent } : {}),
      })
    },
    [command],
  )

  // ---------------------------------------------------------------------------
  // Keyboard navigation
  // ---------------------------------------------------------------------------

  // Slide navigation via arrows / Enter — slidePanel scope so it only
  // fires when the user has interacted with the slide list (pointer-down
  // tracker in useShortcuts), not while editing on the canvas.
  useShortcuts([
    {
      keys: 'ArrowDown',
      scope: 'slidePanel',
      preventDefault: true,
      action: 'slide.next',
      description: 'Next slide',
      handler: () => {
        const currentIdx = slides.findIndex((s) => s.id === activeSlideId)
        const next = slides[Math.min(slides.length - 1, currentIdx + 1)]
        if (next !== undefined) handleActivate(next.id)
      },
    },
    {
      keys: 'ArrowUp',
      scope: 'slidePanel',
      preventDefault: true,
      action: 'slide.previous',
      description: 'Previous slide',
      handler: () => {
        const currentIdx = slides.findIndex((s) => s.id === activeSlideId)
        const prev = slides[Math.max(0, currentIdx - 1)]
        if (prev !== undefined) handleActivate(prev.id)
      },
    },
    {
      keys: 'Enter',
      scope: 'slidePanel',
      preventDefault: true,
      action: 'slide.open',
      description: 'Open active slide',
      handler: () => {
        if (activeSlideId !== null) handleActivate(activeSlideId)
      },
    },
    {
      keys: ['Delete', 'Backspace'],
      scope: 'slidePanel',
      preventDefault: true,
      action: 'slide.delete',
      description: 'Delete active slide',
      handler: () => {
        if (isViewer) return
        if (activeSlideId !== null && slides.length > 1) handleDelete(activeSlideId)
      },
    },
    {
      // Wins over the canvas's Mod+D (duplicate objects) whenever the slide
      // list has the focus: useShortcuts tries the panel's scope first and
      // stops at the first scope that handles the key. preventDefault keeps
      // the browser's own Ctrl+D (bookmark) out of it.
      keys: 'Mod+d',
      scope: 'slidePanel',
      preventDefault: true,
      action: 'slide.duplicate',
      description: 'Duplicate slide(s)',
      handler: () => {
        if (isViewer) return
        if (activeSlideId !== null) handleDuplicate(activeSlideId)
      },
    },
    {
      keys: 'Mod+c',
      scope: 'slidePanel',
      preventDefault: true,
      action: 'slide.copy',
      description: 'Copy slide(s)',
      handler: () => {
        if (activeSlideId !== null) handleCopy(activeSlideId)
      },
    },
    {
      keys: 'Mod+v',
      scope: 'slidePanel',
      preventDefault: true,
      action: 'slide.paste',
      description: 'Paste slide(s) after active',
      // Yield to canvas Mod+V (object paste) when the slide clipboard is
      // empty — e.g. user copied an object on canvas, clicked another
      // thumbnail to navigate, then hit Mod+V expecting to paste the
      // object on the new slide.
      canHandle: () => hasSlideClipboard(),
      handler: () => {
        if (isViewer) return
        const target = activeSlideId ?? slides[slides.length - 1]?.id ?? null
        if (target !== null) handlePaste(target)
      },
    },
  ])

  useEffect(() => {
    if (activeSlideId === null) return
    const list = listRef.current
    if (list === null) return
    const el = list.querySelector(`[data-slide-id="${activeSlideId}"]`) as HTMLElement | null
    if (el !== null && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeSlideId])

  // B3 (docs/plans/performance.md): the rows are memoised, and handlers that
  // depend on the active slide or the selection are new functions on every
  // switch — every row re-rendered for the two that changed. The rows get
  // stable handlers that run the latest ones.
  const rowOnActivate = useStableHandler(handleActivate)
  const rowOnToggleCollapsed = useStableHandler(handleToggleCollapsed)
  const rowOnPointerDown = useStableHandler(handlePointerDown)
  const rowOnDuplicate = useStableHandler(handleDuplicate)
  const rowOnDelete = useStableHandler(handleDelete)
  const rowOnTransition = useStableHandler(handleTransition)
  const rowOnRename = useStableHandler(handleRename)
  const rowOnToggleSkip = useStableHandler(handleToggleSkip)
  const rowOnExportPng = useStableHandler(handleExportPng)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const draggingSet = dragState !== null ? new Set(dragState.slideIds) : null
  /** Jobs waiting to render in the gap above slide `idx`. */
  const importsAt = (idx: number) => pptxDrop.jobs.filter((j) => j.insertAt === idx)
  /** …and everything aimed at or past the end of the list. */
  const importsAtEnd = pptxDrop.jobs.filter((j) => j.insertAt >= slides.length)

  return (
    <div
      className="flex h-full flex-col select-none"
      onMouseDownCapture={(e) => {
        // Shift-click would otherwise extend the browser's text selection
        // across the panel (looks like "everything is highlighted blue").
        // preventDefault at the capture phase stops the selection from
        // even starting; we also clear any leftover range that was
        // anchored outside the panel before the shift-click.
        if (e.shiftKey) {
          e.preventDefault()
          const sel = typeof window !== 'undefined' ? window.getSelection() : null
          sel?.removeAllRanges()
        }
      }}
      onPointerMove={handlePointerMove as unknown as React.PointerEventHandler<HTMLDivElement>}
      onPointerUp={handlePointerUp as unknown as React.PointerEventHandler<HTMLDivElement>}
    >
      {/* Header — P15: collapse icon at the LEFT, then label, count,
          then the add button on the right. */}
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border px-2 py-2">
        {onCollapse !== undefined && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCollapse}
            aria-label="Hide slides panel"
            title="Hide slides panel"
            className="h-6 w-6 flex-shrink-0"
          >
            <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )}
        <h2
          id={headerId}
          className="flex-1 truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Slides
          <span className="ml-1.5 font-normal opacity-60">({slides.length})</span>
        </h2>
        {!isViewer && (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleAdd}
            aria-label="Add slide"
            className="h-6 w-6 flex-shrink-0"
            title="Add slide"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>

      {/* Slide list — wrapped in panel-level context menu so right-click
          on empty area (below last slide / when there are no slides)
          shows a 'Paste slide' option. Per-row items are rendered by the
          same menu via mode='row'. */}
      <SlidesPanelContextMenu
        readOnly={isViewer}
        isSkipped={(id) => slides.find((s) => s.id === id)?.skipped === true}
        onRename={(id) => setEditRequestId(id)}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        onToggleSkip={handleToggleSkip}
        onCopy={handleCopy}
        onExportPng={handleExportPng}
        onPaste={handlePaste}
        canPaste={canPaste}
      >
        {slides.length === 0 ? (
          // Still a drop target with nothing in it — a deck whose slides were
          // all deleted is exactly when someone reaches for a .pptx.
          <div className="flex flex-1 flex-col" {...pptxDrop.dropHandlers}>
            {pptxDrop.jobs.map((job) => (
              <div key={job.id} className="pt-2">
                <PptxImportRow job={job} onDismiss={pptxDrop.dismiss} />
              </div>
            ))}
            <div className="flex flex-1 items-center justify-center">
              <p className="text-xs text-gray-600">
                {pptxDrop.indicatorAt !== null ? 'Drop to import' : 'No slides'}
              </p>
            </div>
          </div>
        ) : (
          <ul
            ref={listRef}
            role="listbox"
            aria-labelledby={headerId}
            aria-orientation="vertical"
            // `overflow-anchor: none`: the rows are a fixed-size grid, so
            // there is nothing scroll anchoring could usefully correct here,
            // and any transient change of a row's height above the viewport
            // would only ever move the list against the user. That is not
            // hypothetical — Pixi's text measurement used to restyle every
            // div on the page for one layout per text render (see
            // renderer/pixiHtmlTextStyleScope.ts), and with anchoring on that
            // dragged the list ~500px mid-load. The leak is fixed at its
            // source; this stays as the panel's own guarantee that it never
            // re-anchors, whatever the next transient turns out to be.
            className="scrollbar-narrative flex flex-1 flex-col gap-2 overflow-y-auto py-2 [overflow-anchor:none]"
            {...pptxDrop.dropHandlers}
          >
            {slides.map((slide, idx) => {
              const isDragging = draggingSet !== null && draggingSet.has(slide.id)
              // Drop indicator fires on the slide that will be pushed by
              // the insertion. moveSlidesBlock re-inserts at `insertAt`
              // in the PRE-move array, so the block lands immediately
              // before the slide currently at `insertAt` (or after the
              // last slide when insertAt >= slides.length).
              const showIndicator =
                dragState !== null &&
                !draggingSet!.has(slide.id) &&
                dragState.insertAt !== dragState.fromIndex
              // A file being dragged over the panel draws the same line, at
              // the gap it would drop into. The two can never be live at
              // once: one is a pointer gesture, the other an HTML5 drag.
              const fileDropAt = pptxDrop.indicatorAt
              const dropIndicatorAbove =
                (showIndicator && dragState!.insertAt === idx) || fileDropAt === idx
              const dropIndicatorBelow =
                (showIndicator &&
                  dragState!.insertAt >= slides.length &&
                  idx === slides.length - 1) ||
                (fileDropAt !== null && fileDropAt >= slides.length && idx === slides.length - 1)

              // Live-preview indent only for the dragged *root* slide.
              const isDragRoot = dragState !== null && dragState.slideIds[0] === slide.id
              const indent =
                isDragRoot && dragState !== null ? dragState.indent : slideIndent(slide)

              const rowImports = importsAt(idx)

              return (
                <Fragment key={slide.id}>
                  {rowImports.map((job) => (
                    <li key={job.id}>
                      <PptxImportRow job={job} onDismiss={pptxDrop.dismiss} />
                    </li>
                  ))}
                  <li>
                    <SlideItem
                      slide={slide}
                      index={idx}
                      indent={indent}
                      hasChildren={outline.hasChildrenMap.get(slide.id) ?? false}
                      collapsed={slide.collapsed === true}
                      hidden={outline.hiddenIds.has(slide.id)}
                      isActive={slide.id === activeSlideId}
                      isActiveDescendant={activeDescendants.has(slide.id)}
                      isSelected={selectedIds.has(slide.id)}
                      isDragging={isDragging}
                      dropIndicatorAbove={dropIndicatorAbove}
                      dropIndicatorBelow={dropIndicatorBelow}
                      thumbnails={thumbnails}
                      visibility={rowVisibility}
                      readOnly={isViewer}
                      onActivate={rowOnActivate}
                      onToggleCollapsed={rowOnToggleCollapsed}
                      onPointerDown={isViewer ? NOOP_POINTER_DOWN : rowOnPointerDown}
                      onDuplicate={rowOnDuplicate}
                      onDelete={rowOnDelete}
                      onTransition={rowOnTransition}
                      onRename={rowOnRename}
                      onToggleSkip={rowOnToggleSkip}
                      onExportPng={rowOnExportPng}
                      editRequestId={editRequestId}
                      onConsumeEditRequest={consumeEditRequest}
                    />
                  </li>
                </Fragment>
              )
            })}
            {/* Anything dropped below the last slide, or aimed past the end
                of a list that has since shrunk. */}
            {importsAtEnd.map((job) => (
              <li key={job.id}>
                <PptxImportRow job={job} onDismiss={pptxDrop.dismiss} />
              </li>
            ))}
          </ul>
        )}
      </SlidesPanelContextMenu>
    </div>
  )
}
