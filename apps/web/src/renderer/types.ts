/**
 * renderer/types.ts
 *
 * M2: Typy přesunuty do @narrative/shared. Tento soubor re-exportuje
 * pro zpětnou kompatibilitu ostatních renderer souborů.
 *
 * Import preferovaně z @narrative/shared přímo.
 */

export type {
  BaseSlideObject,
  RectangleObject,
  SlideObject as SlideObjectData,
  SlideObject,
} from '@narrative/shared'
