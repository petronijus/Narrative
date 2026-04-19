/**
 * state/slideDocContext.ts
 *
 * React context pro SlideDoc — v separátním souboru kvůli react-refresh.
 * Hooks a Provider importují z tohoto souboru.
 */

import { createContext } from 'react'
import type { MutationContext } from '@narrative/slide-model'
import type * as Y from 'yjs'

export interface SlideDocContextValue {
  mutationCtx: MutationContext
  undoManager: Y.UndoManager
}

export const SlideDocContext = createContext<SlideDocContextValue | null>(null)
