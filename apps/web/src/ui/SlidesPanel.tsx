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
 */

import { useRef, useState, useCallback, useEffect, useId, useMemo } from 'react'
import { useSlides } from '../state/useSlides.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useSelection } from '../state/SelectionContext.js'
import { useSlideThumbnails } from '../state/useSlideThumbnails.js'
import {
  addSlide,
  removeSlide,
  moveSlidesBlock,
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

const INDENT_STEP_PX = 24
const INDENT_VISUAL_PX = 16
const MAX_INDENT = 6
const COLLAPSE_MS = 180

// ---------------------------------------------------------------------------
// Outline helpers
// ---------------------------------------------------------------------------

function slideIndent(s: Slide): number {
  return s.indent ?? 0
}

/**
 * Returns the ids of the slide at `fromIndex` plus every following slide
 * that belongs to its outline subtree (consecutive slides with a deeper
 * indent).
 */
function subtreeIds(slides: Slide[], fromIndex: number): string[] {
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
// SlideItem
// ---------------------------------------------------------------------------

interface SlideItemProps {
  slide: Slide
  index: number
  indent: number
  hasChildren: boolean
  collapsed: boolean
  hidden: boolean
  isActive: boolean
  isSelected: boolean
  isDragging: boolean
  dropIndicatorAbove: boolean
  dropIndicatorBelow: boolean
  thumbnailUrl: string | undefined
  readOnly?: boolean
  onActivate: (id: string, shift: boolean) => void
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
  hidden,
  isActive,
  isSelected,
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

  const commit = useCallback(() => {
    onRename(slide.id, draftName)
    setEditing(false)
  }, [draftName, slide.id, onRename])

  const displayName = slide.name ?? `Slide ${index + 1}`

  // Animated show/hide: we render a wrapper that uses grid-template-rows
  // 0fr ↔ 1fr to smoothly collapse a row to zero without measuring.
  const ringClass = isSelected && !isActive ? 'ring-2 ring-blue-400/70' : ''

  return (
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
              'relative cursor-pointer',
              isActive
                ? 'ring-2 ring-blue-500'
                : ringClass !== ''
                  ? ringClass
                  : 'ring-1 ring-gray-700 hover:ring-gray-500',
            ].join(' ')}
            style={{ aspectRatio: '16/9', width: '100%' }}
            onPointerDown={(e) => onPointerDown(e, slide.id, index)}
            onClick={(e) => onActivate(slide.id, e.shiftKey)}
            aria-hidden="true"
          >
            {thumbnailUrl !== undefined ? (
              <img
                src={thumbnailUrl}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              <div
                className="h-full w-full"
                style={{ backgroundColor: placeholderColour(index) }}
              />
            )}

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
            onOpenChange={setMenuOpen}
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

  // Panel-level multi-select (separate from the canvas SelectionContext).
  // Always contains activeSlideId when not empty.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
    activeSlideId !== null ? new Set([activeSlideId]) : new Set(),
  )

  // Keep selection in sync when the active slide changes externally
  // (e.g. keyboard nav, Enter, remote peer).
  useEffect(() => {
    if (activeSlideId === null) return
    setSelectedIds((prev) => {
      if (prev.has(activeSlideId) && prev.size === 1) return prev
      return new Set([activeSlideId])
    })
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
    (id: string, shift: boolean) => {
      if (shift) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(id) && next.size > 1) {
            next.delete(id)
          } else {
            next.add(id)
          }
          return next
        })
        // Don't change active slide on shift-click.
        return
      }
      setSelectedIds(new Set([id]))
      setActiveSlideId(id)
      clearSelection()
    },
    [setActiveSlideId, clearSelection],
  )

  const handleAdd = useCallback(() => {
    const newSlide = addSlide(deckCtx)
    setActiveSlideId(newSlide.id)
    setSelectedIds(new Set([newSlide.id]))
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
      handleActivate(slideId, false)
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

  // ---------------------------------------------------------------------------
  // Drag math
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
   * Clamps a proposed indent against the post-move previous slide. An
   * ancestor of the moving block cannot jump more than one level deeper
   * than the slide immediately preceding its insertion point.
   */
  const clampIndent = useCallback(
    (proposed: number, insertAt: number, movingIds: string[]): number => {
      const movingSet = new Set(movingIds)
      const filtered = slides.filter((s) => !movingSet.has(s.id))
      const clampedInsertAt = Math.max(0, Math.min(insertAt, filtered.length))
      const prev = clampedInsertAt > 0 ? filtered[clampedInsertAt - 1] : undefined
      const maxAllowed = prev === undefined ? 0 : slideIndent(prev) + 1
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
      let insertAt = Math.max(0, Math.min(slides.length, ds.fromIndex + rawRowOffset))
      const rawIndent = ds.fromIndent + Math.round(deltaX / INDENT_STEP_PX)
      const indent = clampIndent(rawIndent, insertAt, ds.slideIds)

      // Don't let the drop split someone else's subtree. If the slide
      // about to be pushed down by the insertion is at a DEEPER indent
      // than the dropped block, walk past the whole run of deeper
      // slides so the foreign subtree stays intact. The dragged slides
      // themselves are skipped — they're "lifted out" during the drag.
      const ownIds = new Set(ds.slideIds)
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
    [slides, getItemHeight, clampIndent],
  )

  // ---------------------------------------------------------------------------
  // Pointer handlers
  // ---------------------------------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, slideId: string, index: number) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('[data-slide-menu]') !== null) return

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

      // Suppress the accidental click-activation after a drag gesture.
      void index
    },
    [slides, selectedIds],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const ds = dragStateRef.current
      if (ds === null) return
      const next: DragState = { ...ds, currentX: e.clientX, currentY: e.clientY }
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

      const movedPosition = ds.insertAt !== ds.fromIndex
      const movedIndent = ds.indent !== ds.fromIndent

      if (movedPosition) {
        moveSlidesBlock(deckCtx, ds.slideIds, ds.insertAt)
      }
      if (movedIndent) {
        // Shift the whole subtree by the same delta so relative indents stay.
        const delta = ds.indent - ds.fromIndent
        for (const id of ds.slideIds) {
          const s = slides.find((x) => x.id === id)
          if (s === undefined) continue
          const nextIndent = Math.max(0, Math.min(MAX_INDENT, slideIndent(s) + delta))
          if (nextIndent !== slideIndent(s)) {
            setSlideIndent(deckCtx, id, nextIndent)
          }
        }
      }
    },
    [deckCtx, slides],
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
        if (next !== undefined) handleActivate(next.id, false)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prevIdx = Math.max(0, currentIdx - 1)
        const prev = slides[prevIdx]
        if (prev !== undefined) handleActivate(prev.id, false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (activeSlideId !== null) handleActivate(activeSlideId, false)
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
  // Render
  // ---------------------------------------------------------------------------

  const draggingSet = dragState !== null ? new Set(dragState.slideIds) : null

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
            const dropIndicatorAbove = showIndicator && dragState!.insertAt === idx
            const dropIndicatorBelow =
              showIndicator && dragState!.insertAt >= slides.length && idx === slides.length - 1

            // Live-preview indent only for the dragged *root* slide.
            const isDragRoot = dragState !== null && dragState.slideIds[0] === slide.id
            const indent = isDragRoot && dragState !== null ? dragState.indent : slideIndent(slide)

            return (
              <li key={slide.id}>
                <SlideItem
                  slide={slide}
                  index={idx}
                  indent={indent}
                  hasChildren={outline.hasChildrenMap.get(slide.id) ?? false}
                  collapsed={slide.collapsed === true}
                  hidden={outline.hiddenIds.has(slide.id)}
                  isActive={slide.id === activeSlideId}
                  isSelected={selectedIds.has(slide.id)}
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
