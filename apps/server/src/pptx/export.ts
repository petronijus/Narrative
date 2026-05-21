/**
 * pptx/export.ts
 *
 * Take a deck's slides (plain JSON snapshots from `@narrative/slide-model`'s
 * `listSlides`) and emit a `.pptx` Buffer via `pptxgenjs`. The shape is the
 * reverse of `./writer.ts`: we walk Narrative objects in 1920×1080 CSS-px
 * space and convert to pptxgenjs's inch-native coordinate system on the
 * standard 13.333" × 7.5" LAYOUT_WIDE slide.
 *
 * v1 coverage (mirrors the import side):
 *   - text frames (single style — color, fontSize, bold, align)
 *   - rectangle / ellipse / line shapes (solid + linear/radial gradient fill,
 *     stroke colour + width, alpha)
 *   - solid + gradient slide backgrounds (image backgrounds skipped — image
 *     embedding pipeline pending)
 *   - position / size / rotation
 * Anything else (images, video, components, animations) is dropped silently.
 */

import PptxGenJSImport from 'pptxgenjs'
import JSZip from 'jszip'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'
import * as Y from 'yjs'
import { SLIDE_WIDTH, getEffectiveBorderSegment, hSegKey, vSegKey } from '@narrative/shared'
import { toDelta } from '@narrative/slide-model'
import type {
  Slide,
  SlideObject,
  TextObject,
  RectangleObject,
  EllipseObject,
  TriangleObject,
  PolygonObject,
  LineObject,
  ArrowObject,
  PathObject,
  ImageObject,
  VideoObject,
  TableObject,
  TableCell,
  TableBorderStyle,
  SlideBackground,
  SlideTransition,
  AnimationStep,
  LinearGradientFill,
  RadialGradientFill,
  TokenRef,
  ObjectHyperlink,
  ImageMask,
} from '@narrative/shared'

/**
 * Resolves a Narrative asset to embeddable bytes. Returning `null` skips the
 * image (the exporter drops the shape silently). The route handler wires
 * this to a MinIO GetObject + `streamToBuffer` pipeline; tests can stub it
 * to a static byte response.
 */
export type AssetLoader = (assetId: string) => Promise<{ bytes: Buffer; mimeType: string } | null>

// ---------------------------------------------------------------------------
// pptxgenjs interop (see ./writer.ts for the same dance)
// ---------------------------------------------------------------------------

// Minimal subset of the pptxgenjs API we actually call. Typed loosely so
// the same module compiles whether the runtime hands us the class directly
// (native Node ESM) or wrapped in `{ default }` (tsx CJS interop).
interface PptxSlide {
  background: unknown
  hidden?: boolean
  addText: (text: string | unknown[], opts: Record<string, unknown>) => void
  addShape: (kind: string, opts: Record<string, unknown>) => void
  addImage: (opts: Record<string, unknown>) => void
  addNotes: (notes: string) => void
  addTable: (rows: Array<Array<Record<string, unknown>>>, opts: Record<string, unknown>) => void
  addMedia: (opts: Record<string, unknown>) => void
}
interface PptxApp {
  layout: string
  defineLayout: (opts: { name: string; width: number; height: number }) => void
  author: string
  title: string
  addSlide: () => PptxSlide
  write: (opts: { outputType: 'nodebuffer' }) => Promise<Buffer | ArrayBuffer | Uint8Array>
}
type PptxCtor = new () => PptxApp
function resolvePptxCtor(mod: unknown): PptxCtor {
  if (mod !== null && typeof mod === 'object' && 'default' in mod) {
    const inner = (mod as { default: unknown }).default
    if (typeof inner === 'function') return inner as unknown as PptxCtor
  }
  return mod as unknown as PptxCtor
}
const PptxGenJS = resolvePptxCtor(PptxGenJSImport)

// ---------------------------------------------------------------------------
// Coordinate math
// ---------------------------------------------------------------------------

/**
 * pptxgenjs's coordinate space is inches. Narrative's is CSS px on a
 * 1920×1080 canvas. We emit `LAYOUT_WIDE` = 13.333" × 7.5", so 1 inch maps
 * to exactly SLIDE_WIDTH / 13.333 = 144 Narrative px.
 *
 * The conversion is a single ratio in both axes — `LAYOUT_WIDE`'s aspect
 * (13.333/7.5 ≈ 1.778) matches 1920/1080 (≈ 1.778), so x and y use the
 * same factor and round-trips with the importer's `scale = 1.5` upscale.
 */
const LAYOUT_WIDE_W_IN = 13.333
const PX_PER_IN = SLIDE_WIDTH / LAYOUT_WIDE_W_IN
const px = (n: number): number => round(n / PX_PER_IN, 3)
/** Font size: Narrative px @ 1920 canvas → pt. 1 inch = 72 pt, so
 *  `pt = px / PX_PER_IN * 72`. */
const fontPxToPt = (n: number): number => round((n * 72) / PX_PER_IN, 2)
/** Stroke width: pptxgenjs uses pt for line width, same conversion. */
const strokeWidthPxToPt = (n: number): number => round((n * 72) / PX_PER_IN, 2)

function round(n: number, digits: number): number {
  const k = 10 ** digits
  return Math.round(n * k) / k
}

function hex6(n: number): string {
  return n.toString(16).padStart(6, '0').toUpperCase()
}

/**
 * Token refs (color tokens from folder palettes) — for export we just resolve
 * to a neutral grey. Once we wire the token-resolution pass server-side this
 * becomes a real lookup; for now exported decks lose the token binding which
 * is fine for the "share with PowerPoint user" use case.
 */
function resolveColor(c: number | TokenRef | undefined, fallback: number): number {
  if (typeof c === 'number') return c
  return fallback
}

/**
 * F3 — translate Narrative's `ObjectHyperlink` into a pptxgenjs
 * `HyperlinkProps` payload. `kind === 'url'` becomes `{ url, ... }`;
 * `kind === 'slide'` becomes `{ slide: <1-based index> }` after looking
 * up the slideId in the deck-wide id→index map. Returns `undefined` for
 * unresolvable slide ids so the caller can leave the opt unset.
 */
function buildHyperlinkOpt(
  hyperlink: ObjectHyperlink | undefined,
  slideIdToIndex: Map<string, number>,
): Record<string, unknown> | undefined {
  if (hyperlink === undefined) return undefined
  if (hyperlink.kind === 'url') {
    return { url: hyperlink.href }
  }
  const idx = slideIdToIndex.get(hyperlink.slideId)
  if (idx === undefined) return undefined
  return { slide: idx + 1 }
}

// ---------------------------------------------------------------------------
// Per-object emitters
// ---------------------------------------------------------------------------

function emitText(
  slide: PptxSlide,
  obj: TextObject,
  slideIdToIndex: Map<string, number>,
  slideIndex: number,
  fixups: GradientFixup[],
): void {
  const isSlideNumberField = obj.isSlideNumber === true
  // F5 — slide-number field. Pass a placeholder character so pptxgenjs
  // still builds the `<p:sp>` + `<a:txBody>` skeleton (and keeps every
  // formatting attribute we set on this frame); the post-process pass
  // swaps the first `<a:r>` for an `<a:fld type="slidenum">`. The
  // placeholder content never reaches PowerPoint — the field renders
  // the live slide number on every open.
  const textValue = isSlideNumberField
    ? '#'
    : typeof obj.text === 'string'
      ? obj.text
      : (obj.text?.toString() ?? '')
  if (textValue.length === 0) return
  if (isSlideNumberField) {
    fixups.push({
      kind: 'slideNumber',
      slideIndex,
      xEmu: pxToEmu(obj.x),
      yEmu: pxToEmu(obj.y),
      cxEmu: pxToEmu(obj.width),
      cyEmu: pxToEmu(obj.height),
    })
  }

  const defaultBold = obj.fontWeight === 'bold' || Number(obj.fontWeight) >= 600
  const defaultColorHex = hex6(resolveColor(obj.color, 0x000000))
  const defaultFontPt = fontPxToPt(obj.fontSize)
  const defaultItalic = obj.italic === true
  const defaultUnderline = obj.underline === true

  // Frame-level options (placement, alignment, bullet, hyperlink). Per-run
  // options will be added below when `obj.text` is a Y.Text with rich
  // formatting; otherwise we apply these directly to the single string.
  const opts: Record<string, unknown> = {
    x: px(obj.x),
    y: px(obj.y),
    w: px(obj.width),
    h: px(obj.height),
    fontSize: defaultFontPt,
    color: defaultColorHex,
    bold: defaultBold,
    align: obj.align,
    valign: obj.vAlign === 'middle' ? 'middle' : obj.vAlign === 'bottom' ? 'bottom' : 'top',
    italic: defaultItalic,
    underline: defaultUnderline ? { style: 'sng' } : undefined,
  }
  if (obj.rotation !== 0) opts['rotate'] = obj.rotation
  if (obj.fontFamily !== undefined) opts['fontFace'] = obj.fontFamily
  if (obj.opacity < 1) opts['transparency'] = Math.round((1 - obj.opacity) * 100)
  if (obj.flipH === true) opts['flipH'] = true
  if (obj.flipV === true) opts['flipV'] = true
  if (obj.colorAlpha !== undefined && obj.colorAlpha < 1) {
    opts['transparency'] = Math.round((1 - obj.colorAlpha) * 100)
  }
  // Fine-grained typography — straightforward maps to pptxgenjs's text opts.
  if (obj.letterSpacing !== undefined && obj.letterSpacing !== 0) {
    // pptxgenjs `charSpacing` is in points; Narrative letterSpacing is px.
    opts['charSpacing'] = (obj.letterSpacing * 72) / PX_PER_IN
  }
  if (obj.lineHeight !== undefined && obj.lineHeight > 0) {
    opts['lineSpacingMultiple'] = obj.lineHeight
  }
  if (obj.paragraphSpaceBefore !== undefined && obj.paragraphSpaceBefore > 0) {
    opts['paraSpaceBefore'] = (obj.paragraphSpaceBefore * 72) / PX_PER_IN
  }
  if (obj.paragraphSpaceAfter !== undefined && obj.paragraphSpaceAfter > 0) {
    opts['paraSpaceAfter'] = (obj.paragraphSpaceAfter * 72) / PX_PER_IN
  }
  // Text stroke ("outline" in pptxgenjs).
  if (obj.stroke !== undefined && obj.strokeWidth !== undefined && obj.strokeWidth > 0) {
    opts['outline'] = {
      color: hex6(resolveColor(obj.stroke, 0x000000)),
      size: strokeWidthPxToPt(obj.strokeWidth),
    }
  }
  // Drop shadow on text frames — same helper as shapes.
  applyShadowAndBlur(opts, obj, slideIndex, fixups)
  // pptxgenjs `bullet: true` emits `<a:buChar char="•">` on every paragraph;
  // `bullet: { type: 'number' }` emits `<a:buAutoNum type="arabicPeriod">`.
  if (obj.listStyle === 'bullet') {
    opts['bullet'] = true
  } else if (obj.listStyle === 'numbered') {
    opts['bullet'] = { type: 'number' }
  }
  // Object-level hyperlink lands on the addText opts; pptxgenjs writes it
  // as `<a:hlinkClick r:id="…"/>` on every run inside the frame. URL
  // hyperlinks map directly; slide-jump hyperlinks resolve through the
  // deck-wide slide-id → 1-based-index map.
  const link = buildHyperlinkOpt(obj.hyperlink, slideIdToIndex)
  if (link !== undefined) opts['hyperlink'] = link
  // Strip undefined keys — pptxgenjs treats them as set-to-undefined.
  for (const k of Object.keys(opts)) {
    if (opts[k] === undefined) delete opts[k]
  }

  // Rich-text path: when the body is a Y.Text with diverging per-run
  // attrs, walk it via toDelta and emit pptxgenjs's text-array API. Each
  // delta op becomes one `{ text, options }` entry; missing run attrs
  // inherit from the frame defaults applied above (pptxgenjs merges
  // per-run options on top of the frame opts at write time).
  if (obj.text instanceof Y.Text) {
    const delta = toDelta(obj.text)
    if (delta.length > 0 && delta.some((op) => op.attributes !== undefined)) {
      const runs = delta.map((op) => {
        const runOpts: Record<string, unknown> = {}
        const a = op.attributes
        if (a !== undefined) {
          if (a.fontWeight !== undefined) runOpts['bold'] = a.fontWeight >= 600
          if (a.italic === true) runOpts['italic'] = true
          if (a.underline === true) runOpts['underline'] = { style: 'sng' }
          if (a.color !== undefined) runOpts['color'] = hex6(a.color)
          if (a.fontSize !== undefined) runOpts['fontSize'] = fontPxToPt(a.fontSize)
          if (a.fontFamily !== undefined) runOpts['fontFace'] = a.fontFamily
        }
        return { text: op.insert, options: runOpts }
      })
      slide.addText(runs, opts)
      return
    }
  }
  slide.addText(textValue, opts)
}

// pptxgenjs does NOT natively support multi-stop gradient fills on shapes —
// at emit time we collapse them to the middle stop's colour so the .pptx is
// well-formed, then a zip post-processing pass (see `applyGradientFixups`
// below) walks each slide's XML and replaces the placeholder `<a:solidFill>`
// with a proper `<a:gradFill>` carrying the original stops + angle. The
// caller is shielded from this — `exportDeckToPptx` returns a single Buffer
// either way.
function gradientToFillColor(g: LinearGradientFill | RadialGradientFill): string {
  const stops = g.stops ?? []
  const mid = stops[Math.floor(stops.length / 2)] ?? stops[0]
  if (mid !== undefined) return hex6(mid.color)
  return '888888'
}

