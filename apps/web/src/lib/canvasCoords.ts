/**
 * lib/canvasCoords.ts — a viewport point as a point on the slide.
 *
 * The artboard is drawn under a CSS `transform: scale(zoom)`, so its
 * `getBoundingClientRect()` is the scaled, visual rect: the offset from its
 * corner is divided by the zoom to land in unscaled 1920×1080 slide space.
 * Every pointer that places something on the slide goes through here — the
 * editor's create tools and drags, and a file dropped on the canvas (which
 * once skipped the division and landed off the cursor at any zoom but 100%).
 */
export function clientToCanvasCoords(
  clientX: number,
  clientY: number,
  canvasRect: DOMRect,
  zoom: number = 1,
): { x: number; y: number } {
  const s = zoom === 0 ? 1 : zoom
  return {
    x: (clientX - canvasRect.left) / s,
    y: (clientY - canvasRect.top) / s,
  }
}
