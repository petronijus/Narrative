/**
 * renderer/CanvasInstanceContext.tsx
 *
 * M6: the context that hands the canvas's internals (SceneGraph,
 * OverlayCompositor) to PresentLayout and the other consumers outside
 * Canvas.tsx.
 *
 * Strategy (option B — ref forwarding + state lifting):
 * - Canvas.tsx gets an `onReady` callback prop.
 * - DeckShell.tsx keeps the `canvasInstance` state and passes it to
 *   CanvasInstanceContext.Provider.
 * - Consumers (PresentLayout, the editor preview) read the instance through
 *   useCanvasInstance().
 *
 * Lifecycle:
 * - The context value is null until Pixi has initialised.
 * - useCanvasInstance() returns null while the canvas is not ready.
 * - On unmount Canvas.tsx calls onReady(null) and the context goes back to null.
 */

import { createContext, useContext } from 'react'
import type { SceneGraph } from './SceneGraph.js'
import type { OverlayCompositor } from './overlay/OverlayCompositor.js'

export interface CanvasInstance {
  sceneGraph: SceneGraph
  compositor: OverlayCompositor
  /** The device px per CSS px the canvas draws for (the window's, or the one its owner set). */
  pixelRatio(): number
  /**
   * Switch the canvas to `ratio` device px per CSS px — laid out through its
   * region (ADR 0020), drawn before the calling task ends, no text restaged
   * (the texts on stage keep their rasters). For a canvas made with
   * `followPixelRatio={false}` (present mode's DensityHandover, ADR 0020 →
   * Present mode); throws on one that follows the window itself. Pictures
   * choose their variants for the new ratio once the caller says so
   * (`sceneGraph.setPixelDensity`).
   */
  setPixelRatio(ratio: number): void
  /**
   * Texts are about to be prepared for `ratio` while the canvas still draws
   * at its current one (present mode's standby set): rasterised at the
   * returned `resolution` — the one `setPixelRatio(ratio)` will give the
   * canvas — they are placed on the device grid the canvas will have then,
   * as a canvas opened at `ratio` places them (canvasRegionController.ts →
   * prepareFor). `moved` is told when a layout before the switch moved that
   * grid (the rasters prepared so far are off it). Ends with the switch to
   * `ratio`, or with `release`. For a canvas made with
   * `followPixelRatio={false}`.
   */
  preparePixelRatio(ratio: number, moved: () => void): { resolution: number; release: () => void }
}

export const CanvasInstanceContext = createContext<CanvasInstance | null>(null)

/**
 * The CanvasInstance of the surrounding canvas: null until the canvas is
 * ready (Pixi initialises asynchronously).
 */
export function useCanvasInstance(): CanvasInstance | null {
  return useContext(CanvasInstanceContext)
}
