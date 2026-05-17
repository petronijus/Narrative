/**
 * shared/src/slide.ts
 *
 * Discriminated union of slide-object types + slide/deck interfaces.
 *
 * Rule: this file MUST NOT import any runtime code. Yjs type-only
 * imports are allowed (they are erased at compile time and don't
 * pull the runtime in). No Pixi, no React.
 */

import type * as Y from 'yjs'

// ---------------------------------------------------------------------------
// M16 P2 — Design token reference
// ---------------------------------------------------------------------------

/**
 * A symbolic reference to a design token stored in the parent folder's Y.Doc.
 * Format: `{ $token: "<category>.<id>" }`
 * Example: `{ $token: "colors.abc1234567" }`
 *
 * Accepted categories: `colors` | `textStyles` | `effectStyles`.
 * The id is the nanoid(10) generated when the token was created.
 *
 * When a field typed `number | TokenRef` holds a TokenRef, the renderer
 * resolves it via `TokensContext.resolve()` before painting.  The literal
 * `number` is always kept in parallel as a fallback (last-known value) so
 * the object renders correctly when the folder doc is not yet synced.
 */
export interface TokenRef {
  $token: string
}

/**
 * Type guard — returns true when `v` is a `TokenRef` object.
 */
export function isTokenRef(v: unknown): v is TokenRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    '$token' in v &&
    typeof (v as Record<string, unknown>)['$token'] === 'string'
  )
}

/**
 * P5c: optional drop shadow. Applied as a DropShadowFilter on the
 * Pixi container of any object type that declares this mixin — so
 * shapes, text and images can all carry a shadow identically.
 */
/**
 * P11: hyperlink target attached to any object. In present mode, a click on
 * a hyperlinked object navigates instead of advancing the timeline.
 *
 * - 'slide' → jump to the deck slide whose id matches `slideId`.
 * - 'url'   → open `href` in the named browsing context (`_blank` default).
 */
export type ObjectHyperlink =
  | { kind: 'slide'; slideId: string }
  | { kind: 'url'; href: string; target?: '_self' | '_blank' }

export interface ShadowStyle {
  /** Shadow color hex or token ref. */
  color: number | TokenRef
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
  /**
   * P11: optional hyperlink target. Present mode intercepts clicks on
   * hyperlinked objects BEFORE animation triggers fire, so a hyperlink
   * navigates instead of advancing the slide timeline. Editor inspector
   * surfaces the field via a "Link" section.
   */
  hyperlink?: ObjectHyperlink
  /**
   * P15: per-object aspect-ratio lock for transform-handle resizing.
   * When `true`, corner drags preserve the original W:H ratio; holding
   * Shift inverts (releases) it. When unset / `false`, resize is free
   * and Shift inverts (locks) it. Toggled from the chain icon between
   * the Width and Height fields in the Inspector's Size section.
   */
  aspectLocked?: boolean
  /**
   * P16: horizontal flip — mirror the object across its vertical centre
   * axis. Implemented in the renderer via `container.scale.x = -1` with
   * the existing center pivot, so the centre stays put and rotation
   * still rotates around the same anchor. Missing ⇒ not flipped.
   */
  flipH?: boolean
  /**
   * P16: vertical flip — mirror across the horizontal centre axis.
   * Same mechanism as `flipH` but on `scale.y`.
   */
  flipV?: boolean
}

/**
 * P5b: optional stroke + per-corner radius for filled shapes. Every field
 * is optional + missing ⇒ unchanged legacy behaviour (fill-only, no stroke,
 * sharp corners). Putting the stroke fields directly on the shape types
 * instead of a nested object keeps applyPatch call-sites trivial and
 * matches the existing line/arrow/path convention.
 */
export interface StrokeStyleFields {
  /** Stroke colour or token ref. Missing ⇒ no stroke. */
  stroke?: number | TokenRef
  /** Stroke width in slide-px. Rendered only when stroke is set. */
  strokeWidth?: number
  /** Dashed stroke pattern — true = dashed, false/undefined = solid. */
  strokeDash?: boolean
  /** Stroke alpha 0..1. Missing ⇒ 1 (fully opaque). */
  strokeAlpha?: number
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
  /** Alpha 0..1. Missing ⇒ 1 (fully opaque). */
  alpha?: number
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
  /** Solid fallback colour hex or token ref. Rendered only when fillStyle is not set. */
  fill: number | TokenRef
  /** Fill alpha 0..1. Missing ⇒ 1. */
  fillAlpha?: number
  /** Optional gradient / image fill. Takes precedence over `fill`. */
  fillStyle?: FillStyle
  /** Uniform or per-corner radius. Missing ⇒ 0 (sharp corners). */
  cornerRadius?: CornerRadius
}

