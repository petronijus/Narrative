/**
 * ui/SlidesPanel.tsx
 *
 * Left sidebar slide panel.
 *
 * P3 outline behaviour (Keynote-style):
 * - Each slide carries an `indent` level (0 = top). Parent = nearest
 *   previous slide with smaller indent.
 * - Parents can `collapsed` — their descendants disappear from the panel
 *   (and only the panel; present-mode ignores collapse).
 * - Drag reorders (vertical) AND re-indents (horizontal delta). The
 *   resulting indent is clamped: a slide can be at most `previous.indent + 1`
 *   after the move, so you can't jump levels.
 */

import { useRef, useState, useCallback, useEffect, useId } from 'react'
import { useSlides } from '../state/useSlides.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useSelection } from '../state/SelectionContext.js'
import { useSlideThumbnails } from '../state/useSlideThumbnails.js'
import {
  addSlide,
  removeSlide,
  moveSlide,
  setSlideName,
  setSlideSkipped,
  setSlideIndent,
  setSlideCollapsed,
} from '@narrative/slide-model'
import { duplicateSlide } from './slideHelpers.js'
import type { Slide } from '@narrative/shared'
import { SlideItemMenu } from './SlideItemMenu.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { Plus, EyeOff, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLACEHOLDER_COLOURS = ['#1e293b', '#1c2b3a', '#1e1e2e', '#1a1a2e', '#16213e', '#0f3460']

function placeholderColour(index: number): string {
  return PLACEHOLDER_COLOURS[index % PLACEHOLDER_COLOURS.length] ?? '#1e293b'
}

/** Pixels of horizontal drag that equal one indent step. */
const INDENT_STEP_PX = 24
/** Visual inset per indent level (in px). */
const INDENT_VISUAL_PX = 16
/** Max indent level. Keynote caps around 5; 6 is plenty. */
const MAX_INDENT = 6

// ---------------------------------------------------------------------------
// Drag state
// ---------------------------------------------------------------------------

interface DragState {
  slideId: string
  fromIndex: number
  fromIndent: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  /** Final drop index in the global slides array. */
  insertAt: number
  /** Final indent after clamp. */
  indent: number
}

// ---------------------------------------------------------------------------
// SlideItem
// ---------------------------------------------------------------------------

interface SlideItemProps {
  slide: Slide
  index: number
  indent: number
  hasChildren: boolean
  collapsed: boolean
  isActive: boolean
  isDragging: boolean
  dropIndicatorAbove: boolean
  dropIndicatorBelow: boolean
  thumbnailUrl: string | undefined
  readOnly?: boolean
  onActivate: (id: string) => void
  onToggleCollapsed: (id: string) => void
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, id: string, index: number) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onTransition: (id: string) => void
  onRename: (id: string, name: string) => void
  onToggleSkip: (id: string) => void
}

