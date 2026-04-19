/**
 * animation/targetResolver.ts
 *
 * M6: Implementace TargetResolver pro Pixi scene graph.
 *
 * Mostem mezi animation engine (packages/animation) a renderer SceneGraph.
 * GSAP animuje proxy objekt → apply() kopíruje stav na Pixi Container.
 *
 * DOM targets (text overlay, letter-by-letter) jsou M15.
 *
 * Proxy pattern (povinný pro Pixi v8):
 * GSAP nemůže spolehlivě animovat Pixi ObservablePoint (scale).
 * Proto animujeme flat proxy objekt a v apply() kopírujeme na Pixi.
 */

import type { TargetResolver, PixiTargetHandle } from '@narrative/animation'
import type { SceneGraph } from '../renderer/SceneGraph.js'

/**
 * Vytvoří TargetResolver napojený na SceneGraph.
 * Resolve je lazy — voláno každý frame pro daný objectId.
 * Pokud objekt neexistuje (nebyl přidán nebo byl smazán), vrátí null.
 */
export function createPixiTargetResolver(sceneGraph: SceneGraph): TargetResolver {
  return {
    resolve(objectId: string): PixiTargetHandle | null {
      const node = sceneGraph.getNode(objectId)
      if (node === undefined) return null

      const { container } = node

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

      return {
        kind: 'pixi',
        proxy,
        apply(): void {
          container.position.set(proxy.x, proxy.y)
          container.rotation = proxy.rotation
          container.alpha = proxy.alpha
          container.scale.set(proxy.scaleX, proxy.scaleY)
        },
      } satisfies PixiTargetHandle
    },
  }
}
