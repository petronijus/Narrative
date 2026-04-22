/**
 * ui/PresenterOverlay.tsx
 *
 * M19 phase 3: presenter view shown on top of present mode.
 *
 * Layout is a bottom-anchored row split into three panels:
 *   - Left  — current slide's speaker notes (plain text preview from
 *             useSlideNotes; keeps the rich-text formatting as newlines +
 *             list markers so you can glance at them during a talk).
 *   - Mid   — next slide preview via useSlideThumbnails.
 *   - Right — elapsed timer from the moment the overlay was mounted.
 *
 * Toggled by a prop from PresentLayout (keyboard 'N' in parent).
 *
 * When visible, the overlay takes the bottom third of the viewport.
 * PresentLayout shrinks the canvas area above it via a sibling flex
 * relationship — we don't need to touch the canvas here.
 */

import { useEffect, useRef, useState } from 'react'
import { useSlides } from '../state/useSlides.js'
import { useSlideNotes } from '../state/useSlideNotes.js'
import { useSlideThumbnails } from '../state/useSlideThumbnails.js'

interface PresenterOverlayProps {
  activeSlideId: string | null
  /** When true, panel is visible. */
  visible: boolean
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export function PresenterOverlay({ activeSlideId, visible }: PresenterOverlayProps) {
  const slides = useSlides()
  const { text: notesText } = useSlideNotes()

  const activeIdx = slides.findIndex((s) => s.id === activeSlideId)
  const nextSlide =
    activeIdx >= 0 && activeIdx < slides.length - 1 ? (slides[activeIdx + 1] ?? null) : null

  // Only thumbnail the next slide (and the current one so the renderer keeps
  // it warm). Limiting the set keeps the background renderer's work bounded.
  const requestedIds: string[] = []
  if (activeSlideId !== null) requestedIds.push(activeSlideId)
  if (nextSlide !== null) requestedIds.push(nextSlide.id)
  const thumbnails = useSlideThumbnails(requestedIds)

  // Timer — reset each time the overlay is opened (visible: false → true).
  const startedAtRef = useRef<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number>(0)

  useEffect(() => {
    if (!visible) {
      startedAtRef.current = null
      setElapsedMs(0)
      return
    }
    startedAtRef.current = performance.now()
    setElapsedMs(0)
    const id = setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedMs(performance.now() - startedAtRef.current)
      }
    }, 500)
    return () => clearInterval(id)
  }, [visible])

  if (!visible) return null

  const nextThumb = nextSlide !== null ? thumbnails.get(nextSlide.id) : undefined

  return (
    <div
      className="pointer-events-auto flex w-full flex-shrink-0 gap-3 border-t border-gray-800 bg-gray-950/95 px-4 py-3 text-gray-200"
      style={{ height: '30vh', minHeight: 180 }}
      role="region"
      aria-label="Presenter view"
    >
      {/* Notes */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Notes
          </span>
          <span className="font-mono text-[10px] tabular-nums text-gray-500">
            Slide {activeIdx + 1} / {slides.length}
          </span>
        </div>
        <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-gray-800 bg-gray-900/60 p-2 font-sans text-sm leading-snug text-gray-100">
          {notesText.length > 0 ? notesText : <em className="text-gray-600">No notes.</em>}
        </pre>
      </div>

      {/* Next slide */}
      <div className="flex w-64 flex-shrink-0 flex-col">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Next
          </span>
          {nextSlide !== null && (
            <span className="font-mono text-[10px] tabular-nums text-gray-500">
              Slide {activeIdx + 2}
            </span>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center overflow-hidden rounded border border-gray-800 bg-gray-900/60">
          {nextSlide === null ? (
            <span className="text-[11px] italic text-gray-600">End of deck</span>
          ) : nextThumb !== undefined ? (
            <img
              src={nextThumb}
              alt={`Slide ${activeIdx + 2} preview`}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-[11px] italic text-gray-600">Rendering…</span>
          )}
        </div>
      </div>

      {/* Timer */}
      <div className="flex w-32 flex-shrink-0 flex-col">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Elapsed
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center rounded border border-gray-800 bg-gray-900/60">
          <span className="font-mono text-2xl tabular-nums text-gray-100">
            {formatElapsed(elapsedMs)}
          </span>
        </div>
      </div>
    </div>
  )
}
