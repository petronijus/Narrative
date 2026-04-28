/**
 * ui/OverlayScrollbars.tsx
 *
 * P15: thin absolute-positioned scrollbars that sit inside the
 * editor's visible channel between the side panels, while the actual
 * scroll surface stays full-bleed under the frosted-glass chrome.
 *
 * Native scrollbars on `stageScrollRef` are hidden via CSS
 * (`scrollbar-width: none` + the WebKit pseudo). These overlays
 * read `scrollTop/Left/Width/Height` + `clientWidth/Height` from the
 * same element, render a track + thumb, and proxy mouse drag back
 * onto the element via direct mutation of `scrollTop` / `scrollLeft`.
 *
 * Two independent primitives keep DOM minimal — when the artboard
 * doesn't overflow on an axis the matching primitive renders null.
 *
 * Sync strategy: `scroll` events on the scroller are passive so they
 * don't fight the wheel-zoom handler in EditorLayout. A ResizeObserver
 * on both the scroller and its first child catches zoom-driven size
 * changes (the artboard wrapper resizes when zoom * SLIDE_WIDTH
 * changes) so the thumb proportions stay correct without polling.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const TRACK_THICKNESS = 10 // px — overall hover slot
const THUMB_THICKNESS = 6 // px — visible bar inside the track
const MIN_THUMB_LENGTH = 28 // px — keeps the thumb grabbable on huge content

interface ScrollMetrics {
  scrollPos: number
  contentSize: number
  viewSize: number
}

function readMetricsV(el: HTMLElement): ScrollMetrics {
  return {
    scrollPos: el.scrollTop,
    contentSize: el.scrollHeight,
    viewSize: el.clientHeight,
  }
}

function readMetricsH(el: HTMLElement): ScrollMetrics {
  return {
    scrollPos: el.scrollLeft,
    contentSize: el.scrollWidth,
    viewSize: el.clientWidth,
  }
}

/**
 * Subscribe to scroll + resize on the target element. Re-reads
 * metrics on each event and feeds them to the caller via setState.
 * `axis` is captured by the reader functions so we don't pass it
 * through the rAF coalescing path.
 */
function useScrollMetrics(ref: RefObject<HTMLElement | null>, axis: 'v' | 'h'): ScrollMetrics {
  const [metrics, setMetrics] = useState<ScrollMetrics>({
    scrollPos: 0,
    contentSize: 0,
    viewSize: 0,
  })

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const read = axis === 'v' ? readMetricsV : readMetricsH

    let rafId = -1
    const sample = (): void => {
      rafId = -1
      setMetrics((prev) => {
        const next = read(el)
        if (
          next.scrollPos === prev.scrollPos &&
          next.contentSize === prev.contentSize &&
          next.viewSize === prev.viewSize
        ) {
          return prev
        }
        return next
      })
    }
    const schedule = (): void => {
      if (rafId !== -1) return
      rafId = requestAnimationFrame(sample)
    }

    // Initial read so the thumb is positioned correctly on first paint
    // even before any scroll/resize event fires.
    setMetrics(read(el))

    el.addEventListener('scroll', schedule, { passive: true })

    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    // First child size also matters — when zoom multiplies the
    // artboard footprint the scroller's scrollWidth/Height change
    // even though the scroller's own clientWidth/Height did not.
    const firstChild = el.firstElementChild
    if (firstChild !== null) ro.observe(firstChild)

    return () => {
      el.removeEventListener('scroll', schedule)
      ro.disconnect()
      if (rafId !== -1) cancelAnimationFrame(rafId)
    }
  }, [ref, axis])

  return metrics
}

interface OverlayScrollbarProps {
  scrollRef: RefObject<HTMLElement | null>
  /** Distance (px) from the relevant editor edge — clears the side panel. */
  start: number
  /** Distance (px) from the OPPOSITE editor edge — clears the other side panel. */
  end: number
  /** Distance (px) from the perpendicular edge (top for V, right for H). */
  perpendicular: number
}

/**
 * Vertical scrollbar — pinned at `right: perpendicular` from the
 * editor's right edge. Track spans `top: start` to `bottom: end`.
 */
