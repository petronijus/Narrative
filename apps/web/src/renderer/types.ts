/**
 * renderer/types.ts
 *
 * M2: Typy přesunuty do @narrative/shared. Tento soubor re-exportuje
 * pro zpětnou kompatibilitu ostatních renderer souborů.
 *
 * Import preferovaně z @narrative/shared přímo.
 *
 * M7: Přidán ObjectBounds — public bounds API pro editor-ui (selection outline,
 *     transform handles, marquee collision).
 */

export type {
  BaseSlideObject,
  RectangleObject,
  EllipseObject,
  TextObject,
  ImageObject,
  SlideObject as SlideObjectData,
  SlideObject,
} from '@narrative/shared'

/**
 * Bounds objektu v různých souřadnicových systémech.
 * Vráceno metodami SceneGraph.getBounds() a SceneGraph.getMultiBounds().
 *
 * Použití v editor-ui:
 * - world.x/y/width/height → AABB pro marquee collision a viewport culling
 * - corners → transform handle positioning (TL, TR, BR, BL po otočení)
 * - center → středový bod pro rotation pivot handle
 * - rotation → aktuální rotace objektu v radiánech
 */
export interface ObjectBounds {
  /** AABB v world coords — bounding box rotovaného obdélníku, axis-aligned. */
  world: { x: number; y: number; width: number; height: number }
  /**
   * Corner positions v world coords — TL, TR, BR, BL (clockwise z top-left).
   * Pro rotation=0 odpovídají rohům AABB.
   */
  corners: Array<{ x: number; y: number }>
  /** Střed objektu v world coords (container.x / container.y — pivot offset). */
  center: { x: number; y: number }
  /** Rotace v radiánech (container.rotation). */
  rotation: number
}
