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

      const { container, data } = node

      // Proxy inicializován z Y.Doc snapshot (node.data), ne z container.x/y.
      // Důvod: pokud se runtime re-creates (user re-enters present, animations array
      // se změní mid-play), container může být uprostřed předchozí animace — jeho
      // position je mid-tween value, ne Y.Doc truth. slideIn preset čte proxy.x
      // jako target end position — pokud by byla mid-tween, animace by skončila
      // na špatném místě. node.data drží Y.Doc snapshot (sync v applyChanges).
      //
      // Scale a rotation nejsou v Y.Doc state model (M7 přidá transform handles),
      // zatím čteme z containeru — pro default (1, 1, 0) je to shodné.
      const proxy = {
        x: data.x,
        y: data.y,
        rotation: data.rotation,
        alpha: data.opacity,
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
