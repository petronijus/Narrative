/**
 * shared/src/slide.ts
 *
 * Discriminated union typů slide objektů + slide/deck interfaces.
 *
 * Pravidlo: tento soubor NESMÍ importovat nic runtime-specifického.
 * Žádný Yjs, žádný Pixi, žádný React. Pure TypeScript types only.
 */

/**
 * P5c: optional drop shadow. Applied as a DropShadowFilter on the
 * Pixi container of any object type that declares this mixin — so
 * shapes, text and images can all carry a shadow identically.
 */
export interface ShadowStyle {
  /** Shadow color hex. */
  color: number
  /** Shadow blur radius in slide-px (≥ 0). */
  blur: number
  /** Horizontal offset in slide-px. */
  offsetX: number
  /** Vertical offset in slide-px. */
  offsetY: number
  /** Overall shadow alpha 0..1. */
  opacity: number
}

export interface BaseSlideObject {
  id: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  /**
   * Authored display name (P5a). Optional. When set, the Inspector and the
   * layer list show this instead of the generic type label. Also feeds
   * Magic Move pairing via shared names across slides.
   */
  name?: string
  /**
   * Editor-only. Locked objects can't be picked by the Select tool, can't
   * be transformed (transform handles hide), and the Inspector renders
   * disabled inputs. Locked objects render normally in present mode and
   * still participate in animations. Toggled from the Inspector.
   */
  locked?: boolean
  /**
   * P5c: drop shadow. Missing ⇒ no shadow (no filter installed).
   */
  shadow?: ShadowStyle
  /**
   * P5c: gaussian blur radius in slide-px. 0 / missing ⇒ no blur.
   */
  blur?: number
  /**
   * P6: implicit group membership. Objects sharing a groupId are
   * selected, moved, duplicated, deleted as a unit. No dedicated group
   * object type — the attribute itself IS the grouping.
   */
  groupId?: string
}

/**
 * P5b: optional stroke + per-corner radius for filled shapes. Every field
 * is optional + missing ⇒ unchanged legacy behaviour (fill-only, no stroke,
 * sharp corners). Putting the stroke fields directly on the shape types
 * instead of a nested object keeps applyPatch call-sites trivial and
 * matches the existing line/arrow/path convention.
 */
export interface StrokeStyleFields {
  /** Stroke colour. Missing ⇒ no stroke. */
  stroke?: number
  /** Stroke width in slide-px. Rendered only when stroke is set. */
  strokeWidth?: number
  /** Dashed stroke pattern — true = dashed, false/undefined = solid. */
  strokeDash?: boolean
}

/**
 * P5b: rich fill variants. Missing `fillStyle` + present `fill: number`
 * keeps the legacy solid-colour path intact. When `fillStyle` is set it
 * takes precedence over `fill`, which is still stored so flipping the
 * picker back to "solid" has a sensible starting point.
 */
export interface FillGradientStop {
  /** Colour hex. */
  color: number
  /** Offset 0..1. */
  offset: number
}
export interface LinearGradientFill {
  kind: 'linearGradient'
  stops: FillGradientStop[]
  /** 0 = top-to-bottom, 90 = left-to-right, clockwise. */
  angleDeg: number
}
export interface RadialGradientFill {
  kind: 'radialGradient'
  stops: FillGradientStop[]
  /** Gradient centre as normalized object coord (0..1). Default 0.5, 0.5. */
  centerX?: number
  centerY?: number
}
/**
 * P5c: image fill — use an uploaded asset (from media_assets) as the
 * shape's fill instead of a solid colour or gradient. Texture is fetched
 * through the same imgproxy pipeline as ImageObject so variants + signed
 * URLs are shared. Cropped/scaled inside the shape according to `fit`:
 * 'cover' (default) fills the shape and crops overflow, 'contain'
 * letterboxes the image inside the shape.
 */
export interface ImageFillStyle {
  kind: 'image'
  assetId: string
  fit?: 'cover' | 'contain'
}

export type FillStyle = LinearGradientFill | RadialGradientFill | ImageFillStyle

export type CornerRadius =
  | number
  | {
      tl: number
      tr: number
      br: number
      bl: number
    }