export interface EllipseObject extends BaseSlideObject, StrokeStyleFields {
  type: 'ellipse'
  /** Solid fallback colour hex or token ref. */
  fill: number | TokenRef
  /** Fill alpha 0..1. Missing ⇒ 1. */
  fillAlpha?: number
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
  fill: number | TokenRef
  fillAlpha?: number
  fillStyle?: FillStyle
}

export interface PolygonObject extends BaseSlideObject, StrokeStyleFields {
  type: 'polygon'
  fill: number | TokenRef
  fillAlpha?: number
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
  /** Stroke colour or token ref. */
  stroke: number | TokenRef
  /** Stroke alpha 0..1. Missing ⇒ 1. */
  strokeAlpha?: number
  /** Stroke width in slide-px. */
  strokeWidth: number
  startCap?: LineCap
  endCap?: LineCap
  /** Dashed stroke pattern — true = default dash, false/undefined = solid. */
  dash?: boolean
}

export interface ArrowObject extends BaseSlideObject, LineEndpoints {
  type: 'arrow'
  stroke: number | TokenRef
  strokeAlpha?: number
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
  stroke: number | TokenRef
  strokeAlpha?: number
  strokeWidth: number
  /** Optional fill for a closed path. */
  fill?: number | TokenRef
  fillAlpha?: number
  /**
   * Optional gradient or image fill — same schema as the parametric
   * shapes. When set, takes precedence over `fill` (which becomes the
   * fallback colour while an image fill is loading). Closed paths only.
   */
  fillStyle?: FillStyle
  /** When true, last anchor connects back to the first. */
  closed?: boolean
  dash?: boolean
}

/**
 * P7: broader weight scale than the original `'normal' | 'bold'`. Numeric
 * values match CSS / Pixi conventions — `normal` is 400, `bold` is 700.
 * Legacy 'normal' / 'bold' strings are accepted so existing Y.Docs keep
 * rendering without migration.
 */
export type FontWeight = 'normal' | 'bold' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900

export type TextVerticalAlign = 'top' | 'middle' | 'bottom'
export type TextListStyle = 'bullet' | 'numbered'

