/**
 * renderer/objectRenderers/index.ts
 *
 * Registr object rendererů.
 *
 * M2 fáze 2a: Všechny tři typy registrovány — rectangle, ellipse, text.
 * M3: ObjectRenderer rozšířen o optional applyPatch — chirurgický patch update.
 *     applyChanges v SceneGraph preferuje applyPatch, fallback na update().
 *
 * Dispatch podle SlideObject.type přes getRenderer(type).
 */

import { rectangleRenderer } from './rectangleRenderer'
import { ellipseRenderer } from './ellipseRenderer'
import { textRenderer } from './textRenderer'
import type { Container } from 'pixi.js'
import type { SlideObject } from '@narrative/shared'

export interface ObjectRenderer<T extends SlideObject = SlideObject> {
  type: T['type']
  mount(data: T): Container
  /**
   * Full update — zůstává pro zpětnou kompatibilitu.
   * Dostane předchozí i nový plný objekt.
   * Pokud renderer implementuje applyPatch, applyChanges ho preferuje.
   */
  update(node: Container, prev: T, next: T): void
  /**
   * Optional: patch-aware update — dostane jen změněné fields.
   * Výkonnější: nečte neodchozené properties, minimalizuje práci rendererů.
   * Pokud renderer implementuje, applyChanges ho preferuje před update().
   */
  applyPatch?(node: Container, patch: Partial<T>): void
  destroy(node: Container): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registr pojme různé generické varianty ObjectRenderer
export const rendererRegistry = new Map<string, ObjectRenderer<any>>([
  ['rectangle', rectangleRenderer],
  ['ellipse', ellipseRenderer],
  ['text', textRenderer],
])

/**
 * Vrátí renderer pro daný type string, nebo undefined pokud typ není registrovaný.
 */
export function getRenderer(type: string): ObjectRenderer | undefined {
  return rendererRegistry.get(type)
}
