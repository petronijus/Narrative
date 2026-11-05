/**
 * ui/useThumbnailPixelWidth.ts — the width, in device pixels, at which a
 * list's slide thumbnails are shown: the width the thumbnail renderer draws
 * them at (state/useSlideThumbnails.ts → `pixelWidth`).
 *
 * Until F10 every thumbnail was read back at the slide's own size, 1920 ×
 * 1080, whatever the renderer was asked for (Pixi's extract reads a
 * container's local bounds, before its scale), and the browser shrank it to
 * the ~224 CSS px of a panel row: ~2 Mpx drawn, read back and PNG-encoded per
 * thumbnail for ~50 kpx shown (~200 kpx on a 2× display). Drawn at the size
 * shown, a picture looks the same and costs ~1/10 to 1/40 of that
 * (performance.md → F10).
 *
 * The width is measured on the first thumbnail frame of the list
 * (`[data-thumbnail-frame]`), times the display's density, rounded up to
 * `WIDTH_STEP`: at once when the rows first appear (the deck's opening pass
 * renders at it), then after `SETTLE_MS` without change when the panel is
 * resized or the window moves to a display of another density (each new width
 * renders every thumbnail again, at idle).
 */

import { useLayoutEffect, useState } from 'react'
import { SLIDE_WIDTH } from '../renderer/constants.js'
import { watchDevicePixelRatio } from '../renderer/devicePixelRatioWatch.js'

/** Widths come in steps of this many device pixels (a resize by a few px renders nothing again). */
export const WIDTH_STEP = 32
/** How long the width must hold before thumbnails are rendered for it (a panel being dragged wider). */
const SETTLE_MS = 300

/** The pictures' width for a frame `cssWidth` CSS px wide at density `ratio`. */
export function thumbnailPixelWidth(cssWidth: number, ratio: number): number {
  const px = Math.ceil((cssWidth * ratio) / WIDTH_STEP) * WIDTH_STEP
  return Math.min(SLIDE_WIDTH, Math.max(WIDTH_STEP, px))
}

/**
 * The device-pixel width of the thumbnails in `list`, null until a
 * thumbnail frame has been measured.
 */
export function useThumbnailPixelWidth(
  /**
   * The list element (null while there is none). A new element — the list
   * remounted — is observed anew; the effect follows the element, not a ref
   * read when the rows last changed.
   */
  list: HTMLElement | null,
  /** Changes whenever the set of rows does (the deck's slide ids, joined). */
  rowsKey: string,
): number | null {
  const [width, setWidth] = useState<number | null>(null)
  const known = width !== null

  useLayoutEffect(() => {
    if (list === null) return
    let ratio = window.devicePixelRatio || 1
    let timer = 0
    const measure = (): number | null => {
      const frame = list.querySelector<HTMLElement>('[data-thumbnail-frame]')
      const css = frame?.getBoundingClientRect().width ?? 0
      // A collapsed panel shows no thumbnails: the last width stays.
      return css > 0 ? thumbnailPixelWidth(css, ratio) : null
    }
    const later = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const next = measure()
        if (next !== null) setWidth(next)
      }, SETTLE_MS)
    }
    if (!known) {
      const first = measure()
      if (first !== null) setWidth(first)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later)
    observer?.observe(list)
    const unwatch = watchDevicePixelRatio((next) => {
      ratio = next
      later()
    })
    return () => {
      window.clearTimeout(timer)
      observer?.disconnect()
      unwatch()
    }
  }, [list, rowsKey, known])

  return width
}
