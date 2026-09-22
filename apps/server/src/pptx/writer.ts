/**
 * pptx/writer.ts
 *
 * Takes a `ParsedPptx` (from `./parser`) and produces a Y.Doc state buffer
 * suitable for insertion into the `deck_updates` table. The resulting buffer
 * is what Hocuspocus's `onLoadDocument` will replay when a client first
 * connects to the new deck.
 *
 * Strategy:
 *   1. `createSlideDoc()` → fresh doc with one default empty slide.
 *   2. For each parsed source slide, `addSlide()` and populate it with the
 *      mapped objects + background.
 *   3. Remove the default slide at index 0 so the deck starts at the first
 *      imported slide.
 *   4. `Y.encodeStateAsUpdate(doc)` → Buffer.
 *
 * v1 mapping coverage (intentionally minimal — refine per real-world fixtures):
 *   - text frame  → TextObject (concatenated paragraphs, first-run style)
 *   - rectangle   → RectangleObject (solid fill + optional stroke)
 *   - ellipse     → EllipseObject  (solid fill + optional stroke)
 *   - line        → LineObject     (stroke only)
 *   - image       → SKIPPED in v1 (needs MinIO upload pipeline; tracked as
 *                  a logged "ignored: image" entry on the result for now)
 *   - solid bg    → ColorBackground
 *   - image bg    → SKIPPED (same reason as images)
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import {
  createSlideDoc,
  hydrateSlideDoc,
  addSlide,
  removeSlide,
  getSlideObjectsCtx,
  getSlideAnimationsCtx,
  getSlideNotes,
  addObject,
  addAnimation,
  setSlideName,
  setSlideSkipped,
  updateSlideBackground,
  updateSlideTransition,
  listSlides,
  PARAGRAPH_SEP,
  blockAttrsToInsertAttrs,
} from '@narrative/slide-model'
import type {
  SlideObject,
  TextObject,
  RectangleObject,
  EllipseObject,
  TriangleObject,
  PolygonObject,
  LineObject,
  ArrowObject,
  PathObject,
  PathAnchor,
  ImageObject,
  VideoObject,
  TableObject,
  TableCell,
  TableDefaults,
  ColorBackground,
  ImageBackground,
  LinearGradientBackground,
  RadialGradientBackground,
  GradientStop,
  LinearGradientFill,
  RadialGradientFill,
  FillStyle,
} from '@narrative/shared'
import { SLIDE_WIDTH, SLIDE_HEIGHT, rotationFromDegrees, sanitizeHref } from '@narrative/shared'
import type {
  ParsedPptx,
  ParsedShape,
  ParsedSlide,
  ParsedGradient,
  ParsedBackground,
  ParsedTableCell,
} from './parser.js'
import { subsystemLogger } from '../observability/logger.js'

const log = subsystemLogger('pptx-import')

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface WriteResult {
  /** `Y.encodeStateAsUpdate(doc)` — store as a single row in `deck_updates`. */
  state: Buffer
  /** Slide count in the resulting deck (matches the parsed input). */
  slideCount: number
  /** Number of source shapes successfully mapped to Narrative objects. */
  objectsCreated: number
  /** Per-kind tally of shapes we skipped (mostly images in v1). */
  skipped: { images: number; unknownShapes: number }
}

// ---------------------------------------------------------------------------
// Shape mapper — ParsedShape → SlideObject | null
// ---------------------------------------------------------------------------

const DEFAULT_TEXT_COLOR = 0x0f172a
const DEFAULT_FILL = 0x4060e0
const DEFAULT_TEXT_SIZE = 18

/**
 * Base fill color for a shape that has only a gradient (no explicit
 * `<a:solidFill>`). Pixi's gradient renderer tints the gradient texture
 * by the object's `fill` color, so we must default to white instead of
 * the brand-blue `DEFAULT_FILL` — otherwise a black-to-white radial
 * gradient ends up looking like a blue-tinted radial gradient.
 */
const NEUTRAL_GRADIENT_BASE_FILL = 0xffffff

function pickFillForShape(s: ParsedShape): number {
  if (s.fillColor !== undefined) return s.fillColor
  if (s.fillGradient !== undefined) return NEUTRAL_GRADIENT_BASE_FILL
  return DEFAULT_FILL
}

/**
 * True when the source `<p:spPr>` declared no fill at all (no
 * `<a:solidFill>`, `<a:gradFill>`, `<a:blipFill>`, or any other fill
 * variant). Distinct from "explicit `<a:noFill/>`" which the parser
 * already flags via `fillAlpha === 0`.
 *
 * PowerPoint resolves "undeclared fill" against the theme + style +
 * placeholder hierarchy, often landing on transparent for text boxes
 * and slide-number placeholders. We don't run that resolution; instead
 * we render the shape transparent so a layout placeholder doesn't
 * surface as a `DEFAULT_FILL`-coloured rectangle on every imported
 * deck — same symptom that turned slide 1's slide-number area into
 * a stray blue band in the audit fixture.
 */
