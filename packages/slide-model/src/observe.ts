/**
 * slide-model/src/observe.ts
 *
 * Observer helpers — subscribe na Y.Array changes pro React konzumenty.
 *
 * Perf note (TODO pro M3 reconciler):
 * Aktuálně provádíme full re-konverzi všech Y.Map na každou změnu.
 * To je O(n) na každý update. Pro M3 bude nahrazeno inkrementálním
 * diff reconcilerem, který zpracuje jen změněné objekty.
 */

import type { SlideObject } from '@narrative/shared'
import { yMapToPlainObject } from './bindings.js'
import type { MutationContext } from './mutations.js'

/**
 * Subscribeuje na změny objects array.
 * Callback je zavolán okamžitě se současným snapshotem,
 * pak na každou změnu (add/update/remove).
 *
 * Vrací unsubscribe funkci — zavolej při unmount.
 */
export function subscribeToObjects(
  ctx: MutationContext,
  callback: (objects: SlideObject[]) => void,
): () => void {
  // Helper pro snapshot všech objektů
  const getSnapshot = (): SlideObject[] => {
    const result: SlideObject[] = []
    for (let i = 0; i < ctx.objects.length; i++) {
      result.push(yMapToPlainObject(ctx.objects.get(i)))
    }
    return result
  }

  // Observer funkce — zavolána Yjs na každou změnu Y.Array nebo vnořených Y.Map
  const observer = () => {
    callback(getSnapshot())
  }

  // observeDeep zachytí i nested Y.Map updates (updateObject patches)
  ctx.objects.observeDeep(observer)

  // Inicializační callback se současným stavem
  callback(getSnapshot())

  // Vrátíme unsubscribe
  return () => {
    ctx.objects.unobserveDeep(observer)
  }
}
