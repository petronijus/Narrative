/**
 * ui/useBoundsSettled.ts
 *
 * DOM overlays read object bounds from the SceneGraph at render time, but
 * nothing tells React when the reconciler has mounted a node: it applies
 * changes on its own rAF-batched subscription. An overlay that renders
 * first (a slide just switched, an object just created by a peer or an
 * agent) finds no bounds and — absent another re-render — stays empty.
 *
 * This hook checks once per animation frame while any of `ids` is
 * unresolved and re-renders its caller once they all resolve. It gives up
 * after a bounded number of frames, so an id that never mounts (deleted,
 * on another slide) cannot keep a frame loop alive.
 */

import { useEffect, useReducer } from 'react'
import type { SceneGraph } from '../renderer/SceneGraph.js'

/** Default budget: ~2 s at 60 Hz. */
const DEFAULT_MAX_FRAMES = 120

export function useBoundsSettled(
  sceneGraph: SceneGraph | null,
  ids: readonly string[],
  maxFrames: number = DEFAULT_MAX_FRAMES,
): void {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  // A stable key, so the effect restarts only when the set of ids changes.
  const key = ids.join('\u0000')

  useEffect(() => {
    if (sceneGraph === null || key === '') return
    const wanted = key.split('\u0000')
    let frames = 0
    let raf = 0
    const check = (): void => {
      if (wanted.every((id) => sceneGraph.getBounds(id) !== null)) {
        rerender()
        return
      }
      frames += 1
      if (frames >= maxFrames) return
      raf = requestAnimationFrame(check)
    }
    raf = requestAnimationFrame(check)
    return () => cancelAnimationFrame(raf)
  }, [sceneGraph, key, maxFrames])
}