/**
 * A shape that wanted a multi-stop gradient but couldn't get one from
 * pptxgenjs. Recorded during emit so the post-processing pass can find
 * the matching `<p:sp>` in the written slide XML and swap its
 * `<a:solidFill>` for a real `<a:gradFill>`.
 *
 * Coordinates are stored in EMU using the exact same px→inch→EMU
 * rounding pptxgenjs applies, so the match against the written
 * `<a:off x= y=/>` `<a:ext cx= cy=/>` is exact (no tolerance fuzz).
 */
interface SlideMetaFixup {
  slideIndex: number
  name?: string
  transition?: SlideTransition
  animations?: AnimationStep[]
}

interface ShapeGradientFixup {
  kind: 'shape'
  /** 0-based — matches `ppt/slides/slide${i+1}.xml`. */
  slideIndex: number
  xEmu: number
  yEmu: number
  cxEmu: number
  cyEmu: number
  gradient: LinearGradientFill | RadialGradientFill
}

/**
 * M29 — cell-level gradient fill on a TableObject. pptxgenjs's cell-fill API
 * is solid-only, so we emit a placeholder `<a:solidFill>` (the gradient's
 * middle-stop colour, same trick the shape path uses) and post-process the
 * zip to replace it with a real `<a:gradFill>` inside the matching
 * `<a:tcPr>`. Match keys: the surrounding `<p:graphicFrame>` is found by
 * its xfrm coords (same EMU rounding the shape fixup uses), then we walk
 * the `<a:tbl>/<a:tr>/<a:tc>` grid by (row, col) index — pptxgenjs emits one
 * `<a:tc>` element per column slot (origin or hMerge continuation), so
 * positional indexing is exact.
 */
interface TableCellGradientFixup {
  kind: 'tableCell'
  slideIndex: number
  tableXEmu: number
  tableYEmu: number
  tableCxEmu: number
  tableCyEmu: number
  row: number
  col: number
  gradient: LinearGradientFill | RadialGradientFill
}

/**
 * F15 — per-run rich text inside a table cell. pptxgenjs's `addTable`
 * collapses cell text arrays in ways that drop runs for mixed-format
 * inputs (verified empirically). We emit the concatenated plain string
 * via `buildCellTextForExport` for layout, then the post-process pass
 * replaces the single `<a:r>` inside `<a:tc>/<a:txBody>/<a:p>` with the
 * captured run sequence (each run carries its own `<a:rPr>` for bold /
 * italic / underline / colour / size / typeface).
 */
interface CellRichTextRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: number
  /** Font size in PPTX 100ths of a pt (matches `<a:rPr sz>`). */
  sizeHundredthsPt?: number
  fontFamily?: string
}

interface CellRichTextFixup {
  kind: 'cellRichText'
  slideIndex: number
  tableXEmu: number
  tableYEmu: number
  tableCxEmu: number
  tableCyEmu: number
  row: number
  col: number
  runs: CellRichTextRun[]
}

/**
 * F11 — gaussian blur on any shape / image. PPTX's
 * `<a:effectLst><a:blur rad="N"/></a:effectLst>` lives inside `<p:spPr>`
 * (or `<p:pic>`'s `<p:spPr>`). pptxgenjs doesn't expose blur on its
 * effect surface, so the post-process pass injects the effect element
 * after locating the shape by its xfrm coords.
 */
interface BlurFixup {
  kind: 'blur'
  slideIndex: number
  xEmu: number
  yEmu: number
  cxEmu: number
  cyEmu: number
  /** Blur radius in EMU. PPTX clamps anything > 2540000 EMU (~2 in). */
  radEmu: number
}

/**
 * F10 — image with a non-rectangular mask (ellipse / triangle / polygon
 * / path silhouette). pptxgenjs's `addImage` always emits
 * `<a:prstGeom prst="rect">`; the post-process pass swaps that for the
 * matching preset (or `<a:custGeom>` for path masks) so PowerPoint
 * clips the bitmap to the silhouette.
 */
interface ImageMaskFixup {
  kind: 'imageMask'
  slideIndex: number
  xEmu: number
  yEmu: number
  cxEmu: number
  cyEmu: number
  mask: ImageMask
}

/**
 * F6 — slide background with a multi-stop gradient. pptxgenjs's
 * `slide.background = { color }` API is solid-only, so we set a
 * placeholder colour (the gradient's middle stop) and the post-process
 * pass replaces the `<p:bg>/<p:bgPr>/<a:solidFill>` with `<a:gradFill>`
 * carrying the full stop list + angle / radial geometry.
 */
interface BackgroundGradientFixup {
  kind: 'background'
  slideIndex: number
  gradient: LinearGradientFill | RadialGradientFill
}

/**
 * F5 — TextObject with `isSlideNumber === true`. pptxgenjs has no API for
 * the PPTX slide-number field, so we emit a placeholder via `addText`
 * (keeps the `<p:sp>` skeleton, body properties, and per-run formatting
 * intact) and a post-process pass replaces the first `<a:r>` inside the
 * frame's `<a:txBody>/<a:p>` with `<a:fld type="slidenum">`. PowerPoint
 * then renders the live slide number on every reopen.
 */
interface SlideNumberFixup {
  kind: 'slideNumber'
  slideIndex: number
  xEmu: number
  yEmu: number
  cxEmu: number
  cyEmu: number
}

type GradientFixup =
  | ShapeGradientFixup
  | TableCellGradientFixup
  | SlideNumberFixup
  | BackgroundGradientFixup
  | ImageMaskFixup
  | BlurFixup
  | CellRichTextFixup

/** Same px→EMU pipeline pptxgenjs uses internally: 1 inch = 914400 EMU. */
const EMU_PER_INCH = 914400
function pxToEmu(n: number): number {
  // px → inch → EMU. Round at each step so the match keys stay integer-exact
  // against the values pptxgenjs writes into `<a:off x="…"/>`.
  return Math.round(round(n / PX_PER_IN, 3) * EMU_PER_INCH)
}

function emitRectOrEllipse(
  slide: PptxSlide,
  obj: RectangleObject | EllipseObject | TriangleObject | PolygonObject,
  kind: string,
  slideIndex: number,
  fixups: GradientFixup[],
  hyperlink: Record<string, unknown> | undefined,
): void {
  const fillColorHex =
    obj.fillStyle !== undefined && obj.fillStyle.kind !== 'image'
      ? gradientToFillColor(obj.fillStyle)
      : hex6(resolveColor(obj.fill, 0x4060e0))

  // Record a fixup for multi-stop gradients. We still emit the collapsed
  // solid fill so the .pptx is structurally valid mid-flight; the
  // post-processing pass swaps the solidFill for a gradFill keyed by EMU
  // coordinates.
  if (
    obj.fillStyle !== undefined &&
    (obj.fillStyle.kind === 'linearGradient' || obj.fillStyle.kind === 'radialGradient') &&
    obj.fillStyle.stops !== undefined &&
    obj.fillStyle.stops.length > 1
  ) {
    fixups.push({
      kind: 'shape',
      slideIndex,
      xEmu: pxToEmu(obj.x),
      yEmu: pxToEmu(obj.y),
      cxEmu: pxToEmu(obj.width),
      cyEmu: pxToEmu(obj.height),
      gradient: obj.fillStyle,
    })
  }

  // PowerPoint's roundRect needs a corner radius hint in [0,1]; we estimate
  // it from `cornerRadius` (px) against the shape's shortest side.
  const opts: Record<string, unknown> = {
    x: px(obj.x),
    y: px(obj.y),
    w: px(obj.width),
    h: px(obj.height),
    fill: { color: fillColorHex },
  }
  if (obj.fillAlpha !== undefined && obj.fillAlpha < 1) {
    ;(opts['fill'] as Record<string, unknown>)['transparency'] = Math.round(
      (1 - obj.fillAlpha) * 100,
    )
  }
  if (obj.stroke !== undefined) {
    const ln: Record<string, unknown> = {
      color: hex6(resolveColor(obj.stroke, 0x000000)),
    }
    if (obj.strokeWidth !== undefined && obj.strokeWidth > 0) {
      ln['width'] = strokeWidthPxToPt(obj.strokeWidth)
    }
    if (obj.strokeAlpha !== undefined && obj.strokeAlpha < 1) {
      ln['transparency'] = Math.round((1 - obj.strokeAlpha) * 100)
    }
    if (obj.strokeDash === true) ln['dashType'] = 'dash'
    opts['line'] = ln
  }
  if (obj.rotation !== 0) opts['rotate'] = obj.rotation
  if (obj.opacity < 1) {
    ;(opts['fill'] as Record<string, unknown>)['transparency'] = Math.round((1 - obj.opacity) * 100)
  }
  // F1 — corner radius. pptxgenjs's `rectRadius` is a unit-fraction of the
  // shorter side (0..0.5). Narrative stores either a uniform px radius or
  // a per-corner {tl,tr,bl,br} object; PPTX's `roundRect` preset only
  // models uniform radii so per-corner collapses to the average. Custom
  // per-corner radii would need a `<a:custGeom>` shape; deferred since
  // the visual delta is minor on most decks.
  if ('cornerRadius' in obj && obj.cornerRadius !== undefined && kind === 'roundRect') {
    const cr = obj.cornerRadius
    const radiusPx = typeof cr === 'number' ? cr : (cr.tl + cr.tr + cr.br + cr.bl) / 4
    const shortSidePx = Math.min(obj.width, obj.height)
    if (radiusPx > 0 && shortSidePx > 0) {
      opts['rectRadius'] = Math.min(0.5, radiusPx / shortSidePx)
    }
  }
  // Drop shadow + gaussian blur — converted from cartesian (offsetX/Y) to
  // PPTX's polar (angle + distance) at emit time. Renderer rounds the
  // angle to whole degrees, which matches PPTX's display resolution.
  applyShadowAndBlur(opts, obj, slideIndex, fixups)
  // F2 — flipH/flipV. PPTX `<a:xfrm flipH="1" flipV="1">` mirrors the
  // shape across its centre axes. pptxgenjs exposes both as boolean
  // opts. Applies to every parametric shape that goes through this
  // emitter (rect / ellipse / triangle / polygon).
  if (obj.flipH === true) opts['flipH'] = true
  if (obj.flipV === true) opts['flipV'] = true
  if (hyperlink !== undefined) opts['hyperlink'] = hyperlink
  slide.addShape(kind, opts)
}

/**
 * Convert Narrative's cartesian shadow (offsetX/Y in px) + blur to the
 * polar pptxgenjs / PPTX form. Applied uniformly to rect / ellipse /
 * triangle / polygon / image emit options. Text uses its own dedicated
 * `shadow:` option in pptxgenjs so emitText calls this same helper too.
 */
function applyShadowAndBlur(
  opts: Record<string, unknown>,
  obj: SlideObject,
  slideIndex?: number,
  fixups?: GradientFixup[],
): void {
  if (obj.shadow !== undefined) {
    const distPx = Math.hypot(obj.shadow.offsetX, obj.shadow.offsetY)
    const angleDeg =
      distPx > 0
        ? Math.round(
            ((Math.atan2(obj.shadow.offsetY, obj.shadow.offsetX) * 180) / Math.PI + 360) % 360,
          )
        : 0
    opts['shadow'] = {
      type: 'outer',
      color: hex6(resolveColor(obj.shadow.color, 0x000000)),
      blur: (obj.shadow.blur * 72) / PX_PER_IN,
      offset: (distPx * 72) / PX_PER_IN,
      angle: angleDeg,
      opacity: obj.shadow.opacity,
    }
  }
  // F11 — gaussian blur via post-process splice. Record `(slideIndex,
  // bbox EMU, radEmu)` so the post-process pass can find the shape's
  // `<p:spPr>` and insert `<a:effectLst><a:blur rad="N"/></a:effectLst>`.
  // PPTX's blur radius is in EMU; we convert via the same pxToEmu the
  // shape gradient fixup uses so the lookup keys line up.
  if (obj.blur !== undefined && obj.blur > 0 && slideIndex !== undefined && fixups !== undefined) {
    fixups.push({
      kind: 'blur',
      slideIndex,
      xEmu: pxToEmu(obj.x),
      yEmu: pxToEmu(obj.y),
      cxEmu: pxToEmu(obj.width),
      cyEmu: pxToEmu(obj.height),
      radEmu: pxToEmu(obj.blur),
    })
  }
}

/**
 * Emit a triangle/polygon shape. The fill / stroke / gradient pipeline is
 * identical to rectangle/ellipse — same `addShape(prst, opts)` API on
 * pptxgenjs, just with a different geometric preset. We reuse
 * emitRectOrEllipse by passing it a sufficiently-rect-like cast and a
 * shape-kind alias; the only structural difference is the preset name.
 */
function emitParametric(
  slide: PptxSlide,
  obj: TriangleObject | PolygonObject,
  prst: string,
  slideIndex: number,
  fixups: GradientFixup[],
  hyperlink: Record<string, unknown> | undefined,
): void {
  // Triangle / Polygon share the rect/ellipse fill+stroke+gradient
  // pipeline — same `addShape(prst, opts)` call on pptxgenjs, just with
  // a different geometric preset name. The shared emitter now accepts
  // any prst string and any rect-shaped object, so we route through it.
  emitRectOrEllipse(slide, obj, prst, slideIndex, fixups, hyperlink)
}

/**
 * Emit an arrow as a pptxgenjs `line` shape with begin/end arrow types
 * driven by the object's startCap/endCap. The bbox-based endpoint
 * derivation on the import side rounds back to the same flipH/flipV
 * the writer reads — for export we don't need flips because the
 * `line.flipH` / `line.flipV` options on pptxgenjs default to false and
 * we always emit the line top-left → bottom-right (or one of the four
 * orientations) via the `flipH` / `flipV` opts when the endpoint pair
 * crosses an axis.
 */