export function OverlayScrollbarV({ scrollRef, start, end, perpendicular }: OverlayScrollbarProps) {
  const metrics = useScrollMetrics(scrollRef, 'v')
  const trackRef = useRef<HTMLDivElement>(null)
  const [trackLen, setTrackLen] = useState(0)
  const dragRef = useRef<{ startClient: number; startScroll: number } | null>(null)

  // Measure the actual track height — `top: start; bottom: end` lets
  // the browser size it against the viewport, but we still need the
  // numeric height to size the thumb. Without this the thumb ends up
  // proportional to the SCROLLER's clientHeight (full-bleed) instead
  // of the track's clipped channel, so it overshoots the bottom edge.
  useEffect(() => {
    const el = trackRef.current
    if (el === null) return
    const update = (): void => {
      const h = el.clientHeight
      setTrackLen((prev) => (prev === h ? prev : h))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [start, end])

  const overflow = metrics.contentSize - metrics.viewSize
  const visible = overflow > 1 && metrics.viewSize > 0 && trackLen > 0

  const ratio = visible ? metrics.viewSize / metrics.contentSize : 1
  const thumbLen = Math.min(trackLen, Math.max(MIN_THUMB_LENGTH, Math.floor(trackLen * ratio)))
  const maxThumbOffset = trackLen - thumbLen
  const thumbOffset = overflow > 0 ? Math.round((metrics.scrollPos / overflow) * maxThumbOffset) : 0

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return
      const el = scrollRef.current
      if (el === null) return
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = { startClient: e.clientY, startScroll: el.scrollTop }
      ;(e.target as Element).setPointerCapture(e.pointerId)
    },
    [scrollRef],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current
      const el = scrollRef.current
      if (drag === null || el === null || maxThumbOffset <= 0) return
      const dy = e.clientY - drag.startClient
      // 1 px of pointer movement = (overflow / maxThumbOffset) px of
      // scrolling — keeps the thumb visually under the cursor inside
      // the channel-sized track.
      const pxPerThumb = overflow / maxThumbOffset
      el.scrollTop = drag.startScroll + dy * pxPerThumb
    },
    [scrollRef, overflow, maxThumbOffset],
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    ;(e.target as Element).releasePointerCapture(e.pointerId)
  }, [])

  // Track must stay mounted so its ref + ResizeObserver can measure
  // it on first paint; a `visible && return null` here would prevent
  // the ref from ever attaching, leaving trackLen=0 forever, which
  // in turn keeps `visible` false — a self-defeating gate.
  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      className="pointer-events-none fixed z-30"
      style={{
        right: perpendicular,
        top: start,
        bottom: end,
        width: TRACK_THICKNESS,
      }}
    >
      {visible && (
        <div
          className="pointer-events-auto absolute cursor-pointer rounded-full bg-foreground/30 shadow-[0_0_0_1px_rgba(0,0,0,0.15),0_1px_3px_rgba(0,0,0,0.25)] transition-colors hover:bg-foreground/50 active:bg-foreground/60"
          style={{
            top: thumbOffset,
            right: (TRACK_THICKNESS - THUMB_THICKNESS) / 2,
            width: THUMB_THICKNESS,
            height: thumbLen,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      )}
    </div>
  )
}

/**
 * Horizontal scrollbar — pinned at `bottom: perpendicular` from the
 * editor's bottom edge. Track spans `left: start` to `right: end`.
 */
export function OverlayScrollbarH({ scrollRef, start, end, perpendicular }: OverlayScrollbarProps) {
  const metrics = useScrollMetrics(scrollRef, 'h')
  const trackRef = useRef<HTMLDivElement>(null)
  const [trackLen, setTrackLen] = useState(0)
  const dragRef = useRef<{ startClient: number; startScroll: number } | null>(null)

  useEffect(() => {
    const el = trackRef.current
    if (el === null) return
    const update = (): void => {
      const w = el.clientWidth
      setTrackLen((prev) => (prev === w ? prev : w))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [start, end])

  const overflow = metrics.contentSize - metrics.viewSize
  const visible = overflow > 1 && metrics.viewSize > 0 && trackLen > 0

  const ratio = visible ? metrics.viewSize / metrics.contentSize : 1
  const thumbLen = Math.min(trackLen, Math.max(MIN_THUMB_LENGTH, Math.floor(trackLen * ratio)))
  const maxThumbOffset = trackLen - thumbLen
  const thumbOffset = overflow > 0 ? Math.round((metrics.scrollPos / overflow) * maxThumbOffset) : 0

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return
      const el = scrollRef.current
      if (el === null) return
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = { startClient: e.clientX, startScroll: el.scrollLeft }
      ;(e.target as Element).setPointerCapture(e.pointerId)
    },
    [scrollRef],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current
      const el = scrollRef.current
      if (drag === null || el === null || maxThumbOffset <= 0) return
      const dx = e.clientX - drag.startClient
      const pxPerThumb = overflow / maxThumbOffset
      el.scrollLeft = drag.startScroll + dx * pxPerThumb
    },
    [scrollRef, overflow, maxThumbOffset],
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    ;(e.target as Element).releasePointerCapture(e.pointerId)
  }, [])

  // See note in OverlayScrollbarV — keep the track mounted so the
  // ResizeObserver can measure it.
  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      className="pointer-events-none fixed z-30"
      style={{
        bottom: perpendicular,
        left: start,
        right: end,
        height: TRACK_THICKNESS,
      }}
    >
      {visible && (
        <div
          className="pointer-events-auto absolute cursor-pointer rounded-full bg-foreground/30 shadow-[0_0_0_1px_rgba(0,0,0,0.15),0_1px_3px_rgba(0,0,0,0.25)] transition-colors hover:bg-foreground/50 active:bg-foreground/60"
          style={{
            left: thumbOffset,
            bottom: (TRACK_THICKNESS - THUMB_THICKNESS) / 2,
            height: THUMB_THICKNESS,
            width: thumbLen,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      )}
    </div>
  )
}
