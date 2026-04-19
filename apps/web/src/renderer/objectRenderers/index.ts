/**
 * renderer/objectRenderers/index.ts
 *
 * Zjednodušený registr object rendererů pro M1.
 *
 * M2: Tento registr se přesune do state-sync package jako plný registerObjectType()
 * s inspector, schema, hitTest a dalšími properties.
 *
 * Aktuálně: jednoduchý Map<type, renderer> lookup.
 */

import { rectangleRenderer } from './rectangleRenderer'
import type { Container } from 'pixi.js'
import type { SlideObjectData } from '../types'

export interface ObjectRenderer<T extends SlideObjectData = SlideObjectData> {
  type: T['type']
  mount(data: T): Container
  update(node: Container, prev: T, next: T): void
  destroy(node: Container): void
}

// Registr je typed jako Map s obecnějším typem — konkrétní renderers jsou typovány interně
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registr musí pojmout různé generické varianty ObjectRenderer
const rendererRegistry = new Map<string, ObjectRenderer<any>>([['rectangle', rectangleRenderer]])

/**
 * Vrátí renderer pro daný type string, nebo undefined pokud typ není registrovaný.
 */
export function getRenderer(type: string): ObjectRenderer | undefined {
  return rendererRegistry.get(type)
}
