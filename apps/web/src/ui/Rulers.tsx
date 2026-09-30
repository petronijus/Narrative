/**
 * ui/Rulers.tsx
 *
 * P11: 24 px ruler strips around the artboard + drag-out guide gestures.
 *
 * Layout
 * ------
 * - Top strip: full-width horizontal ruler showing the X axis.
 * - Left strip: full-height vertical ruler showing the Y axis.
 *   Their corner overlaps in a small square at top-left.
 *
 * Tick marks every 100 slide-px, numeric labels every 200 slide-px.
 * Strips are positioned ABOVE the artboard's own transform: scale(zoom)
 * stack — the parent passes the live zoom + slide dimensions so we can
 * draw the ticks at the screen-space positions that actually line up
 * with the scaled artboard underneath.
 *
 * Drag-out gesture
 * ----------------
 * Pointer-down on a strip starts a drag-out. While dragging we render a
 * thin follow-cursor preview line. On pointer-up:
 *   - Inside the artboard rect → `guide.add` at the slide-space position.
 *   - Outside              → cancel.
 *
 * Existing guides are drawn by the parent (EditorLayout) inside the
 * artboard so they participate in the normal scroll/zoom transform.
 *
 * Every write is a `guide.*` command (useCommand), the same ones agents use.
 */

import { useEffect, useRef, useState } from 'react'
import type { DeckGuide } from '@narrative/shared'
import { useCommand } from '../state/useCommand.js'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '../components/ui/context-menu.js'
import { Trash2 } from 'lucide-react'

export interface RulersProps {
  /** Slide width in slide-space px (1920). */
  slideWidth: number
  /** Slide height in slide-space px (1080). */
  slideHeight: number
  /** Current zoom factor. Slide-px → screen-px multiplier. */
  zoom: number
  /**
   * Live ref to the artboard div so the drag-out gesture can convert
   * pointer-up viewport coords into slide-space coords for `guide.add`.
   */
  artboardRef: React.RefObject<HTMLDivElement | null>
}

/** A guide position kept on the slide (the rect edge can round a hair past it). */
function clampToSlide(position: number, limit: number): number {
  return Math.max(0, Math.min(limit, position))
}

const RULER_THICKNESS = 24
const TICK_STEP = 100
const LABEL_STEP = 200

interface DragState {
  orientation: 'horizontal' | 'vertical'
  /** Live viewport coord on the perpendicular axis — drives the preview line. */
  viewportPos: number
}

