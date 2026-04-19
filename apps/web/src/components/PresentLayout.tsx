/**
 * components/PresentLayout.tsx
 *
 * M5: Present mode fullscreen shell.
 *
 * Architektura:
 * - Žádný toolbar, sidebar, inspector — čistý fullscreen render.
 * - Canvas komponenta (sdílený renderer pipeline) je umístěna v centered
 *   slide-sized kontejneru. CSS transform: scale() aplikuje scale-to-fit.
 * - Pixi canvas má fyzický CSS size SLIDE_WIDTH × SLIDE_HEIGHT (1920×1080)
 *   a ResizeObserver na viewport počítá scale = min(vw/sw, vh/sh).
 * - Žádné pointer listeners → canvas je read-only (pointer-events:none).
 * - Keyboard: Escape → editor, Arrow/Space/Page → placeholder (M9 multi-slide).
 * - Fullscreen API: klávesa F nebo F11.
 *
 * Accessibility:
 * - role="application" s aria-label pro screen reader context.
 * - Subtle escape hint v rohu (aria-hidden).
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Canvas } from '../renderer/Canvas.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'

/** Vypočte scale-to-fit pro slide do daného viewportu při zachování aspect ratio. */
function computeScale(viewportW: number, viewportH: number): number {
  if (viewportW <= 0 || viewportH <= 0) return 1
  return Math.min(viewportW / SLIDE_WIDTH, viewportH / SLIDE_HEIGHT)
}

export function PresentLayout() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  const containerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<number>(() =>
    computeScale(window.innerWidth, window.innerHeight),
  )

  // ---------------------------------------------------------------------------
  // Scale-to-fit: ResizeObserver na fullscreen container
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const containerEl = containerRef.current
    if (containerEl === null) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      const { width, height } = entry.contentRect
      setScale(computeScale(width, height))
    })

    observer.observe(containerEl)

    // Počáteční výpočet (pro případ, že ResizeObserver nepošle entry synchronně)
    const { width, height } = containerEl.getBoundingClientRect()
    setScale(computeScale(width, height))

    return () => observer.disconnect()
  }, [])

  // ---------------------------------------------------------------------------
  // Fullscreen API toggle
  // ---------------------------------------------------------------------------

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement === null) {
      try {
        await document.documentElement.requestFullscreen()
      } catch {
        // Fullscreen odmítnut (embedded context apod.) — ignoruj
      }
    } else {
      try {
        await document.exitFullscreen()
      } catch {
        // Nelze exit — ignoruj
      }
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Keyboard handling
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      switch (e.key) {
        case 'Escape':
          e.preventDefault()
          navigate(`/deck/${id ?? ''}`)
          break

        case 'ArrowLeft':
        case 'ArrowRight':
        case ' ':
        case 'PageUp':
        case 'PageDown':
          e.preventDefault()
          console.debug('[present] navigation key pressed — M9 will wire up multi-slide nav')
          break

        case 'f':
        case 'F11':
          e.preventDefault()
          void toggleFullscreen()
          break

        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [id, navigate, toggleFullscreen])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 flex items-center justify-center bg-black"
      role="application"
      aria-label="Presentation — press Escape to return to editor"
    >
      {/*
        Slide wrapper: pevný CSS size 1920×1080, škálován CSS transformací.
        transform-origin: center center (default) → správné centrování.
        pointer-events: none → žádná interakce.
      */}
      <div
        className="pointer-events-none relative"
        style={{
          width: SLIDE_WIDTH,
          height: SLIDE_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
        data-testid="slide-container"
      >
        <Canvas />
      </div>

      {/* Slide counter (M5: vždy 1/1; M9 napojí real index) */}
      <div
        className="absolute bottom-4 right-4 select-none text-xs text-white/40"
        aria-hidden="true"
      >
        1 / 1
      </div>

      {/* Escape hint */}
      <div
        className="absolute bottom-4 left-4 select-none text-xs text-white/30"
        aria-hidden="true"
      >
        Esc — back to editor
      </div>
    </div>
  )
}
