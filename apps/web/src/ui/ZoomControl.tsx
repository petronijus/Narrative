/**
 * ui/ZoomControl.tsx
 *
 * P4a: floating zoom pill that lives in the bottom-right corner of
 * the canvas stage. Vertical slider plus +/− buttons, a reset-to-100 %
 * label and a fit-to-screen icon.
 */

import { Maximize2, Minus, Plus } from 'lucide-react'
import { MAX_ZOOM, MIN_ZOOM, useZoomLevel } from '../state/useZoomLevel.js'

interface ZoomControlProps {
  /** Scroll container used to compute fit-to-screen. */
  stageScrollRef: React.RefObject<HTMLDivElement>
  /**
   * P15: live insets of the floating chrome (side panels, toolbar,
   * bottom panels). The stage scroll surface is full-bleed under
   * those panels so the frosted glass has artboard content to blur,
   * but "fit to screen" must size the artboard against the visible
   * channel — otherwise the artboard ends up partially hidden under
   * the panels. Each value is the pixel inset on that edge of the
   * scroller; collapsing a panel lowers its inset live.
   */
  viewportInsets?: { top: number; right: number; bottom: number; left: number }
}

export function ZoomControl({ stageScrollRef, viewportInsets }: ZoomControlProps) {
  const { zoom, setZoom, zoomIn, zoomOut, resetZoom } = useZoomLevel()

  const handleFit = () => {
    const el = stageScrollRef.current
    const vw = el?.clientWidth ?? window.innerWidth
    const vh = el?.clientHeight ?? window.innerHeight
    const insetLeft = viewportInsets?.left ?? 0
    const insetRight = viewportInsets?.right ?? 0
    const insetTop = viewportInsets?.top ?? 0
    const insetBottom = viewportInsets?.bottom ?? 0
    const channelW = vw - insetLeft - insetRight
    const channelH = vh - insetTop - insetBottom
    // 32 px breathing room on each axis inside the channel so the
    // artboard doesn't kiss the panels.
    const fit = Math.min((channelW - 64) / 1920, (channelH - 64) / 1080)
    if (!Number.isFinite(fit) || fit <= 0) return

    const clamped = Math.round(fit * 100) / 100
    setZoom(clamped)

    // Compute the scroll position mathematically — no DOM reads needed
    // after the zoom change, which avoids timing races with React commit.
    //
    // The inner stage padding wrapper is:
    //   padding: 200px on all sides, display:grid, place-items:center
    //   min-width:  max(400 + 1920*fit, channelW)
    //   min-height: max(400 + 1080*fit, channelH)
    //
    // The artboard is centered in the wrapper. To center the artboard
    // in the visible channel we need:
    //   scrollLeft = (wrapperW - channelW) / 2
    //   scrollTop  = (wrapperH - channelH) / 2
    // clamped to ≥ 0 (no scroll needed when artboard fits the channel).
    const artW = 1920 * clamped
    const artH = 1080 * clamped
    // wrapper width = max(padding + artboard + padding, channelW)
    const wrapperW = Math.max(200 + artW + 200, channelW)
    const wrapperH = Math.max(200 + artH + 200, channelH)
    const targetScrollLeft = Math.max(0, (wrapperW - channelW) / 2)
    const targetScrollTop = Math.max(0, (wrapperH - channelH) / 2)

    // Apply after React has committed the new zoom and the layout has
    // reflowed. A double-rAF is the idiomatic way to ensure we're past
    // both the React commit pass and the browser's layout pass.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scroller = stageScrollRef.current
        if (scroller === null) return
        scroller.scrollLeft = targetScrollLeft
        scroller.scrollTop = targetScrollTop
      })
    })
  }

  return (
    <div
      className="pointer-events-auto flex flex-col items-center gap-1 rounded-md border border-border bg-surface-1/80 p-1.5 shadow-sm backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={handleFit}
        aria-label="Fit to screen"
        title="Fit to screen"
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
      >
        <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={zoomIn}
        disabled={zoom >= MAX_ZOOM - 0.001}
        aria-label="Zoom in"
        title="Zoom in"
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <input
        type="range"
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step={0.05}
        value={zoom}
        onChange={(e) => setZoom(Number(e.target.value))}
        aria-label="Zoom level"
        className="zoom-slider h-20 w-6 accent-foreground"
        style={{
          writingMode: 'vertical-lr',
          direction: 'rtl',
        }}
      />
      <button
        type="button"
        onClick={zoomOut}
        disabled={zoom <= MIN_ZOOM + 0.001}
        aria-label="Zoom out"
        title="Zoom out"
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      >
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={resetZoom}
        aria-label="Reset zoom to 100%"
        title="Reset to 100%"
        className="flex h-5 min-w-[36px] items-center justify-center rounded px-1 text-[10px] tabular-nums text-foreground transition hover:bg-surface-2"
      >
        {Math.round(zoom * 100)}%
      </button>
    </div>
  )
}
