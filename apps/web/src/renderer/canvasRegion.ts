/**
 * renderer/canvasRegion.ts — the editor canvas draws the part of its world
 * the window shows, at the device's own resolution, with a backing store
 * whose size does not change with the zoom (ADR 0020).
 *
 * Before: the canvas covered the artboard and its bleed (2720 × 1880 CSS px)
 * at `dpr × zoom` — capped at 25 Mpx (resampled by the compositor above
 * ≈2.2×), and reallocated on every zoom commit (Pixi's `resizeCanvas`:
 * 50 ms a commit, a long frame after every zoom gesture). Now:
 *
 *   - **The backing store** is the stage's viewport and a margin
 *     (`MARGIN` each side) at the device's pixel ratio, fixed while the
 *     window keeps its size: a zoom changes the renderer's resolution, not
 *     the pixel count (Pixi reallocates only when that changes).
 *   - **The region** is the part of the world that store covers at the
 *     resolution: `backing / resolution` CSS px, placed around what the
 *     window shows, moved when a scroll takes the view out of it. The stage
 *     is drawn through a render transform (stageRender.ts): world
 *     coordinates never move, only what is drawn.
 *   - **On the device grid**: the region's corner is a whole number of
 *     device px from the world's origin, and the canvas and the overlay root
 *     move by the fraction of a device px the artboard sits off the grid, the
 *     slide's origin back by as much — every text raster lands where the page
 *     rounds the same text (runText/placement.ts).
 *   - **A zoom-out gesture** that shows more of the world than the region
 *     holds lowers the resolution at once (a new transform, no
 *     reallocation, texts pinned to their rasters); the commit after the
 *     gesture gives everything the zoom's own resolution.
 */

/** How far the region reaches past the viewport on each side, as a share of it. */
export const MARGIN = 0.25

/** The most pixels the backing store holds (≈100 MB of VRAM); a bigger window's margin shrinks. */
export const MAX_BACKING_PIXELS = 25_000_000

export interface Size {
  width: number
  height: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The backing store for a viewport of `viewport` CSS px at `dpr`. */
export function backingFor(viewport: Size, dpr: number): Size {
  const w = Math.max(1, viewport.width) * dpr
  const h = Math.max(1, viewport.height) * dpr
  const wanted = 1 + 2 * MARGIN
  const room = Math.sqrt(MAX_BACKING_PIXELS / (w * h))
  const k = Math.max(Math.min(wanted, room), Math.min(1, room))
  return { width: Math.ceil(w * k), height: Math.ceil(h * k) }
}

/** The region `backing` covers at `resolution`, centred on `visible` (world CSS px), its corner on a whole device px. */
export function regionAround(visible: Box, backing: Size, resolution: number): Box {
  const width = backing.width / resolution
  const height = backing.height / resolution
  const x = Math.round((visible.x + visible.width / 2 - width / 2) * resolution) / resolution
  const y = Math.round((visible.y + visible.height / 2 - height / 2) * resolution) / resolution
  return { x, y, width, height }
}

/** Whether `region` holds all of `visible` (a hair of tolerance for float noise). */
export function regionHolds(region: Box, visible: Box): boolean {
  const e = 1e-3
  return (
    visible.x >= region.x - e &&
    visible.y >= region.y - e &&
    visible.x + visible.width <= region.x + region.width + e &&
    visible.y + visible.height <= region.y + region.height + e
  )
}

/**
 * The resolution at which `backing` covers `visible` with a little to spare
 * (a zoom-out gesture outgrowing the region), never above `resolution`.
 */
export function resolutionToHold(visible: Box, backing: Size, resolution: number): number {
  // Headroom: the region then holds the view with half its size to spare,
  // so a gesture that goes on zooming out lays the canvas out again only
  // every few steps, not every one (each is a draw in the gesture).
  const fit = Math.min(
    backing.width / Math.max(1, visible.width * 1.5),
    backing.height / Math.max(1, visible.height * 1.5),
  )
  return Math.min(resolution, fit)
}

/**
 * The fraction of a device px `v` (device px, read from DOMRects) sits off
 * the grid, to 1/4096 px: past the rects' float32 noise (≈1/8000 px at
 * 4000 px), well inside what decides a rounding. It was 1/64, "the layout's
 * precision" — but a zoomed artboard puts the world's origin at any fraction
 * (400 × 3.4903… px from the artboard's corner): at 349 % the phase came out
 * 0.140625 for 0.137187, and a baseline the page draws 0.0017 px past a half
 * was painted a device row higher (item A, 2026-10-28).
 */
export function gridFraction(v: number): number {
  // `+ 0`: a corner just under a whole px is on it, not at −0.
  return Math.round((v - Math.round(v)) * 4096) / 4096 + 0
}
