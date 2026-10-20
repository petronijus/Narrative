/**
 * editor/snapGuidesStore.ts — the snap guides drawn during a drag, outside
 * React state (performance.md → E6).
 *
 * A drag on a crowded slide snaps to a different guide on most pointer moves.
 * As EditorLayout state, each new set re-rendered the whole editor; in this
 * store only the guide layer (`useSnapGuides`) renders. Ephemeral UI, never
 * document data.
 */

import { useSyncExternalStore } from 'react'
import { sameSnapGuides, type SnapGuide } from './snap.js'

export interface SnapGuidesStore {
  get(): SnapGuide[]
  /** Replace the guides; the same guides as now change nothing (no render). */
  set(next: SnapGuide[]): void
  subscribe(listener: () => void): () => void
}

export function createSnapGuidesStore(): SnapGuidesStore {
  let guides: SnapGuide[] = []
  const listeners = new Set<() => void>()
  return {
    get: () => guides,
    set(next) {
      if (sameSnapGuides(guides, next)) return
      guides = next
      for (const l of [...listeners]) l()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The guides of `store`, re-rendering the caller when they change. */
export function useSnapGuides(store: SnapGuidesStore): SnapGuide[] {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