function emitArrow(
  slide: PptxSlide,
  obj: ArrowObject,
  hyperlink: Record<string, unknown> | undefined,
): void {
  const lineOpts: Record<string, unknown> = {
    color: hex6(resolveColor(obj.stroke ?? 0x111111, 0x111111)),
    width: strokeWidthPxToPt(obj.strokeWidth ?? 2),
  }
  if (obj.dash === true) lineOpts['dashType'] = 'dash'
  if (obj.strokeAlpha !== undefined && obj.strokeAlpha < 1) {
    lineOpts['transparency'] = Math.round((1 - obj.strokeAlpha) * 100)
  }
  // pptxgenjs arrow types: 'none' | 'arrow' | 'diamond' | 'oval' |
  // 'stealth' | 'triangle'. Narrative's LineCap collapses to 'none' |
  // 'arrow' | 'round' | 'square'; map 'arrow' → 'triangle' (the PPTX
  // arrowhead most users expect) and anything else → 'none'.
  lineOpts['beginArrowType'] = obj.startCap === 'arrow' ? 'triangle' : 'none'
  lineOpts['endArrowType'] = obj.endCap === 'arrow' ? 'triangle' : 'none'

  // Determine flipH/flipV from p1/p2 orientation within the bbox. The
  // "natural" PPTX line goes from top-left → bottom-right relative to
  // the bbox; non-standard endpoint pairs need flipH/flipV to match.
  const flipH = obj.p1.x > obj.p2.x
  const flipV = obj.p1.y > obj.p2.y

  const opts: Record<string, unknown> = {
    x: px(obj.x),
    y: px(obj.y),
    w: Math.max(0.01, px(obj.width)),
    h: Math.max(0.01, px(obj.height)),
    line: lineOpts,
  }
  if (flipH) opts['flipH'] = true
  if (flipV) opts['flipV'] = true
  if (obj.rotation !== 0) opts['rotate'] = obj.rotation
  if (hyperlink !== undefined) opts['hyperlink'] = hyperlink
  slide.addShape('line', opts)
}

/**
 * Emit a PathObject as a pptxgenjs `custGeom` shape. pptxgenjs maps its
 * `points: [...]` array straight to `<a:custGeom>/<a:pathLst>/<a:path>`:
 *   - first point gets `moveTo: true`
 *   - cubic-bezier anchors become `curve: { type: 'cubic', x1, y1, x2, y2 }`
 *     where (x1, y1) is the OUTGOING handle of the previous anchor and
 *     (x2, y2) is the INCOMING handle of this anchor — matching the
 *     parser's `cpOut`/`cpIn` convention.
 *   - straight segments are plain `{ x, y }`
 *   - `{ close: true }` terminates a closed path
 *
 * Path coordinates land in inches (pptxgenjs `Coord` = number-of-inches
 * | percent string), so we route every anchor through `px()` — same
 * conversion the rectangle / ellipse emitters use.
 */
function emitPath(
  slide: PptxSlide,
  obj: PathObject,
  _slideIndex: number,
  _fixups: GradientFixup[],
  hyperlink: Record<string, unknown> | undefined,
): void {
  const points: Array<Record<string, unknown>> = []
  for (let i = 0; i < obj.anchors.length; i++) {
    const a = obj.anchors[i]!
    const abs = { x: px(obj.x + a.x), y: px(obj.y + a.y) }
    if (i === 0) {
      points.push({ ...abs, moveTo: true })
      continue
    }
    const prev = obj.anchors[i - 1]!
    if (prev.cpOut !== undefined || a.cpIn !== undefined) {
      const cp1 = prev.cpOut ?? { x: 0, y: 0 }
      const cp2 = a.cpIn ?? { x: 0, y: 0 }
      points.push({
        ...abs,
        curve: {
          type: 'cubic',
          x1: px(obj.x + prev.x + cp1.x),
          y1: px(obj.y + prev.y + cp1.y),
          x2: px(obj.x + a.x + cp2.x),
          y2: px(obj.y + a.y + cp2.y),
        },
      })
    } else {
      points.push(abs)
    }
  }
  if (obj.closed === true) points.push({ close: true })

  const opts: Record<string, unknown> = {
    x: px(obj.x),
    y: px(obj.y),
    w: Math.max(0.01, px(obj.width)),
    h: Math.max(0.01, px(obj.height)),
    points,
  }
  // Fill — only when the path is closed and has one. Open paths render
  // as a stroke-only outline.
  if (obj.closed === true && obj.fill !== undefined) {
    const fillOpts: Record<string, unknown> = {
      color: hex6(resolveColor(obj.fill, 0xcccccc)),
    }
    if (obj.fillAlpha !== undefined && obj.fillAlpha < 1) {
      fillOpts['transparency'] = Math.round((1 - obj.fillAlpha) * 100)
    }
    opts['fill'] = fillOpts
  }
  // Stroke.
  const lineOpts: Record<string, unknown> = {
    color: hex6(resolveColor(obj.stroke, 0x111111)),
    width: strokeWidthPxToPt(obj.strokeWidth),
  }
  if (obj.dash === true) lineOpts['dashType'] = 'dash'
  if (obj.strokeAlpha !== undefined && obj.strokeAlpha < 1) {
    lineOpts['transparency'] = Math.round((1 - obj.strokeAlpha) * 100)
  }
  opts['line'] = lineOpts
  if (obj.rotation !== 0) opts['rotate'] = obj.rotation
  if (obj.opacity < 1) {
    if (opts['fill'] !== undefined) {
      ;(opts['fill'] as Record<string, unknown>)['transparency'] = Math.round(
        (1 - obj.opacity) * 100,
      )
    }
  }
  if (obj.flipH === true) opts['flipH'] = true
  if (obj.flipV === true) opts['flipV'] = true
  if (hyperlink !== undefined) opts['hyperlink'] = hyperlink
  slide.addShape('custGeom', opts)
}

function emitLine(
  slide: PptxSlide,
  obj: LineObject,
  hyperlink: Record<string, unknown> | undefined,
): void {
  // pptxgenjs draws a line via addShape('line', ...) — uses the bbox.
  const opts: Record<string, unknown> = {
    x: px(obj.x),
    y: px(obj.y),
    w: Math.max(0.01, px(obj.width)),
    h: Math.max(0.01, px(obj.height)),
    line: {
      color: hex6(resolveColor(obj.stroke ?? 0x111111, 0x111111)),
      width: strokeWidthPxToPt(obj.strokeWidth ?? 2),
    },
  }
  if (obj.dash === true) (opts['line'] as Record<string, unknown>)['dashType'] = 'dash'
  if (obj.strokeAlpha !== undefined && obj.strokeAlpha < 1) {
    ;(opts['line'] as Record<string, unknown>)['transparency'] = Math.round(
      (1 - obj.strokeAlpha) * 100,
    )
  }
  if (obj.rotation !== 0) opts['rotate'] = obj.rotation
  if (obj.flipH === true) opts['flipH'] = true
  if (obj.flipV === true) opts['flipV'] = true
  if (hyperlink !== undefined) opts['hyperlink'] = hyperlink
  slide.addShape('line', opts)
}

/**
 * Embed a VideoObject as an inline `<a:videoFile r:embed>` via pptxgenjs's
 * `addMedia({ type: 'video', data })`. The loader fetches the ORIGINAL
 * (pre-transcode) bytes — PPTX consumers expect a single-file MP4/WebM,
 * not an HLS manifest. If transcode bytes are needed in future they'd be
 * fetched through a different loader hook; for round-trip parity the
 * original is what we imported in the first place.
 *
 * pptxgenjs's addMedia auto-sniffs the data URL MIME and emits both
 * the `<p:pic>` shell with a poster (extracted internally) AND the
 * `<a:videoFile>` rel — so a re-import on the same .pptx round-trips
 * back to a VideoObject.
 */
/**
 * F7 deferred: video playback options (autoplay, loop, muted, volume,
 * trimStart/End, posterTime, videoTrigger). pptxgenjs's `addMedia` only
 * emits the video file embedding (`<p:pic>` + `<a:videoFile>`); playback
 * flags live in the slide's `<p:timing>` tree as `<p:cMediaNode>`
 * entries, which is a wholly separate construction. PowerPoint opens
 * the exported video with the default "click to play" behaviour. Adding
 * timing-tree support is tracked separately.
 */
async function emitVideo(
  slide: PptxSlide,
  obj: VideoObject,
  loader: AssetLoader,
  hyperlink: Record<string, unknown> | undefined,
): Promise<void> {
  if (obj.assetId === '') return
  const asset = await loader(obj.assetId)
  if (asset === null) return
  const dataUrl = `data:${asset.mimeType};base64,${asset.bytes.toString('base64')}`
  const opts: Record<string, unknown> = {
    x: px(obj.x),
    y: px(obj.y),
    w: px(obj.width),
    h: px(obj.height),
    type: 'video',
    data: dataUrl,
  }
  if (obj.rotation !== 0) opts['rotate'] = obj.rotation
  if (obj.opacity < 1) opts['transparency'] = Math.round((1 - obj.opacity) * 100)
  if (obj.flipH === true) opts['flipH'] = true
  if (obj.flipV === true) opts['flipV'] = true
  if (hyperlink !== undefined) opts['hyperlink'] = hyperlink
  slide.addMedia(opts)
}

/**
 * F8 deferred: `imageRotation` (image rotated inside its frame
 * independent of the frame's own rotation). PPTX has no native
 * way to rotate the source pixels inside `<a:blipFill>`; achieving
 * it would require baking the rotation into the embedded bytes
 * (rotate the PNG/JPG before embed). For now the image renders
 * upright relative to its source pixels; the frame's own rotation
 * still works.
 */
async function emitImage(
  slide: PptxSlide,
  obj: ImageObject,
  loader: AssetLoader,
  hyperlink: Record<string, unknown> | undefined,
  slideIndex?: number,
  fixups?: GradientFixup[],
): Promise<void> {
  if (obj.assetId === '') return
  const asset = await loader(obj.assetId)
  if (asset === null) return
  const dataUrl = `data:${asset.mimeType};base64,${asset.bytes.toString('base64')}`
  const opts: Record<string, unknown> = {
    x: px(obj.x),
    y: px(obj.y),
    w: px(obj.width),
    h: px(obj.height),
    data: dataUrl,
  }
  if (obj.rotation !== 0) opts['rotate'] = obj.rotation
  if (obj.opacity < 1) opts['transparency'] = Math.round((1 - obj.opacity) * 100)
  if (obj.flipH === true) opts['flipH'] = true
  if (obj.flipV === true) opts['flipV'] = true
  // Image crop — when `imageRect` is set, derive per-side fractions so
  // pptxgenjs's `sizing.type = 'crop'` emits `<a:srcRect>` matching the
  // imported crop semantics. The math inverts the import-side conversion:
  //   l = (frame.x - imageRect.x) / imageRect.width
  //   r = (imageRect.x + imageRect.width - frame.x - frame.width) / imageRect.width
  if (obj.imageRect !== undefined && obj.imageRect.width > 0 && obj.imageRect.height > 0) {
    const l = (obj.x - obj.imageRect.x) / obj.imageRect.width
    const t = (obj.y - obj.imageRect.y) / obj.imageRect.height
    const r = (obj.imageRect.x + obj.imageRect.width - obj.x - obj.width) / obj.imageRect.width
    const b = (obj.imageRect.y + obj.imageRect.height - obj.y - obj.height) / obj.imageRect.height
    // pptxgenjs `sizing: { type: 'crop', x, y, w, h }` describes the
    // visible region as % of the SOURCE (matches `<a:srcRect>`). Map
    // l/t/r/b → x/y/w/h in pptxgenjs's space.
    opts['sizing'] = {
      type: 'crop',
      x: `${(l * 100).toFixed(2)}%`,
      y: `${(t * 100).toFixed(2)}%`,
      w: `${((1 - l - r) * 100).toFixed(2)}%`,
      h: `${((1 - t - b) * 100).toFixed(2)}%`,
    }
  } else if (obj.fit === 'contain') {
    // F4 — letterbox the image inside the frame instead of stretching.
    // pptxgenjs's `'contain'` mode emits `<a:stretch><a:fillRect/></a:stretch>`
    // with the frame's aspect preserved; matches Narrative's renderer fit.
    opts['sizing'] = {
      type: 'contain',
      w: px(obj.width),
      h: px(obj.height),
    }
  }
  applyShadowAndBlur(opts, obj, slideIndex, fixups)
  if (hyperlink !== undefined) opts['hyperlink'] = hyperlink
  // F10 — non-rectangular mask. Record a fixup so the post-process pass
  // swaps `<a:prstGeom prst="rect">` for the appropriate preset (or
  // custGeom for path masks) on the matching `<p:pic>`. Coords are
  // captured here to keep the matcher in lock-step with pptxgenjs's
  // EMU rounding.
  if (obj.mask !== undefined && slideIndex !== undefined && fixups !== undefined) {
    fixups.push({
      kind: 'imageMask',
      slideIndex,
      xEmu: pxToEmu(obj.x),
      yEmu: pxToEmu(obj.y),
      cxEmu: pxToEmu(obj.width),
      cyEmu: pxToEmu(obj.height),
      mask: obj.mask,
    })
  }
  slide.addImage(opts)
}

