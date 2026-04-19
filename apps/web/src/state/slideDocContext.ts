/**
 * state/slideDocContext.ts
 *
 * React context pro SlideDoc — v separátním souboru kvůli react-refresh.
 * Hooks a Provider importují z tohoto souboru.
 *
 * M6 update: mutationCtx je rozšířen na SlideMutationContext (obsahuje
 * objects i animations). Context consumers mají přístup k oběma mutations API.
 *
 * M8 update: přidány awareness + localUser (per-session peer identity).
 */

import { createContext } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { PeerUser } from '@narrative/shared'
import type * as Y from 'yjs'

export type WsStatus = 'connecting' | 'connected' | 'disconnected'

export interface SlideDocContextValue {
  mutationCtx: SlideMutationContext
  undoManager: Y.UndoManager
  wsStatus: WsStatus
  /** Y.Awareness instance z HocuspocusProvider. Přímý přístup pouze pro hooks v apps/web/state. */
  awareness: Awareness
  /** Lokální user identity — deterministická z session ID. */
  localUser: PeerUser
}

export const SlideDocContext = createContext<SlideDocContextValue | null>(null)

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * createMockSlideDocValue — factory pro testovací mock SlideDocContextValue.
 *
 * Sdílí se mezi všemi testy které mockují SlideDocContext, aby bylo jasné
 * jaké fields existují a aby přidání nového field v M8+ nerozlámalo testy.
 */
export function createMockSlideDocValue(
  overrides?: Partial<SlideDocContextValue>,
): SlideDocContextValue {
  const mockAwareness = {
    on: () => {},
    off: () => {},
    setLocalState: () => {},
    getLocalState: () => null,
    getStates: () => new Map(),
    clientID: 1,
  } as unknown as Awareness

  const mockDoc = {} as unknown as Y.Doc
  const mockObjects = {
    toArray: () => [],
    observe: () => {},
    unobserve: () => {},
  } as unknown as Y.Array<Y.Map<unknown>>
  const mockAnimations = mockObjects

  const defaults: SlideDocContextValue = {
    mutationCtx: {
      doc: mockDoc,
      objects: mockObjects,
      animations: mockAnimations,
    },
    undoManager: {
      undo: () => {},
      redo: () => {},
      on: () => {},
      off: () => {},
      canUndo: () => false,
      canRedo: () => false,
    } as unknown as Y.UndoManager,
    wsStatus: 'connected',
    awareness: mockAwareness,
    localUser: {
      id: 'test-peer-id',
      name: 'User test',
      color: 'hsl(42, 70%, 55%)',
    },
  }

  return { ...defaults, ...overrides }
}