export interface TextObject extends BaseSlideObject {
  type: 'text'
  /**
   * Text body. New objects use a `Y.Text` so collaborators can carry
   * inline formatting (italic / underline / fontWeight / color) as
   * Quill-style attributes on character ranges. Existing decks loaded
   * from disk may still have `text: string` until the next mutation
   * promotes it to `Y.Text` (see slide-model `addObject` /
   * `updateObject`).
   */
  text: string | Y.Text
  fontSize: number
  fontWeight: FontWeight
  /** Default color for runs whose own attribute does not override it. May be a token ref. */
  color: number | TokenRef
  /** Text fill alpha 0..1. Missing ⇒ 1. */
  colorAlpha?: number
  align: 'left' | 'center' | 'right'
  /**
   * P7: font family. Missing ⇒ renderer default
   * (`system-ui, -apple-system, sans-serif`). Value is a full CSS
   * font-family string so the Inspector can offer curated presets while
   * still letting power users type their own stack.
   */
  fontFamily?: string
  /** Vertical alignment inside the text box. Default 'top'. */
  vAlign?: TextVerticalAlign
  /**
   * Line-height multiplier (1 = font size, 1.4 = typical body). Pixi's
   * TextStyle expects absolute lineHeight in px — renderer multiplies
   * by fontSize.
   */
  lineHeight?: number
  /** Letter spacing in px. Default 0. */
  letterSpacing?: number
  /** Vertical space inserted ABOVE each paragraph, in px. Default 0. */
  paragraphSpaceBefore?: number
  /** Vertical space inserted BELOW each paragraph, in px. Default 0. */
  paragraphSpaceAfter?: number
  /**
   * Visual case transform — applied at render time only, the underlying
   * text content stays untouched (so editing in-place still shows the
   * original casing). Maps directly to CSS `text-transform`.
   */
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  /**
   * When this object is linked to a folder text style via `textStyleId`,
   * this list records every typography field the user has hand-tweaked
   * since applying the preset. Edits to the underlying token in folder
   * settings propagate to non-overridden fields only — the override
   * list is what makes "preset bumped to size 50, but my one-off size
   * 30 stays" work. "Reset to preset" wipes this back to empty.
   */
  textStyleOverrides?: Array<TextStyleOverrideKey>
  /**
   * Default italic for runs whose own attribute does not override it.
   * Pixi maps to `font-style: italic`. Missing ⇒ upright.
   */
  italic?: boolean
  /**
   * Default underline for runs whose own attribute does not override it.
   * Rendered via the HTMLText `<u>` element.
   */
  underline?: boolean
  /**
   * List marker — 'bullet' for •, 'numbered' for 1. 2. 3. Missing ⇒
   * plain paragraph. Renderer prepends the glyph per line.
   */
  listStyle?: TextListStyle
  /** Optional stroke on glyphs. May be a token ref. */
  stroke?: number | TokenRef
  /** Stroke alpha 0..1. Missing ⇒ 1. */
  strokeAlpha?: number
  /** Stroke width in px. Rendered only when stroke is set. Default 1. */
  strokeWidth?: number
  /**
   * Page-number field. When true, the renderer ignores `text` and instead
   * displays the live slide number of the slide hosting this object (or the
   * slide hosting the component instance, when this leaf lives inside one).
   * Counter walks the deck in order and skips slides flagged `skipped`.
   * Styling (font, size, color, alignment, transform, etc.) is honoured
   * normally — only the text content is overridden at render time.
   */
  isSlideNumber?: boolean
}

/** Keys of TextObject typography fields that participate in preset binding. */
export type TextStyleOverrideKey =
  | 'fontFamily'
  | 'fontWeight'
  | 'fontSize'
  | 'lineHeight'
  | 'letterSpacing'
  | 'paragraphSpaceBefore'
  | 'paragraphSpaceAfter'
  | 'color'
  | 'textTransform'

const TEXT_STYLE_OVERRIDE_KEY_SET: ReadonlySet<TextStyleOverrideKey> = new Set([
  'fontFamily',
  'fontWeight',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'paragraphSpaceBefore',
  'paragraphSpaceAfter',
  'color',
  'textTransform',
])

export const TEXT_STYLE_OVERRIDE_KEYS: ReadonlyArray<TextStyleOverrideKey> = Array.from(
  TEXT_STYLE_OVERRIDE_KEY_SET,
)

export function isTextStyleOverrideKey(k: string): k is TextStyleOverrideKey {
  return TEXT_STYLE_OVERRIDE_KEY_SET.has(k as TextStyleOverrideKey)
}

/**
 * Shape-as-mask (P11r+1). Applied to an ImageObject so the visible image is
 * clipped to a non-rectangular silhouette. The mask shape's bounding box
 * coincides with the image's frame (object.x/y/width/height) — when the
 * frame is resized the mask scales with it, just like the standalone shape
 * would. Stored as the discriminated geometry of the originating shape so
 * the renderer can replay the same path.
 *
 * Path-kind anchors are normalized to 0..1 (relative to the source path's
 * bounding box) so they stretch with the frame without storing absolute px.
 */
export interface NormalizedPathAnchor {
  /** 0..1 relative to mask width. */
  x: number
  /** 0..1 relative to mask height. */
  y: number
  /** Incoming control handle, normalized like x/y. */
  cpIn?: { x: number; y: number }
  /** Outgoing control handle, normalized like x/y. */
  cpOut?: { x: number; y: number }
}