function sourceDeclaredNoFill(s: ParsedShape): boolean {
  return (
    s.fillColor === undefined &&
    s.fillGradient === undefined &&
    (s.imagePath === undefined || s.imagePath === '') &&
    s.assetId === undefined
  )
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function gradientStops(g: ParsedGradient): GradientStop[] {
  return g.stops.map((s) => {
    const stop: GradientStop = { color: s.color, offset: s.offset }
    if (s.alpha !== undefined) stop.alpha = s.alpha
    return stop
  })
}

function gradientToFillStyle(g: ParsedGradient): FillStyle {
  if (g.kind === 'linearGradient') {
    const fill: LinearGradientFill = {
      kind: 'linearGradient',
      stops: gradientStops(g),
      angleDeg: g.angleDeg,
    }
    return fill
  }
  // Radial — Narrative requires centerX/Y on the fill style.
  const fill: RadialGradientFill = {
    kind: 'radialGradient',
    stops: gradientStops(g),
    centerX: 0.5,
    centerY: 0.5,
  }
  return fill
}

/**
 * Build a Y.Text body for a parsed text shape when the runs carry per-run
 * formatting worth preserving. Returns null when the runs are empty or
 * uniformly match the shape-level defaults — in that case the caller falls
 * back to the plain `s.text` string and addObject seeds a default Y.Text.
 *
 * Run attrs map to Quill-style format keys (Narrative's `richText.ts`):
 *   italic / underline → boolean
 *   fontWeight         → 700 for bold runs, omitted otherwise
 *   color              → number 0xRRGGBB
 *   fontSize           → px (already scaled here)
 *   fontFamily         → string (passed through; renderer reads it on the
 *                        delta via `richText.toHtml`)
 *
 * `letterSpacing` is captured on `ParsedTextRun` but NOT plumbed into the
 * Y.Text body — `richText.RichAttrs` doesn't model it (PPTX has no
 * established mid-run letter-spacing convention either; Narrative carries
 * it at the frame / cell level only).
 *
 * Hyperlinks on individual runs are NOT serialised as Quill attrs in v1 —
 * Narrative's model attaches one hyperlink per TextObject, not per run.
 * The first-run hyperlink is captured upstream and lands on the shape's
 * `hyperlink` field, which `mapShape` copies onto the TextObject.
 */
function buildRichTextBody(s: ParsedShape, scale: number): Y.Text | null {
  const runs = s.textRuns
  if (runs === undefined || runs.length === 0) return null

  // Per-paragraph block attributes (list / level / glyph / autonum). When
  // present, the Y.Text MUST be rebuilt so each block attr can ride on the
  // paragraph-separator character that terminates its paragraph \u2014 even when
  // the runs themselves carry no inline formatting (a plain bullet list).
  const paragraphs = s.paragraphs
  const hasBlockAttrs =
    paragraphs !== undefined && paragraphs.some((p) => blockAttrsToInsertAttrs(p) !== undefined)

  // Test: does any run carry formatting (other than the run's own text)?
  // If every run is "plain text only", the existing string path suffices.
  // Both '\n' (soft break) and PARAGRAPH_SEP (PPTX paragraph separator)
  // are pure structural runs with no inline formatting attributes.
  const isStructuralBreak = (t: string): boolean => t === '\n' || t === PARAGRAPH_SEP
  const hasRichRun = runs.some(
    (r) =>
      !isStructuralBreak(r.text) &&
      (r.bold === true ||
        r.italic === true ||
        r.underline === true ||
        r.color !== undefined ||
        r.fontSize !== undefined ||
        r.fontFamily !== undefined),
  )
  // Nothing to preserve beyond plain text \u2192 let the string fast-path win.
  if (!hasRichRun && !hasBlockAttrs) return null

  // Yjs `insert` with no `attributes` argument INHERITS the formatting of the
  // character to its left. A formatted separator therefore bleeds its block
  // attrs onto the following plain run AND onto the next separator. To stop
  // that, every separator is inserted with an EXPLICIT record that sets each
  // block key to either its value or `null` (a null clears the key), fully
  // overriding whatever was inherited. Inline keys on the separator are left
  // out — separators never carry inline run formatting.
  const BLOCK_KEYS = ['list', 'level', 'bulletChar', 'numberFormat', 'startAt'] as const
  const clearBlockKeys = (): Record<string, unknown> => {
    const rec: Record<string, unknown> = {}
    for (const k of BLOCK_KEYS) rec[k] = null
    return rec
  }
  const separatorAttrs = (paraIndex: number): Record<string, unknown> => {
    const set = paragraphs?.[paraIndex]
      ? (blockAttrsToInsertAttrs(paragraphs[paraIndex]!) ?? {})
      : {}
    const rec: Record<string, unknown> = {}
    for (const k of BLOCK_KEYS) rec[k] = k in set ? set[k] : null
    return rec
  }

  const yt = new Y.Text()
  let cursor = 0
  let paraIndex = 0
  for (const r of runs) {
    if (r.text.length === 0) continue
    // Paragraph separator: insert it carrying THIS paragraph's block attrs
    // (explicit, with nulls clearing unset keys), then advance.
    if (r.text === PARAGRAPH_SEP) {
      yt.insert(cursor, PARAGRAPH_SEP, separatorAttrs(paraIndex))
      cursor += 1
      paraIndex += 1
      continue
    }
    // Insert the run/soft-break with block keys explicitly cleared so it does
    // NOT inherit a preceding formatted separator's list attrs (those belong
    // on separators only). Inline formatting is applied via `format` below.
    yt.insert(cursor, r.text, hasBlockAttrs ? clearBlockKeys() : undefined)
    // Soft-break ('\n') synthetic runs carry no inline formatting \u2014 skip the
    // format pass but DON'T advance the paragraph index (still same <a:p>).
    if (r.text === '\n') {
      cursor += 1
      continue
    }
    const attrs: Record<string, unknown> = {}
    if (r.bold === true) attrs['fontWeight'] = 700
    if (r.italic === true) attrs['italic'] = true
    if (r.underline === true) attrs['underline'] = true
    if (r.color !== undefined) attrs['color'] = r.color
    if (r.fontSize !== undefined) attrs['fontSize'] = round(r.fontSize * scale)
    if (r.fontFamily !== undefined) attrs['fontFamily'] = r.fontFamily
    if (Object.keys(attrs).length > 0) {
      yt.format(cursor, r.text.length, attrs)
    }
    cursor += r.text.length
  }
  // Trailing separator for the FINAL paragraph. The run stream only carries
  // inter-paragraph separators (N-1 of them for N paragraphs), so the last
  // paragraph has no terminator yet. The per-paragraph list model stores a
  // paragraph's block attrs on its terminating separator, so the final
  // paragraph needs one when ANY paragraph in the frame carries block attrs
  // (preserving the slide-model trailing-separator invariant). Plain decks
  // with no list formatting keep the legacy no-trailing-separator shape.
  if (hasBlockAttrs) {
    yt.insert(cursor, PARAGRAPH_SEP, separatorAttrs(paraIndex))
  }
  return yt
}

/**
 * Derive a `LineEndpoints` pair from a connector's bbox + flipH/flipV. PPTX
 * connector geometry uses the bbox alone to describe direction: the
 * default line goes from top-left to bottom-right; `flipH` swaps left↔right,
 * `flipV` swaps top↔bottom. Combined, the four corner pairs give the
 * four possible directions of a connector that occupies the same bbox.
 */
function endpointsFromBbox(
  width: number,
  height: number,
  flipH?: boolean,
  flipV?: boolean,
): { p1: { x: number; y: number }; p2: { x: number; y: number } } {
  const left = 0
  const right = width
  const top = 0
  const bottom = height
  if (flipH && flipV) return { p1: { x: right, y: bottom }, p2: { x: left, y: top } }
  if (flipH) return { p1: { x: right, y: top }, p2: { x: left, y: bottom } }
  if (flipV) return { p1: { x: left, y: bottom }, p2: { x: right, y: top } }
  return { p1: { x: left, y: top }, p2: { x: right, y: bottom } }
}

function mapShape(s: ParsedShape, scale: number): SlideObject | null {
  const base: {
    id: string
    x: number
    y: number
    width: number
    height: number
    rotation: number
    opacity: number
    groupId?: string
    shadow?: {
      color: number
      blur: number
      offsetX: number
      offsetY: number
      opacity: number
    }
    blur?: number
  } = {
    id: nanoid(),
    x: round(s.x * scale),
    y: round(s.y * scale),
    width: round(Math.max(1, s.width * scale)),
    height: round(Math.max(1, s.height * scale)),
    // ParsedShape carries PPTX degrees; the model stores radians. Not
    // rounded: two decimals of a radian is 0.6°, visible on a long line.
    rotation: rotationFromDegrees(s.rotation),
    opacity: 1,
  }
  if (s.groupId !== undefined) base.groupId = s.groupId
  if (s.shadow !== undefined) {
    base.shadow = {
      color: s.shadow.color,
      blur: round(s.shadow.blur * scale),
      offsetX: round(s.shadow.offsetX * scale),
      offsetY: round(s.shadow.offsetY * scale),
      opacity: s.shadow.opacity,
    }
  }
  if (s.blur !== undefined && s.blur > 0) base.blur = round(s.blur * scale)

  // Text takes precedence — a `p:sp` with a `<p:txBody>` that has runs is
  // imported as a text frame regardless of its preset geometry.
  if (s.kind === 'text' && s.text !== undefined && s.text.length > 0) {
    // Narrative TextObject only models 'left' | 'center' | 'right'; coerce
    // PPTX 'justify' to 'left' since we don't render justified text yet.
    const align: 'left' | 'center' | 'right' =
      s.textAlign === 'center' || s.textAlign === 'right' ? s.textAlign : 'left'
    // Build a Y.Text body when the parsed runs carry per-run formatting
    // that diverges from the frame-wide defaults. Single-style frames stay
    // on the existing string path — `addObject` seeds a Y.Text from the
    // string automatically (mutations.richtext.test covers that path).
    const richBody = buildRichTextBody(s, scale)
    const obj: TextObject = {
      ...base,
      type: 'text',
      text: richBody ?? s.text,
      fontSize: round((s.fontSize ?? DEFAULT_TEXT_SIZE) * scale),
      fontWeight: s.bold === true ? 'bold' : 'normal',
      color: s.textColor ?? DEFAULT_TEXT_COLOR,
      align,
    }
    if (s.textColorAlpha !== undefined && s.textColorAlpha < 1) {
      obj.colorAlpha = s.textColorAlpha
    }
    // Default vAlign is 'top' — only set when the source explicitly anchors
    // middle/bottom, so we don't bloat the doc with redundant fields.
    if (s.textVerticalAlign === 'middle' || s.textVerticalAlign === 'bottom') {
      obj.vAlign = s.textVerticalAlign
    }
    // Per-paragraph list fidelity supersedes the legacy frame-wide
    // `listStyle`. Block attrs (list kind / level / glyph / autonum) ride on
    // the Y.Text paragraph separators via `buildRichTextBody` →
    // `blockAttrsToInsertAttrs`, so we intentionally leave `obj.listStyle`
    // unset on import. (The legacy field stays defined on the schema for
    // backward-compat with pre-multi-level decks; the slide-model migrates
    // it to per-paragraph attrs on first edit.)
    if (s.hyperlink !== undefined) {
      // Sanitise at the import boundary: a crafted .pptx can carry a
      // `javascript:`/`data:` hlinkClick target. Drop anything that isn't
      // an allowed scheme so we never persist a dangerous href into the doc.
      const href = sanitizeHref(s.hyperlink.href)
      if (href !== null) {
        obj.hyperlink = { kind: 'url', href, target: '_blank' }
      }
    }
    // Frame-level text fine attrs.
    if (s.fontFamily !== undefined) obj.fontFamily = s.fontFamily
    if (s.letterSpacing !== undefined) obj.letterSpacing = round(s.letterSpacing * scale)
    if (s.lineHeight !== undefined && s.lineHeight > 0) obj.lineHeight = s.lineHeight
    if (s.lineSpacing !== undefined && s.lineSpacing > 0) obj.lineSpacing = s.lineSpacing
    if (s.paragraphSpaceBefore !== undefined && s.paragraphSpaceBefore > 0) {
      obj.paragraphSpaceBefore = round(s.paragraphSpaceBefore * scale)
    }
    if (s.paragraphSpaceAfter !== undefined && s.paragraphSpaceAfter > 0) {
      obj.paragraphSpaceAfter = round(s.paragraphSpaceAfter * scale)
    }
    if (s.textTransform !== undefined && s.textTransform !== 'none') {
      obj.textTransform = s.textTransform
    }
    if (s.textStrokeColor !== undefined) obj.stroke = s.textStrokeColor
    if (s.textStrokeAlpha !== undefined && s.textStrokeAlpha < 1) {
      obj.strokeAlpha = s.textStrokeAlpha
    }
    if (s.textStrokeWidth !== undefined && s.textStrokeWidth > 0) {
      obj.strokeWidth = round(s.textStrokeWidth * scale)
    }
    return obj
  }

  if (s.kind === 'rectangle') {
    const obj: RectangleObject = {
      ...base,
      type: 'rectangle',
      fill: pickFillForShape(s),
    }
    if (s.fillAlpha !== undefined && s.fillAlpha < 1) obj.fillAlpha = s.fillAlpha
    else if (sourceDeclaredNoFill(s)) obj.fillAlpha = 0
    if (s.fillGradient !== undefined) obj.fillStyle = gradientToFillStyle(s.fillGradient)
    if (s.strokeColor !== undefined) obj.stroke = s.strokeColor
    if (s.strokeAlpha !== undefined && s.strokeAlpha < 1) obj.strokeAlpha = s.strokeAlpha
    if (s.strokeWidth !== undefined && s.strokeWidth > 0) {
      obj.strokeWidth = round(s.strokeWidth * scale)
    }
    if (s.cornerRadius !== undefined && s.cornerRadius > 0) {
      // ParsedShape.cornerRadius is in slide-local px; Narrative's
      // RectangleObject.cornerRadius accepts a number applied to all
      // four corners. Scale to deck-canvas px in lockstep with x/y/w/h.
      obj.cornerRadius = round(s.cornerRadius * scale)
    }
    return obj
  }

  if (s.kind === 'ellipse') {
    const obj: EllipseObject = {
      ...base,
      type: 'ellipse',
      fill: pickFillForShape(s),
    }
    if (s.fillAlpha !== undefined && s.fillAlpha < 1) obj.fillAlpha = s.fillAlpha
    else if (sourceDeclaredNoFill(s)) obj.fillAlpha = 0
    if (s.fillGradient !== undefined) obj.fillStyle = gradientToFillStyle(s.fillGradient)
    if (s.strokeColor !== undefined) obj.stroke = s.strokeColor
    if (s.strokeAlpha !== undefined && s.strokeAlpha < 1) obj.strokeAlpha = s.strokeAlpha
    if (s.strokeWidth !== undefined && s.strokeWidth > 0) {
      obj.strokeWidth = round(s.strokeWidth * scale)
    }
    return obj
  }

  if (s.kind === 'triangle') {
    const obj: TriangleObject = {
      ...base,
      type: 'triangle',
      fill: pickFillForShape(s),
    }
    if (s.fillAlpha !== undefined && s.fillAlpha < 1) obj.fillAlpha = s.fillAlpha
    else if (sourceDeclaredNoFill(s)) obj.fillAlpha = 0
    if (s.fillGradient !== undefined) obj.fillStyle = gradientToFillStyle(s.fillGradient)
    if (s.strokeColor !== undefined) obj.stroke = s.strokeColor
    if (s.strokeAlpha !== undefined && s.strokeAlpha < 1) obj.strokeAlpha = s.strokeAlpha
    if (s.strokeWidth !== undefined && s.strokeWidth > 0) {
      obj.strokeWidth = round(s.strokeWidth * scale)
    }
    return obj
  }

  if (s.kind === 'polygon') {
    const obj: PolygonObject = {
      ...base,
      type: 'polygon',
      fill: pickFillForShape(s),
      sides: s.sides ?? 6, // hexagon fallback — polygon detection always sets sides
    }
    if (s.fillAlpha !== undefined && s.fillAlpha < 1) obj.fillAlpha = s.fillAlpha
    else if (sourceDeclaredNoFill(s)) obj.fillAlpha = 0
    if (s.fillGradient !== undefined) obj.fillStyle = gradientToFillStyle(s.fillGradient)
    if (s.strokeColor !== undefined) obj.stroke = s.strokeColor
    if (s.strokeAlpha !== undefined && s.strokeAlpha < 1) obj.strokeAlpha = s.strokeAlpha
    if (s.strokeWidth !== undefined && s.strokeWidth > 0) {
      obj.strokeWidth = round(s.strokeWidth * scale)
    }
    return obj
  }

  if (s.kind === 'path') {
    if (s.pathAnchors === undefined || s.pathAnchors.length === 0) return null
    // Path anchors come from the parser in slide-local px (post emuToPx)
    // but Narrative's PathAnchor schema positions anchors RELATIVE to the
    // object's `(x, y)` origin. Subtract the shape's anchor and scale to
    // the deck canvas.
    const anchors: PathAnchor[] = s.pathAnchors.map((a) => {
      const ax = round((a.x - s.x) * scale)
      const ay = round((a.y - s.y) * scale)
      const out: PathAnchor = { x: ax, y: ay }
      if (a.cpIn !== undefined) {
        out.cpIn = { x: round(a.cpIn.x * scale), y: round(a.cpIn.y * scale) }
      }
      if (a.cpOut !== undefined) {
        out.cpOut = { x: round(a.cpOut.x * scale), y: round(a.cpOut.y * scale) }
      }
      // Carry the subpath-start flag through. The renderer uses it to
      // emit Graphics.moveTo for disconnected sub-shapes — PPTX
      // `<a:custGeom>` icons (e.g. dot grids) pack hundreds of those
      // into one path.
      if (a.moveTo === true) out.moveTo = true
      return out
    })
    // Source `<a:ln w="…">` declares a stroke WIDTH; the colour comes
    // from a separate `<a:solidFill>` child (or `<a:lnRef>` style ref).
    // A line with `<a:noFill/>` (or no fill child at all) means "draw
    // no stroke" even though `w` is set — common on PPTX vector logos
    // where the design is a pure silhouette (e.g. the AFRY letterforms
    // in the audit fixture). The previous code fabricated a 0x111111
    // stroke at the declared width whenever `strokeColor` was undefined,
    // producing a thin near-black outline that thickened the imported
    // glyphs vs the original. Fix: emit `strokeWidth: 0` when the
    // parser found no colour, so the renderer skips the stroke pass.
    const hasStrokeColor = s.strokeColor !== undefined
    const obj: PathObject = {
      ...base,
      type: 'path',
      anchors,
      stroke: s.strokeColor ?? 0x111111,
      strokeWidth: hasStrokeColor
        ? s.strokeWidth !== undefined && s.strokeWidth > 0
          ? round(s.strokeWidth * scale)
          : 2
        : 0,
    }
    if (s.fillColor !== undefined) obj.fill = s.fillColor
    if (s.fillAlpha !== undefined && s.fillAlpha < 1) obj.fillAlpha = s.fillAlpha
    if (s.fillGradient !== undefined) obj.fillStyle = gradientToFillStyle(s.fillGradient)
    if (s.strokeAlpha !== undefined && s.strokeAlpha < 1) obj.strokeAlpha = s.strokeAlpha
    if (s.pathClosed === true) obj.closed = true
    return obj
  }

  if (s.kind === 'arrow') {
    // ArrowObject + LineObject share the same LineEndpoints schema —
    // p1/p2 are relative to (x, y), so the bbox flips handled below
    // determine which corner each endpoint lands at.
    const { p1, p2 } = endpointsFromBbox(base.width, base.height, s.flipH, s.flipV)
    const obj: ArrowObject = {
      ...base,
      type: 'arrow',
      stroke: s.strokeColor ?? 0x111111,
      strokeWidth:
        s.strokeWidth !== undefined && s.strokeWidth > 0 ? round(s.strokeWidth * scale) : 2,
      p1,
      p2,
      startCap: s.startCap ?? 'none',
      endCap: s.endCap ?? 'arrow',
    }
    if (s.strokeAlpha !== undefined && s.strokeAlpha < 1) obj.strokeAlpha = s.strokeAlpha
    return obj
  }

  if (s.kind === 'image') {
    // Only emit the ImageObject if the importer set `assetId` (i.e. the
    // image bytes were successfully uploaded to MinIO). Without an assetId
    // there's nothing for the renderer to draw, so we drop silently.
    if (s.assetId === undefined || s.assetId === '') return null
    const obj: ImageObject = {
      ...base,
      type: 'image',
      assetId: s.assetId,
      variant: 'display',
      fit: 'cover',
    }
    // PPTX `<a:alphaModFix>` on the blip maps to the image object's opacity.
    if (s.imageAlpha !== undefined && s.imageAlpha < 1) obj.opacity = s.imageAlpha
    if (s.imageRect !== undefined) {
      obj.imageRect = {
        x: round(s.imageRect.x * scale),
        y: round(s.imageRect.y * scale),
        width: round(s.imageRect.width * scale),
        height: round(s.imageRect.height * scale),
      }
    }
    return obj
  }

  if (s.kind === 'video') {
    if (s.assetId === undefined || s.assetId === '') return null
    // Imported videos default to muted + click-to-play — same convention
    // a user gets when uploading a video through the editor's tus flow.
    // The HLS transcode kicks in async post-import; until it finishes,
    // the renderer paints `posterAssetId` (the blipFill poster the PPTX
    // carried alongside the videoFile) as the immediate preview frame
    // so the slide stays visible from the moment the deck opens.
    const obj: VideoObject = {
      ...base,
      type: 'video',
      assetId: s.assetId,
      fit: 'contain',
      muted: true,
      autoplay: false,
    }
    if (s.posterAssetId !== undefined && s.posterAssetId !== '') {
      obj.posterAssetId = s.posterAssetId
    }
    return obj
  }

  if (s.kind === 'line') {
    const { p1, p2 } = endpointsFromBbox(base.width, base.height, s.flipH, s.flipV)
    const obj: LineObject = {
      ...base,
      type: 'line',
      stroke: s.strokeColor ?? 0x111111,
      strokeWidth:
        s.strokeWidth !== undefined && s.strokeWidth > 0 ? round(s.strokeWidth * scale) : 2,
      p1,
      p2,
      startCap: s.startCap ?? 'none',
      endCap: s.endCap ?? 'none',
    }
    if (s.strokeAlpha !== undefined && s.strokeAlpha < 1) obj.strokeAlpha = s.strokeAlpha
    return obj
  }

  if (s.kind === 'table') {
    return mapTableShape(s, base, scale)
  }

  return null
}

/**
 * Build a Narrative TableObject from a parsed `<a:tbl>` shape.
 *
 * The parser emits a fully-populated cell matrix with merge pointers
 * already stamped (origin carries gridSpan/rowSpan; continuation cells
 * carry mergeOriginR/C). We translate each cell into a TableCell with
 * a Y.Text body, honour explicit per-cell styles, and let the table's
 * `defaults` carry any uniform layout values (font / padding / border).
 *
 * Width/height: the parser already produced `tableColWidths` /
 * `tableRowHeights` in px (pre-scale). We rescale them so they sum to
 * the table's outer bbox — the renderer treats colWidths/rowHeights as
 * proportions, so the absolute values don't have to match the bbox
 * exactly, but keeping them in sync makes future drag-resize start from
 * a sane baseline.
 */
function mapTableShape(
  s: ParsedShape,
  base: {
    id: string
    x: number
    y: number
    width: number
    height: number
    rotation: number
    opacity: number
  },
  scale: number,
): TableObject | null {
  const rawCells = s.tableCells
  const rawColWidths = s.tableColWidths
  const rawRowHeights = s.tableRowHeights
  if (
    rawCells === undefined ||
    rawColWidths === undefined ||
    rawRowHeights === undefined ||
    rawCells.length === 0 ||
    rawColWidths.length === 0
  ) {
    return null
  }
  // Rescale col/row sizes from px (pre-scale) to slide px (post-scale).
  // Renderer treats these as proportions, so the absolute scale doesn't
  // matter functionally — but keeping them aligned with the bbox makes
  // the column-resize handles (Phase 5 polish) start with sane values.
  const colWidths = rawColWidths.map((w) => Math.max(1, round(w * scale)))
  const rowHeights = rawRowHeights.map((h) => Math.max(1, round(h * scale)))

  // Aggregate typography defaults across live cells (skipping merge
  // continuation cells). Any field that's uniformly set on every cell that
  // has a value gets lifted to `TableDefaults`; per-cell overrides for the
  // same field are then stripped so the doc isn't bloated with redundancy
  // and the renderer's "inherit-from-defaults" path takes over. Mirrors
  // PowerPoint's `<a:tblPr>` + `<a:txStyles>` model where a default tier
  // governs everything not explicitly overridden per cell.
  const agg = aggregateTableTypography(rawCells, scale)
  const defaults: TableDefaults = {
    fontSize: agg.fontSize ?? 18,
    fontWeight: agg.fontWeight ?? 'normal',
    color: agg.color ?? 0x111111,
    align: agg.align ?? 'left',
    vAlign: agg.vAlign ?? 'middle',
    border: { color: 0xcccccc, width: 1 },
    padding: agg.padding ?? { top: 8, right: 8, bottom: 8, left: 8 },
  }
  if (agg.fontFamily !== undefined) defaults.fontFamily = agg.fontFamily
  if (agg.lineHeight !== undefined) defaults.lineHeight = agg.lineHeight
  if (agg.letterSpacing !== undefined) defaults.letterSpacing = agg.letterSpacing
  if (agg.paragraphSpaceBefore !== undefined) {
    defaults.paragraphSpaceBefore = agg.paragraphSpaceBefore
  }
  if (agg.paragraphSpaceAfter !== undefined) {
    defaults.paragraphSpaceAfter = agg.paragraphSpaceAfter
  }
  if (agg.textTransform !== undefined) defaults.textTransform = agg.textTransform

  // Build rows. Each cell either carries its own Y.Text-backed body or
  // an empty string (the binding layer in slide-model will create the
  // Y.Text post-integration during addObject). Per-cell typography is
  // only written when the value diverges from the aggregated default.
  const rows: TableCell[][] = []
  for (let r = 0; r < rawCells.length; r++) {
    const rawRow = rawCells[r]!
    const row: TableCell[] = []
    for (let c = 0; c < rawColWidths.length; c++) {
      const rawCell = rawRow[c] ?? { text: '' }
      const cell: TableCell = { text: rawCell.text ?? '' }
      // Build a Y.Text body if any run carries inline formatting. We
      // reuse `buildRichTextBody` by faking a `ParsedShape` with the
      // cell's runs — the function reads `textRuns` and returns either
      // a formatted Y.Text or null.
      const richBody = buildRichTextBody(
        { textRuns: rawCell.textRuns, kind: 'text' } as ParsedShape,
        scale,
      )
      if (richBody !== null) cell.text = richBody
      if (rawCell.fontSize !== undefined) {
        const scaled = round(rawCell.fontSize * scale)
        if (scaled !== defaults.fontSize) cell.fontSize = scaled
      }
      if (rawCell.fontWeight !== undefined && rawCell.fontWeight !== defaults.fontWeight) {
        cell.fontWeight = rawCell.fontWeight
      }
      if (rawCell.color !== undefined && rawCell.color !== defaults.color) {
        cell.color = rawCell.color
      }
      if (rawCell.align !== undefined && rawCell.align !== defaults.align) {
        cell.align = rawCell.align
      }
      if (rawCell.vAlign !== undefined && rawCell.vAlign !== defaults.vAlign) {
        cell.vAlign = rawCell.vAlign
      }
      if (rawCell.lineHeight !== undefined && rawCell.lineHeight !== defaults.lineHeight) {
        cell.lineHeight = rawCell.lineHeight
      }
      if (rawCell.letterSpacing !== undefined) {
        const scaled = round(rawCell.letterSpacing * scale)
        if (scaled !== defaults.letterSpacing) cell.letterSpacing = scaled
      }
      if (
        rawCell.textTransform !== undefined &&
        rawCell.textTransform !== 'none' &&
        rawCell.textTransform !== defaults.textTransform
      ) {
        cell.textTransform = rawCell.textTransform
      }
      if (rawCell.fill !== undefined) cell.fill = rawCell.fill
      if (rawCell.fillAlpha !== undefined && rawCell.fillAlpha < 1) {
        cell.fillAlpha = rawCell.fillAlpha
      }
      if (rawCell.fillGradient !== undefined) {
        cell.fillStyle = gradientToFillStyle(rawCell.fillGradient)
      }
      if (rawCell.padding !== undefined) {
        const scaledPadding = {
          top: round(rawCell.padding.top * scale),
          right: round(rawCell.padding.right * scale),
          bottom: round(rawCell.padding.bottom * scale),
          left: round(rawCell.padding.left * scale),
        }
        const dp = defaults.padding
        if (
          scaledPadding.top !== dp.top ||
          scaledPadding.right !== dp.right ||
          scaledPadding.bottom !== dp.bottom ||
          scaledPadding.left !== dp.left
        ) {
          cell.padding = scaledPadding
        }
      }
      // Per-edge borders. Each edge already carries px values (the
      // parser ran through emuToPx) — the writer just multiplies by
      // the slide-canvas scale so widths land in the same units as
      // every other shape's stroke.
      if (rawCell.border !== undefined) {
        const b: NonNullable<TableCell['border']> = {}
        if (rawCell.border.top !== undefined) {
          b.top = {
            color: rawCell.border.top.color,
            width: round(rawCell.border.top.width * scale),
          }
        }
        if (rawCell.border.right !== undefined) {
          b.right = {
            color: rawCell.border.right.color,
            width: round(rawCell.border.right.width * scale),
          }
        }
        if (rawCell.border.bottom !== undefined) {
          b.bottom = {
            color: rawCell.border.bottom.color,
            width: round(rawCell.border.bottom.width * scale),
          }
        }
        if (rawCell.border.left !== undefined) {
          b.left = {
            color: rawCell.border.left.color,
            width: round(rawCell.border.left.width * scale),
          }
        }
        cell.border = b
      }
      // Merge stamping — same shape as Narrative's TableCell schema.
      if (rawCell.gridSpan !== undefined && rawCell.gridSpan > 1) {
        cell.gridSpan = rawCell.gridSpan
      }
      if (rawCell.rowSpan !== undefined && rawCell.rowSpan > 1) {
        cell.rowSpan = rawCell.rowSpan
      }
      if (rawCell.mergeOriginR !== undefined) cell.mergeOriginR = rawCell.mergeOriginR
      if (rawCell.mergeOriginC !== undefined) cell.mergeOriginC = rawCell.mergeOriginC
      row.push(cell)
    }
    rows.push(row)
  }

  return {
    ...base,
    type: 'table',
    colWidths,
    rowHeights,
    rows,
    defaults,
  }
}

interface AggregatedTableTypography {
  fontFamily?: string
  fontSize?: number
  fontWeight?: 'normal' | 'bold'
  color?: number
  align?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'middle' | 'bottom'
  lineHeight?: number
  letterSpacing?: number
  paragraphSpaceBefore?: number
  paragraphSpaceAfter?: number
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  padding?: { top: number; right: number; bottom: number; left: number }
}

/**
 * Scan every live cell (skipping merge-continuation slots) and collect a
 * field's value when it's uniform — i.e. every cell that sets the field
 * agrees on the value. Numeric fields are scaled the same way the
 * per-cell write path scales them so the strip-on-match comparison is
 * exact rather than tolerance-based.
 */
function aggregateTableTypography(
  rawCells: ParsedTableCell[][],
  scale: number,
): AggregatedTableTypography {
  const live: ParsedTableCell[] = []
  for (const row of rawCells) {
    for (const c of row) {
      if (c.mergeOriginR !== undefined || c.mergeOriginC !== undefined) continue
      live.push(c)
    }
  }
  if (live.length === 0) return {}

  function uniform<T>(
    get: (c: ParsedTableCell) => T | undefined,
    eq: (a: T, b: T) => boolean = (a, b) => a === b,
  ): T | undefined {
    let candidate: T | undefined
    let found = false
    for (const c of live) {
      const v = get(c)
      if (v === undefined) continue
      if (!found) {
        candidate = v
        found = true
      } else if (candidate === undefined || !eq(candidate, v)) {
        return undefined
      }
    }
    return candidate
  }

  const paddingEq = (
    a: { top: number; right: number; bottom: number; left: number },
    b: { top: number; right: number; bottom: number; left: number },
  ): boolean => a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left

  const result: AggregatedTableTypography = {}
  const fontFamily = uniform((c) => c.fontFamily)
  if (fontFamily !== undefined) result.fontFamily = fontFamily
  const fontSize = uniform((c) =>
    c.fontSize !== undefined ? round(c.fontSize * scale) : undefined,
  )
  if (fontSize !== undefined) result.fontSize = fontSize
  const fontWeight = uniform((c) => c.fontWeight)
  if (fontWeight !== undefined) result.fontWeight = fontWeight
  const color = uniform((c) => c.color)
  if (color !== undefined) result.color = color
  const align = uniform((c) => c.align)
  if (align !== undefined) result.align = align
  const vAlign = uniform((c) => c.vAlign)
  if (vAlign !== undefined) result.vAlign = vAlign
  const lineHeight = uniform((c) => c.lineHeight)
  if (lineHeight !== undefined) result.lineHeight = lineHeight
  const letterSpacing = uniform((c) =>
    c.letterSpacing !== undefined ? round(c.letterSpacing * scale) : undefined,
  )
  if (letterSpacing !== undefined) result.letterSpacing = letterSpacing
  const paragraphSpaceBefore = uniform((c) =>
    c.paragraphSpaceBefore !== undefined ? round(c.paragraphSpaceBefore * scale) : undefined,
  )
  if (paragraphSpaceBefore !== undefined) result.paragraphSpaceBefore = paragraphSpaceBefore
  const paragraphSpaceAfter = uniform((c) =>
    c.paragraphSpaceAfter !== undefined ? round(c.paragraphSpaceAfter * scale) : undefined,
  )
  if (paragraphSpaceAfter !== undefined) result.paragraphSpaceAfter = paragraphSpaceAfter
  const textTransform = uniform((c) =>
    c.textTransform !== undefined && c.textTransform !== 'none' ? c.textTransform : undefined,
  )
  if (textTransform !== undefined) result.textTransform = textTransform
  const padding = uniform(
    (c) =>
      c.padding !== undefined
        ? {
            top: round(c.padding.top * scale),
            right: round(c.padding.right * scale),
            bottom: round(c.padding.bottom * scale),
            left: round(c.padding.left * scale),
          }
        : undefined,
    paddingEq,
  )
  if (padding !== undefined) result.padding = padding
  return result
}

function backgroundForSlide(
  parsedBg: ParsedBackground,
): ColorBackground | LinearGradientBackground | RadialGradientBackground | ImageBackground | null {
  if (parsedBg.kind === 'solid' && parsedBg.color !== undefined) {
    return { kind: 'color', color: parsedBg.color, alpha: 1 }
  }
  if (parsedBg.kind === 'gradient' && parsedBg.gradient !== undefined) {
    const g = parsedBg.gradient
    if (g.kind === 'linearGradient') {
      return { kind: 'linearGradient', angleDeg: g.angleDeg, stops: gradientStops(g) }
    }
    return {
      kind: 'radialGradient',
      centerX: 0.5,
      centerY: 0.5,
      radius: 0.5,
      stops: gradientStops(g),
    }
  }
  if (parsedBg.kind === 'image' && parsedBg.assetId !== undefined) {
    return { kind: 'image', assetId: parsedBg.assetId, fit: 'cover' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Slide writer
// ---------------------------------------------------------------------------

function writeSlideShapes(
  ctx: ReturnType<typeof createSlideDoc>,
  slideId: string,
  parsedSlide: ParsedSlide,
  scale: number,
): { objectsCreated: number; skippedImages: number; skippedUnknown: number } {
  const objCtx = getSlideObjectsCtx(ctx, slideId)
  let objectsCreated = 0
  let skippedImages = 0
  let skippedUnknown = 0

  if (objCtx === null) {
    return { objectsCreated, skippedImages, skippedUnknown }
  }

  // spId → SlideObject.id map. Populated as we emit each shape so the
  // animation pass (below) can resolve `<p:spTgt spid="N">` references
  // back to the nanoid the writer assigned.
  const spIdToObjectId = new Map<number, string>()

  for (const shape of parsedSlide.shapes) {
    // Images with no assetId were not (or could not be) uploaded — count
    // them as skipped. mapShape returns null for those.
    if (shape.kind === 'image' && (shape.assetId === undefined || shape.assetId === '')) {
      skippedImages++
      continue
    }
    // Video shapes carry their blipFill poster as `posterAssetId` on the
    // VideoObject itself (see mapShape's video branch). The renderer
    // paints that poster immediately, before the HLS transcode finishes,
    // so we don't need a sibling ImageObject anymore. Round-trip is
    // cleaner too — export emits the poster as a `<p:blipFill>` on the
    // same `<p:pic>` that carries `<a:videoFile>`, matching how
    // PowerPoint authors it.
    const obj = mapShape(shape, scale)
    if (obj === null) {
      if (shape.kind === 'image') skippedImages++
      else skippedUnknown++
      continue
    }
    try {
      addObject(objCtx, obj)
      if (shape.spId !== undefined) spIdToObjectId.set(shape.spId, obj.id)
      objectsCreated++
    } catch (err) {
      log.warn(
        {
          sourceTag: shape.sourceTag,
          kind: shape.kind,
          err: err instanceof Error ? err.message : String(err),
        },
        'addObject failed',
      )
      skippedUnknown++
    }
  }

  // Solid / gradient backgrounds — image bgs skipped in v1.
  const bg = backgroundForSlide(parsedSlide.background)
  if (bg !== null) updateSlideBackground(ctx, slideId, bg)

  // Speaker notes — seed the slide's Y.XmlFragment with ProseMirror
  // `<paragraph>` elements containing each parsed paragraph as plain text.
  // Tiptap/y-prosemirror binds to this same fragment in the editor so the
  // user sees the imported notes immediately on first open.
  if (parsedSlide.notes !== undefined && parsedSlide.notes.length > 0) {
    seedSlideNotes(ctx, slideId, parsedSlide.notes)
  }

  // Slide name + skipped flag.
  if (parsedSlide.name !== undefined && parsedSlide.name.length > 0) {
    setSlideName(ctx, slideId, parsedSlide.name)
  }
  if (parsedSlide.skipped === true) {
    setSlideSkipped(ctx, slideId, true)
  }

  // Slide transition. Parser uses short PPTX direction codes ('l' / 'r'
  // / 'u' / 'd'); Narrative's SlidePushDirection uses the long form.
  if (parsedSlide.transition !== undefined) {
    const longDirection: 'left' | 'right' | 'up' | 'down' | undefined =
      parsedSlide.transition.direction === 'l'
        ? 'left'
        : parsedSlide.transition.direction === 'r'
          ? 'right'
          : parsedSlide.transition.direction === 'u'
            ? 'up'
            : parsedSlide.transition.direction === 'd'
              ? 'down'
              : undefined
    const patch: {
      kind: NonNullable<ParsedSlide['transition']>['kind']
      durationMs: number
      direction?: 'left' | 'right' | 'up' | 'down'
    } = {
      kind: parsedSlide.transition.kind,
      durationMs: parsedSlide.transition.durationMs,
    }
    if (longDirection !== undefined) patch.direction = longDirection
    updateSlideTransition(ctx, slideId, patch)
  }

  // Animations — resolve each step's target spId against the map we just
  // built, then add to the slide's animations Y.Array via the
  // animationMutations API. Steps that target an unknown spId (e.g. the
  // shape was dropped during the shapes pass) are skipped silently.
  if (parsedSlide.animations !== undefined && parsedSlide.animations.length > 0) {
    const animCtx = getSlideAnimationsCtx(ctx, slideId)
    if (animCtx !== null) {
      for (const step of parsedSlide.animations) {
        const targetObjId = spIdToObjectId.get(step.spId)
        if (targetObjId === undefined) continue
        addAnimation(animCtx, {
          objectId: targetObjId,
          preset: step.preset as never,
          trigger: step.trigger,
          duration: Math.max(0.05, step.durationMs / 1000),
          delay: Math.max(0, step.delayMs / 1000),
          easing: 'power2.out',
        })
      }
    }
  }

  return { objectsCreated, skippedImages, skippedUnknown }
}

/**
 * Lazily populate a slide's notes Y.XmlFragment from parsed plain-text
 * paragraphs. ProseMirror's default schema treats each block as a
 * `paragraph` node containing zero or more text children, so we mirror
 * that shape: one Y.XmlElement('paragraph') per source paragraph, each
 * holding a Y.XmlText with the line's plain content.
 *
 * Empty paragraphs come through as empty `<paragraph/>` so the editor
 * preserves blank-line spacing from the source.
 */
function seedSlideNotes(
  ctx: ReturnType<typeof createSlideDoc>,
  slideId: string,
  paragraphs: string[],
): void {
  const fragment = getSlideNotes(ctx, slideId)
  if (fragment === null) return
  ctx.doc.transact(() => {
    for (const para of paragraphs) {
      const block = new Y.XmlElement('paragraph')
      if (para.length > 0) {
        const text = new Y.XmlText()
        text.insert(0, para)
        block.insert(0, [text])
      }
      fragment.insert(fragment.length, [block])
    }
  })
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

/**
 * Turn a parsed `.pptx` into a Y.Doc state buffer + summary stats. Pure —
 * no DB or filesystem side-effects. Caller is responsible for inserting
 * the resulting `state` into `deck_updates`.
 */
export function buildDeckUpdate(parsed: ParsedPptx): WriteResult {
  const ctx = createSlideDoc()

  // Capture the default empty slide id so we can remove it after import.
  const defaultSlides = listSlides(ctx)
  const defaultSlideId = defaultSlides[0]?.id

  let objectsCreated = 0
  let skippedImages = 0
  let skippedUnknown = 0

  // PPTX widescreen is 1280×720 @ 96 DPI; we target a 1920×1080 canvas. The
  // scale factor is uniform — width and height ratios are identical for
  // standard 16:9 inputs. For non-standard aspect ratios we pick the smaller
  // ratio so content fits inside the target canvas (letterboxing) instead of
  // spilling off the edge.
  const scaleX = SLIDE_WIDTH / Math.max(1, parsed.slideWidth)
  const scaleY = SLIDE_HEIGHT / Math.max(1, parsed.slideHeight)
  const scale = Math.min(scaleX, scaleY)

  for (const slide of parsed.slides) {
    const created = addSlide(ctx)
    const stats = writeSlideShapes(ctx, created.id, slide, scale)
    objectsCreated += stats.objectsCreated
    skippedImages += stats.skippedImages
    skippedUnknown += stats.skippedUnknown
  }

  // Remove the default empty slide so the deck starts on the first imported
  // slide. If for some reason we have zero parsed slides, leave the empty
  // default behind — `removeSlide` would just re-create it anyway.
  if (defaultSlideId !== undefined && parsed.slides.length > 0) {
    removeSlide(ctx, defaultSlideId)
  }

  const state = Buffer.from(Y.encodeStateAsUpdate(ctx.doc))
  return {
    state,
    slideCount: listSlides(ctx).length,
    objectsCreated,
    skipped: { images: skippedImages, unknownShapes: skippedUnknown },
  }
}

/**
 * Insert parsed slides into an existing deck's Y.Doc and return the
 * differential update — the caller stores this as a new `deck_updates`
 * row, so Hocuspocus's next replay produces the existing deck PLUS the
 * inserted slides.
 *
 * The `existingDoc` MUST already be hydrated from prior `deck_updates`
 * rows; this function does not re-fetch anything from storage. The
 * caller (route handler) replays the deck history and hands the resulting
 * Y.Doc here.
 *
 * `insertAt` is the index the first imported slide takes in the deck, in
 * the PRE-insert array — the same convention the slides panel's drop
 * indicator uses, so "the indicator sits above slide 3" means
 * `insertAt === 3`. The rest follow it in file order, which is why the
 * index is stepped per slide instead of passing the same one each time:
 * `addSlide(ctx, 3)` three times over would reverse the deck. Omitted (or
 * past the end) appends, which is what the toolbar's Append button wants.
 *
 * Returned `slideCount` is the number of slides INSERTED, not the deck's
 * new total — matches the import route's response shape for symmetry.
 */
export function buildDeckAppendUpdate(
  parsed: ParsedPptx,
  existingDoc: Y.Doc,
  insertAt?: number,
): WriteResult {
  const ctx = hydrateSlideDoc(existingDoc)
  // Snapshot of the doc's state BEFORE we append. `encodeStateAsUpdate(doc,
  // sv)` returns only the operations missing from `sv` — exactly the diff
  // our mutations are about to introduce.
  const sv = Y.encodeStateVector(existingDoc)

  let objectsCreated = 0
  let skippedImages = 0
  let skippedUnknown = 0

  const scaleX = SLIDE_WIDTH / Math.max(1, parsed.slideWidth)
  const scaleY = SLIDE_HEIGHT / Math.max(1, parsed.slideHeight)
  const scale = Math.min(scaleX, scaleY)

  // Clamp once, up front: a caller that asks for index 99 of a 4-slide deck
  // means "at the end", and a negative index means "at the top".
  const existingCount = listSlides(ctx).length
  const base =
    insertAt === undefined ? undefined : Math.max(0, Math.min(Math.trunc(insertAt), existingCount))

  for (const [offset, slide] of parsed.slides.entries()) {
    // addSlide() with no index argument appends at the end of the slides
    // array — what "import → append" wants. With one, each slide goes one
    // place further along so the imported run keeps its file order.
    const created = base === undefined ? addSlide(ctx) : addSlide(ctx, base + offset)
    const stats = writeSlideShapes(ctx, created.id, slide, scale)
    objectsCreated += stats.objectsCreated
    skippedImages += stats.skippedImages
    skippedUnknown += stats.skippedUnknown
  }

  const state = Buffer.from(Y.encodeStateAsUpdate(existingDoc, sv))
  return {
    state,
    slideCount: parsed.slides.length,
    objectsCreated,
    skipped: { images: skippedImages, unknownShapes: skippedUnknown },
  }
}
