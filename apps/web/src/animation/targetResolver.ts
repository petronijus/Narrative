/**
 * animation/targetResolver.ts
 *
 * M6: Implementace TargetResolver pro Pixi scene graph.
 *
 * Most mezi animation engine (packages/animation) a renderer SceneGraph.
 * GSAP animuje proxy objekt → apply() kopíruje stav na Pixi Container.
 *
 * DOM targets (text overlay, letter-by-letter) jsou M15.
 *
 * Proxy pattern (povinný pro Pixi v8):
 * GSAP nemůže spolehlivě animovat Pixi ObservablePoint (scale).
 * Proto animujeme flat proxy objekt a v apply() kopírujeme na Pixi.
 *
 * M16 P8 — Component-instance leaves.
 *
 * The slide-level animation merger compiles every master animation step
 * with a SYNTHETIC target id of the form `instance:<instanceId>:<leafId>`.
 * The resolver routes those to the per-instance Pixi child container kept
 * in `componentInstanceRenderer`'s childMap (id-keyed reconcile from P6,
 * so the container reference is stable across master edits as long as the
 * leaf survives). Plain (non-prefixed) ids continue to resolve through
 * SceneGraph.getNode as before — instance-leaf routing is purely additive.
 */

import type { TargetResolver, PixiTargetHandle } from '@narrative/animation'
import type { Container } from 'pixi.js'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import { getInstanceLeafContainer } from '../renderer/objectRenderers/componentInstanceRenderer.js'
import { makeInstanceLeafTargetId, parseInstanceTargetId } from './instanceTargetIds.js'

// Re-export so existing imports continue to work.
export { makeInstanceLeafTargetId }

// ---------------------------------------------------------------------------
// Internal handle — extends PixiTargetHandle with the bound Container so
// the cache can detect a re-mount and rebuild the proxy. (Public
// PixiTargetHandle stays slim — engine-side code never sees the extra slot.)
// ---------------------------------------------------------------------------

interface InternalHandle extends PixiTargetHandle {
  container: Container
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Vytvoří TargetResolver napojený na SceneGraph.
 * Resolve je lazy — voláno při kompilaci každého AnimationStep.
 * Pokud objekt neexistuje (nebyl přidán nebo byl smazán), vrátí null.
 *
 * M15: Proxy je per-target cachovaný uvnitř jednoho resolveru. Dva
 * AnimationStepy na stejném targetu tak sdílí jeden proxy + jednu apply
 * funkci. Bez sdílení by každá animace měla svůj proxy s vlastní kopií
 * ostatních properties — a apply() druhé animace by přepisovala
 * container hodnoty, které právě zapsala první animace (např. fadeIn
 * zapíše scaleX=1 ze svého proxy přes wipeIn.scaleX=0.5).
 *
 * M16 P8: cache key je raw target id (string), takže synthetic
 * `instance:<i>:<l>` ids dostávají vlastní handle nezávisle na slide-level
 * Pixi ids — různé instance stejného master leafu nesdílí stav, což je
 * správně (každá instance má svůj container).
 *
 * Pokud po reconcile vznikne pro daný leaf nový container (master swap,
 * detach + remount), invalidujeme cached handle porovnáním container
 * reference. Bez toho by GSAP zapisoval na destroyed container.
 */
export function createPixiTargetResolver(sceneGraph: SceneGraph): TargetResolver {
  const cache = new Map<string, InternalHandle>()

  function buildHandle(targetId: string, container: Container): InternalHandle {
    // Proxy inicializován z Pixi containeru (ne z node.data).
    // Důvod: apply() zapisuje proxy zpět na container, takže proxy.x musí
    // sémanticky odpovídat container.x. Pro rectangleRenderer je
    // container.x = data.x + pivot.x (pivot na středu), ne data.x.
    // Kdybychom použili data.x, apply by posunul container o -pivot.x.
    const proxy = {
      x: container.x,
      y: container.y,
      rotation: container.rotation,
      alpha: container.alpha,
      scaleX: container.scale.x,
      scaleY: container.scale.y,
    }
    const handle: InternalHandle = {
      kind: 'pixi',
      proxy,
      apply(): void {
        container.position.set(proxy.x, proxy.y)
        container.rotation = proxy.rotation
        container.alpha = proxy.alpha
        container.scale.set(proxy.scaleX, proxy.scaleY)
      },
      container,
    }
    cache.set(targetId, handle)
    return handle
  }

  function resolveContainer(targetId: string): Container | null {
    const parsed = parseInstanceTargetId(targetId)
    if (parsed !== null) {
      const instanceNode = sceneGraph.getNode(parsed.instanceId)
      if (instanceNode === undefined) return null
      return getInstanceLeafContainer(instanceNode.container, parsed.leafId)
    }
    const node = sceneGraph.getNode(targetId)
    return node === undefined ? null : node.container
  }

  return {
    resolve(targetId: string): PixiTargetHandle | null {
      const container = resolveContainer(targetId)
      if (container === null) {
        cache.delete(targetId)
        return null
      }
      const cached = cache.get(targetId)
      if (cached !== undefined && cached.container === container) {
        return cached
      }
      // First resolve OR the underlying container was swapped (master
      // detach + remount, instance re-target). Build a fresh handle —
      // the old one is dropped along with the cache entry.
      return buildHandle(targetId, container)
    },
  }
}
