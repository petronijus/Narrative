/**
 * ui/useTextLayoutTick.ts — re-render when a text box of the canvas is drawn
 * at a new height or type scale (`autofit`, agentic A4.2).
 *
 * Overlays that place themselves by `SceneGraph.getBounds` re-render as the
 * document changes; a growing box changes its drawn height without one
 * (an agent's text reflowed, a face that loaded late), so they listen here
 * too.
 */

import { useEffect, useState } from 'react'
import type { SceneGraph } from '../renderer/SceneGraph.js'

export function useTextLayoutTick(sceneGraph: SceneGraph | null): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (sceneGraph === null) return
    return sceneGraph.onTextLayout(() => setTick((n) => n + 1))
  }, [sceneGraph])
  return tick
}