export function Rulers({ slideWidth, slideHeight, zoom, artboardRef }: RulersProps) {
  const command = useCommand()
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  // Install pointermove / pointerup listeners only while dragging — keeps
  // the editor pointer pipeline clean otherwise.
  useEffect(() => {
    if (drag === null) return

    function handleMove(e: PointerEvent) {
      const cur = dragRef.current
      if (cur === null) return
      setDrag({
        orientation: cur.orientation,
        viewportPos: cur.orientation === 'horizontal' ? e.clientY : e.clientX,
      })
    }

    function handleUp(e: PointerEvent) {
      const cur = dragRef.current
      setDrag(null)
      dragRef.current = null
      if (cur === null) return

      const artboard = artboardRef.current
      if (artboard === null) return
      const rect = artboard.getBoundingClientRect()
      // Drop only when pointer is inside the artboard rect.
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        return
      }
      // Convert to slide-space coords.
      const sx = ((e.clientX - rect.left) / rect.width) * slideWidth
      const sy = ((e.clientY - rect.top) / rect.height) * slideHeight
      command.tryRun('guide.add', {
        orientation: cur.orientation,
        position:
          cur.orientation === 'horizontal'
            ? clampToSlide(sy, slideHeight)
            : clampToSlide(sx, slideWidth),
      })
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [drag, artboardRef, command, slideWidth, slideHeight])

  // ---------------------------------------------------------------------------
  // Tick rendering
  // ---------------------------------------------------------------------------

  const horizontalTicks: Array<{ slidePos: number; screenPos: number; major: boolean }> = []
  for (let v = 0; v <= slideWidth; v += TICK_STEP) {
    horizontalTicks.push({
      slidePos: v,
      screenPos: v * zoom,
      major: v % LABEL_STEP === 0,
    })
  }

  const verticalTicks: Array<{ slidePos: number; screenPos: number; major: boolean }> = []
  for (let v = 0; v <= slideHeight; v += TICK_STEP) {
    verticalTicks.push({
      slidePos: v,
      screenPos: v * zoom,
      major: v % LABEL_STEP === 0,
    })
  }

  return (
    <>
      {/* Top horizontal ruler — sits above the artboard, offset by
          RULER_THICKNESS to leave room for the corner square. The strip
          spans the artboard's screen width (slideWidth * zoom). */}
      <div
        aria-hidden="true"
        data-ruler="top"
        onPointerDown={(e) => {
          e.preventDefault()
          setDrag({ orientation: 'horizontal', viewportPos: e.clientY })
          dragRef.current = { orientation: 'horizontal', viewportPos: e.clientY }
        }}
        className="absolute select-none border-b border-border bg-surface-2/95 text-[9px] text-muted-foreground"
        style={{
          left: 0,
          top: -RULER_THICKNESS,
          width: slideWidth * zoom,
          height: RULER_THICKNESS,
          cursor: 'ns-resize',
        }}
      >
        {horizontalTicks.map((t) => (
          <div
            key={`h-${t.slidePos}`}
            className="absolute bottom-0"
            style={{ left: t.screenPos, height: t.major ? 10 : 5, width: 1 }}
          >
            <div className="h-full w-px bg-muted-foreground/60" />
            {t.major && (
              <span
                className="absolute"
                style={{ left: 2, bottom: 11, lineHeight: 1, whiteSpace: 'nowrap' }}
              >
                {t.slidePos}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Left vertical ruler. */}
      <div
        aria-hidden="true"
        data-ruler="left"
        onPointerDown={(e) => {
          e.preventDefault()
          setDrag({ orientation: 'vertical', viewportPos: e.clientX })
          dragRef.current = { orientation: 'vertical', viewportPos: e.clientX }
        }}
        className="absolute select-none border-r border-border bg-surface-2/95 text-[9px] text-muted-foreground"
        style={{
          top: 0,
          left: -RULER_THICKNESS,
          width: RULER_THICKNESS,
          height: slideHeight * zoom,
          cursor: 'ew-resize',
        }}
      >
        {verticalTicks.map((t) => (
          <div
            key={`v-${t.slidePos}`}
            className="absolute right-0"
            style={{ top: t.screenPos, width: t.major ? 10 : 5, height: 1 }}
          >
            <div className="h-px w-full bg-muted-foreground/60" />
            {t.major && (
              <span
                className="absolute"
                style={{ top: 2, right: 11, lineHeight: 1, whiteSpace: 'nowrap' }}
              >
                {t.slidePos}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Top-left corner square covering the ruler intersection. */}
      <div
        aria-hidden="true"
        className="absolute border-b border-r border-border bg-surface-2/95"
        style={{
          left: -RULER_THICKNESS,
          top: -RULER_THICKNESS,
          width: RULER_THICKNESS,
          height: RULER_THICKNESS,
        }}
      />

      {/* Drag-out preview — full viewport overlay so the line follows the
          pointer past the artboard edge. Position fixed in viewport space. */}
      {drag !== null && (
        <div
          className="pointer-events-none fixed inset-0 z-50"
          style={{
            // Single thin cyan line at the live pointer coord.
            background:
              drag.orientation === 'horizontal'
                ? `linear-gradient(to bottom, transparent ${drag.viewportPos - 1}px, rgb(34, 211, 238) ${drag.viewportPos - 1}px, rgb(34, 211, 238) ${drag.viewportPos}px, transparent ${drag.viewportPos}px)`
                : `linear-gradient(to right, transparent ${drag.viewportPos - 1}px, rgb(34, 211, 238) ${drag.viewportPos - 1}px, rgb(34, 211, 238) ${drag.viewportPos}px, transparent ${drag.viewportPos}px)`,
            opacity: 0.7,
          }}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// GuideOverlay — renders existing guides inside the artboard at their
// slide-space position. Slides into the same un-zoomed coordinate frame
// as the rest of the artboard contents (TransformHandles, SnapGuides),
// so positions are direct slide-px values.
// ---------------------------------------------------------------------------

export interface GuideOverlayProps {
  guides: DeckGuide[]
  slideWidth: number
  slideHeight: number
}

export function GuideOverlay({ guides, slideWidth, slideHeight }: GuideOverlayProps) {
  const command = useCommand()
  const [drag, setDrag] = useState<{ id: string; pos: number } | null>(null)
  const dragRef = useRef<typeof drag>(null)
  dragRef.current = drag

  useEffect(() => {
    if (drag === null) return
    // We need the artboard's rect to translate viewport→slide on move.
    // Walk up from any guide line element to find it. Simpler: compute
    // from a parent div via a data attribute on body? Cleanest: caller
    // wraps GuideOverlay so its parent IS the artboard. Use offsetParent.
    function handleMove(e: PointerEvent) {
      const cur = dragRef.current
      if (cur === null) return
      // Use the slideContainer rect — we read it from a global selector
      // since the overlay sits inside it.
      const el = document.querySelector('[data-artboard-root="1"]') as HTMLElement | null
      if (el === null) return
      const rect = el.getBoundingClientRect()
      const guide = guides.find((g) => g.id === cur.id)
      if (guide === undefined) return
      const slidePos =
        guide.orientation === 'horizontal'
          ? ((e.clientY - rect.top) / rect.height) * slideHeight
          : ((e.clientX - rect.left) / rect.width) * slideWidth
      setDrag({ id: cur.id, pos: slidePos })
    }

    function handleUp(e: PointerEvent) {
      const cur = dragRef.current
      setDrag(null)
      dragRef.current = null
      if (cur === null) return

      const el = document.querySelector('[data-artboard-root="1"]') as HTMLElement | null
      if (el === null) return
      const rect = el.getBoundingClientRect()
      const guide = guides.find((g) => g.id === cur.id)
      if (guide === undefined) return

      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom

      if (!inside) {
        // Drag outside artboard → delete.
        command.tryRun('guide.remove', { guides: [cur.id] })
        return
      }

      const slidePos =
        guide.orientation === 'horizontal'
          ? ((e.clientY - rect.top) / rect.height) * slideHeight
          : ((e.clientX - rect.left) / rect.width) * slideWidth
      command.tryRun('guide.update', {
        guide: cur.id,
        position: clampToSlide(
          slidePos,
          guide.orientation === 'horizontal' ? slideHeight : slideWidth,
        ),
      })
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [drag, guides, command, slideWidth, slideHeight])

  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-artboard-root="1"
      style={{ width: slideWidth, height: slideHeight }}
    >
      {guides.map((g) => {
        const live = drag !== null && drag.id === g.id ? drag.pos : g.position
        const style: React.CSSProperties =
          g.orientation === 'horizontal'
            ? { top: live, left: 0, width: slideWidth, height: 1 }
            : { left: live, top: 0, width: 1, height: slideHeight }
        return (
          <ContextMenu key={g.id}>
            <ContextMenuTrigger asChild>
              <div
                role="separator"
                aria-orientation={g.orientation}
                onPointerDown={(e) => {
                  // Don't start a drag from a right-click — Radix needs the
                  // contextmenu event to fire after pointerdown to position
                  // the menu at the cursor.
                  if (e.button !== 0) return
                  e.preventDefault()
                  e.stopPropagation()
                  setDrag({ id: g.id, pos: g.position })
                  dragRef.current = { id: g.id, pos: g.position }
                }}
                className="pointer-events-auto absolute"
                style={{
                  ...style,
                  background: 'rgb(34, 211, 238)',
                  opacity: 0.5,
                  cursor: g.orientation === 'horizontal' ? 'ns-resize' : 'ew-resize',
                  boxShadow:
                    g.orientation === 'horizontal'
                      ? '0 -3px 0 -2px transparent, 0 3px 0 -2px transparent'
                      : '-3px 0 0 -2px transparent, 3px 0 0 -2px transparent',
                }}
              />
            </ContextMenuTrigger>
            {/* The menu renders in a portal, but React still bubbles its
                pointer events up this component tree — to the line's drag
                handler and on to the canvas, which captures the pointer and
                keeps the item from ever seeing its click. They stop here. */}
            <ContextMenuContent
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
            >
              <ContextMenuItem
                action="guide.remove"
                onSelect={() => command.tryRun('guide.remove', { guides: [g.id] })}
                className="text-red-500 focus:text-red-500"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Delete guide
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
  )
}
