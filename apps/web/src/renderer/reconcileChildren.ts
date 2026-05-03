/**
 * renderer/reconcileChildren.ts
 *
 * Generic id-keyed list reconciler over a renderer registry.
 *
 * Used by the componentInstance renderer (M16 P6) to diff a master subtree
 * snapshot against the previous render. Pulled out of the renderer so the
 * deck-level reconciler can adopt the same algorithm in a future cleanup
 * (currently SceneGraph rolls its own diff in `applyChanges` — different
 * input shape, same idea).
 *
 * Algorithm:
 *   1. Index nextList by id.
 *   2. For each entry in prevList:
 *        - missing in next   → registry.destroy
 *        - present in next   → registry.update (full update, not patch)
 *   3. For each entry in next not seen in prev → registry.mount + addChild.
 *   4. After all mounts/updates, walk next in order and call setChildIndex
 *      to align Pixi z-order with snapshot order.
 *
 * Returns a fresh Map<id, Container> the caller can hold onto for the
 * next reconciliation pass.
 *
 * Performance: O(prev + next) including the final z-order pass.
 */

import type { Container } from 'pixi.js'
import type { SlideObject } from '@narrative/shared'
import type { ObjectRenderer } from './objectRenderers'

export interface ReconcileRegistry {
  /** Resolve a renderer by SlideObject.type. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry is heterogeneous over renderer<T>
  get(type: string): ObjectRenderer<any> | undefined
}

export interface ReconcileResult {
  /** Container map keyed by object id, post-reconciliation. */
  containers: Map<string, Container>
}

export function reconcileChildren(
  parent: Container,
  prevContainers: ReadonlyMap<string, Container>,
  prevList: ReadonlyArray<SlideObject>,
  nextList: ReadonlyArray<SlideObject>,
  registry: ReconcileRegistry,
): ReconcileResult {
  // Index inputs by id for O(1) lookup.
  const prevById = new Map<string, SlideObject>()
  for (const obj of prevList) prevById.set(obj.id, obj)

  const nextById = new Map<string, SlideObject>()
  for (const obj of nextList) nextById.set(obj.id, obj)

  const containers = new Map<string, Container>()

  // Pass 1 — destroy removed, update kept.
  for (const [id, prev] of prevById) {
    const next = nextById.get(id)
    const node = prevContainers.get(id)
    if (node === undefined) continue
    if (next === undefined) {
      const renderer = registry.get(prev.type)
      try {
        if (parent.children.includes(node)) parent.removeChild(node)
      } catch {
        // ignore — node may have been destroyed already
      }
      try {
        renderer?.destroy(node)
      } catch {
        // swallow — best-effort teardown
      }
      continue
    }
    // Keep — update path. If type changed, treat as remount.
    if (prev.type !== next.type) {
      const prevRenderer = registry.get(prev.type)
      try {
        if (parent.children.includes(node)) parent.removeChild(node)
      } catch {
        // ignore
      }
      try {
        prevRenderer?.destroy(node)
      } catch {
        // ignore
      }
      const nextRenderer = registry.get(next.type)
      if (nextRenderer !== undefined) {
        const fresh = nextRenderer.mount(next)
        parent.addChild(fresh)
        containers.set(id, fresh)
      }
      continue
    }
    const renderer = registry.get(next.type)
    if (renderer !== undefined) {
      try {
        renderer.update(node, prev, next)
      } catch {
        // best-effort — keep the previous container so the rest of the
        // reconciliation still proceeds.
      }
    }
    containers.set(id, node)
  }

  // Pass 2 — mount additions.
  for (const next of nextList) {
    if (containers.has(next.id)) continue
    if (prevById.has(next.id)) continue // Already handled above.
    const renderer = registry.get(next.type)
    if (renderer === undefined) continue
    const node = renderer.mount(next)
    parent.addChild(node)
    containers.set(next.id, node)
  }

  // Pass 3 — z-order pass: align Pixi child order with nextList order.
  // The instance container may have non-master children (e.g. selection
  // overlays added by the editor) — we only re-index the children we own.
  for (let i = 0; i < nextList.length; i++) {
    const obj = nextList[i]
    if (obj === undefined) continue
    const node = containers.get(obj.id)
    if (node === undefined) continue
    const currentIdx = parent.getChildIndex(node)
    if (currentIdx !== i && i < parent.children.length) {
      try {
        parent.setChildIndex(node, i)
      } catch {
        // ignore — Pixi throws if the index is out of range; the next
        // tick will retry once mounts settle.
      }
    }
  }

  return { containers }
}
