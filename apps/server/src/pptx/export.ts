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
import { SLIDE_WIDTH } from '@narrative/shared'
import { toDelta } from '@narrative/slide-model'
import type {
  Slide,
  SlideObject,
  TextObject,
  RectangleObject,
  EllipseObject,
  LineObject,
  ImageObject,
  SlideBackground,
  LinearGradientFill,
  RadialGradientFill,
  TokenRef,
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
  addText: (text: string | unknown[], opts: Record<string, unknown>) => void
  addShape: (kind: string, opts: Record<string, unknown>) => void
  addImage: (opts: Record<string, unknown>) => void
  addNotes: (notes: string) => void
  addTable: (rows: Array<Array<Record<string, unknown>>>, opts: Record<string, unknown>) => void
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

// ---------------------------------------------------------------------------
// Per-object emitters
// ---------------------------------------------------------------------------

function emitText(slide: PptxSlide, obj: TextObject): void {
  const textValue = typeof obj.text === 'string' ? obj.text : (obj.text?.toString() ?? '')
  if (textValue.length === 0) return

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
  if (obj.colorAlpha !== undefined && obj.colorAlpha < 1) {
    opts['transparency'] = Math.round((1 - obj.colorAlpha) * 100)
  }
  // pptxgenjs `bullet: true` emits `<a:buChar char="•">` on every paragraph;
  // `bullet: { type: 'number' }` emits `<a:buAutoNum type="arabicPeriod">`.
  if (obj.listStyle === 'bullet') {
    opts['bullet'] = true
  } else if (obj.listStyle === 'numbered') {
    opts['bullet'] = { type: 'number' }
  }
  // Object-level hyperlink lands on the addText opts; pptxgenjs writes it
  // as `<a:hlinkClick r:id="…"/>` on every run inside the frame.
  if (obj.hyperlink !== undefined && obj.hyperlink.kind === 'url') {
    opts['hyperlink'] = { url: obj.hyperlink.href }
  }
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
interface GradientFixup {
  /** 0-based — matches `ppt/slides/slide${i+1}.xml`. */
  slideIndex: number
  xEmu: number
  yEmu: number
  cxEmu: number
  cyEmu: number
  gradient: LinearGradientFill | RadialGradientFill
}

/** Same px→EMU pipeline pptxgenjs uses internally: 1 inch = 914400 EMU. */
const EMU_PER_INCH = 914400
function pxToEmu(n: number): number {
  // px → inch → EMU. Round at each step so the match keys stay integer-exact
  // against the values pptxgenjs writes into `<a:off x="…"/>`.
  return Math.round(round(n / PX_PER_IN, 3) * EMU_PER_INCH)
}

function emitRectOrEllipse(
  slide: PptxSlide,
  obj: RectangleObject | EllipseObject,
  kind: 'rect' | 'ellipse' | 'roundRect',
  slideIndex: number,
  fixups: GradientFixup[],
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
  slide.addShape(kind, opts)
}

function emitLine(slide: PptxSlide, obj: LineObject): void {
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
  slide.addShape('line', opts)
}

async function emitImage(slide: PptxSlide, obj: ImageObject, loader: AssetLoader): Promise<void> {
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
): Promise<void> {
  switch (obj.type) {
    case 'text':
      emitText(slide, obj)
      break
    case 'rectangle': {
      const rectKind: 'rect' | 'roundRect' =
        obj.cornerRadius !== undefined && obj.cornerRadius !== 0 ? 'roundRect' : 'rect'
      emitRectOrEllipse(slide, obj, rectKind, slideIndex, fixups)
      break
    }
    case 'ellipse':
      emitRectOrEllipse(slide, obj, 'ellipse', slideIndex, fixups)
      break
    case 'line':
      emitLine(slide, obj)
      break
    case 'image':
      if (loader !== undefined) await emitImage(slide, obj, loader)
      break
    default:
      // video / triangle / polygon / arrow / path / component-instance
      // → not yet supported. Drop silently; the user gets a slide with the
      // mapped shapes only.
      break
  }
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

async function applyBackground(
  slide: PptxSlide,
  bg: SlideBackground | undefined,
  loader: AssetLoader | undefined,
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
    // pptxgenjs slide backgrounds don't support multi-stop gradients —
    // collapse to the middle stop colour, same trick as shape fills.
    const stops = bg.stops ?? []
    const mid = stops[Math.floor(stops.length / 2)] ?? stops[0]
    if (mid !== undefined) slide.background = { color: hex6(mid.color) }
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

export interface ExportOptions {
  /** Goes into the .pptx core properties (title field). Defaults to "Narrative deck". */
  title?: string
  /** Goes into the .pptx core properties (author field). */
  author?: string
  /** Resolves Narrative media assets to embeddable bytes. Without it, image
   *  shapes and image backgrounds are dropped silently. */
  assetLoader?: AssetLoader
  /** Plain-text speaker notes per slide id. Slide ids without an entry
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

  for (let slideIndex = 0; slideIndex < slides.length; slideIndex++) {
    const slide = slides[slideIndex]!
    const out = pres.addSlide()
    await applyBackground(out, slide.background, options.assetLoader)

    // Reconstruct tables — groups of cell rects + cell texts that form a
    // uniform N×M grid get emitted as `<a:tbl>` so the round-trip preserves
    // table semantics. Non-table groups (or single shapes) fall through to
    // the per-object emit below. consumedIds collects shape ids the table
    // pass has already emitted, so the loop skips them.
    const consumedIds = emitGroupedTables(out, slide.objects ?? [])
    for (const obj of slide.objects ?? []) {
      if (consumedIds.has(obj.id)) continue
      await emitObject(out, obj, options.assetLoader, slideIndex, gradientFixups)
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
  return buffer
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
    for (const node of walkTree(tree)) {
      if (getElementName(node) !== 'p:sp') continue
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

      const match = slideFixups.find(
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
