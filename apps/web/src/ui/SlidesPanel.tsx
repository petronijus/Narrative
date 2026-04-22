/**
 * ui/SlidesPanel.tsx
 *
 * Left sidebar slide panel (M9).
 *
 * Features:
 * - Ordered list of slide thumbnails (200×113 / 16:9)
 * - Active-slide highlight (2px blue ring)
 * - Numbering (1-based), add / duplicate / delete / transition
 * - Drag-to-reorder via pointer events (no library)
 * - Keyboard: Up/Down navigate, Enter activates
 * - Thumbnails: consumes useSlideThumbnails() when available; falls back to
 *   index-keyed placeholder colour block.
 *   TODO: wire real thumbnails once renderer agent ships useSlideThumbnails.
 *
 * Mutations: addSlide, removeSlide, moveSlide, duplicateSlide (client-side helper).
 */

import { useRef, useState, useCallback, useEffect, useId } from 'react'
import { useSlides } from '../state/useSlides.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useSelection } from '../state/SelectionContext.js'
import { useSlideThumbnails } from '../state/useSlideThumbnails.js'
import { addSlide, removeSlide, moveSlide } from '@narrative/slide-model'
import { duplicateSlide } from './slideHelpers.js'
import type { Slide } from '@narrative/shared'
import { SlideItemMenu } from './SlideItemMenu.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Fallback palette for thumbnail placeholder colours
// ---------------------------------------------------------------------------

const PLACEHOLDER_COLOURS = ['#1e293b', '#1c2b3a', '#1e1e2e', '#1a1a2e', '#16213e', '#0f3460']

function placeholderColour(index: number): string {
  return PLACEHOLDER_COLOURS[index % PLACEHOLDER_COLOURS.length] ?? '#1e293b'
}

// ---------------------------------------------------------------------------
// Drag-to-reorder state
// ---------------------------------------------------------------------------

interface DragState {
  slideId: string
  fromIndex: number
  /** Current drop-target index (insertion point) */
  insertAt: number
  startY: number
  currentY: number
}

// ---------------------------------------------------------------------------
// SlideItem
// ---------------------------------------------------------------------------

interface SlideItemProps {
  slide: Slide
  index: number
  isActive: boolean
  isDragging: boolean
  dropIndicatorAbove: boolean
  dropIndicatorBelow: boolean
  thumbnailUrl: string | undefined
  /** M10: hide mutation controls for viewers */
  readOnly?: boolean
  onActivate: (id: string) => void
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, id: string, index: number) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onTransition: (id: string) => void
}