function SlideItem({
  slide,
  index,
  indent,
  hasChildren,
  collapsed,
  isActive,
  isDragging,
  dropIndicatorAbove,
  dropIndicatorBelow,
  thumbnailUrl,
  readOnly = false,
  onActivate,
  onToggleCollapsed,
  onPointerDown,
  onDuplicate,
  onDelete,
  onTransition,
  onRename,
  onToggleSkip,
}: SlideItemProps) {
  const labelId = `slide-item-label-${slide.id}`
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(slide.name ?? '')
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

  const commit = useCallback(() => {
    onRename(slide.id, draftName)
    setEditing(false)
  }, [draftName, slide.id, onRename])

  const displayName = slide.name ?? `Slide ${index + 1}`

  return (
    <div
      role="option"
      aria-selected={isActive}
      aria-labelledby={labelId}
      data-slide-id={slide.id}
      data-slide-index={index}
      style={{ paddingLeft: indent * INDENT_VISUAL_PX }}
      className={['group relative flex-shrink-0', isDragging ? 'opacity-40' : ''].join(' ')}
    >
      {/* Drop indicator — above */}
      {dropIndicatorAbove && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-0.5 left-2 right-2 h-0.5 rounded-full bg-blue-400"
        />
      )}

      {/* Collapse chevron — only rendered for parents */}
      {hasChildren && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleCollapsed(slide.id)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={collapsed ? 'Expand children' : 'Collapse children'}
          className="absolute left-0 top-2 z-10 flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          style={{ left: Math.max(0, indent * INDENT_VISUAL_PX - 16) }}
        >
          <ChevronRight
            className={'h-3 w-3 transition-transform ' + (collapsed ? '' : 'rotate-90')}
            aria-hidden="true"
          />
        </button>
      )}

      {/* Thumbnail card */}
      <div
        className={[
          'relative mx-2 cursor-pointer overflow-hidden rounded',
          'transition-shadow duration-100',
          isActive ? 'ring-2 ring-blue-500' : 'ring-1 ring-gray-700 hover:ring-gray-500',
          slide.skipped === true ? 'opacity-50' : '',
        ].join(' ')}
        style={{ aspectRatio: '16/9' }}
        onClick={() => onActivate(slide.id)}
        onPointerDown={(e) => onPointerDown(e, slide.id, index)}
        aria-hidden="true"
      >
        {thumbnailUrl !== undefined ? (
          <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="h-full w-full" style={{ backgroundColor: placeholderColour(index) }} />
        )}

        {/* Slide number badge — bottom left */}
        <span
          id={labelId}
          className="absolute bottom-1 left-1.5 rounded bg-black/50 px-1 text-[10px] font-medium text-white/80 select-none"
        >
          {index + 1}
        </span>

        {/* Skipped badge — corner eye-off icon */}
        {slide.skipped === true && (
          <span
            aria-label="Skipped in present mode"
            className="absolute right-1 bottom-1 rounded bg-black/55 p-0.5 text-white/80"
          >
            <EyeOff className="h-3 w-3" aria-hidden="true" />
          </span>
        )}
      </div>

      {/* Slide name — double-click / F2 to edit */}
      <div className="mx-2 mt-1 text-[11px] text-muted-foreground">
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
            className="w-full rounded border border-border bg-surface-1 px-1 py-0.5 text-[11px] text-foreground outline-none focus:border-border-strong"
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
            className="block w-full truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-surface-2/60"
            title={displayName}
          >
            {displayName}
          </button>
        )}
      </div>

      {/* Drop indicator — below */}
      {dropIndicatorBelow && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-0.5 left-2 right-2 h-0.5 rounded-full bg-blue-400"
        />
      )}

      {/* Three-dot menu button — hidden for viewer role */}
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
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SlidesPanel
// ---------------------------------------------------------------------------

