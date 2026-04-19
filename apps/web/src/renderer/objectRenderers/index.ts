/**
 * renderer/objectRenderers/index.ts
 *
 * Registr object rendererů.
 *
 * M1: Jednoduchý Map<type, renderer> lookup.
 * M2: Přechod na SlideObject z @narrative/shared. Ellipse a text renderers
 *     budou přidány renderer agentem v M2 fázi 2.
 * M2 phase 2+: Plná registerObjectType() API s inspector, schema, hitTest.
 */

import { rectangleRenderer } from './rectangleRenderer'
import type { Container } from 'pixi.js'
import type { SlideObject } from '@narrative/shared'

export interface ObjectRenderer<T extends SlideObject = SlideObject> {
  type: T['type']
  mount(data: T): Container
  update(node: Container, prev: T, next: T): void
  destroy(node: Container): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registr pojme různé generické varianty ObjectRenderer
const rendererRegistry = new Map<string, ObjectRenderer<any>>([['rectangle', rectangleRenderer]])

/**
 * Vrátí renderer pro daný type string, nebo undefined pokud typ není registrovaný.
 */
export function getRenderer(type: string): ObjectRenderer | undefined {
  return rendererRegistry.get(type)
}