export type ImageMask =
  | { kind: 'rectangle'; cornerRadius?: CornerRadius }
  | { kind: 'ellipse' }
  | { kind: 'triangle' }
  | { kind: 'polygon'; sides: number }
  | { kind: 'path'; anchors: NormalizedPathAnchor[]; closed: boolean }

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
  /**
   * P11 (Keynote-style crop): slide-space rect where the source image
   * is drawn. When undefined, defaults to the object's own
   * x/y/width/height (no visible crop). When set, may be larger than or
   * extend outside the object's frame — the renderer clips visible
   * pixels to the object's x/y/width/height. Dragging the image inside
   * crop mode mutates this rect's x/y; resizing the frame mutates the
   * object's x/y/width/height while leaving imageRect alone.
   */
  imageRect?: { x: number; y: number; width: number; height: number }
  /**
   * P11 (crop, round 2): rotation of the source image inside the
   * frame, in radians, around the imageRect centre. Independent of
   * the object's own rotation (which rotates the FRAME and the image
   * together as a single unit). Default 0 ⇒ image is upright relative
   * to the frame.
   */
  imageRotation?: number
  /**
   * Shape-as-mask (P11r+1). When set, the renderer clips the visible
   * image to this shape's silhouette instead of the default rectangle.
   * The mask's bounding box matches the image's frame, so resizing the
   * frame scales the mask. Missing ⇒ classic rectangular crop.
   */
  mask?: ImageMask
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
   * Wait for a user click before playing. Mutually exclusive with
   * `autoplay`: when both are set, `playOnClick` wins. In present
   * mode, click-to-toggle still works for any video (it's the
   * existing fallback), but this flag is the explicit author
   * intent — it's surfaced in the Inspector and on the animation
   * timeline so other steps can be timed off it.
   */
  playOnClick?: boolean
  /**
   * Animation-style trigger for video playback so the video can be
   * sequenced relative to the slide's animation steps:
   *   • 'onEnter'        → start at slide-enter + delay (≡ autoplay)
   *   • 'withPrevious'   → start at prevStep.start + delay
   *   • 'afterPrevious'  → start at prevStep.end + delay
   *   • 'onClick'        → wait for user click (≡ playOnClick)
   * Default behavior when missing: 'onClick' if playOnClick is set,
   * else 'onEnter' if autoplay is set, else 'manual' (no trigger).
   */
  videoTrigger?: 'onEnter' | 'withPrevious' | 'afterPrevious' | 'onClick'
  /** Delay in seconds applied to the video's trigger anchor. */
  videoDelay?: number
  /**
   * Loop playback in present mode. Default: false.
   */
  loop?: boolean
  /**
   * Mute audio. Default: true (browsers block autoplay with sound).
   */
  muted?: boolean
  /**
   * P8: playback volume 0..1. Default 1. Ignored when muted.
   */
  volume?: number
  /**
   * P8: show the browser's native <video> control bar (play / scrub /
   * volume / fullscreen). Default false — author wants a clean canvas
   * preview, not chrome. Toggled per-object from the Inspector.
   */
  showControls?: boolean
  /**
   * P8: poster frame override — seconds into the clip to use as the
   * still image displayed in the editor before play. The transcode
   * worker writes the default poster at t=0; this lets the author pick
   * a later frame. Renderer requests `?t=N` against the poster URL
   * when the field is set.
   */
  posterTime?: number
  /**
   * P8: trim start in seconds. Player skips to this offset on first
   * play and treats earlier frames as out-of-range. Stretch goal —
   * renderer respects, but the ffmpeg worker doesn't actually clip
   * the underlying file yet.
   */
  trimStart?: number
  /** P8: trim end in seconds. */
  trimEnd?: number
  /**
   * Accessibility alt text / video description.
   */
  alt?: string
}

// ---------------------------------------------------------------------------
// (Removed) Component instance
//
// Components used to be a "live" SlideObject (`componentInstance`) that
// resolved a master at render time and merged per-leaf overrides. The
// editor now stamps masters onto the slide as plain primitives — see
// `packages/slide-model/src/stampComponent.ts`. The `componentInstance`
// SlideObject type and its override payloads are gone; existing decks
// that still carry `componentInstance` entries are no-ops at the
// renderer (unknown types are skipped).
// ---------------------------------------------------------------------------

