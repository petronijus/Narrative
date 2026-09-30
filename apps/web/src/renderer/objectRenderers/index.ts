/**
 * renderer/objectRenderers/index.ts
 *
 * Object renderer registry.
 *
 * M2 phase 2a: All three types registered — rectangle, ellipse, text.
 * M3: ObjectRenderer extended with optional applyPatch — surgical patch update.
 *     applyChanges in SceneGraph prefers applyPatch, falls back to update().
 * M11: Added 'image' renderer. ObjectRenderer extended with optional thumbnailMount —
 *      overrides mount() in thumbnail context. If not provided, mount() is used.
 *
 * Dispatch by SlideObject.type via getRenderer(type).
 */

import { rectangleRenderer } from './rectangleRenderer'
import { ellipseRenderer } from './ellipseRenderer'
import { textRenderer } from './textRenderer'
import { imageRenderer } from './imageRenderer'
import { videoRenderer } from './videoRenderer'
import { triangleRenderer, polygonRenderer } from './polygonRenderer'
import { lineRenderer, arrowRenderer } from './lineRenderer'
import { pathRenderer } from './pathRenderer'
import { tableRenderer } from './tableRenderer'
import type { Container } from 'pixi.js'
import type { SlideObject } from '@narrative/shared'

export interface ObjectRenderer<T extends SlideObject = SlideObject> {
  type: T['type']
  mount(data: T): Container
  /**
   * Full update — kept for backward compatibility.
   * Receives previous and next full object.
   * If renderer implements applyPatch, applyChanges prefers it.
   */
  update(node: Container, prev: T, next: T): void
  /**
   * Optional: patch-aware update — receives only changed fields.
   * More efficient: skips unchanged properties, minimises renderer work.
   * If implemented, applyChanges prefers it over update().
   */
  applyPatch?(node: Container, patch: Partial<T>): void
  /**
   * Optional: thumbnail-context mount override.
   * Called by ThumbnailRenderer instead of mount() to avoid costly async
   * operations (e.g. texture loads) in the offscreen render path.
   * If not provided, mount() is used for thumbnails as well.
   */
  thumbnailMount?(data: T): Container
  /**
   * Repaint every part of `node` whose colour this renderer resolves through
   * `resolveColour` (fills, strokes, text colours, table cells and borders)
   * from `data`, with the resolver installed now. Geometry, layout and text
   * content are unchanged — only what a colour-token resolution feeds.
   *
   * SceneGraph calls it when the colour resolver changes (the folder's tokens
   * arrived or changed: renderer/colourResolver.ts) for the nodes whose token
   * colours resolve differently now; nothing in their Yjs data changed, so
   * `update` / `applyPatch` would see no difference. The drop shadow is not
   * part of it: filterEffects owns that, for every object type alike.
   *
   * A renderer that resolves no colours of its own implements it as a no-op
   * and says why — it is required so a new renderer has to decide.
   */
  repaintColours(node: Container, data: T): void
  /**
   * Destroy the node and release any held resources.
   */
  destroy(node: Container): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry holds various generic ObjectRenderer variants
export const rendererRegistry = new Map<string, ObjectRenderer<any>>([
  ['rectangle', rectangleRenderer],
  ['ellipse', ellipseRenderer],
  ['triangle', triangleRenderer],
  ['polygon', polygonRenderer],
  ['line', lineRenderer],
  ['arrow', arrowRenderer],
  ['path', pathRenderer],
  ['table', tableRenderer as ObjectRenderer<SlideObject>],
  ['text', textRenderer],
  ['image', imageRenderer],
  ['video', videoRenderer as ObjectRenderer<SlideObject>],
])

/**
 * Returns the renderer for the given type string, or undefined if not registered.
 */
export function getRenderer(type: string): ObjectRenderer | undefined {
  return rendererRegistry.get(type)
}
