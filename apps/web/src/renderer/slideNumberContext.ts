/**
 * renderer/slideNumberContext.ts
 *
 * Module-level register of the slide number for whatever slide the
 * renderer is currently painting. Read by `textRenderer` when a
 * `TextObject.isSlideNumber` flag is set; the rendered text becomes
 * the live integer instead of the stored content.
 *
 * Why module-level?
 *   The Pixi `SceneGraph` only ever holds the active slide's objects at
 *   a time, so a single slot is enough for the editor + present mode.
 *   The thumbnail renderer paints one slide per call; it sets the
 *   number before each render and clears it after.
 */

let currentSlideNumber: number | undefined = undefined

export function setRenderingSlideNumber(n: number | undefined): void {
  currentSlideNumber = n
}

export function getRenderingSlideNumber(): number | undefined {
  return currentSlideNumber
}