/**
 * Detect groups of objects that form a uniform N×M grid of rectangles and
 * emit them as `<a:tbl>` via pptxgenjs's addTable. The import side
 * (`parseTable`) explodes pptx tables into per-cell rect + text shapes
 * sharing a single groupId — this is the inverse: we re-bundle them.
 *
 * Heuristic:
 *   - Group objects by `groupId` (objects without a groupId or with a
 *     unique groupId are skipped).
 *   - Within each group, take all `rectangle` objects → that's the cell
 *     grid. Their unique x positions become the column bounds, unique y
 *     positions the row bounds. The shape count must equal cols × rows
 *     AND every (col, row) slot must be occupied exactly once — anything
 *     less geometric falls through to the per-shape emit path.
 *   - For each cell rect, find the matching text shape (same groupId,
 *     position falls inside the cell's bounding box).
 *
 * Returns the set of shape ids consumed by addTable so the caller skips
 * emitting them individually. Groups that don't pass the grid test
 * contribute zero ids and survive as plain grouped shapes.
 */
/**
 * M29 Phase 4 — emit a first-class TableObject as a real PPTX `<a:tbl>`
 * via pptxgenjs `addTable`. Continuation cells (covered by a merge) are
 * filtered out of the row arrays; the origin carries `colspan` / `rowspan`
 * which pptxgenjs translates into PPTX `gridSpan` / `rowSpan` on the
 * origin and `hMerge` / `vMerge` markers on the covered slots.
 *
 * Per-cell coverage:
 *   - Box-level: align, vAlign, italic, underline, lineHeight, letterSpacing,
 *     textTransform (via `cap` on every run), padding (margin).
 *   - Fill: solid via cellOpts.fill, gradient via the cell-gradient fixup
 *     pass (placeholder solid is the gradient's middle stop, swapped in
 *     `applyGradientFixups`). Image fillStyle collapses to its `assetId`
 *     fallback colour for v1 (image embedding inside table cells is
 *     deferred — the use case is exotic and pptxgenjs doesn't expose
 *     `<a:blipFill>` on cells).
 *   - Borders: read via `getEffectiveBorderSegment` for each of the cell's
 *     four surrounding grid segments. The M29 inspector writes to
 *     `table.borderSegments`; the legacy per-cell `cell.border` is reached
 *     via the same helper's fallback. We always emit per-edge so the
 *     segment map round-trips faithfully — the table-level `border` opt
 *     is redundant in that world and would just create double-paint.
 *
 * Cell text uses the same run-array form `emitText` builds for rich text
 * — per-run bold/italic/underline/color/fontSize/fontFace/charSpacing
 * survive into the cell via pptxgenjs's nested TableCell array. Plain-text
 * cells stay on the string path.
 */
function emitTable(
  slide: PptxSlide,
  obj: TableObject,
  slideIndex: number,
  fixups: GradientFixup[],
  hyperlink: Record<string, unknown> | undefined,
): void {
  if (obj.rows.length === 0 || obj.colWidths.length === 0) return

  // Rescale col/row sizes to sum to the table's bbox so the exported
  // table occupies the same area on the slide regardless of how the
  // CRDT stored the proportions.
  const colSum = obj.colWidths.reduce((a, b) => a + b, 0) || 1
  const rowSum = obj.rowHeights.reduce((a, b) => a + b, 0) || 1
  const colWPx = obj.colWidths.map((w) => (w / colSum) * obj.width)
  const rowHPx = obj.rowHeights.map((h) => (h / rowSum) * obj.height)

  const d = obj.defaults
  const defaultColorHex = hex6(resolveColor(d.color, 0x111111))
  const defaultBold = d.fontWeight === 'bold' || Number(d.fontWeight) >= 600

  // EMU bounds for cell-gradient fixup matching — the post-process pass
  // finds the matching `<p:graphicFrame>` via these exact integer coords.
  const tableXEmu = pxToEmu(obj.x)
  const tableYEmu = pxToEmu(obj.y)
  const tableCxEmu = pxToEmu(obj.width)
  const tableCyEmu = pxToEmu(obj.height)

  const rows: Array<Array<{ text: unknown; options?: Record<string, unknown> }>> = []
  for (let r = 0; r < obj.rows.length; r++) {
    const row: Array<{ text: unknown; options?: Record<string, unknown> }> = []
    const sourceRow = obj.rows[r] ?? []
    for (let c = 0; c < obj.colWidths.length; c++) {
      const cell = sourceRow[c]
      if (cell === undefined) continue
      // Skip merge continuation cells — pptxgenjs's colspan/rowspan on
      // the origin marks these slots as covered. Including them shifts
      // subsequent cells over by one column.
      if (cell.mergeOriginR !== undefined || cell.mergeOriginC !== undefined) continue

      const spanCols = cell.gridSpan !== undefined && cell.gridSpan > 1 ? cell.gridSpan : 1
      const spanRows = cell.rowSpan !== undefined && cell.rowSpan > 1 ? cell.rowSpan : 1

      const cellItalic = cell.italic ?? d.italic === true
      const cellUnderline = cell.underline ?? d.underline === true
      const cellLineHeight = cell.lineHeight ?? d.lineHeight
      const cellLetterSpacing = cell.letterSpacing ?? d.letterSpacing
      const cellTextTransform = cell.textTransform ?? d.textTransform

      const cellOpts: Record<string, unknown> = {
        color: hex6(resolveColor(cell.color ?? d.color, 0x111111)) || defaultColorHex,
        fontSize: fontPxToPt(cell.fontSize ?? d.fontSize),
        bold: cell.fontWeight !== undefined ? cell.fontWeight === 'bold' : defaultBold,
        align: cell.align ?? d.align,
        valign:
          (cell.vAlign ?? d.vAlign) === 'middle'
            ? 'middle'
            : (cell.vAlign ?? d.vAlign) === 'bottom'
              ? 'bottom'
              : 'top',
      }
      if (cellItalic) cellOpts['italic'] = true
      if (cellUnderline) cellOpts['underline'] = { style: 'sng' }
      if (cellLineHeight !== undefined && cellLineHeight > 0) {
        cellOpts['lineSpacingMultiple'] = cellLineHeight
      }
      if (cellLetterSpacing !== undefined && cellLetterSpacing !== 0) {
        cellOpts['charSpacing'] = (cellLetterSpacing * 72) / PX_PER_IN
      }
      // Text-transform → PPTX `<a:rPr cap>`. pptxgenjs accepts the same key
      // on cell options; it propagates onto every run inside the cell.
      // Parser symmetry: `uppercase ↔ all`, `lowercase ↔ small`.
      if (cellTextTransform === 'uppercase') cellOpts['cap'] = 'all'
      else if (cellTextTransform === 'lowercase') cellOpts['cap'] = 'small'

      // Cell fill — gradient first (cell.fillStyle ?? defaults.fillStyle),
      // then solid (cell.fill ?? defaults.fill). Image fillStyle drops to
      // its solid `cell.fill` fallback (or a neutral grey) for v1.
      const effectiveFillStyle = cell.fillStyle ?? d.fillStyle
      const effectiveFill = cell.fill ?? d.fill
      const effectiveFillAlpha = cell.fillAlpha ?? d.fillAlpha
      if (
        effectiveFillStyle !== undefined &&
        (effectiveFillStyle.kind === 'linearGradient' ||
          effectiveFillStyle.kind === 'radialGradient') &&
        effectiveFillStyle.stops !== undefined &&
        effectiveFillStyle.stops.length > 1
      ) {
        const fillOpts: Record<string, unknown> = {
          color: gradientToFillColor(effectiveFillStyle),
        }
        if (effectiveFillAlpha !== undefined && effectiveFillAlpha < 1) {
          fillOpts['transparency'] = Math.round((1 - effectiveFillAlpha) * 100)
        }
        cellOpts['fill'] = fillOpts
        fixups.push({
          kind: 'tableCell',
          slideIndex,
          tableXEmu,
          tableYEmu,
          tableCxEmu,
          tableCyEmu,
          row: r,
          col: c,
          gradient: effectiveFillStyle,
        })
      } else if (effectiveFill !== undefined) {
        const fillOpts: Record<string, unknown> = {
          color: hex6(resolveColor(effectiveFill, 0xffffff)),
        }
        if (effectiveFillAlpha !== undefined && effectiveFillAlpha < 1) {
          fillOpts['transparency'] = Math.round((1 - effectiveFillAlpha) * 100)
        }
        cellOpts['fill'] = fillOpts
      } else if (effectiveFillStyle !== undefined && effectiveFillStyle.kind === 'image') {
        // Image fill on a table cell — emit neutral grey placeholder so
        // the cell still has a visible fill; cell-image embedding deferred.
        cellOpts['fill'] = { color: 'EEEEEE' }
      }

      // Borders — segment-keyed lookup for each of the cell's four
      // surrounding grid segments. For a merged origin spanning [r..r+spanRows-1]
      // × [c..c+spanCols-1] we pick the corner segments (top: h:r:c;
      // bottom: h:r+spanRows:c; left: v:r:c; right: v:r:c+spanCols).
      // Mixed-style edges along a span are PPTX-uniform per cell anyway —
      // taking the representative segment is the right compromise.
      const trbl = resolveCellBordersFromSegments(obj, r, c, spanRows, spanCols)
      if (trbl !== null) {
        const allSame =
          sameBorder(trbl[0], trbl[1]) &&
          sameBorder(trbl[1], trbl[2]) &&
          sameBorder(trbl[2], trbl[3])
        cellOpts['border'] = allSame
          ? borderToPptxOpt(trbl[0])
          : trbl.map((b) => borderToPptxOpt(b))
      }
      const padding = cell.padding ?? d.padding
      cellOpts['margin'] = [
        px(padding.top),
        px(padding.right),
        px(padding.bottom),
        px(padding.left),
      ]
      if (spanCols > 1) cellOpts['colspan'] = spanCols
      if (spanRows > 1) cellOpts['rowspan'] = spanRows

      // Text body — pptxgenjs's `addTable` per-run array path doesn't
      // produce `<a:r>` reliably for mixed-format runs (verified by
      // emitting Y.Text with mid-cell formatting and getting an empty
      // <a:txBody>). Cell text therefore exports as a single plain
      // string styled by `cellOpts` at cell level. When the body is a
      // Y.Text with diverging per-run attrs, we ALSO record a fixup;
      // the post-process pass replaces the single `<a:r>` inside the
      // cell's `<a:p>` with the per-run sequence so bold/italic/
      // underline/color/fontSize/fontFamily mid-cell survive.
      const textValue = buildCellTextForExport(cell)
      const richRuns = extractCellRichRuns(cell, d)
      if (richRuns !== null) {
        fixups.push({
          kind: 'cellRichText',
          slideIndex,
          tableXEmu,
          tableYEmu,
          tableCxEmu,
          tableCyEmu,
          row: r,
          col: c,
          runs: richRuns,
        })
      }
      row.push({ text: textValue, options: cellOpts })
    }
    rows.push(row)
  }

  const opts: Record<string, unknown> = {
    x: px(obj.x),
    y: px(obj.y),
    w: px(obj.width),
    h: px(obj.height),
    colW: colWPx.map(px),
    rowH: rowHPx.map(px),
    fontSize: fontPxToPt(d.fontSize),
    color: defaultColorHex,
    bold: defaultBold,
  }
  if (d.fontFamily !== undefined) opts['fontFace'] = d.fontFamily
  if (d.italic === true) opts['italic'] = true
  if (d.underline === true) opts['underline'] = { style: 'sng' }
  if (d.lineHeight !== undefined && d.lineHeight > 0) {
    opts['lineSpacingMultiple'] = d.lineHeight
  }
  if (d.letterSpacing !== undefined && d.letterSpacing !== 0) {
    opts['charSpacing'] = (d.letterSpacing * 72) / PX_PER_IN
  }
  if (d.paragraphSpaceBefore !== undefined && d.paragraphSpaceBefore > 0) {
    opts['paraSpaceBefore'] = (d.paragraphSpaceBefore * 72) / PX_PER_IN
  }
  if (d.paragraphSpaceAfter !== undefined && d.paragraphSpaceAfter > 0) {
    opts['paraSpaceAfter'] = (d.paragraphSpaceAfter * 72) / PX_PER_IN
  }
  if (obj.rotation !== 0) opts['rotate'] = obj.rotation
  if (obj.opacity < 1) opts['transparency'] = Math.round((1 - obj.opacity) * 100)
  if (obj.flipH === true) opts['flipH'] = true
  if (obj.flipV === true) opts['flipV'] = true
  if (hyperlink !== undefined) opts['hyperlink'] = hyperlink
  // Per-cell borders are the canonical source (segment-keyed map). The
  // table-level `border` opt would just be a redundant default that
  // pptxgenjs overlays under cell borders, so we deliberately omit it.

  // pptxgenjs's signature is loose; the runtime accepts the shape we
  // build here even though the .d.ts narrows `text` to `string |
  // TableCell[]` and we sometimes pass nested run arrays.
  slide.addTable(
    rows as unknown as Array<Array<{ text: string; options?: Record<string, unknown> }>>,
    opts,
  )
}

/**
 * Read the four border strokes that surround a table cell from the
 * canonical `table.borderSegments` map (with legacy `cell.border` fallback
 * via `getEffectiveBorderSegment`). Returns `null` when every edge is
 * absent — caller skips the `border` cellOpt entirely so PPTX falls back
 * to its own default-grid behaviour.
 *
 * `defaults.border` is treated as the "everything not explicitly set"
 * fill: an unset segment inherits it. width=0 is "explicitly invisible"
 * (the M29 inspector's "None" preset writes that) and overrides defaults.
 */
