/**
 * state/slideDocContext.ts
 *
 * React context pro SlideDoc — v separátním souboru kvůli react-refresh.
 * Hooks a Provider importují z tohoto souboru.
 *
 * M6 update: mutationCtx je rozšířen na SlideMutationContext (obsahuje
 * objects i animations). Context consumers mají přístup k oběma mutations API.
 */

import { createContext } from 'react'
import type { SlideMutationContext } from '@narrative/slide-model'
import type * as Y from 'yjs'

export type WsStatus = 'connecting' | 'connected' | 'disconnected'

export interface SlideDocContextValue {
  mutationCtx: SlideMutationContext
  undoManager: Y.UndoManager
  wsStatus: WsStatus
}

export const SlideDocContext = createContext<SlideDocContextValue | null>(null)
