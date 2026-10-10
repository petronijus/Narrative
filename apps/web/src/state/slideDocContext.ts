/**
 * state/slideDocContext.ts
 *
 * React context for SlideDoc — in a separate file for react-refresh compliance.
 *
 * M9 update: context now exposes deckCtx (SlideMutationContext = { doc, slides })
 * instead of the old mutationCtx ({ doc, objects, animations }).
 *
 * Consumers must obtain per-slide scoped contexts via:
 *   getSlideObjectsCtx(deckCtx, activeSlideId)
 *   getSlideAnimationsCtx(deckCtx, activeSlideId)
 *
 * UndoManager tracks the top-level slides Y.Array (and all nested content).
 */

import { createContext } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { PeerUser } from '@narrative/shared'
import type * as Y from 'yjs'

export type WsStatus = 'connecting' | 'connected' | 'disconnected'

export interface SlideDocContextValue {
  /** Deck-level mutation context — holds doc + slides Y.Array. */
  deckCtx: SlideMutationContext
  undoManager: Y.UndoManager
  wsStatus: WsStatus
  /**
   * The server's state of the document has arrived (Hocuspocus `onSynced`);
   * always true for a local document. The render page (agentic A3) waits for
   * it before it calls a slide settled.
   */
  synced: boolean
  /** The server refused the connection (no access, revoked or expired token); never true locally. */
  refused: boolean
  /** Y.Awareness instance from HocuspocusProvider. Direct access for state hooks only. */
  awareness: Awareness
  /** Local user identity — deterministic from session ID. */
  localUser: PeerUser
  /**
   * The Hocuspocus document this context is synced to (a deck's name is its
   * id), or null for a local-only document (the component master editor).
   * Agent peers identify the user they work for by a key scoped to it
   * (ui/peerPresence.ts).
   */
  documentName: string | null
  /**
   * Which document this is, for things that must tell documents apart even
   * without a server connection (the object clipboard): the deck id, or
   * `component:<id>` for a component master.
   */
  documentKey: string
  /**
   * Resolves once the server holds every change made to this document so
   * far (state/providerSaved.ts); call it before a server write that reads
   * the document live, such as promoting objects to a component.
   */
  whenSaved: () => Promise<void>
}

export const SlideDocContext = createContext<SlideDocContextValue | null>(null)

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * createMockSlideDocValue — factory for test mock SlideDocContextValue.
 *
 * Shared across tests that mock SlideDocContext.
 * Adding new fields to SlideDocContextValue only requires updating this factory.
 *
 * @param overrides Partial overrides for specific fields.
 * @param slideCount Number of mock slides to pre-seed (default 1).
 */
export function createMockSlideDocValue(
  overrides?: Partial<SlideDocContextValue>,
  slideCount = 1,
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

  // Build mock slides Y.Array with slideCount entries
  const mockSlideIds: string[] = Array.from(
    { length: Math.max(1, slideCount) },
    (_, i) => `mock-slide-${i}`,
  )
  const mockSlides = {
    length: mockSlideIds.length,
    get: (i: number) => {
      const id = mockSlideIds[i] ?? `mock-slide-${i}`
      return {
        get: (key: string) => {
          if (key === 'id') return id
          if (key === 'objects')
            return {
              length: 0,
              get: () => undefined,
              observeDeep: () => {},
              unobserveDeep: () => {},
            }
          if (key === 'animations')
            return {
              length: 0,
              get: () => undefined,
              observeDeep: () => {},
              unobserveDeep: () => {},
            }
          if (key === 'transition')
            return {
              get: (k: string) => (k === 'kind' ? 'none' : k === 'durationMs' ? 0 : undefined),
            }
          return undefined
        },
      }
    },
    observe: () => {},
    unobserve: () => {},
    observeDeep: () => {},
    unobserveDeep: () => {},
    toArray: () => [],
    push: () => {},
    insert: () => {},
    delete: () => {},
  } as unknown as Y.Array<Y.Map<unknown>>

  const defaults: SlideDocContextValue = {
    deckCtx: {
      doc: mockDoc,
      slides: mockSlides,
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
    synced: true,
    refused: false,
    awareness: mockAwareness,
    documentName: null,
    documentKey: 'mock-deck',
    whenSaved: async () => {},
    localUser: {
      id: 'test-peer-id',
      name: 'User test',
      color: 'hsl(42, 70%, 55%)',
    },
  }

  return { ...defaults, ...overrides }
}
