/**
 * renderer/types.ts
 *
 * Discriminated union pro slide objekty + render context typy.
 *
 * M1: Pouze 'rectangle'. V M2 se tento soubor přesune do packages/shared/
 * a rozšíří o ellipse, text, image a další typy registrované přes objectTypeRegistry.
 */

export interface BaseSlideObject {
  id: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
}

export interface RectangleObject extends BaseSlideObject {
  type: 'rectangle'
  /** Pixi color hex číslo, např. 0x4060e0 */
  fill: number
}

/**
 * SlideObjectData — discriminated union. Každý budoucí typ přidá svůj branch sem.
 * Type guard: switch(obj.type) { case 'rectangle': ... }
 */
export type SlideObjectData = RectangleObject