export function SlidesPanel(): JSX.Element {
  const slides = useSlides()
  const { activeSlideId, setActiveSlideId } = useActiveSlide()
  const { deckCtx } = useSlideDoc()
  const { clear: clearSelection } = useSelection()
  const listRef = useRef<HTMLUListElement>(null)
  const headerId = useId()
  const { role } = useDeckRole()
  const isViewer = role === 'viewer'

  const allSlideIds = slides.map((s) => s.id)
  const thumbnailMap = useSlideThumbnails(allSlideIds)

  const [dragState, setDragState] = useState<DragState | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const itemHeightRef = useRef<number>(90)

  const handleActivate = useCallback(
    (id: string) => {
      setActiveSlideId(id)
      clearSelection()
    },
    [setActiveSlideId, clearSelection],
  )

  const handleAdd = useCallback(() => {
    const newSlide = addSlide(deckCtx)
    setActiveSlideId(newSlide.id)
    clearSelection()
  }, [deckCtx, setActiveSlideId, clearSelection])

  const handleDuplicate = useCallback(
    (slideId: string) => {
      const idx = slides.findIndex((s) => s.id === slideId)
      if (idx === -1) return
      const newSlide = duplicateSlide(deckCtx, slideId, idx + 1)
      if (newSlide !== null) {
        setActiveSlideId(newSlide.id)
        clearSelection()
      }
    },
    [deckCtx, slides, setActiveSlideId, clearSelection],
  )

  const handleDelete = useCallback(
    (slideId: string) => {
      const idx = slides.findIndex((s) => s.id === slideId)
      if (idx !== -1 && slides.length > 1) {
        const nextIdx = idx > 0 ? idx - 1 : 1
        const nextSlide = slides[nextIdx]
        if (nextSlide !== undefined && activeSlideId === slideId) {
          setActiveSlideId(nextSlide.id)
        }
      }
      removeSlide(deckCtx, slideId)
      clearSelection()
    },
    [deckCtx, slides, activeSlideId, setActiveSlideId, clearSelection],
  )

  const handleTransition = useCallback(
    (slideId: string) => {
      handleActivate(slideId)
    },
    [handleActivate],
  )

  const handleRename = useCallback(
    (slideId: string, name: string) => {
      setSlideName(deckCtx, slideId, name)
    },
    [deckCtx],
  )

  const handleToggleSkip = useCallback(
    (slideId: string) => {
      const s = slides.find((x) => x.id === slideId)
      if (s === undefined) return
      setSlideSkipped(deckCtx, slideId, s.skipped !== true)
    },
    [deckCtx, slides],
  )

  const handleToggleCollapsed = useCallback(
    (slideId: string) => {
      const s = slides.find((x) => x.id === slideId)
      if (s === undefined) return
      setSlideCollapsed(deckCtx, slideId, s.collapsed !== true)
    },
    [deckCtx, slides],
  )

  // ---------------------------------------------------------------------------
  // Drag math helpers
  // ---------------------------------------------------------------------------

  const getItemHeight = useCallback((): number => {
    const list = listRef.current
    if (list === null) return 90
    const firstItem = list.querySelector('[data-slide-id]') as HTMLElement | null
    if (firstItem === null) return 90
    const h = firstItem.getBoundingClientRect().height
    if (h > 0) itemHeightRef.current = h
    return itemHeightRef.current
  }, [])

  /**
   * Clamps a proposed indent given the previous slide in the post-move
   * slide list. A slide can be at most one level deeper than the slide
   * preceding its drop position. With no preceding slide (= top of
   * list), the only legal indent is 0.
   */
  const clampIndent = useCallback(
    (proposed: number, insertAt: number, movingSlideId: string): number => {
      // Rebuild the list as it would look after the move: drop the
      // moving slide from its current position, then consult the slide
      // just before insertAt.
      const filtered = slides.filter((s) => s.id !== movingSlideId)
      const clampedInsertAt = Math.max(0, Math.min(insertAt, filtered.length))
      const prev = clampedInsertAt > 0 ? filtered[clampedInsertAt - 1] : undefined
      const maxAllowed = prev === undefined ? 0 : (prev.indent ?? 0) + 1
      return Math.max(0, Math.min(MAX_INDENT, Math.min(proposed, maxAllowed)))
    },
    [slides],
  )

  const computeDragOutcome = useCallback(
    (ds: DragState): { insertAt: number; indent: number } => {
      const h = getItemHeight()
      const deltaY = ds.currentY - ds.startY
      const deltaX = ds.currentX - ds.startX
      const rawRowOffset = Math.round(deltaY / h)
      const insertAt = Math.max(0, Math.min(slides.length - 1, ds.fromIndex + rawRowOffset))
      const rawIndent = ds.fromIndent + Math.round(deltaX / INDENT_STEP_PX)
      const indent = clampIndent(rawIndent, insertAt, ds.slideId)
      return { insertAt, indent }
    },
    [slides.length, getItemHeight, clampIndent],
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, slideId: string, index: number) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('[data-slide-menu]') !== null) return
      const slide = slides.find((s) => s.id === slideId)
      if (slide === undefined) return

      e.currentTarget.setPointerCapture(e.pointerId)

      const state: DragState = {
        slideId,
        fromIndex: index,
        fromIndent: slide.indent ?? 0,
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
        insertAt: index,
        indent: slide.indent ?? 0,
      }
      dragStateRef.current = state
      setDragState({ ...state })
    },
    [slides],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const ds = dragStateRef.current
      if (ds === null) return

      const next: DragState = {
        ...ds,
        currentX: e.clientX,
        currentY: e.clientY,
      }
      const outcome = computeDragOutcome(next)
      next.insertAt = outcome.insertAt
      next.indent = outcome.indent
      dragStateRef.current = next
      setDragState({ ...next })
    },
    [computeDragOutcome],
  )

  const handlePointerUp = useCallback(
    (_e: React.PointerEvent<HTMLElement>) => {
      const ds = dragStateRef.current
      if (ds === null) return

      dragStateRef.current = null
      setDragState(null)

      // Apply position change first (if any), then indent. Both mutations
      // sit inside LOCAL_ORIGIN transacts — paired within the same frame.
      if (ds.insertAt !== ds.fromIndex) {
        moveSlide(deckCtx, ds.slideId, ds.insertAt)
      }
      if (ds.indent !== ds.fromIndent) {
        setSlideIndent(deckCtx, ds.slideId, ds.indent)
      }
    },
    [deckCtx],
  )

  // ---------------------------------------------------------------------------
  // Keyboard navigation
  // ---------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      const currentIdx = slides.findIndex((s) => s.id === activeSlideId)

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const nextIdx = Math.min(slides.length - 1, currentIdx + 1)
        const next = slides[nextIdx]
        if (next !== undefined) handleActivate(next.id)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prevIdx = Math.max(0, currentIdx - 1)
        const prev = slides[prevIdx]
        if (prev !== undefined) handleActivate(prev.id)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (activeSlideId !== null) handleActivate(activeSlideId)
      }
    },
    [slides, activeSlideId, handleActivate],
  )

  useEffect(() => {
    if (activeSlideId === null) return
    const list = listRef.current
    if (list === null) return
    const el = list.querySelector(`[data-slide-id="${activeSlideId}"]`) as HTMLElement | null
    if (el !== null && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeSlideId])

  // ---------------------------------------------------------------------------
  // Derived outline state — which slides have children + which are hidden
  // ---------------------------------------------------------------------------

  const outline = (() => {
    const hasChildrenMap = new Map<string, boolean>()
    const hiddenIds = new Set<string>()

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i]
      if (slide === undefined) continue
      const indent = slide.indent ?? 0

      // Has children if the next slide is at a deeper indent.
      const next = slides[i + 1]
      const hasChildren = next !== undefined && (next.indent ?? 0) > indent
      hasChildrenMap.set(slide.id, hasChildren)
    }

    // A slide is hidden if ANY ancestor (earlier slide with smaller
    // indent) is collapsed. Walk left-to-right, track the deepest
    // collapsed-ancestor indent we're still "under".
    let suppressingIndent: number | null = null
    for (const slide of slides) {
      const indent = slide.indent ?? 0
      if (suppressingIndent !== null && indent > suppressingIndent) {
        hiddenIds.add(slide.id)
      } else {
        suppressingIndent = null
      }
      if (slide.collapsed === true && suppressingIndent === null) {
        suppressingIndent = indent
      }
    }

    return { hasChildrenMap, hiddenIds }
  })()

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="flex h-full flex-col"
      onPointerMove={handlePointerMove as unknown as React.PointerEventHandler<HTMLDivElement>}
      onPointerUp={handlePointerUp as unknown as React.PointerEventHandler<HTMLDivElement>}
    >
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <h2
          id={headerId}
          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
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
            className="h-6 w-6"
            title="Add slide"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>

      {/* Slide list */}
      {slides.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-gray-600">No slides</p>
        </div>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          aria-labelledby={headerId}
          aria-orientation="vertical"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="scrollbar-narrative flex flex-1 flex-col gap-2 overflow-y-auto py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {slides.map((slide, idx) => {
            if (outline.hiddenIds.has(slide.id)) return null
            const isDragging = dragState?.slideId === slide.id
            const dropIndicatorAbove =
              dragState !== null &&
              dragState.slideId !== slide.id &&
              dragState.insertAt === idx &&
              dragState.insertAt < dragState.fromIndex
            const dropIndicatorBelow =
              dragState !== null &&
              dragState.slideId !== slide.id &&
              dragState.insertAt === idx &&
              dragState.insertAt > dragState.fromIndex

            // During a drag, preview the moving slide's indent live — every
            // other slide uses its committed indent.
            const indent = isDragging && dragState !== null ? dragState.indent : (slide.indent ?? 0)
            const hasChildren = outline.hasChildrenMap.get(slide.id) ?? false

            return (
              <li key={slide.id} className="flex-shrink-0">
                <SlideItem
                  slide={slide}
                  index={idx}
                  indent={indent}
                  hasChildren={hasChildren}
                  collapsed={slide.collapsed === true}
                  isActive={slide.id === activeSlideId}
                  isDragging={isDragging}
                  dropIndicatorAbove={dropIndicatorAbove}
                  dropIndicatorBelow={dropIndicatorBelow}
                  thumbnailUrl={thumbnailMap.get(slide.id)}
                  readOnly={isViewer}
                  onActivate={handleActivate}
                  onToggleCollapsed={handleToggleCollapsed}
                  onPointerDown={isViewer ? () => {} : handlePointerDown}
                  onDuplicate={handleDuplicate}
                  onDelete={handleDelete}
                  onTransition={handleTransition}
                  onRename={handleRename}
                  onToggleSkip={handleToggleSkip}
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
