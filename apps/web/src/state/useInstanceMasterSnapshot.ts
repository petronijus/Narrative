/**
 * state/useInstanceMasterSnapshot.ts
 *
 * M16 P7 — React hook the inspector uses to read a component instance's
 * master subtree.
 *
 * Why a dedicated hook (instead of reusing the renderer's path):
 *   The renderer holds its own per-node acquire/release pair scoped to the
 *   Pixi mount lifetime. The inspector lives in a different React tree
 *   (right panel) — it must drive its own ref-count or risk the cache
 *   tearing the doc down between renders. The hook handles both:
 *   acquire on mount, release on unmount, debounced re-renders on master
 *   changes via `subscribeToComponentDoc`.
 *
 * Returned status:
 *   - `'pending'`  — cache hasn't received its first sync round-trip yet,
 *                    OR the doc has no slides yet. Inspector shows a
 *                    "Loading master…" hint.
 *   - `'synced'`   — at least one slide present; `snapshot` is non-null.
 *   - `'missing'`  — synced but no slides → master was deleted server-side.
 *                    Inspector flips to the warning panel.
 *
 * Snapshot is the same plain-object shape extractComponentSnapshot
 * produces; `null` when status is not 'synced'.
 */

import { useEffect, useState } from 'react'
import {
  acquireComponentDoc,
  releaseComponentDoc,
  getComponentDoc,
  getComponentDocSyncStatus,
  subscribeToComponentDoc,
} from './componentDocCache.js'
import { extractComponentSnapshot, type ComponentSnapshot } from './extractComponentSnapshot.js'

export type InstanceMasterStatus = 'pending' | 'synced' | 'missing'

export interface InstanceMasterResult {
  status: InstanceMasterStatus
  snapshot: ComponentSnapshot | null
}

export function useInstanceMasterSnapshot(componentId: string | null): InstanceMasterResult {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (componentId === null) return undefined
    acquireComponentDoc(componentId)
    const unsub = subscribeToComponentDoc(componentId, () => {
      // The cache debounces via rAF — bumping the tick state nudges a
      // re-render so the next render reads the latest snapshot. Using
      // a counter rather than a ref-bound state means React can dedupe
      // identical bumps within the same render pass.
      setTick((t) => t + 1)
    })
    return () => {
      unsub()
      releaseComponentDoc(componentId)
    }
  }, [componentId])

  if (componentId === null) {
    return { status: 'pending', snapshot: null }
  }

  // tick is read here purely so React tracks the dependency — the actual
  // data lives in the cache. ESLint thinks tick is unused; reference it
  // via a void-expression so the eager-tree-shaker can't drop the read.
  void tick

  const cacheStatus = getComponentDocSyncStatus(componentId)
  if (cacheStatus !== 'synced') return { status: 'pending', snapshot: null }
  const doc = getComponentDoc(componentId)
  if (doc === null) return { status: 'missing', snapshot: null }
  const snapshot = extractComponentSnapshot(doc)
  if (snapshot === null) return { status: 'missing', snapshot: null }
  return { status: 'synced', snapshot }
}