/**

/**
 * M29 — first-class table object. Live alongside RectangleObject as a
 * peer in the SlideObject union; renderer + inspector + PPTX import all
 * branch on `type: 'table'`.
 *
 * The 2-D `rows` grid mirrors PPTX `<a:tr>/<a:tc>` exactly. Cell merge
 * works via origin cells carrying `gridSpan`/`rowSpan` while non-origin
 * cells in the spanned area carry `mergeOriginR/C` pointers; the
 * renderer skips drawing the pointer cells. `colWidths` + `rowHeights`
 * sum to the table's `width` / `height`; resizing the outer bbox
 * proportionally scales each, while resizing an inner divider
 * redistributes between two adjacent cells (table width unchanged —
 * the Office convention, picked over Google Docs's grow-the-table mode
 * per the M29 plan's default).
 */
export interface TableBorderStyle {
  color: number | TokenRef
  width: number
  /** Stroke style. Subset of PPTX's many — sane v1 set. */
  dash?: 'solid' | 'dash' | 'dot'
  alpha?: number
}

export interface TableCellEdgeBorders {
  top?: TableBorderStyle
  right?: TableBorderStyle
  bottom?: TableBorderStyle
  left?: TableBorderStyle
}

export interface TableCellPadding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface TableCell {
  /** Y.Text-backed body — same rich-text pipeline as TextObject. Existing
   *  Y.Docs loaded from disk may still carry a plain string until the
   *  next mutation promotes it (mirrors TextObject's promotion path). */
  text: string | Y.Text
  /** Per-cell overrides; missing fields inherit from `table.defaults`. */
  fontSize?: number
  fontWeight?: FontWeight
  /** Italic + underline are box-level (single value for the cell). Inline
   *  per-run formatting is handled separately on the Y.Text body — the
   *  field here is the fallback for cells without inline overrides and
   *  the value the Typography section toggles when no caret is set. */
  italic?: boolean
  underline?: boolean
  /** Line height as a unitless multiplier (e.g. 1.2). Matches the
   *  TextObject schema so the same Typography section can drive both. */
  lineHeight?: number
  /** Letter-spacing in slide-local px. Mirrors TextObject. */
  letterSpacing?: number
  /** Visual case transform applied at render time. Mirrors TextObject. */
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  color?: number | TokenRef
  align?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'middle' | 'bottom'
  fill?: number | TokenRef
  fillAlpha?: number
  /** Per-edge border — independently controllable, fixes the M28-era
   *  "Narrative has one stroke per shape" limitation that collapsed
   *  PPTX `<a:lnL|R|T|B>` to a single uniform stroke on import. */
  border?: TableCellEdgeBorders
  padding?: TableCellPadding
  /** Cell merge — gridSpan/rowSpan on the ORIGIN cell only; non-origin
   *  cells in the spanned area carry mergeOriginR/C pointers. The
   *  origin renders the full merged area; pointer cells skip rendering.
   *  gridSpan/rowSpan default to 1 when missing. */
  gridSpan?: number
  rowSpan?: number
  mergeOriginR?: number
  mergeOriginC?: number
}

export interface TableDefaults {
  fontFamily?: string
  fontSize: number
  fontWeight: FontWeight
  /** Italic / underline box-level defaults; cells override via their
   *  own optional fields. Same semantics as TextObject. */
  italic?: boolean
  underline?: boolean
  /** Unitless line-height multiplier (e.g. 1.2). Mirrors TextObject. */
  lineHeight?: number
  /** Letter-spacing in slide-local px. Mirrors TextObject. */
  letterSpacing?: number
  /** Visual case transform at render time. Mirrors TextObject. */
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  color: number | TokenRef
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
  fill?: number | TokenRef
  /** Default fill alpha 0..1 (cells inherit when their own `fillAlpha`
   *  is absent). 0 = transparent / "no color" — matches the shape
   *  inspector's representation. Missing ⇒ 1 (fully opaque). */
  fillAlpha?: number
  /** Default per-edge border; falls back to a 1px `#CCCCCC` grid when
   *  the table is freshly created. */
  border?: TableBorderStyle
  padding: TableCellPadding
}

export interface TableObject extends BaseSlideObject {
  type: 'table'
  /** Column widths in slide-local px. Sum must equal `width`. */
  colWidths: number[]
  /** Row heights in slide-local px. Sum must equal `height`. */
  rowHeights: number[]
  /** rows[r][c] = TableCell. 2-D shape mirrors PPTX `<a:tr>/<a:tc>`. */
  rows: TableCell[][]
  /** Default cell styling — cells inherit any field they don't override. */
  defaults: TableDefaults
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
  | TableObject

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