export interface RectangleObject extends BaseSlideObject, StrokeStyleFields {
  type: 'rectangle'
  /** Solid fallback colour hex. Rendered only when fillStyle is not set. */
  fill: number
  /** Optional gradient / image fill. Takes precedence over `fill`. */
  fillStyle?: FillStyle
  /** Uniform or per-corner radius. Missing ⇒ 0 (sharp corners). */
  cornerRadius?: CornerRadius
}

export interface EllipseObject extends BaseSlideObject, StrokeStyleFields {
  type: 'ellipse'
  /** Solid fallback colour hex. */
  fill: number
  /** Optional gradient / image fill. Takes precedence over `fill`. */
  fillStyle?: FillStyle
}

/**
 * P4b: triangle and regular polygon share the same AABB-based
 * schema as Rectangle/Ellipse. `sides` controls the polygon — 3 for
 * a triangle (top-pointing equilateral), 4+ for regular n-gons.
 */
export interface TriangleObject extends BaseSlideObject, StrokeStyleFields {
  type: 'triangle'
  fill: number
  fillStyle?: FillStyle
}

export interface PolygonObject extends BaseSlideObject, StrokeStyleFields {
  type: 'polygon'
  fill: number
  fillStyle?: FillStyle
  /** Number of sides. Clamped to [3, 12] in the renderer. */
  sides: number
}

/**
 * P4b: line / arrow. Position (x,y) + width/height describe the AABB
 * of the two endpoints — individual endpoint offsets live in
 * `p1`/`p2` relative to (x,y), so a transform (move, rotate) on the
 * object just shifts those two anchors together.
 */
export interface LineEndpoints {
  /** First endpoint, relative to (x, y). */
  p1: { x: number; y: number }
  /** Second endpoint, relative to (x, y). */
  p2: { x: number; y: number }
}

export type LineCap = 'none' | 'round' | 'square' | 'arrow'

export interface LineObject extends BaseSlideObject, LineEndpoints {
  type: 'line'
  /** Stroke colour. */
  stroke: number
  /** Stroke width in slide-px. */
  strokeWidth: number
  startCap?: LineCap
  endCap?: LineCap
  /** Dashed stroke pattern — true = default dash, false/undefined = solid. */
  dash?: boolean
}

export interface ArrowObject extends BaseSlideObject, LineEndpoints {
  type: 'arrow'
  stroke: number
  strokeWidth: number
  startCap?: LineCap
  endCap?: LineCap
  dash?: boolean
}

/**
 * P4c: bezier path (pen tool output). Anchors live relative to
 * (x, y); each optional cpIn / cpOut is a cubic-bezier control point
 * relative to that anchor. Segments between two consecutive anchors
 * use a cubic curve when the outgoing anchor has cpOut and the
 * incoming has cpIn, otherwise a straight line.
 */
export interface PathAnchor {
  x: number
  y: number
  /** Incoming control handle, relative to this anchor. */
  cpIn?: { x: number; y: number }
  /** Outgoing control handle, relative to this anchor. */
  cpOut?: { x: number; y: number }
}

export interface PathObject extends BaseSlideObject {
  type: 'path'
  anchors: PathAnchor[]
  stroke: number
  strokeWidth: number
  /** Optional fill for a closed path. */
  fill?: number
  /** When true, last anchor connects back to the first. */
  closed?: boolean
  dash?: boolean
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

export interface VideoObject extends BaseSlideObject {
  type: 'video'
  /**
   * Asset ID from media_assets table. The asset's transcode_status determines
   * whether the video is playable — renderer must check before attempting HLS playback.
   * An empty string means the object is a broken placeholder (upload/transcode pending).
   */
  assetId: string
  /**
   * Fit mode within the object bounding box — same semantics as ImageObject.
   * Default: 'contain'.
   */
  fit?: 'cover' | 'contain'
  /**
   * Autoplay in present mode. Default: false.
   * Most browsers block autoplay with audio — pair with muted: true.
   */
  autoplay?: boolean
  /**
   * Loop playback in present mode. Default: false.
   */
  loop?: boolean
  /**
   * Mute audio. Default: true (browsers block autoplay with sound).
   */
  muted?: boolean
  /**
   * Accessibility alt text / video description.
   */
  alt?: string
}

/**
 * SlideObject — discriminated union. switch(obj.type) pro type narrowing.
 */
export type SlideObject =
  | RectangleObject
  | EllipseObject
  | TriangleObject
  | PolygonObject
  | LineObject
  | ArrowObject
  | PathObject
  | TextObject
  | ImageObject
  | VideoObject

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