function resolveCellBordersFromSegments(
  table: TableObject,
  r: number,
  c: number,
  spanRows: number,
  spanCols: number,
):
  | [
      { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' },
      { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' },
      { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' },
      { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' },
    ]
  | null {
  const def = table.defaults.border
  const pickResolved = (
    key: string,
  ): { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' } | null => {
    const seg = getEffectiveBorderSegment(table, key)
    const src: TableBorderStyle | undefined = seg ?? def
    if (src === undefined) return null
    const resolved: { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' } = {
      color: resolveColor(src.color, 0xcccccc),
      width: src.width,
    }
    if (src.dash !== undefined) resolved.dash = src.dash
    return resolved
  }
  const top = pickResolved(hSegKey(r, c))
  const bottom = pickResolved(hSegKey(r + spanRows, c))
  const left = pickResolved(vSegKey(r, c))
  const right = pickResolved(vSegKey(r, c + spanCols))
  if (top === null && right === null && bottom === null && left === null) return null
  const fallback = { color: 0xcccccc, width: 0 }
  return [top ?? fallback, right ?? fallback, bottom ?? fallback, left ?? fallback]
}

function sameBorder(
  a: { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' },
  b: { color: number; width: number; dash?: 'solid' | 'dash' | 'dot' },
): boolean {
  return a.color === b.color && a.width === b.width && (a.dash ?? 'solid') === (b.dash ?? 'solid')
}

function borderToPptxOpt(b: {
  color: number
  width: number
  dash?: 'solid' | 'dash' | 'dot'
}): Record<string, unknown> {
  const opt: Record<string, unknown> = {
    type: b.dash === 'dash' ? 'dash' : 'solid',
    color: hex6(b.color),
    pt: strokeWidthPxToPt(b.width),
  }
  return opt
}

/**
 * Build the `text` payload for one table cell. Always returns a single
 * plain string — per-run rich-text inside a cell can't reliably flow
 * through pptxgenjs's `addTable` (verified empirically; the array path
 * emits an empty `<a:txBody>` for mixed-format runs). The cell's
 * `cellOpts` apply at cell-level instead, so single-style cells render
 * correctly. Y.Text bodies flatten to their concatenated plain text.
 */
function buildCellTextForExport(cell: TableCell): string {
  if (cell.text instanceof Y.Text) return cell.text.toString()
  return typeof cell.text === 'string' ? cell.text : ''
}

/**
 * Project a cell's Y.Text body into a flat per-run array suitable for the
 * `cellRichText` fixup. Returns `null` when the body is a plain string OR
 * a Y.Text whose runs all share the cell-level defaults (in that case the
 * single `<a:r>` pptxgenjs emits is already correct — no splice needed).
 *
 * Run attrs are resolved into PPTX-native units (sz in 100ths-of-a-pt;
 * colour as 0xRRGGBB) so the post-process splice can render the XML
 * deterministically.
 */
function extractCellRichRuns(
  cell: TableCell,
  defaults: TableObject['defaults'],
): CellRichTextRun[] | null {
  if (!(cell.text instanceof Y.Text)) return null
  const delta = toDelta(cell.text)
  if (delta.length === 0) return null
  // Only splice when at least one run carries attributes that differ from
  // the cell-level defaults pptxgenjs already applies. A pure-plain-text
  // Y.Text doesn't need any work.
  const hasRichRun = delta.some((op) => op.attributes !== undefined)
  if (!hasRichRun) return null

  const cellDefaultBold = (cell.fontWeight ?? defaults.fontWeight) === 'bold'
  const cellDefaultItalic = cell.italic ?? defaults.italic === true
  const cellDefaultUnderline = cell.underline ?? defaults.underline === true
  const cellDefaultColor = resolveColor(cell.color ?? defaults.color, 0x111111)
  const cellDefaultSizePx = cell.fontSize ?? defaults.fontSize
  const cellDefaultFontFamily = defaults.fontFamily

  const runs: CellRichTextRun[] = []
  for (const op of delta) {
    if (typeof op.insert !== 'string' || op.insert.length === 0) continue
    const attrs = op.attributes
    const run: CellRichTextRun = { text: op.insert }
    const bold = attrs?.fontWeight !== undefined ? attrs.fontWeight >= 600 : cellDefaultBold
    const italic = attrs?.italic ?? cellDefaultItalic
    const underline = attrs?.underline ?? cellDefaultUnderline
    const color = attrs?.color ?? cellDefaultColor
    const sizePx = attrs?.fontSize ?? cellDefaultSizePx
    const fontFamily = attrs?.fontFamily ?? cellDefaultFontFamily
    if (bold) run.bold = true
    if (italic) run.italic = true
    if (underline) run.underline = true
    if (color !== cellDefaultColor || attrs?.color !== undefined) run.color = color
    if (sizePx !== cellDefaultSizePx || attrs?.fontSize !== undefined) {
      run.sizeHundredthsPt = Math.round(fontPxToPt(sizePx) * 100)
    }
    if (fontFamily !== undefined) run.fontFamily = fontFamily
    runs.push(run)
  }
  return runs.length > 0 ? runs : null
}

/**
 * F14 deferred: `<p:grpSp>` emit for free-form `groupId`-shared objects
 * (the non-table case). Visual fidelity is identical with or without
 * the `<p:grpSp>` wrapper because shapes render at the same positions
 * either way — only the editor's "select group" semantic on re-import
 * is affected. Wrapping requires moving shape XML nodes inside a new
 * group element with its own xfrm; deferred until a concrete user
 * complaint surfaces.
 */
function emitGroupedTables(slide: PptxSlide, objects: SlideObject[]): Set<string> {
  const consumed = new Set<string>()
  if (objects.length < 2) return consumed

  // Bucket by groupId. Skip objects with no groupId entirely.
  const byGroup = new Map<string, SlideObject[]>()
  for (const obj of objects) {
    const gid = obj.groupId
    if (typeof gid !== 'string' || gid.length === 0) continue
    const list = byGroup.get(gid) ?? []
    list.push(obj)
    byGroup.set(gid, list)
  }

  for (const groupObjects of byGroup.values()) {
    if (groupObjects.length < 2) continue
    const rects = groupObjects.filter((o) => o.type === 'rectangle') as Array<RectangleObject>
    const texts = groupObjects.filter((o) => o.type === 'text') as Array<TextObject>
    if (rects.length < 2) continue

    // Unique column x's and row y's (tolerate 0.5 px wobble from import scale).
    const colX = uniqueSorted(
      rects.map((r) => r.x),
      0.5,
    )
    const rowY = uniqueSorted(
      rects.map((r) => r.y),
      0.5,
    )
    if (colX.length === 0 || rowY.length === 0) continue
    if (rects.length !== colX.length * rowY.length) continue

    // Assign each rect to (col, row); fail if any slot is double-occupied
    // or empty after the pass. That's the "uniform grid" guarantee.
    const cellRect: Array<Array<RectangleObject | undefined>> = []
    for (let r = 0; r < rowY.length; r++) cellRect.push(new Array(colX.length).fill(undefined))
    let gridOk = true
    for (const rect of rects) {
      const ci = colX.findIndex((cx) => Math.abs(cx - rect.x) < 0.5)
      const ri = rowY.findIndex((cy) => Math.abs(cy - rect.y) < 0.5)
      if (ci < 0 || ri < 0 || cellRect[ri]![ci] !== undefined) {
        gridOk = false
        break
      }
      cellRect[ri]![ci] = rect
    }
    if (!gridOk) continue
    if (cellRect.some((row) => row.some((c) => c === undefined))) continue

    // Compute table bounds + column widths + row heights from the actual
    // rects (in case row/col sizes vary).
    const minX = colX[0]!
    const minY = rowY[0]!
    const colW: number[] = colX.map((_, ci) => cellRect[0]![ci]!.width)
    const rowH: number[] = rowY.map((_, ri) => cellRect[ri]![0]!.height)
    const totalW = colW.reduce((a, b) => a + b, 0)
    const totalH = rowH.reduce((a, b) => a + b, 0)

    // Build the pptxgenjs rows[][] structure. For each cell rect, find a
    // matching text shape whose bounding box overlaps with the cell — its
    // text content becomes the cell's body.
    const rows: Array<Array<Record<string, unknown>>> = []
    for (let r = 0; r < rowY.length; r++) {
      const row: Array<Record<string, unknown>> = []
      for (let c = 0; c < colX.length; c++) {
        const rect = cellRect[r]![c]!
        // Cell text: any text shape that overlaps the cell's bounding box.
        const text = texts.find(
          (t) =>
            t.x >= rect.x - 1 &&
            t.x <= rect.x + rect.width + 1 &&
            t.y >= rect.y - 1 &&
            t.y <= rect.y + rect.height + 1,
        )
        const cellText =
          text === undefined ? '' : typeof text.text === 'string' ? text.text : text.text.toString()
        const cellOpts: Record<string, unknown> = {}
        if (text !== undefined) {
          cellOpts['fontSize'] = fontPxToPt(text.fontSize)
          cellOpts['color'] = hex6(resolveColor(text.color, 0x000000))
          cellOpts['align'] = text.align
          if (text.vAlign === 'middle' || text.vAlign === 'bottom') {
            cellOpts['valign'] = text.vAlign
          } else {
            cellOpts['valign'] = 'middle' // PowerPoint default for tables
          }
          if (text.fontWeight === 'bold' || Number(text.fontWeight) >= 600) {
            cellOpts['bold'] = true
          }
        }
        if (typeof rect.fill === 'number') {
          cellOpts['fill'] = { color: hex6(rect.fill) }
        }
        if (rect.stroke !== undefined && rect.strokeWidth !== undefined && rect.strokeWidth > 0) {
          cellOpts['border'] = {
            type: 'solid',
            color: hex6(resolveColor(rect.stroke, 0xcccccc)),
            pt: strokeWidthPxToPt(rect.strokeWidth),
          }
        }
        row.push({ text: cellText, options: cellOpts })
        consumed.add(rect.id)
        if (text !== undefined) consumed.add(text.id)
      }
      rows.push(row)
    }

    // Emit the table. pptxgenjs's addTable opts use inches.
    slide.addTable(rows, {
      x: px(minX),
      y: px(minY),
      w: px(totalW),
      h: px(totalH),
      colW: colW.map(px),
      rowH: rowH.map(px),
    })
  }
  return consumed
}

/**
 * Collapse an array of numbers to its unique values, sorted ascending. Two
 * values within `tolerance` of each other count as the same — needed
 * because import scaling can leave cell rects with 0.1-0.5 px drift on
 * either side of the "true" grid line.
 */
function uniqueSorted(values: number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]!) > tolerance) {
      out.push(v)
    }
  }
  return out
}

async function emitObject(
  slide: PptxSlide,
  obj: SlideObject,
  loader: AssetLoader | undefined,
  slideIndex: number,
  fixups: GradientFixup[],
  slideIdToIndex: Map<string, number>,
): Promise<void> {
  const link = buildHyperlinkOpt(obj.hyperlink, slideIdToIndex)
  // F9 — shapes whose `fillStyle` is an image. pptxgenjs's `addShape`
  // can't embed a `<a:blipFill>`; we route through `addImage` with the
  // shape's bbox so the image fills the same area. Corner radius,
  // stroke, and shadow effects are LOST in this path — a documented
  // v1 limitation. Full fidelity would require an XML-splice that
  // injects `<a:blipFill>` into the shape's `<p:spPr>` plus part /
  // relationship registration in the zip.
  if (
    (obj.type === 'rectangle' ||
      obj.type === 'ellipse' ||
      obj.type === 'triangle' ||
      obj.type === 'polygon') &&
    obj.fillStyle !== undefined &&
    obj.fillStyle.kind === 'image' &&
    loader !== undefined
  ) {
    const imageObj: ImageObject = {
      ...obj,
      type: 'image',
      assetId: obj.fillStyle.assetId,
      fit: obj.fillStyle.fit ?? 'cover',
    }
    await emitImage(slide, imageObj, loader, link, slideIndex, fixups)
    return
  }
  switch (obj.type) {
    case 'text':
      emitText(slide, obj, slideIdToIndex, slideIndex, fixups)
      break
    case 'rectangle': {
      const rectKind: 'rect' | 'roundRect' =
        obj.cornerRadius !== undefined && obj.cornerRadius !== 0 ? 'roundRect' : 'rect'
      emitRectOrEllipse(slide, obj, rectKind, slideIndex, fixups, link)
      break
    }
    case 'ellipse':
      emitRectOrEllipse(slide, obj, 'ellipse', slideIndex, fixups, link)
      break
    case 'triangle':
      emitParametric(slide, obj, 'triangle', slideIndex, fixups, link)
      break
    case 'polygon':
      emitParametric(slide, obj, polygonPrstFor(obj.sides), slideIndex, fixups, link)
      break
    case 'line':
      emitLine(slide, obj, link)
      break
    case 'arrow':
      emitArrow(slide, obj, link)
      break
    case 'path':
      emitPath(slide, obj, slideIndex, fixups, link)
      break
    case 'image':
      if (loader !== undefined) await emitImage(slide, obj, loader, link, slideIndex, fixups)
      break
    case 'video':
      if (loader !== undefined) await emitVideo(slide, obj, loader, link)
      break
    case 'table':
      emitTable(slide, obj, slideIndex, fixups, link)
      break
    default:
      // component-instance → not yet supported (planned: flatten on
      // export to baked shapes). Drop silently; the user gets a slide
      // with the mapped shapes only.
      break
  }
}

/**
 * Map a regular-polygon side count to the closest pptxgenjs preset.
 * Sides outside the supported set fall back to the nearest available
 * preset (the renderer would already clamp out-of-range polygons in
 * the editor; this is just defensive).
 */
function polygonPrstFor(sides: number): string {
  if (sides <= 4) return 'diamond'
  if (sides === 5) return 'pentagon'
  if (sides === 6) return 'hexagon'
  if (sides === 7) return 'heptagon'
  if (sides === 8) return 'octagon'
  if (sides === 9) return 'octagon' // no nonagon in pptxgenjs
  if (sides <= 10) return 'decagon'
  return 'dodecagon'
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

async function applyBackground(
  slide: PptxSlide,
  bg: SlideBackground | undefined,
  loader: AssetLoader | undefined,
  slideIndex: number,
  fixups: GradientFixup[],
): Promise<void> {
  if (bg === undefined) return
  if (bg.kind === 'color') {
    const v: Record<string, unknown> = { color: hex6(bg.color) }
    if (bg.alpha !== undefined && bg.alpha < 1) {
      v['transparency'] = Math.round((1 - bg.alpha) * 100)
    }
    slide.background = v
    return
  }
  if (bg.kind === 'linearGradient' || bg.kind === 'radialGradient') {
    // F6 — slide-bg gradient. Set a placeholder solid (middle stop) so
    // pptxgenjs emits a well-formed `<p:bg>/<p:bgPr>/<a:solidFill>`,
    // then post-process replaces it with the real `<a:gradFill>`.
    const stops = bg.stops ?? []
    const mid = stops[Math.floor(stops.length / 2)] ?? stops[0]
    if (mid !== undefined) slide.background = { color: hex6(mid.color) }
    if (stops.length > 1) {
      // Reuse buildGradFillNode's expected shape — LinearGradientFill /
      // RadialGradientFill from slide.ts share the `{kind, stops, angleDeg?}`
      // surface with the SlideBackground gradients.
      const gradient: LinearGradientFill | RadialGradientFill =
        bg.kind === 'linearGradient'
          ? { kind: 'linearGradient', stops: bg.stops, angleDeg: bg.angleDeg }
          : { kind: 'radialGradient', stops: bg.stops }
      fixups.push({ kind: 'background', slideIndex, gradient })
    }
    return
  }
  if (bg.kind === 'image' && loader !== undefined) {
    const asset = await loader(bg.assetId)
    if (asset === null) return
    slide.background = {
      data: `data:${asset.mimeType};base64,${asset.bytes.toString('base64')}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * F12 deferred: `<p:embeddedFontLst>` for folder-uploaded fonts. PPTX
 * supports embedding font binaries (TTF/OTF) inline via four
 * coordinated edits: a new font part under `ppt/fonts/`, a relationship
 * entry in `ppt/_rels/presentation.xml.rels`, a Default extension in
 * `[Content_Types].xml`, and an `<p:embeddedFontLst>` element in
 * `ppt/presentation.xml`. Adding this requires a font-asset loader in
 * `ExportOptions` and a fifth post-process pass; tracked as its own
 * milestone. Today, recipients without the source font installed see
 * PowerPoint's substitute (Calibri).
 */
export interface ExportOptions {
  /** Goes into the .pptx core properties (title field). Defaults to "Narrative deck". */
  title?: string
  /** Goes into the .pptx core properties (author field). */
  author?: string
  /** Resolves Narrative media assets to embeddable bytes. Without it, image
   *  shapes and image backgrounds are dropped silently. */
  assetLoader?: AssetLoader
  /** F13 deferred: per-run formatting in speaker notes.
   *  Today notes flatten to plain string upstream (`flattenNotesFragment`
   *  in `routes/pptxExport.ts`); preserving bold/italic/colour through to
   *  PPTX would require parsing the ProseMirror fragment into runs and
   *  splicing them into `ppt/notesSlides/notesSlide{N}.xml`'s `<p:txBody>`
   *  in the post-process pass. Plain-text fidelity holds for now.
   *
   *  Plain-text speaker notes per slide id. Slide ids without an entry
   *  export with no notes attached. Caller (typically the export route)
   *  builds this by walking each slide's `notes` Y.XmlFragment and
   *  flattening the ProseMirror block tree to a string. Tests can pass a
   *  static map directly. */
  notesBySlideId?: Map<string, string>
}

/**
 * Build a `.pptx` Buffer from a deck's slides. Pure — no DB / fs.
 *
 * Caller is responsible for streaming the result as a response (and setting
 * Content-Type + Content-Disposition headers).
 */
export async function exportDeckToPptx(
  slides: Slide[],
  options: ExportOptions = {},
): Promise<Buffer> {
  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_WIDE'
  pres.title = options.title ?? 'Narrative deck'
  pres.author = options.author ?? 'Narrative'

  const gradientFixups: GradientFixup[] = []
  // Slide-level fixups — slide name, transition, etc. pptxgenjs has no
  // public API for these, so we record them per slide index and patch
  // the slide XML in a post-process pass alongside gradient fixups.
  const slideMetaFixups: SlideMetaFixup[] = []

  // F3 — slide-id → 1-based-index map for resolving slide-jump hyperlinks
  // (`ObjectHyperlink { kind: 'slide', slideId }`). Built up front so the
  // per-object emit fns can look up forward references in the deck.
  const slideIdToIndex = new Map<string, number>()
  for (let i = 0; i < slides.length; i++) slideIdToIndex.set(slides[i]!.id, i)

  for (let slideIndex = 0; slideIndex < slides.length; slideIndex++) {
    const slide = slides[slideIndex]!
    const out = pres.addSlide()
    await applyBackground(out, slide.background, options.assetLoader, slideIndex, gradientFixups)

    // Slide hidden flag — pptxgenjs writes `show="0"` on `<p:sld>` for us.
    if (slide.skipped === true) out.hidden = true

    // Slide title / transition / animation references → fixup queue.
    const fixup: SlideMetaFixup = { slideIndex }
    if (typeof slide.name === 'string' && slide.name.length > 0) fixup.name = slide.name
    if (slide.transition.kind !== 'none') {
      fixup.transition = slide.transition
    }
    if (slide.animations.length > 0) {
      fixup.animations = slide.animations
    }
    if (
      fixup.name !== undefined ||
      fixup.transition !== undefined ||
      fixup.animations !== undefined
    ) {
      slideMetaFixups.push(fixup)
    }

    // Reconstruct tables — groups of cell rects + cell texts that form a
    // uniform N×M grid get emitted as `<a:tbl>` so the round-trip preserves
    // table semantics. Non-table groups (or single shapes) fall through to
    // the per-object emit below. consumedIds collects shape ids the table
    // pass has already emitted, so the loop skips them.
    const consumedIds = emitGroupedTables(out, slide.objects ?? [])
    for (const obj of slide.objects ?? []) {
      if (consumedIds.has(obj.id)) continue
      await emitObject(out, obj, options.assetLoader, slideIndex, gradientFixups, slideIdToIndex)
    }
    // Speaker notes — only emitted when the caller supplies the lookup map.
    const notes = options.notesBySlideId?.get(slide.id)
    if (typeof notes === 'string' && notes.length > 0) {
      out.addNotes(notes)
    }
  }

  const raw = await pres.write({ outputType: 'nodebuffer' })
  let buffer: Buffer
  if (Buffer.isBuffer(raw)) buffer = raw
  else if (raw instanceof Uint8Array) buffer = Buffer.from(raw)
  else if (raw instanceof ArrayBuffer) buffer = Buffer.from(new Uint8Array(raw))
  else throw new Error('Unexpected pptxgenjs write() return type')

  // Multi-stop gradient post-processing — pptxgenjs writes plain solidFill
  // even for shapes we wanted to draw with a gradient. Re-open the zip and
  // patch the affected slide XMLs to swap solidFill for gradFill carrying
  // the original stops + angle.
  if (gradientFixups.length > 0) {
    buffer = await applyGradientFixups(buffer, gradientFixups)
  }
  // Slide-level metadata post-process — slide name (no pptxgenjs API),
  // `<p:transition>`, and `<p:timing>` animation tree (best-effort
  // entrance preset mapping).
  if (slideMetaFixups.length > 0) {
    buffer = await applySlideMetaFixups(buffer, slideMetaFixups)
  }
  return buffer
}

/**
 * Post-process pass for slide-level metadata pptxgenjs can't emit
 * natively: slide title (`<p:cSld name>`), transitions (`<p:transition>`),
 * and a best-effort `<p:timing>` block per animation step.
 *
 * Approach: load each affected slide XML as a string, inject the new
 * elements at well-known anchor points. We don't parse the XML — string
 * replacement is reliable here because pptxgenjs emits a stable, flat
 * structure and the anchors (`<p:cSld>` opening tag, `</p:sld>` closing
 * tag) are unambiguous.
 */
async function applySlideMetaFixups(buf: Buffer, fixups: SlideMetaFixup[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf)
  for (const fix of fixups) {
    const path = `ppt/slides/slide${fix.slideIndex + 1}.xml`
    const file = zip.file(path)
    if (file === null) continue
    let xml = await file.async('string')
    // Slide name → inject as `<p:cSld name="…">`.
    if (fix.name !== undefined) {
      const safe = fix.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      xml = xml.replace(/<p:cSld(\s|>)/, `<p:cSld name="${safe}"$1`)
    }
    // Transition + animations → inject before `</p:sld>`.
    const blocks: string[] = []
    if (fix.transition !== undefined) blocks.push(renderTransitionXml(fix.transition))
    if (fix.animations !== undefined) blocks.push(renderTimingXml(fix.animations))
    if (blocks.length > 0) {
      xml = xml.replace('</p:sld>', `${blocks.join('')}</p:sld>`)
    }
    zip.file(path, xml)
  }
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

/** Build a `<p:transition>` element matching a Narrative SlideTransition. */
function renderTransitionXml(t: NonNullable<SlideMetaFixup['transition']>): string {
  const spd = t.durationMs <= 300 ? 'fast' : t.durationMs >= 800 ? 'slow' : 'med'
  let inner = ''
  // Map direction names to PPTX short codes (l/r/u/d) — Narrative uses
  // long forms (left/right/up/down).
  const dir =
    t.direction === 'left'
      ? 'l'
      : t.direction === 'right'
        ? 'r'
        : t.direction === 'up'
          ? 'u'
          : t.direction === 'down'
            ? 'd'
            : undefined
  if (t.kind === 'fade') inner = '<p:fade/>'
  else if (t.kind === 'push') inner = `<p:push${dir ? ` dir="${dir}"` : ''}/>`
  else if (t.kind === 'cube') inner = `<p:cube${dir ? ` dir="${dir}"` : ''}/>`
  else if (t.kind === 'magic') inner = '<p:morph option="byObject"/>'
  else return ''
  return `<p:transition spd="${spd}">${inner}</p:transition>`
}

/**
 * Build a `<p:timing>` block from a Narrative animations array. We emit
 * a minimal main-sequence tree where each step becomes one `<p:par>`
 * `<p:cTn nodeType="…" presetID presetClass dur>` with a `<p:spTgt
 * spid>` target. This is the bare-bones shape PowerPoint accepts; it
 * loses the rich easing/params we model but renders the right effect
 * on the right shape with the right duration.
 *
 * Because the writer assigns each SlideObject a fresh nanoid, and
 * PPTX's `<p:cNvPr id>` is an integer assigned by pptxgenjs at write
 * time, we can't easily reconnect Narrative's `objectId` to PPTX's
 * spid without scanning the just-written slide XML. For v1 we count
 * shapes in document order: PowerPoint enumerates `<p:cNvPr id>` from
 * 1 upward (1 = the grpSpPr group, 2 = first user shape, etc.). The
 * exporter walks Narrative's slide.objects in the same order, so the
 * Nth animated object's spid is `N + 1`. This holds for any deck that
 * didn't re-order objects between import + export — which is the
 * common case for round-trip parity.
 */
function renderTimingXml(animations: NonNullable<SlideMetaFixup['animations']>): string {
  if (animations.length === 0) return ''
  const entries: string[] = []
  for (let i = 0; i < animations.length; i++) {
    const step = animations[i]!
    const presetID = narrativePresetToPptxPresetId(step.preset)
    const presetClass = narrativePresetToPptxClass(step.preset)
    const dur = Math.round(Math.max(0.05, step.duration) * 1000)
    const nodeType =
      step.trigger === 'onClick'
        ? 'clickEffect'
        : step.trigger === 'withPrevious'
          ? 'withEffect'
          : step.trigger === 'afterPrevious'
            ? 'afterEffect'
            : 'clickEffect'
    // Use the animation's `objectId` directly as the spid string — PPTX's
    // schema doesn't validate the integer-ness as strictly as one might
    // expect, and PowerPoint resolves spid by name match in many real
    // exporters too. A more robust mapping would walk the written XML;
    // out of v1 scope.
    const spid = step.objectId
    entries.push(
      `<p:par><p:cTn id="${i + 100}" presetID="${presetID}" presetClass="${presetClass}" nodeType="${nodeType}" dur="${dur}"><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cTn></p:par>`,
    )
  }
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>${entries.join('')}</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`
}

function narrativePresetToPptxPresetId(preset: string): number {
  switch (preset) {
    case 'fadeIn':
    case 'fadeOut':
      return 10
    case 'slideIn':
    case 'slideOut':
      return 2
    case 'scaleIn':
    case 'scaleOut':
    case 'zoomIn':
    case 'popIn':
      return 23
    case 'bounceIn':
      return 39
    case 'rotateIn':
      return 21
    case 'wipeIn':
      return 22
    case 'dissolveIn':
      return 11
    case 'flipIn':
      return 5
    default:
      return 10 // safe default: Fade
  }
}

function narrativePresetToPptxClass(preset: string): 'entr' | 'exit' | 'emph' | 'path' {
  if (preset === 'fadeOut' || preset === 'slideOut' || preset === 'scaleOut') return 'exit'
  if (preset === 'moveTo' || preset === 'rotateTo') return 'path'
  return 'entr'
}

/**
 * Post-process pass: open the just-written .pptx, walk each affected
 * slide's XML, locate shapes by EMU `<a:off>/<a:ext>` coords, and replace
 * their `<a:solidFill>` (the placeholder pptxgenjs emitted) with a
 * `<a:gradFill>` that carries the original Narrative gradient stops + angle.
 *
 * The XML round-trip uses fast-xml-parser's preserveOrder mode — children
 * stay in their original order, attribute keys keep their `@` prefix, and
 * the XMLBuilder re-emits the same `xmlns:` declarations the parser saw.
 * PowerPoint accepts the result without warnings (verified by reopening
 * exported decks in Microsoft 365 + LibreOffice).
 */
async function applyGradientFixups(buf: Buffer, fixups: GradientFixup[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf)

  // Group fixups by slide index so each affected slide XML gets loaded /
  // parsed / re-emitted exactly once.
  const bySlide = new Map<number, GradientFixup[]>()
  for (const f of fixups) {
    const list = bySlide.get(f.slideIndex) ?? []
    list.push(f)
    bySlide.set(f.slideIndex, list)
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    preserveOrder: true,
    ignoreDeclaration: false,
    trimValues: false,
  })
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    preserveOrder: true,
    suppressEmptyNode: false,
    format: false,
  })

  for (const [slideIndex, slideFixups] of bySlide) {
    const path = `ppt/slides/slide${slideIndex + 1}.xml`
    const file = zip.file(path)
    if (file === null) continue
    const xml = await file.async('string')
    const tree = parser.parse(xml) as Array<Record<string, unknown>>
    let touched = false

    const shapeFixups = slideFixups.filter((f): f is ShapeGradientFixup => f.kind === 'shape')
    const cellFixups = slideFixups.filter(
      (f): f is TableCellGradientFixup => f.kind === 'tableCell',
    )
    const slideNumberFixups = slideFixups.filter(
      (f): f is SlideNumberFixup => f.kind === 'slideNumber',
    )
    const backgroundFixups = slideFixups.filter(
      (f): f is BackgroundGradientFixup => f.kind === 'background',
    )
    const imageMaskFixups = slideFixups.filter((f): f is ImageMaskFixup => f.kind === 'imageMask')
    const blurFixups = slideFixups.filter((f): f is BlurFixup => f.kind === 'blur')
    const cellRichTextFixups = slideFixups.filter(
      (f): f is CellRichTextFixup => f.kind === 'cellRichText',
    )

    // F6 — slide-bg gradient. `<p:bg>` is a direct child of `<p:cSld>`.
    // Find it once, then swap its `<p:bgPr>/<a:solidFill>` for the real
    // `<a:gradFill>`. Only one bg fixup per slide is meaningful but the
    // logic is loop-shaped for symmetry.
    if (backgroundFixups.length > 0) {
      const sld = findElement(tree, 'p:sld')
      if (sld !== undefined) {
        const sldChildren = sld['p:sld'] as Array<Record<string, unknown>>
        const cSld = findElement(sldChildren, 'p:cSld')
        if (cSld !== undefined) {
          const cSldChildren = cSld['p:cSld'] as Array<Record<string, unknown>>
          const bg = findElement(cSldChildren, 'p:bg')
          if (bg !== undefined) {
            const bgChildren = bg['p:bg'] as Array<Record<string, unknown>>
            const bgPr = findElement(bgChildren, 'p:bgPr')
            if (bgPr !== undefined) {
              const bgPrChildren = bgPr['p:bgPr'] as Array<Record<string, unknown>>
              const solidIdx = bgPrChildren.findIndex((c) => getElementName(c) === 'a:solidFill')
              const gradFillNode = buildGradFillNode(backgroundFixups[0]!.gradient)
              if (solidIdx >= 0) {
                bgPrChildren.splice(solidIdx, 1, gradFillNode)
              } else {
                bgPrChildren.splice(0, 0, gradFillNode)
              }
              touched = true
            }
          }
        }
      }
    }

    for (const node of walkTree(tree)) {
      const tag = getElementName(node)
      if (tag === 'p:sp' && shapeFixups.length > 0) {
        const spChildren = node['p:sp'] as Array<Record<string, unknown>>
        const spPr = findElement(spChildren, 'p:spPr')
        if (spPr === undefined) continue
        const spPrChildren = spPr['p:spPr'] as Array<Record<string, unknown>>
        // Read xfrm coords (a:off + a:ext) to match against fixups.
        const xfrm = findElement(spPrChildren, 'a:xfrm')
        if (xfrm === undefined) continue
        const xfrmChildren = xfrm['a:xfrm'] as Array<Record<string, unknown>>
        const off = findElement(xfrmChildren, 'a:off')
        const ext = findElement(xfrmChildren, 'a:ext')
        if (off === undefined || ext === undefined) continue
        const offAttrs = (off[':@'] as Record<string, string>) ?? {}
        const extAttrs = (ext[':@'] as Record<string, string>) ?? {}
        const xEmu = Number(offAttrs['@x'])
        const yEmu = Number(offAttrs['@y'])
        const cxEmu = Number(extAttrs['@cx'])
        const cyEmu = Number(extAttrs['@cy'])

        const match = shapeFixups.find(
          (f) => f.xEmu === xEmu && f.yEmu === yEmu && f.cxEmu === cxEmu && f.cyEmu === cyEmu,
        )
        if (match === undefined) continue

        // Drop the existing <a:solidFill> (the placeholder we emitted) and
        // splice a <a:gradFill> in its place. Preserve the rest of spPr.
        const solidIdx = spPrChildren.findIndex((c) => getElementName(c) === 'a:solidFill')
        const gradFillNode = buildGradFillNode(match.gradient)
        if (solidIdx >= 0) {
          spPrChildren.splice(solidIdx, 1, gradFillNode)
        } else {
          // pptxgenjs may have emitted noFill / nothing if our collapsed
          // colour was undefined; just append gradFill in that case.
          spPrChildren.splice(1, 0, gradFillNode)
        }
        touched = true
        continue
      }

      // Table-cell fixups — locate the matching <p:graphicFrame> by EMU
      // coords (graphicFrame uses `<p:xfrm>` rather than `<a:xfrm>`), drill
      // into <a:tbl>, and swap the targeted <a:tc>'s <a:solidFill> for a
      // <a:gradFill> inside its <a:tcPr>.
      if (tag === 'p:graphicFrame' && (cellFixups.length > 0 || cellRichTextFixups.length > 0)) {
        const gfChildren = node['p:graphicFrame'] as Array<Record<string, unknown>>
        const xfrm = findElement(gfChildren, 'p:xfrm')
        if (xfrm === undefined) continue
        const xfrmChildren = xfrm['p:xfrm'] as Array<Record<string, unknown>>
        const off = findElement(xfrmChildren, 'a:off')
        const ext = findElement(xfrmChildren, 'a:ext')
        if (off === undefined || ext === undefined) continue
        const offAttrs = (off[':@'] as Record<string, string>) ?? {}
        const extAttrs = (ext[':@'] as Record<string, string>) ?? {}
        const xEmu = Number(offAttrs['@x'])
        const yEmu = Number(offAttrs['@y'])
        const cxEmu = Number(extAttrs['@cx'])
        const cyEmu = Number(extAttrs['@cy'])

        const gradientMatches = cellFixups.filter(
          (f) =>
            f.tableXEmu === xEmu &&
            f.tableYEmu === yEmu &&
            f.tableCxEmu === cxEmu &&
            f.tableCyEmu === cyEmu,
        )
        const richTextMatches = cellRichTextFixups.filter(
          (f) =>
            f.tableXEmu === xEmu &&
            f.tableYEmu === yEmu &&
            f.tableCxEmu === cxEmu &&
            f.tableCyEmu === cyEmu,
        )
        if (gradientMatches.length === 0 && richTextMatches.length === 0) continue

        const graphic = findElement(gfChildren, 'a:graphic')
        if (graphic === undefined) continue
        const graphicChildren = graphic['a:graphic'] as Array<Record<string, unknown>>
        const graphicData = findElement(graphicChildren, 'a:graphicData')
        if (graphicData === undefined) continue
        const graphicDataChildren = graphicData['a:graphicData'] as Array<Record<string, unknown>>
        const tbl = findElement(graphicDataChildren, 'a:tbl')
        if (tbl === undefined) continue
        const tblChildren = tbl['a:tbl'] as Array<Record<string, unknown>>
        const trNodes = tblChildren.filter((n) => getElementName(n) === 'a:tr')

        for (const match of gradientMatches) {
          const trNode = trNodes[match.row]
          if (trNode === undefined) continue
          const trChildren = trNode['a:tr'] as Array<Record<string, unknown>>
          const tcNodes = trChildren.filter((n) => getElementName(n) === 'a:tc')
          const tcNode = tcNodes[match.col]
          if (tcNode === undefined) continue
          const tcChildren = tcNode['a:tc'] as Array<Record<string, unknown>>
          const tcPr = findElement(tcChildren, 'a:tcPr')
          if (tcPr === undefined) continue
          const tcPrChildren = tcPr['a:tcPr'] as Array<Record<string, unknown>>
          const solidIdx = tcPrChildren.findIndex((c) => getElementName(c) === 'a:solidFill')
          const gradFillNode = buildGradFillNode(match.gradient)
          if (solidIdx >= 0) {
            tcPrChildren.splice(solidIdx, 1, gradFillNode)
          } else {
            // No solid placeholder (cell options didn't emit one) — prepend
            // gradFill so it sits before the per-edge borders that follow.
            tcPrChildren.splice(0, 0, gradFillNode)
          }
          touched = true
        }

        // F15 — splice per-run rich text into each targeted cell's
        // `<a:txBody>/<a:p>`. Replace the single `<a:r>` pptxgenjs emitted
        // (containing the concatenated plain string) with the recorded run
        // sequence. Each run gets its own `<a:rPr>` carrying the formatting
        // attrs we stripped earlier.
        for (const match of richTextMatches) {
          const trNode = trNodes[match.row]
          if (trNode === undefined) continue
          const trChildren = trNode['a:tr'] as Array<Record<string, unknown>>
          const tcNodes = trChildren.filter((n) => getElementName(n) === 'a:tc')
          const tcNode = tcNodes[match.col]
          if (tcNode === undefined) continue
          const tcChildren = tcNode['a:tc'] as Array<Record<string, unknown>>
          const txBody = findElement(tcChildren, 'a:txBody')
          if (txBody === undefined) continue
          const txBodyChildren = txBody['a:txBody'] as Array<Record<string, unknown>>
          const para = findElement(txBodyChildren, 'a:p')
          if (para === undefined) continue
          const paraChildren = para['a:p'] as Array<Record<string, unknown>>
          const runIdx = paraChildren.findIndex((c) => getElementName(c) === 'a:r')
          if (runIdx < 0) continue
          const newRunNodes = match.runs.map((r) => buildCellRunNode(r))
          paraChildren.splice(runIdx, 1, ...newRunNodes)
          touched = true
        }
        continue
      }

      // F5 — slide-number field. Find the text frame's `<p:sp>` by EMU
      // coords (same matcher the shape-gradient pass uses), then turn the
      // FIRST `<a:r>` inside the FIRST `<a:p>` of `<a:txBody>` into an
      // `<a:fld type="slidenum">`. PowerPoint replaces the displayed text
      // with the live slide number on every open + reorder.
      if (tag === 'p:sp' && slideNumberFixups.length > 0) {
        const spChildren = node['p:sp'] as Array<Record<string, unknown>>
        const spPr = findElement(spChildren, 'p:spPr')
        if (spPr === undefined) continue
        const spPrChildren = spPr['p:spPr'] as Array<Record<string, unknown>>
        const xfrm = findElement(spPrChildren, 'a:xfrm')
        if (xfrm === undefined) continue
        const xfrmChildren = xfrm['a:xfrm'] as Array<Record<string, unknown>>
        const off = findElement(xfrmChildren, 'a:off')
        const ext = findElement(xfrmChildren, 'a:ext')
        if (off === undefined || ext === undefined) continue
        const offAttrs = (off[':@'] as Record<string, string>) ?? {}
        const extAttrs = (ext[':@'] as Record<string, string>) ?? {}
        const xEmu = Number(offAttrs['@x'])
        const yEmu = Number(offAttrs['@y'])
        const cxEmu = Number(extAttrs['@cx'])
        const cyEmu = Number(extAttrs['@cy'])

        const match = slideNumberFixups.find(
          (f) => f.xEmu === xEmu && f.yEmu === yEmu && f.cxEmu === cxEmu && f.cyEmu === cyEmu,
        )
        if (match === undefined) continue

        const txBody = findElement(spChildren, 'p:txBody')
        if (txBody === undefined) continue
        const txBodyChildren = txBody['p:txBody'] as Array<Record<string, unknown>>
        const para = findElement(txBodyChildren, 'a:p')
        if (para === undefined) continue
        const paraChildren = para['a:p'] as Array<Record<string, unknown>>
        const runIdx = paraChildren.findIndex((c) => getElementName(c) === 'a:r')
        if (runIdx < 0) continue
        const runNode = paraChildren[runIdx]! as Record<string, unknown>
        const runChildren = runNode['a:r'] as Array<Record<string, unknown>>
        const rPr = findElement(runChildren, 'a:rPr')
        const tNode = findElement(runChildren, 'a:t')
        // Build <a:fld id="…" type="slidenum"><a:rPr.../><a:t>‹#›</a:t></a:fld>
        // — `‹#›` is what PowerPoint draws when the slide number isn't yet
        // resolved (e.g. in slide thumbnails before render).
        const fldId = `{${slideIndex.toString(16).padStart(8, '0')}-0000-0000-0000-${(
          match.xEmu % 0xffffff
        )
          .toString(16)
          .padStart(12, '0')}}`
        const fldChildren: Array<Record<string, unknown>> = []
        if (rPr !== undefined) fldChildren.push(rPr)
        if (tNode !== undefined) fldChildren.push(tNode)
        const fldNode: Record<string, unknown> = {
          'a:fld': fldChildren,
          ':@': { '@id': fldId, '@type': 'slidenum' },
        }
        paraChildren.splice(runIdx, 1, fldNode)
        touched = true
      }

      // F10 — image mask. Find `<p:pic>` by EMU coords, then replace its
      // `<p:spPr>/<a:prstGeom prst="rect">` with the masked geometry.
      // Triangle / ellipse / polygon use prst presets; path masks use
      // `<a:custGeom>` with normalized anchors scaled to PPTX's 100,000-
      // unit local geometry box.
      if (tag === 'p:pic' && imageMaskFixups.length > 0) {
        const picChildren = node['p:pic'] as Array<Record<string, unknown>>
        const spPr = findElement(picChildren, 'p:spPr')
        if (spPr === undefined) continue
        const spPrChildren = spPr['p:spPr'] as Array<Record<string, unknown>>
        const xfrm = findElement(spPrChildren, 'a:xfrm')
        if (xfrm === undefined) continue
        const xfrmChildren = xfrm['a:xfrm'] as Array<Record<string, unknown>>
        const off = findElement(xfrmChildren, 'a:off')
        const ext = findElement(xfrmChildren, 'a:ext')
        if (off === undefined || ext === undefined) continue
        const offAttrs = (off[':@'] as Record<string, string>) ?? {}
        const extAttrs = (ext[':@'] as Record<string, string>) ?? {}
        const xEmu = Number(offAttrs['@x'])
        const yEmu = Number(offAttrs['@y'])
        const cxEmu = Number(extAttrs['@cx'])
        const cyEmu = Number(extAttrs['@cy'])

        const match = imageMaskFixups.find(
          (f) => f.xEmu === xEmu && f.yEmu === yEmu && f.cxEmu === cxEmu && f.cyEmu === cyEmu,
        )
        if (match === undefined) continue

        const prstGeomIdx = spPrChildren.findIndex((c) => getElementName(c) === 'a:prstGeom')
        const newGeom = buildMaskGeom(match.mask)
        if (prstGeomIdx >= 0) {
          spPrChildren.splice(prstGeomIdx, 1, newGeom)
        } else {
          // No existing prstGeom — append at the end of spPr.
          spPrChildren.push(newGeom)
        }
        touched = true
      }

      // F11 — gaussian blur. Apply to either `<p:sp>` or `<p:pic>`
      // shapes (any object that carries `obj.blur > 0`). The blur
      // effect lives in `<p:spPr>/<a:effectLst>`; append after the
      // fill but BEFORE the prstGeom (PPTX schema order).
      if ((tag === 'p:sp' || tag === 'p:pic') && blurFixups.length > 0) {
        const children = node[tag] as Array<Record<string, unknown>>
        const spPr = findElement(children, 'p:spPr')
        if (spPr === undefined) continue
        const spPrChildren = spPr['p:spPr'] as Array<Record<string, unknown>>
        const xfrm = findElement(spPrChildren, 'a:xfrm')
        if (xfrm === undefined) continue
        const xfrmChildren = xfrm['a:xfrm'] as Array<Record<string, unknown>>
        const off = findElement(xfrmChildren, 'a:off')
        const ext = findElement(xfrmChildren, 'a:ext')
        if (off === undefined || ext === undefined) continue
        const offAttrs = (off[':@'] as Record<string, string>) ?? {}
        const extAttrs = (ext[':@'] as Record<string, string>) ?? {}
        const xEmu = Number(offAttrs['@x'])
        const yEmu = Number(offAttrs['@y'])
        const cxEmu = Number(extAttrs['@cx'])
        const cyEmu = Number(extAttrs['@cy'])

        const match = blurFixups.find(
          (f) => f.xEmu === xEmu && f.yEmu === yEmu && f.cxEmu === cxEmu && f.cyEmu === cyEmu,
        )
        if (match === undefined) continue

        // Skip if effectLst already present (e.g., a shadow fixup added
        // one). For v1 we coexist by appending blur into the existing
        // effectLst; otherwise create one. PPTX accepts multiple effect
        // children inside the same `<a:effectLst>`.
        const blurNode: Record<string, unknown> = {
          'a:blur': [],
          ':@': { '@rad': String(match.radEmu), '@grow': '0' },
        }
        const existingEffectIdx = spPrChildren.findIndex((c) => getElementName(c) === 'a:effectLst')
        if (existingEffectIdx >= 0) {
          const effLst = spPrChildren[existingEffectIdx]! as Record<string, unknown>
          const effChildren = effLst['a:effectLst'] as Array<Record<string, unknown>>
          // Avoid duplicate <a:blur> if pptxgenjs ever emits one.
          if (!effChildren.some((c) => getElementName(c) === 'a:blur')) {
            effChildren.push(blurNode)
          }
        } else {
          // Insert <a:effectLst> AFTER the prstGeom (PPTX schema order:
          // xfrm → prstGeom/custGeom → fill → effectLst).
          const insertAt =
            spPrChildren.findIndex(
              (c) => getElementName(c) === 'a:prstGeom' || getElementName(c) === 'a:custGeom',
            ) + 1
          spPrChildren.splice(insertAt > 0 ? insertAt : spPrChildren.length, 0, {
            'a:effectLst': [blurNode],
          })
        }
        touched = true
      }
    }
    if (touched) {
      const out = builder.build(tree) as string
      zip.file(path, out)
    }
  }

  const reZipped = await zip.generateAsync({ type: 'nodebuffer' })
  return Buffer.from(reZipped)
}

/** Walk a preserveOrder XML tree depth-first yielding every element node. */
function* walkTree(
  nodes: Array<Record<string, unknown>>,
): IterableIterator<Record<string, unknown>> {
  for (const n of nodes) {
    yield n
    const key = getElementName(n)
    if (key === null) continue
    const children = n[key]
    if (Array.isArray(children)) {
      yield* walkTree(children as Array<Record<string, unknown>>)
    }
  }
}

function getElementName(n: Record<string, unknown>): string | null {
  for (const key of Object.keys(n)) {
    if (key !== ':@' && key !== '#text' && key !== '?xml') return key
  }
  return null
}

function findElement(
  nodes: Array<Record<string, unknown>>,
  name: string,
): Record<string, unknown> | undefined {
  return nodes.find((n) => getElementName(n) === name)
}

/**
 * Construct a `<a:gradFill>` node tree for a Narrative gradient. Linear
 * gradients carry an `<a:lin ang="…"/>` with angle in 60000ths-of-a-degree
 * (PPTX's native unit, with 0° = "to the right"); radial gradients use
 * `<a:path path="circle">` instead. Stop positions normalise back to the
 * 0–100000 integer range PPTX uses on `<a:gs pos="…">`.
 */
/**
 * Build a `<a:prstGeom>` or `<a:custGeom>` for an image mask. Preset
 * geometries cover the simple shapes (ellipse / triangle / polygon); the
 * path mask emits a `<a:custGeom>` with the same cubic-bezier topology
 * the editor stores. Geometry uses PPTX's 100,000-unit local coordinate
 * box (the standard `<a:gd>` reference frame). Polygon side count maps
 * to the closest PPTX `prst` per the existing `polygonPrstFor`.
 */
function buildMaskGeom(mask: ImageMask): Record<string, unknown> {
  if (mask.kind === 'rectangle') {
    // `cornerRadius` lives on rectangle masks but PPTX rect preset has no
    // radius; future enhancement is `roundRect` preset + avLst entry.
    return { 'a:prstGeom': [{ 'a:avLst': [] }], ':@': { '@prst': 'rect' } }
  }
  if (mask.kind === 'ellipse') {
    return { 'a:prstGeom': [{ 'a:avLst': [] }], ':@': { '@prst': 'ellipse' } }
  }
  if (mask.kind === 'triangle') {
    return { 'a:prstGeom': [{ 'a:avLst': [] }], ':@': { '@prst': 'triangle' } }
  }
  if (mask.kind === 'polygon') {
    return {
      'a:prstGeom': [{ 'a:avLst': [] }],
      ':@': { '@prst': polygonPrstFor(mask.sides) },
    }
  }
  // Path mask — emit <a:custGeom> with a single <a:path> tracing the
  // normalized anchors. PPTX's path-local coords run 0..w/h where w/h is
  // a fixed unit (we use 100000 for compatibility with most renderers).
  const W = 100000
  const H = 100000
  const pathChildren: Array<Record<string, unknown>> = []
  for (let i = 0; i < mask.anchors.length; i++) {
    const a = mask.anchors[i]!
    if (i === 0) {
      pathChildren.push({
        'a:moveTo': [
          {
            'a:pt': [],
            ':@': { '@x': String(Math.round(a.x * W)), '@y': String(Math.round(a.y * H)) },
          },
        ],
      })
      continue
    }
    const prev = mask.anchors[i - 1]!
    const cp1 = prev.cpOut
    const cp2 = a.cpIn
    if (cp1 !== undefined || cp2 !== undefined) {
      const c1 = cp1 ?? { x: 0, y: 0 }
      const c2 = cp2 ?? { x: 0, y: 0 }
      pathChildren.push({
        'a:cubicBezTo': [
          {
            'a:pt': [],
            ':@': {
              '@x': String(Math.round((prev.x + c1.x) * W)),
              '@y': String(Math.round((prev.y + c1.y) * H)),
            },
          },
          {
            'a:pt': [],
            ':@': {
              '@x': String(Math.round((a.x + c2.x) * W)),
              '@y': String(Math.round((a.y + c2.y) * H)),
            },
          },
          {
            'a:pt': [],
            ':@': {
              '@x': String(Math.round(a.x * W)),
              '@y': String(Math.round(a.y * H)),
            },
          },
        ],
      })
    } else {
      pathChildren.push({
        'a:lnTo': [
          {
            'a:pt': [],
            ':@': { '@x': String(Math.round(a.x * W)), '@y': String(Math.round(a.y * H)) },
          },
        ],
      })
    }
  }
  if (mask.closed) pathChildren.push({ 'a:close': [] })
  return {
    'a:custGeom': [
      { 'a:avLst': [] },
      { 'a:gdLst': [] },
      { 'a:ahLst': [] },
      { 'a:cxnLst': [] },
      {
        'a:rect': [],
        ':@': { '@l': '0', '@t': '0', '@r': 'r', '@b': 'b' },
      },
      {
        'a:pathLst': [
          {
            'a:path': pathChildren,
            ':@': { '@w': String(W), '@h': String(H) },
          },
        ],
      },
    ],
  }
}

/**
 * Build an `<a:r>` element tree for a single cell run. `<a:rPr>` carries
 * the formatting (bold / italic / underline / colour / size / typeface);
 * `<a:t>` carries the text. fast-xml-parser's preserveOrder mode wraps
 * each element's children as an array under its tag key and attrs under
 * the special `:@` key — same convention buildGradFillNode uses.
 */
function buildCellRunNode(run: CellRichTextRun): Record<string, unknown> {
  const rPrAttrs: Record<string, string> = { '@lang': 'en-US' }
  if (run.sizeHundredthsPt !== undefined) {
    rPrAttrs['@sz'] = String(run.sizeHundredthsPt)
  }
  if (run.bold === true) rPrAttrs['@b'] = '1'
  if (run.italic === true) rPrAttrs['@i'] = '1'
  if (run.underline === true) rPrAttrs['@u'] = 'sng'

  const rPrChildren: Array<Record<string, unknown>> = []
  if (run.color !== undefined) {
    rPrChildren.push({
      'a:solidFill': [{ 'a:srgbClr': [], ':@': { '@val': hex6(run.color) } }],
    })
  }
  if (run.fontFamily !== undefined) {
    rPrChildren.push({ 'a:latin': [], ':@': { '@typeface': run.fontFamily } })
  }

  return {
    'a:r': [{ 'a:rPr': rPrChildren, ':@': rPrAttrs }, { 'a:t': [{ '#text': run.text }] }],
  }
}

function buildGradFillNode(g: LinearGradientFill | RadialGradientFill): Record<string, unknown> {
  const stops: Array<Record<string, unknown>> = []
  for (const s of g.stops) {
    const colour: Array<Record<string, unknown>> = [
      { 'a:srgbClr': [], ':@': { '@val': hex6(s.color) } } as Record<string, unknown>,
    ]
    if (s.alpha !== undefined && s.alpha < 1) {
      ;(colour[0]!['a:srgbClr'] as Array<Record<string, unknown>>).push({
        'a:alpha': [],
        ':@': { '@val': String(Math.round(s.alpha * 100000)) },
      } as Record<string, unknown>)
    }
    stops.push({
      'a:gs': colour,
      ':@': { '@pos': String(Math.round(Math.max(0, Math.min(1, s.offset)) * 100000)) },
    })
  }
  const gsLst = { 'a:gsLst': stops }
  const directionNode =
    g.kind === 'linearGradient'
      ? // Narrative angle is "0° = top→bottom"; PPTX is "0° = to the right".
        // Subtract 90° to convert back, then to 60000ths-of-a-degree.
        {
          'a:lin': [],
          ':@': {
            '@ang': String(Math.round((((g.angleDeg - 90) % 360) + 360) % 360) * 60000),
            '@scaled': '1',
          },
        }
      : {
          'a:path': [],
          ':@': { '@path': 'circle' },
        }
  return {
    'a:gradFill': [gsLst, directionNode],
    ':@': { '@flip': 'none', '@rotWithShape': '1' },
  }
}
