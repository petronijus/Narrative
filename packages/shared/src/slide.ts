/**
 * shared/src/slide.ts
 *
 * Discriminated union typů slide objektů + slide/deck interfaces.
 *
 * Pravidlo: tento soubor NESMÍ importovat nic runtime-specifického.
 * Žádný Yjs, žádný Pixi, žádný React. Pure TypeScript types only.
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
  /** Pixi/CSS color hex číslo, např. 0x4060e0 */
  fill: number
}

export interface EllipseObject extends BaseSlideObject {
  type: 'ellipse'
  /** Pixi/CSS color hex číslo */
  fill: number
}

export interface TextObject extends BaseSlideObject {
  type: 'text'
  text: string
  fontSize: number
  fontWeight: 'normal' | 'bold'
  /** Pixi/CSS color hex číslo, např. 0x000000 */
  color: number
  align: 'left' | 'center' | 'right'
}

export interface ImageObject extends BaseSlideObject {
  type: 'image'
  /**
   * Asset ID from media_assets table — stable reference to the uploaded original.
   * Callers MUST provide a valid assetId via createObjectOfType overrides after upload.
   * An empty string here means the object is a broken placeholder (upload pending).
   */
  assetId: string
  /**
   * Rendering variant the editor requests from imgproxy.
   * Renderer picks based on context; stored here so a slide can force-pin a variant.
   * Default: 'display' (1600w).
   */
  variant?: 'thumb' | 'display' | 'original'
  /**
   * Fit mode when the image's native aspect differs from the object's bounding box.
   * 'cover' = crop to fill (default), 'contain' = letterbox.
   */
  fit?: 'cover' | 'contain'
  /**
   * Optional alt text for accessibility / PDF export.
   */
  alt?: string
}

/**
 * SlideObject — discriminated union. switch(obj.type) pro type narrowing.
 */
export type SlideObject = RectangleObject | EllipseObject | TextObject | ImageObject

/** Typ string pro switch/lookup */
export type SlideObjectType = SlideObject['type']

/**
 * Partial patch pro update operace — vylučuje immutable fields id a type.
 */
export type SlideObjectPatch<T extends SlideObject> = Partial<Omit<T, 'id' | 'type'>>

/**
 * @deprecated Use Slide from deck.ts (M9 multi-slide schema).
 * Kept for reference only — removed from exports in M9.
 */
export interface LegacySingleSlide {
  id: string
  objects: SlideObject[]
}

/**
 * ObjectChangeSet — inkrementální diff dodaný state-sync agentem.
 *
 * Kontrakt: state-sync → renderer (applyChanges).
 * Nesmí se měnit bez schválení tech-leada (koordinace agentů).
 *
 * - added: nové objekty k přidání do scene graph
 * - removed: ID objektů k odstranění
 * - updated: patch-based updaty (jen změněné fields)
 * - snapshot: plná kolekce po aplikaci diff (pro bootstrap a debug)
 */
export interface ObjectChangeSet {
  added: SlideObject[]
  removed: string[]
  updated: Array<{ id: string; patch: Partial<SlideObject> }>
  snapshot: SlideObject[]
}
