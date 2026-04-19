/**
 * renderer/objectRenderers/index.ts
 *
 * Registr object rendererů.
 *
 * M2 fáze 2a: Všechny tři typy registrovány — rectangle, ellipse, text.
 * Dispatch podle SlideObject.type přes getRenderer(type).
 *
 * M2 phase 2+: Plná registerObjectType() API s inspector, schema bude v M3+.
 */

import { rectangleRenderer } from './rectangleRenderer'
import { ellipseRenderer } from './ellipseRenderer'
import { textRenderer } from './textRenderer'
import type { Container } from 'pixi.js'
import type { SlideObject } from '@narrative/shared'

export interface ObjectRenderer<T extends SlideObject = SlideObject> {
  type: T['type']
  mount(data: T): Container
  update(node: Container, prev: T, next: T): void
  destroy(node: Container): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registr pojme různé generické varianty ObjectRenderer
const rendererRegistry = new Map<string, ObjectRenderer<any>>([
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
