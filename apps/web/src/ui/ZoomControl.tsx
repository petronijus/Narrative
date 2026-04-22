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
}

export function ZoomControl({ stageScrollRef }: ZoomControlProps) {
  const { zoom, setZoom, zoomIn, zoomOut, resetZoom } = useZoomLevel()

  const handleFit = () => {
    const el = stageScrollRef.current
    const vw = el?.clientWidth ?? window.innerWidth
    const vh = el?.clientHeight ?? window.innerHeight
    const fit = Math.min((vw - 64) / 1920, (vh - 64) / 1080)
    if (Number.isFinite(fit) && fit > 0) {
      setZoom(Math.round(fit * 100) / 100)
    }
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
