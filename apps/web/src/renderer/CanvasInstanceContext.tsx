/**
 * renderer/CanvasInstanceContext.tsx
 *
 * M6: Context pro exposování Canvas internals (SceneGraph + OverlayCompositor)
 * do PresentLayout a dalších konzumentů mimo Canvas.tsx.
 *
 * Strategie (varianta B — ref forwarding + state lifting):
 * - Canvas.tsx obdrží `onReady` callback prop.
 * - DeckShell.tsx drží `canvasInstance` state a pasuje ho do CanvasInstanceContext.Provider.
 * - Konzumenti (PresentLayout, editor preview) čtou instance přes useCanvasInstance().
 *
 * Lifecycle:
 * - Context value je null dokud Pixi neinicializuje.
 * - useCanvasInstance() vrátí null pokud Canvas ještě není ready.
 * - Po unmount Canvas.tsx volá onReady(null) → context se nuluje.
 */

import { createContext, useContext } from 'react'
import type { SceneGraph } from './SceneGraph.js'
import type { OverlayCompositor } from './overlay/OverlayCompositor.js'

export interface CanvasInstance {
  sceneGraph: SceneGraph
  compositor: OverlayCompositor
}

export const CanvasInstanceContext = createContext<CanvasInstance | null>(null)

/**
 * Hook pro čtení CanvasInstance.
 * Vrátí null pokud Canvas ještě není ready (async Pixi init).
 */
export function useCanvasInstance(): CanvasInstance | null {
  return useContext(CanvasInstanceContext)
}