function SlideItem({
  slide,
  index,
  isActive,
  isDragging,
  dropIndicatorAbove,
  dropIndicatorBelow,
  thumbnailUrl,
  readOnly = false,
  onActivate,
  onPointerDown,
  onDuplicate,
  onDelete,
  onTransition,
}: SlideItemProps) {
  const labelId = `slide-item-label-${slide.id}`

  return (
    <div
      role="option"
      aria-selected={isActive}
      aria-labelledby={labelId}
      data-slide-id={slide.id}
      data-slide-index={index}
      className={['group relative flex-shrink-0', isDragging ? 'opacity-40' : ''].join(' ')}
    >
      {/* Drop indicator — above */}
      {dropIndicatorAbove && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-0.5 left-2 right-2 h-0.5 rounded-full bg-blue-400"
        />
      )}

      {/* Thumbnail card */}
      <div
        className={[
          'relative mx-2 cursor-pointer overflow-hidden rounded',
          'transition-shadow duration-100',
          isActive ? 'ring-2 ring-blue-500' : 'ring-1 ring-gray-700 hover:ring-gray-500',
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
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onTransition={onTransition}
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

  // ---------------------------------------------------------------------------
  // Thumbnail URLs from renderer agent's useSlideThumbnails hook
  // ---------------------------------------------------------------------------
  const allSlideIds = slides.map((s) => s.id)
  const thumbnailMap = useSlideThumbnails(allSlideIds)

  // ---------------------------------------------------------------------------
  // Drag-to-reorder state
  // ---------------------------------------------------------------------------

  const [dragState, setDragState] = useState<DragState | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const itemHeightRef = useRef<number>(90) // estimated, updated on first drag

  const handleActivate = useCallback(
    (id: string) => {
      setActiveSlideId(id)
      clearSelection()
    },
    [setActiveSlideId, clearSelection],
  )

  // ---------------------------------------------------------------------------
  // Add slide
  // ---------------------------------------------------------------------------

  const handleAdd = useCallback(() => {
    const newSlide = addSlide(deckCtx)
    setActiveSlideId(newSlide.id)
    clearSelection()
  }, [deckCtx, setActiveSlideId, clearSelection])

  // ---------------------------------------------------------------------------
  // Duplicate
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  const handleDelete = useCallback(
    (slideId: string) => {
      // Determine next active slide before deletion
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

  // ---------------------------------------------------------------------------
  // Transition (deferred — opens Inspector slide section)
  // ---------------------------------------------------------------------------

  const handleTransition = useCallback(
    (slideId: string) => {
      // Activate the slide so Inspector shows its transition settings
      handleActivate(slideId)
    },
    [handleActivate],
  )

  // ---------------------------------------------------------------------------
  // Drag-to-reorder — pointer events
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

  const getInsertAt = useCallback(
    (startIndex: number, deltaY: number): number => {
      const h = getItemHeight()
      const rawOffset = Math.round(deltaY / h)
      return Math.max(0, Math.min(slides.length - 1, startIndex + rawOffset))
    },
    [slides.length, getItemHeight],
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, slideId: string, index: number) => {
      // Only start drag on primary button, non-menu targets
      if (e.button !== 0) return
      // Don't start drag if clicking the menu button or its children
      const target = e.target as HTMLElement
      if (target.closest('[data-slide-menu]') !== null) return

      e.currentTarget.setPointerCapture(e.pointerId)

      const state: DragState = {
        slideId,
        fromIndex: index,
        insertAt: index,
        startY: e.clientY,
        currentY: e.clientY,
      }
      dragStateRef.current = state
      setDragState({ ...state })
    },
    [],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const ds = dragStateRef.current
      if (ds === null) return

      const updated: DragState = {
        ...ds,
        currentY: e.clientY,
        insertAt: getInsertAt(ds.fromIndex, e.clientY - ds.startY),
      }
      dragStateRef.current = updated
      setDragState({ ...updated })
    },
    [getInsertAt],
  )

  const handlePointerUp = useCallback(
    (_e: React.PointerEvent<HTMLElement>) => {
      const ds = dragStateRef.current
      if (ds === null) return

      dragStateRef.current = null
      setDragState(null)

      if (ds.insertAt !== ds.fromIndex) {
        moveSlide(deckCtx, ds.slideId, ds.insertAt)
      }
    },
    [deckCtx],
  )

  // ---------------------------------------------------------------------------
  // Keyboard navigation in panel
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

  // ---------------------------------------------------------------------------
  // Scroll active slide into view
  // ---------------------------------------------------------------------------

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
        {/* Add slide button — hidden for viewer role */}
        {!isViewer && (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleAdd}
            aria-label="Add slide"
            className="h-6 w-6"
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
          className="flex flex-1 flex-col gap-2 overflow-y-auto py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
        >
          {slides.map((slide, idx) => {
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

            return (
              <li key={slide.id} className="flex-shrink-0">
                <SlideItem
                  slide={slide}
                  index={idx}
                  isActive={slide.id === activeSlideId}
                  isDragging={isDragging}
                  dropIndicatorAbove={dropIndicatorAbove}
                  dropIndicatorBelow={dropIndicatorBelow}
                  thumbnailUrl={thumbnailMap.get(slide.id)}
                  readOnly={isViewer}
                  onActivate={handleActivate}
                  onPointerDown={isViewer ? () => {} : handlePointerDown}
                  onDuplicate={handleDuplicate}
                  onDelete={handleDelete}
                  onTransition={handleTransition}
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
