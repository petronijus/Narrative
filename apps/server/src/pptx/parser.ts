/**
 * pptx/parser.ts
 *
 * Reads a `.pptx` (PresentationML / OOXML) blob and lowers it into the
 * intermediate shape the importer + spike both consume. Backed by
 * `jszip` + `fast-xml-parser`.
 *
 * The MVP mapping table lives alongside in `docs/plans/m28-pptx-import-export.md`.
 * Anything not in that table is dropped (logged via the `ignored` field on the
 * result). The goal is "recognisably the same", not byte-perfect.
 *
 * Coordinate model: PPTX uses EMU (English Metric Units), 914 400 per inch.
 * The parser emits coordinates already converted to **px at 96 DPI** so the
 * mapper / writer can work in the unit Narrative uses.
 */

import JSZip from 'jszip'
import type {
  AnimationPreset,
  AnimationTrigger,
  ImageMask,
  ListNumberFormat,
  ParagraphAttrs,
  SlideTransition,
} from '@narrative/shared'
import { MAX_LIST_LEVEL } from '@narrative/shared'
import {
  type XmlNode,
  ooxmlParser,
  getAttrs,
  getTag,
  getChildren,
  findFirst,
  findAll,
  walk,
} from './ooxml/read.js'
import {
  type ThemeColourMap,
  parseHexColour,
  resolveSchemeColour,
  parseColourAndAlphaFrom,
  parseColourFrom,
  unpackRgb,
  packRgb,
  clamp01,
} from './ooxml/color.js'
import { type ParsedGradient, parseGradient } from './ooxml/fill.js'
import { EMU_PER_SOURCE_PX, emuToSourcePx } from './ooxml/units.js'
import { readLine } from './ooxml/line.js'
import { readEffects } from './ooxml/effects.js'
import {
  readAspectLocked,
  readCustGeom,
  readImageRect,
  readPictureMask,
  readRoundRectRadius,
  srcRectSignature,
  type GeomAnchor as ParsedPathAnchor,
} from './ooxml/shapes.js'
import {
  readNarrativeExt,
  readSlideExt,
  type FrameFingerprint,
  type NarrativeObjectExt,
} from './ooxml/narrativeExt.js'
import { imageCrop, slideExtFields } from './ooxml/extSchema.js'
import { readTransition } from './ooxml/transition.js'
import { readTiming } from './ooxml/timing.js'
import type { NotesDoc } from '@narrative/slide-model'
import { readNotes } from './ooxml/notes.js'
import { ALIGN, ANCHOR, AUTONUM, BORDER_DASH } from './ooxml/vocabulary.js'
import { defaultBulletGlyph } from '@narrative/slide-model'
import {
  DEFAULT_BODY_INSETS,
  paragraphAttrsKey,
  readBodyInsets,
  readParagraphExt,
  readRunExt,
  type BodyInsets,
} from './ooxml/text.js'
import { paragraphAttrs as paragraphAttrsSchema } from './ooxml/extSchema.js'

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ParsedShapeKind =
  | 'text'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'triangle'
  | 'polygon'
  | 'path'
  | 'image'
  | 'video'
  | 'table'
  | 'unknown'

/**
 * M29 Phase 4 — one parsed cell inside `<a:tbl>`. Mirrors the run-level
 * subset of `ParsedShape` that's relevant inside a table cell. Per-edge
 * border / padding / fill colour come from `<a:tcPr>`; the merge fields
 * mirror Narrative's TableCell schema (origin carries gridSpan/rowSpan,
 * continuation cells carry mergeOriginR/C pointers).
 */
/** One edge of a table cell, in source px. */
export interface ParsedCellBorder {
  color: number
  width: number
  dash?: 'solid' | 'dash' | 'dot'
  alpha?: number
}

export interface ParsedTableCell {
  /** Concatenated plain text of every run in the cell — same shape as
   *  ParsedShape.text for ordinary text frames. The writer turns this
   *  into a Y.Text body. */
  text: string
  /** Per-run breakdown so the writer can preserve mid-cell formatting
   *  (bold, italic, colour, font) via Y.Text format ops. Absent when
   *  the cell has no `<a:txBody>`. */
  textRuns?: ParsedTextRun[]
  /** First-run text colour (0xRRGGBB). */
  color?: number
  fontSize?: number
  fontWeight?: 'normal' | 'bold'
  fontFamily?: string
  /** Frame-level typography from `<a:txBody>/<a:bodyPr>` + first paragraph
   *  `<a:pPr>` + first run `<a:rPr>`. These mirror the ParsedShape fields
   *  parseShape produces for text frames; the writer either lifts them
   *  into `TableDefaults` when uniform across all cells or writes them
   *  per-cell otherwise. Values are in px / unitless (already scaled by
   *  parseShape's PPTX_FONT_TO_PX). */
  lineHeight?: number
  /** Multiple of the font's normal line height (spcPct / 100000). */
  lineSpacing?: number
  letterSpacing?: number
  paragraphSpaceBefore?: number
  paragraphSpaceAfter?: number
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  align?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'middle' | 'bottom'
  /** Cell background — solid fill from `<a:tcPr>/<a:solidFill>` or the
   *  preset-banding heuristic. */
  fill?: number
  fillAlpha?: number
  /** Cell background — linear or radial gradient from `<a:tcPr>/<a:gradFill>`.
   *  Writer maps to `TableCell.fillStyle` (`gradientToFillStyle`); the
   *  renderer paints it through the same procedural-texture cache
   *  rectangles use. Image fills on cells are not supported in v1. */
  fillGradient?: ParsedGradient
  /** Per-cell border override (`<a:tcPr>/<a:lnL|R|T|B>`). Each edge
   *  carries its own colour + width, matching Narrative's
   *  TableCellEdgeBorders shape. An undefined edge means "inherit
   *  from the table default" (renderer-side fallback). */
  border?: {
    top?: ParsedCellBorder
    right?: ParsedCellBorder
    bottom?: ParsedCellBorder
    left?: ParsedCellBorder
  }
  /** Zip path of a picture fill (`<a:tcPr>/<a:blipFill>`); the importer
   *  sets `assetId` once the bytes are stored. */
  imagePath?: string
  assetId?: string
  /** Cell content padding (PPTX `<a:tcPr marL/marR/marT/marB>`). */
  padding?: { top: number; right: number; bottom: number; left: number }
  /** Merge extent — set on the origin only. `gridSpan` = column count
   *  the origin owns, `rowSpan` = row count. */
  gridSpan?: number
  rowSpan?: number
  /** Continuation pointer — set on every covered cell except the origin.
   *  Lets the renderer skip them and the editor walk back. */
  mergeOriginR?: number
  mergeOriginC?: number
}

/**
 * Path-object anchor — same schema as Narrative's PathAnchor, but in
 * PPTX EMU before the writer scales to canvas pixels. cpIn / cpOut are
 * the cubic-bezier control handles relative to the anchor; missing on
 * both sides of a segment means the segment is a straight line.
 */
export type { GeomAnchor as ParsedPathAnchor } from './ooxml/shapes.js'

/**
 * A single styled run inside a text frame. Mirrors PPTX's `<a:r>` shape
 * exactly: a contiguous slice of text that shares one set of formatting
 * attributes. The writer turns a sequence of these into a Y.Text with
 * Quill-style per-range format attrs, giving Narrative true per-character
 * inline formatting (bold mid-paragraph, two colours in one frame, etc.).
 *
 * Paragraph breaks appear as synthetic runs with `text === '\n'` and no
 * formatting — keeps the runs[] array a flat list the writer can iterate
 * once while building the Y.Text body.
 */
export interface ParsedTextRun {
  text: string
  color?: number
  colorAlpha?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** Run font size in px (post `PPTX_FONT_TO_PX` conversion). */
  fontSize?: number
  /** The run's `<a:rPr>/<a:hlinkClick>`, resolved through the slide's rels. */
  hyperlink?: ParsedHyperlink
  /** Font family from `<a:rPr>/<a:latin typeface="…">`. */
  fontFamily?: string
  /** Letter spacing in px (PPTX `<a:rPr spc>` is 100ths of a point). */
  letterSpacing?: number
  /** Exact numeric weight from a Narrative export's run extension. */
  fontWeight?: number
}

export interface ParsedShape {
  kind: ParsedShapeKind
  /** Top-left in slide-local px (96 DPI). */
  x: number
  y: number
  width: number
  height: number
  /** Degrees, clockwise. 0 by default. */
  rotation: number
  /** Solid fill, 0xRRGGBB. Undefined when no solid fill (gradient / image / none). */
  fillColor?: number
  /** Fill alpha 0..1, if `<a:alpha>` was set on the fill colour. */
  fillAlpha?: number
  /** Linear or radial gradient fill, when `<a:gradFill>` was present. */
  fillGradient?: ParsedGradient
  /** Outline color, 0xRRGGBB. */
  strokeColor?: number
  /** Stroke alpha 0..1, if `<a:alpha>` was set on the line colour. */
  strokeAlpha?: number
  /** Outline width in px. */
  strokeWidth?: number
  /** Dashed outline (`<a:prstDash>` other than solid). */
  strokeDash?: boolean
  /** For a shape its text made a text frame: the geometry it draws under
   *  the text (rectangle, ellipse, …), see `extractGeometryUnderText`. */
  geometryKind?: ParsedShapeKind
  /** Corner radius in px, from a `roundRect`'s `adj`. */
  cornerRadius?: number
  /** Model values from a Narrative export's extension (`ooxml/narrativeExt.ts`),
   *  present only while the shape's frame is the one they were written for.
   *  The writer lays them over the object it maps. */
  narrative?: NarrativeObjectExt
  /** Concatenated text content (one style per frame; per-run formatting deferred). */
  text?: string
  /** First-run text colour (0xRRGGBB) if set. */
  textColor?: number
  /** First-run text colour alpha 0..1, if `<a:alpha>` was set. */
  textColorAlpha?: number
  /** Paragraph alignment, after inheriting layout/master defaults. */
  textAlign?: 'left' | 'center' | 'right' | 'justify'
  /** List marker for the first paragraph (PowerPoint resolves per-paragraph;
   *  v1 maps Narrative's frame-wide `listStyle` to the first paragraph's
   *  marker). Falls through slide pPr → placeholder lvl1pPr → master
   *  `<p:txStyles>` lvl1pPr. Missing ⇒ no bullet.
   *
   *  LEGACY: superseded by per-paragraph `paragraphs[]` below. Still set on
   *  parse for diagnostics / backward-compat, but the writer no longer maps
   *  it onto `TextObject.listStyle` — the per-paragraph block attrs win. */
  listStyle?: 'bullet' | 'numbered'
  /** Per-paragraph block attributes — one entry per source `<a:p>`, in
   *  document order. Each carries the paragraph's resolved list kind, nesting
   *  level, custom bullet glyph, autonum format + startAt. An entry with no
   *  `list` (and no `level`) is a plain paragraph. The writer attaches these
   *  to the Y.Text body's paragraph-separator characters via
   *  `blockAttrsToInsertAttrs`. Present only for `kind === 'text'` shapes that
   *  carry at least one paragraph with list / level data; absent on plain
   *  un-listed frames so the writer's string fast-path still applies. */
  paragraphs?: ParagraphAttrs[]
  /** Vertical anchor of the text box: `t` / `ctr` / `b` → top / middle /
   *  bottom. Inherits from the placeholder's `<a:bodyPr anchor>` when the
   *  slide's own bodyPr is empty. Default = top. */
  textVerticalAlign?: 'top' | 'middle' | 'bottom'
  /** First-run font size in px (PPTX uses 100ths of a point — converted here). */
  fontSize?: number
  /** First-run bold flag. */
  bold?: boolean
  /** Source XML element name (e.g. `p:sp`, `p:pic`, `p:cxnSp`). Useful for debugging. */
  sourceTag: string
  /** PPTX preset geometry name (`rect`, `ellipse`, `line`, …), if `<a:prstGeom>` was present. */
  prstGeom?: string
  /** PPTX-side relationship id for picture fills (lets the writer resolve the embed). */
  blipRelId?: string
  /** Zip-internal path of the embedded image (e.g. `ppt/media/image1.png`).
   *  Looked up against `ParsedPptx.embeddedImages` by the importer. Set by
   *  the parser at the same time as `blipRelId` so the route handler has a
   *  stable key without re-walking the rels chain. */
  imagePath?: string
  /** Image opacity 0..1 from `<a:blip>/<a:alphaModFix amt="N">` (PPTX uses
   *  parts-per-100000). Maps to the writer's `opacity` on the emitted image
   *  object. Missing ⇒ fully opaque. */
  imageAlpha?: number
  /** Set by the importer after MinIO upload. The writer uses this to emit
   *  a Narrative `ImageObject` with a real `assetId`. */
  assetId?: string
  /** Full per-run breakdown (rich text). Missing on non-text shapes; the
   *  writer falls back to the flat `text` + first-run style fields below
   *  when this is absent. Present even for single-run text frames so
   *  callers don't have to special-case formatting consistency checks. */
  textRuns?: ParsedTextRun[]
  /** The shape's click action (`<p:cNvPr>/<a:hlinkClick>`), or for a text
   *  frame without one its first run's link — Narrative models one link
   *  per object. */
  hyperlink?: ParsedHyperlink
  /** Alt text, `<p:cNvPr descr>`. */
  alt?: string
  /** A picture's own geometry as the model's image mask (`ooxml/shapes.ts`);
   *  a rectangle's corner radius is in source px. */
  mask?: ImageMask
  /** `noChangeAspect` on the shape's locks. */
  aspectLocked?: boolean
  /** P6 group membership — table cells share a single nanoid groupId so
   *  the user can move/duplicate/delete the table as a unit. Other shape
   *  kinds leave this undefined. */
  groupId?: string
  /** Regular-polygon side count for `kind === 'polygon'`. Derived from
   *  PPTX preset name: pentagon=5, hexagon=6, heptagon=7, octagon=8,
   *  decagon=10, dodecagon=12. */
  sides?: number
  /** Line/arrow endpoint caps — set when `kind === 'line'` or 'arrow'.
   *  PPTX uses `<a:headEnd type="…">` / `<a:tailEnd type="…">` on the
   *  line's `<a:ln>`; any non-"none" head/tail upgrades the shape to
   *  `kind: 'arrow'` so the writer routes it correctly. */
  startCap?: 'none' | 'arrow' | 'round' | 'square'
  endCap?: 'none' | 'arrow' | 'round' | 'square'
  /** Connector flip flags from `<a:xfrm flipH="1" flipV="1">`. Combined
   *  with the connector's bbox to derive p1/p2 endpoints in the writer. */
  flipH?: boolean
  flipV?: boolean
  /** Path anchors for `kind === 'path'` — extracted from `<a:custGeom>`.
   *  Coordinates are in slide-local px (post emuToPx), same coordinate
   *  space as `x` / `y`. The writer translates them into Narrative's
   *  PathAnchor schema (which positions anchors relative to the object's
   *  `(x, y)` origin). */
  pathAnchors?: ParsedPathAnchor[]
  /** True when the path's source `<a:path>` ended with `<a:close/>`. */
  pathClosed?: boolean
  /** Zip-internal path of the embedded video file (e.g.
   *  `ppt/media/media1.mp4`). Set when the shape is a `<p:pic>` with a
   *  `<a:videoFile>` rel inside its `<p:nvPr>`. The route handler uploads
   *  the bytes to MinIO and patches `assetId` for the writer. */
  videoPath?: string
  /** Sniffed MIME type of the embedded video bytes (e.g. `video/mp4`). */
  videoMimeType?: string
  /** When `kind === 'video'`, the resolved assetId of the poster image
   *  (the blipFill that PPTX stamps under the video for the first-frame
   *  preview). Emitted by the writer as a sibling ImageObject so the
   *  slide stays visible even while the HLS transcode is pending. */
  posterAssetId?: string
  /** Drop shadow extracted from `<a:effectLst>/<a:outerShdw>`. PPTX stores
   *  the shadow in polar coords (dist + dir); we convert to Narrative's
   *  cartesian (offsetX/Y) at parse time. */
  shadow?: {
    color: number
    blur: number
    offsetX: number
    offsetY: number
    opacity: number
  }
  /** Gaussian blur radius in px from `<a:effectLst>/<a:blur rad>`. */
  blur?: number
  /** Image crop window in slide-local px, derived from `<a:blipFill>/<a:srcRect>`.
   *  Same coordinate space as the shape's `x` / `y` / `width` / `height`. The
   *  writer translates to Narrative's `imageRect` (which is also slide-local). */
  imageRect?: { x: number; y: number; width: number; height: number }
  /** PPTX `<p:cNvPr id="N">` integer id. Used by the writer to resolve
   *  animation `<p:spTgt spid="N">` references to the SlideObject.id the
   *  writer assigned to this shape. */
  spId?: number
  /** `<p:cNvPr name="…">` author-visible name. Capture so re-export emits
   *  back the same name attr. */
  cnvName?: string
  /** Frame-level text properties — captured during text-frame parsing and
   *  laid onto the TextObject root by the writer. Per-run values would be
   *  captured under `textRuns[i]` instead; these fields hold the values
   *  Narrative models at the frame level (no per-run variant). */
  fontFamily?: string
  letterSpacing?: number
  lineHeight?: number
  /** Multiple of the font's normal line height (spcPct / 100000). */
  lineSpacing?: number
  paragraphSpaceBefore?: number
  paragraphSpaceAfter?: number
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  /** Frame italic / underline from the shape's lstStyle (the frame tier). */
  italic?: boolean
  underline?: boolean
  /** The text body's insets in source px (`<a:bodyPr lIns/tIns/rIns/bIns>`,
   *  inherited and defaulted as PowerPoint does). The model's text frame is
   *  where its text is, so the writer maps the frame shrunk by them. */
  textInsets?: { l: number; t: number; r: number; b: number }
  /** `<a:bodyPr wrap="none">` — see TextObject.wrap. */
  wrap?: 'none'
  /** The frame is a PowerPoint slide-number field (`<a:fld type="slidenum">`)
   *  and nothing else; becomes `TextObject.isSlideNumber`. */
  isSlideNumber?: boolean
  /** Text-shape stroke ("text outline") — `<a:rPr><a:ln>` solidFill +
   *  width. Captured from the first run; collapsed onto TextObject root. */
  textStrokeColor?: number
  textStrokeAlpha?: number
  textStrokeWidth?: number
  /** Set when `kind === 'table'` — column widths in px (post emuToPx,
   *  pre-scale). The writer rescales these into the table's bbox when
   *  it builds the Narrative TableObject. */
  tableColWidths?: number[]
  /** Set when `kind === 'table'` — row heights in px. */
  tableRowHeights?: number[]
  /** Set when `kind === 'table'` — `rows[r][c]` is a parsed cell. */
  tableCells?: ParsedTableCell[][]
}

export interface ParsedBackground {
  kind: 'solid' | 'gradient' | 'image' | 'none'
  /** 0xRRGGBB when kind === 'solid'. */
  color?: number
  /** Solid colour alpha 0..1, when `<a:alpha>` was set. */
  alpha?: number
  /** Image darkening 0..1, from `<a:lum bright>` below zero. */
  dim?: number
  /** Present when kind === 'gradient'. */
  gradient?: ParsedGradient
  /** Relationship id for an `<a:blipFill>` background. */
  blipRelId?: string
  /** Zip-internal path of the embedded image (same role as on ParsedShape). */
  imagePath?: string
  /** Set by the importer after MinIO upload — same role as on ParsedShape. */
  assetId?: string
}

/**
 * Theme palette resolved from `ppt/theme/theme1.xml`. Maps scheme-color
 * names (`accent1` / `tx1` / `bg1` / `lt2` / `dk1` / …) to 0xRRGGBB ints.
 * Used to resolve `<a:schemeClr val="…"/>` references against the deck's
 * actual theme rather than guessing a default palette.
 */
export type { ThemeColourMap } from './ooxml/color.js'
export type {
  ParsedGradientStop,
  ParsedLinearGradient,
  ParsedRadialGradient,
  ParsedGradient,
} from './ooxml/fill.js'

/**
 * `<a:theme>/<a:objectDefaults>/<a:txDef>/<a:lstStyle>/<a:defPPr>/<a:defRPr>`
 * — the OOXML-level default text styling for a text-box shape (`<p:cNvSpPr
 *  txBox="1">`) that doesn't carry its own color/font on the run, paragraph,
 * or text body. Lowest layer of the inheritance chain for non-placeholder
 * text. Stored on a WeakMap keyed by the theme map so we don't have to
 * thread an extra parameter through the dozen functions that take a
 * `ThemeColourMap`.
 */
interface ThemeTxDef {
  color?: number
  colorAlpha?: number
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  fontFamily?: string
}
const themeTxDefStore = new WeakMap<ThemeColourMap, ThemeTxDef>()

/**
 * `<a:fontScheme>` from `theme1.xml` — the two typefaces every OOXML theme
 * font reference points at. `+mj-*` (major) is the heading font, `+mn-*`
 * (minor) the body font.
 */
interface ThemeFonts {
  major?: string
  minor?: string
}

/** Side-band store, same trick as `themeTxDefStore`: keyed by the theme map
 *  so the dozen functions that already thread a `ThemeColourMap` don't need
 *  a second parameter. */
const themeFontStore = new WeakMap<ThemeColourMap, ThemeFonts>()

/** Side-band store, same trick again: per-level `marL` from
 *  `ppt/presentation.xml` `<p:defaultTextStyle>` — the bottom layer for text
 *  that is not a placeholder (text boxes, shapes with text). */
const presentationLevelMarginsStore = new WeakMap<ThemeColourMap, Array<number | undefined>>()

/**
 * Resolve an `<a:latin typeface="…">` value.
 *
 * A typeface is either a literal font name or a theme reference: `+mj-lt`
 * (major/heading latin), `+mn-lt` (minor/body latin), plus the `-ea` / `-cs`
 * east-asian and complex-script variants, which we map onto the same two
 * latin faces — PowerPoint itself falls back to the latin face when the
 * script-specific font isn't installed.
 *
 * Returns `undefined` for an empty value, and for a theme reference the
 * loaded theme has no entry for — the caller then keeps looking up the
 * inheritance chain instead of persisting raw OOXML markup like `+mn-lt`
 * into the deck's `fontFamily`.
 */
function resolveTypeface(raw: unknown, theme: ThemeColourMap): string | undefined {
  if (typeof raw !== 'string') return undefined
  const tf = raw.trim()
  if (tf.length === 0) return undefined
  if (!tf.startsWith('+')) return tf
  const fonts = themeFontStore.get(theme)
  if (fonts === undefined) return undefined
  const resolved = tf.startsWith('+mj')
    ? fonts.major
    : tf.startsWith('+mn')
      ? fonts.minor
      : undefined
  return resolved !== undefined && resolved.length > 0 ? resolved : undefined
}

/** Where a hyperlink leads, before slide paths are mapped to slide ids. */
export type ParsedHyperlink = { kind: 'url'; href: string } | { kind: 'slide'; slidePath: string }

export interface ParsedSlide {
  /** File name like `slide1.xml` — useful for diagnostics. */
  source: string
  /** Zip path of the slide part (`ppt/slides/slide1.xml`): the target of
   *  slide-jump hyperlinks. Set by `parsePptx`. */
  path?: string
  background: ParsedBackground
  shapes: ParsedShape[]
  /** Speaker notes from the linked `ppt/notesSlides/notesSlideN.xml`: the
   *  notes editor's document (`ooxml/notes.ts`). Missing ⇒ no notes. */
  notes?: NotesDoc
  /** Slide title from `<p:cSld name="…">`. Optional. */
  name?: string
  /** True when the source `<p:sld show="0">` — slide hidden in presenter. */
  skipped?: boolean
  /** The slide's transition (`ooxml/transition.ts`). */
  transition?: SlideTransition
  /** Imported animation steps (`ooxml/timing.ts`). */
  animations?: ParsedAnimationStep[]
  /** Validated fields of a Narrative export's slide extension (`extSchema.ts`). */
  narrative?: Record<string, unknown>
}

/**
 * One animation step extracted from a slide's `<p:timing>` tree. PPTX
 * timing is fundamentally lossier than Narrative's DSL (it's a nested
 * click/withEffect/afterEffect tree with discrete preset IDs); we map
 * each effect to the closest Narrative AnimationPreset + duration +
 * trigger. The target shape's resolved id needs separate plumbing on
 * the writer side because PPTX targets via `spid` (the cNvPr id, an
 * integer) and Narrative targets via the SlideObject.id (nanoid).
 */
export interface ParsedAnimationStep {
  /** PPTX `spid` reference — the integer `<p:cNvPr id>` of the target. */
  spId: number
  preset: AnimationPreset
  trigger: AnimationTrigger
  /** Seconds, as the model stores them. */
  duration: number
  /** Seconds. */
  delay: number
  easing?: string
  params?: Record<string, unknown>
}

export interface ParsedEmbeddedImage {
  /** Zip-internal path, e.g. `ppt/media/image1.png`. Doubles as the lookup key. */
  zipPath: string
  /** Raw bytes pulled out of the .pptx archive. */
  bytes: Buffer
  /** MIME type sniffed from the file's magic header (falls back to extension). */
  mimeType: string
  /** Filename extension WITHOUT the dot (`png` / `jpeg` / `gif` / …). */
  ext: string
}

/**
 * Embedded TrueType / OpenType font extracted from `<p:embeddedFontLst>`.
 * PowerPoint emits one entry per (typeface × variant) combination — a
 * deck that ships Druk Wide in regular + bold + italic + boldItalic
 * produces four entries with the same `typeface` and four different
 * `zipPath`s. The importer uploads each as its own `media_assets` row
 * with `kind='font'` so the renderer's font registry picks up the
 * correct face for the requested weight/style at runtime.
 */
export interface ParsedEmbeddedFont {
  /** Zip-internal path of the font file (e.g. `ppt/fonts/font1.fntdata`). */
  zipPath: string
  /** Raw TrueType / OpenType bytes. Pre-deobfuscated when the source was
   *  flagged as the OOXML `obfuscatedFont` content type. */
  bytes: Buffer
  /** Filename extension WITHOUT the dot — `ttf` / `otf` / `fntdata`. */
  ext: string
  /** Authored typeface name from the `<p:font typeface="…">` attribute.
   *  This is the family name the slide content references. */
  typeface: string
  /** Which variant of the typeface this file represents. PPTX splits a
   *  family into 4 separate variants; collapse to weight + italic flag. */
  variant: 'regular' | 'bold' | 'italic' | 'boldItalic'
}

export interface ParsedPptx {
  /** PPTX slide dimensions in px (96 DPI). */
  slideWidth: number
  slideHeight: number
  slides: ParsedSlide[]
  /** XML elements observed but not in the MVP mapping table. */
  ignoredElements: string[]
  /** Total distinct XML tags observed across all slides. */
  distinctElementCount: number
  /** Embedded images, keyed by their zip path. The importer iterates this
   *  map, uploads each to MinIO, and then patches the matching shape
   *  `imagePath` references with the resulting `assetId`. */
  embeddedImages: Map<string, ParsedEmbeddedImage>
  /** Embedded fonts from `<p:embeddedFontLst>` in ppt/presentation.xml.
   *  Each entry is one typeface × variant cell; importDeck uploads
   *  each as a `kind='font'` media_assets row keyed to the deck. */
  embeddedFonts: ParsedEmbeddedFont[]
}

// ---------------------------------------------------------------------------
// EMU + colour helpers
// ---------------------------------------------------------------------------

/** PPTX uses 914 400 EMU per inch; web is 96 px per inch. */
export const EMU_PER_PX = EMU_PER_SOURCE_PX
export const emuToPx = emuToSourcePx

/** An `<a:xfrm>` / `<p:xfrm>` as the raw integers the extension fingerprints. */
function frameFingerprintOf(xfrm: XmlNode): FrameFingerprint {
  const tagName = getTag(xfrm) ?? 'a:xfrm'
  const kids = getChildren(xfrm, tagName)
  const off = getAttrs(findFirst(kids, 'a:off') ?? {})
  const ext = getAttrs(findFirst(kids, 'a:ext') ?? {})
  const n = (v: unknown): number => {
    const x = Number(v)
    return Number.isFinite(x) ? x : 0
  }
  return {
    x: n(off['@x']),
    y: n(off['@y']),
    cx: n(ext['@cx']),
    cy: n(ext['@cy']),
    rot: n(getAttrs(xfrm)['@rot']),
  }
}

/** PPTX rotations are stored as 60 000ths-of-a-degree integers. */
const PPTX_ROT_PER_DEG = 60000

/** PPTX font sizes are 100ths of a point. 1pt = 1/72 inch ≈ 1.333 px @ 96 DPI. */
const PPTX_FONT_TO_PX = (1 / 100) * (96 / 72)

/**
 * Percentage line spacing (`<a:lnSpc><a:spcPct val="N"/>`) is a multiple of
 * the font's own normal line height — PowerPoint's meaning — and is stored
 * verbatim as `lineSpacing` (N / 100000). The web client resolves it against
 * the measured font. It used to be folded into `lineHeight` with a flat
 * ×1.2, which was only right for fonts whose normal happens to be 1.2 em and
 * left every imported frame a few percent off its PowerPoint height.
 *
 * Table cells are the exception: the table pipeline has no font-metric
 * resolver yet, so cells keep the historical approximation.
 */
const TABLE_CELL_LEADING_APPROX = 1.2

// ---------------------------------------------------------------------------
// Mapping tables (kept in sync with docs/plans/m28-pptx-import-export.md)
// ---------------------------------------------------------------------------

/** Top-level / structural elements we map. */
const MVP_ELEMENTS = new Set<string>([
  'p:sld',
  'p:cSld',
  'p:spTree',
  'p:nvGrpSpPr',
  'p:grpSpPr',
  'p:nvSpPr',
  'p:nvPicPr',
  'p:nvCxnSpPr',
  'p:sp',
  'p:pic',
  'p:cxnSp',
  'p:spPr',
  'a:xfrm',
  'a:off',
  'a:ext',
  'a:prstGeom',
  'a:avLst',
  'a:solidFill',
  'a:srgbClr',
  'a:blipFill',
  'a:blip',
  'a:stretch',
  'a:fillRect',
  'a:ln',
  'a:noFill',
  'p:txBody',
  'a:bodyPr',
  'a:lstStyle',
  'a:p',
  'a:pPr',
  'a:r',
  'a:rPr',
  'a:t',
  'a:endParaRPr',
  'p:cNvPr',
  'p:cNvSpPr',
  'p:cNvPicPr',
  'p:cNvCxnSpPr',
  'a:picLocks',
  'a:spLocks',
  'a:cxnSpLocks',
  'p:bg',
  'p:bgPr',
  'p:bgRef',
  'a:buChar',
  'a:buAutoNum',
  'a:buNone',
  'a:hlinkClick',
  // Line/arrow endpoint markers.
  'a:headEnd',
  'a:tailEnd',
  // Custom path geometry — `<a:custGeom>` and its segments.
  'a:videoFile',
  'a:audioFile',
  // Effects.
  'a:effectLst',
  'a:outerShdw',
  'a:innerShdw',
  'a:blur',
  'a:srcRect',
  // Slide-level: transitions + animations.
  'p:transition',
  'p:fade',
  'p:push',
  'p:cover',
  'p:wipe',
  'p:cube',
  'p:flythrough',
  'p:doors',
  'p:morph',
  'p:none',
  'p:timing',
  'p:tnLst',
  'p:par',
  'p:cTn',
  'p:childTnLst',
  'p:stCondLst',
  'p:cond',
  'p:tgtEl',
  'p:spTgt',
  'p:bldP',
  'p:bldLst',
  'p:set',
  'p:to',
  'p:strVal',
  'p:attrNameLst',
  'p:attrName',
  'p:anim',
  'p:animEffect',
  // Charts — graphic frame envelope + AlternateContent fallback path.
  // The `<c:*>` chart spec itself is not parsed (we use the fallback
  // image instead), but the wrappers should not pollute `ignoredElements`.
  'mc:AlternateContent',
  'mc:Choice',
  'mc:Fallback',
  'c:chart',
  'c:externalData',
  // Text frame fine-grained attrs.
  'a:latin',
  'a:ea',
  'a:cs',
  'a:lnSpc',
  'a:spcBef',
  'a:spcAft',
  'a:spcPct',
  'a:spcPts',
  'a:custGeom',
  'a:pathLst',
  'a:path',
  'a:moveTo',
  'a:lnTo',
  'a:cubicBezTo',
  'a:quadBezTo',
  'a:close',
  'a:pt',
  // Tables — exploded into per-cell rect + text shapes by `parseTable`.
  'p:graphicFrame',
  'p:nvGraphicFramePr',
  'p:cNvGraphicFramePr',
  'p:graphicFramePr',
  'a:graphic',
  'a:graphicData',
  'a:tbl',
  'a:tblPr',
  'a:tblGrid',
  'a:gridCol',
  'a:extLst',
  'a:tr',
  'a:tc',
  'a:tcPr',
  'a:lnL',
  'a:lnR',
  'a:lnT',
  'a:lnB',
])

// ---------------------------------------------------------------------------
// Internal: walk preserveOrder XML trees
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parse one shape (p:sp, p:pic, p:cxnSp)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Master + layout flattening — see `SlideContext` for the full set of artefacts
// we pull off a slide's layout/master chain. The pipeline is built around the
// idea that Narrative has no master/template layer: anything visible on a
// PowerPoint slide (logo on master, accent strip on layout, default text
// colours on `<p:txStyles>`, layout/master background) must be **baked** into
// each Narrative slide. The slide is otherwise a stand-alone artefact.
// ---------------------------------------------------------------------------

/**
 * Default text run styling from a `<a:lvl1pPr>/<a:defRPr>` block. PPTX layers
 * these defaults across:
 *   master `<p:txStyles>/<p:titleStyle|bodyStyle|otherStyle>`
 *     → master/layout placeholder definitions (lvl1pPr inside each `<p:sp>`)
 *     → slide's own `<a:rPr>` on the run
 * We capture each layer separately so the slide-side parser can fall through
 * in priority order when the slide doesn't set something inline.
 */
interface TextStyleDefaults {
  /** PPTX 100ths-of-a-point (consumer multiplies by PPTX_FONT_TO_PX). */
  fontSize100?: number
  color?: number
  colorAlpha?: number
  bold?: boolean
  /** Bullet marker declared at this style layer.
   *    'bullet'   — `<a:buChar char="…">` present
   *    'numbered' — `<a:buAutoNum type="…">` present
   *    'none'     — explicit `<a:buNone/>` — distinguished from "not declared"
   *                 so a higher layer's bullet can be vetoed by a lower layer
   *                 setting buNone. */
  listStyle?: 'bullet' | 'numbered' | 'none'
  /** Default typeface for this style layer, theme references resolved. */
  fontFamily?: string
  /** Line spacing declared by `<a:lvl1pPr>/<a:lnSpc>` at this style layer. */
  lineSpacing?: LineSpacingDecl
  /** Per-level `marL` (EMU), see {@link readLevelMargins}. */
  levelMargins?: Array<number | undefined>
  /** `<a:defRPr spc>`: letter spacing in 100ths of a point. */
  letterSpacing100?: number
  /** `<a:defRPr cap>`. */
  textTransform?: 'none' | 'uppercase' | 'lowercase'
}

/**
 * `<a:lnSpc>` as declared, before it is resolved against a font size.
 *
 * `spcPct` is a multiple of the font's normal line height and maps straight
 * onto `lineSpacing`. `spcPts` is absolute (100ths of a point) and can only
 * become the per-font-size `lineHeight` ratio once the frame's final font
 * size is known — which, for placeholder text, is often inherited from the
 * same layout/master layer or from one below it. Carrying the raw declaration
 * down the inheritance chain and resolving it once at the end keeps the two
 * questions — *which layer wins* and *what the number means* — apart.
 */
type LineSpacingDecl = { kind: 'pct'; value: number } | { kind: 'pts'; value100: number }

/** `<a:spcBef>` / `<a:spcAft>` as px, when given in points (`<a:spcPts>`). */
function readSpacingPts(pPrChildren: XmlNode[], name: 'a:spcBef' | 'a:spcAft'): number | undefined {
  const node = findFirst(pPrChildren, name)
  if (node === undefined) return undefined
  const pts = findFirst(getChildren(node, name), 'a:spcPts')
  if (pts === undefined) return undefined
  const v = Number(getAttrs(pts)['@val'])
  return Number.isFinite(v) ? v * PPTX_FONT_TO_PX : undefined
}

/** `<a:pPr>/<a:defRPr>`: run properties for the runs of one paragraph. */
interface ParagraphRunDefaults {
  color?: number
  colorAlpha?: number
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  letterSpacing?: number
  textTransform?: ParsedShape['textTransform']
  fontFamily?: string
}

/**
 * What one `<a:rPr>` says about its run (or line break), explicit "off"
 * values included: `b="0"` in a bold frame is a non-bold run.
 */
function readRunProperties(
  rPr: XmlNode,
  theme: ThemeColourMap,
  hyperlinkRels: HyperlinkRelMap,
): {
  attrs: Omit<ParsedTextRun, 'text'>
  textTransform: ParsedShape['textTransform']
  ln: XmlNode | undefined
} {
  const attrs: Omit<ParsedTextRun, 'text'> = {}
  const a = getAttrs(rPr)
  const b = readOnOff(a['@b'])
  if (b !== undefined) attrs.bold = b
  const i = readOnOff(a['@i'])
  if (i !== undefined) attrs.italic = i
  if (typeof a['@u'] === 'string') attrs.underline = a['@u'] !== 'none'
  const exact = readRunExt(rPr)
  if (exact.fontWeight !== undefined) attrs.fontWeight = exact.fontWeight
  const sz = Number(a['@sz'])
  if (typeof a['@sz'] === 'string' && Number.isFinite(sz)) attrs.fontSize = sz * PPTX_FONT_TO_PX
  // Letter spacing — `spc` is 100ths of a point (signed).
  const spc = Number(a['@spc'])
  if (typeof a['@spc'] === 'string' && Number.isFinite(spc))
    attrs.letterSpacing = spc * PPTX_FONT_TO_PX
  const cap = a['@cap']
  const textTransform: ParsedShape['textTransform'] =
    cap === 'all' ? 'uppercase' : cap === 'small' ? 'lowercase' : undefined
  const kids = getChildren(rPr, 'a:rPr')
  const solid = findFirst(kids, 'a:solidFill')
  if (solid !== undefined) {
    const c = parseColourAndAlphaFrom(solid, theme)
    if (c !== undefined) {
      attrs.color = c.color
      if (c.alpha !== undefined) attrs.colorAlpha = c.alpha
    }
  }
  // `<a:latin>` names the face; PowerPoint falls back to it when an
  // east-asian / complex-script face (`<a:ea>` / `<a:cs>`) is missing.
  const latinNode = findFirst(kids, 'a:latin')
  if (latinNode !== undefined) {
    const tf = resolveTypeface(getAttrs(latinNode)['@typeface'], theme)
    if (tf !== undefined) attrs.fontFamily = tf
  }
  // A family stack a Narrative export wrote as its first face.
  if (exact.fontFamily !== undefined) attrs.fontFamily = exact.fontFamily
  // `<a:hlinkClick r:id>` → the slide relationship's target URL.
  const hlink = findFirst(kids, 'a:hlinkClick')
  if (hlink !== undefined) {
    const rId = getAttrs(hlink)['@r:id']
    if (typeof rId === 'string') {
      const link = hyperlinkRels.get(rId)
      if (link !== undefined) attrs.hyperlink = link
    }
  }
  return { attrs, textTransform, ln: findFirst(kids, 'a:ln') }
}

/** Fill what a run left unsaid from its paragraph's `<a:defRPr>`. */
function applyParagraphRunDefaults(run: ParsedTextRun, d: ParagraphRunDefaults): void {
  if (run.color === undefined && d.color !== undefined) {
    run.color = d.color
    if (d.colorAlpha !== undefined) run.colorAlpha = d.colorAlpha
  }
  if (run.fontSize === undefined && d.fontSize !== undefined) run.fontSize = d.fontSize
  if (run.bold === undefined && d.bold === true) run.bold = true
  if (run.italic === undefined && d.italic === true) run.italic = true
  if (run.underline === undefined && d.underline === true) run.underline = true
  if (run.letterSpacing === undefined && d.letterSpacing !== undefined)
    run.letterSpacing = d.letterSpacing
  if (run.fontFamily === undefined && d.fontFamily !== undefined) run.fontFamily = d.fontFamily
}

/** Whether a text body's only visible content is a slide-number field. */
function isSlideNumberOnly(paragraphs: XmlNode[]): boolean {
  let field = false
  for (const p of paragraphs) {
    for (const child of getChildren(p, 'a:p')) {
      const t = getTag(child)
      if (t !== 'a:r' && t !== 'a:fld') continue
      if (t === 'a:fld' && getAttrs(child)['@type'] === 'slidenum') {
        field = true
        continue
      }
      const tNode = findFirst(getChildren(child, t), 'a:t')
      const text =
        tNode !== undefined
          ? getChildren(tNode, 'a:t')
              .map((c) => (c as { '#text'?: unknown })['#text'] ?? '')
              .join('')
          : ''
      if (String(text).trim() !== '') return false
    }
  }
  return field
}

/** An OOXML boolean attribute (`1` / `0` / `true` / `false`), undefined when absent. */
function readOnOff(v: unknown): boolean | undefined {
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return undefined
}

/**
 * Read `<a:lnSpc>` from the children of a paragraph-properties node
 * (`<a:pPr>`, `<a:lvl1pPr>`, …). Returns undefined when absent or malformed,
 * so the caller falls through to the next layer.
 */
function readLineSpacingDecl(pPrChildren: XmlNode[]): LineSpacingDecl | undefined {
  const lnSpc = findFirst(pPrChildren, 'a:lnSpc')
  if (lnSpc === undefined) return undefined
  const lnSpcChildren = getChildren(lnSpc, 'a:lnSpc')
  const pct = findFirst(lnSpcChildren, 'a:spcPct')
  if (pct !== undefined) {
    const v = Number(getAttrs(pct)['@val'])
    return Number.isFinite(v) && v > 0 ? { kind: 'pct', value: v / 100000 } : undefined
  }
  const pts = findFirst(lnSpcChildren, 'a:spcPts')
  if (pts !== undefined) {
    const v = Number(getAttrs(pts)['@val'])
    return Number.isFinite(v) && v > 0 ? { kind: 'pts', value100: v } : undefined
  }
  return undefined
}

/**
 * Left margin (`marL`, EMU) declared for each outline level — index 0 is
 * `<a:lvl1pPr>`, 8 is `<a:lvl9pPr>` — by a list-style container
 * (`<a:lstStyle>`, `<p:titleStyle>`, `<a:defaultTextStyle>`, …). A level the
 * container does not mention, or mentions without `marL`, is undefined so the
 * next layer down can answer it.
 *
 * This is what a paragraph's `lvl` actually does in PowerPoint: it selects
 * the level whose margin (and bullet, size, …) applies. On a paragraph with
 * no bullet the margin is the level's only visible effect.
 */
function readLevelMargins(containerChildren: XmlNode[]): Array<number | undefined> {
  const out: Array<number | undefined> = []
  for (let n = 1; n <= 9; n++) {
    const lvl = findFirst(containerChildren, `a:lvl${n}pPr`)
    const raw = lvl !== undefined ? getAttrs(lvl)['@marL'] : undefined
    const v = typeof raw === 'string' ? Number(raw) : Number.NaN
    out.push(Number.isFinite(v) ? v : undefined)
  }
  return out
}

/** First defined margin for `levelIndex` across layers, most specific first. */
function firstLevelMargin(
  levelIndex: number,
  layers: Array<Array<number | undefined> | undefined>,
): number | undefined {
  for (const layer of layers) {
    const v = layer?.[levelIndex]
    if (v !== undefined) return v
  }
  return undefined
}

/**
 * Master-level text style buckets keyed by placeholder family. PowerPoint
 * routes `title|ctrTitle` to `title`, `body|subTitle` to `body`, everything
 * else (`obj` / `chart` / `tbl` / …) to `other`.
 */
interface TxStylesByBucket {
  title?: TextStyleDefaults
  body?: TextStyleDefaults
  other?: TextStyleDefaults
}

/**
 * Geometry + default text styling for a placeholder (`<p:ph>`) declared in a
 * slide layout or master. Used to fill in `<a:xfrm>` (and text properties)
 * when the slide itself doesn't override them — the common case for
 * "title" / "body" / "subTitle" text frames the user types into but never
 * styles directly.
 */
interface PlaceholderEntry {
  /** All in EMU, matching the source XML so the caller can apply emuToPx. */
  x: number
  y: number
  width: number
  height: number
  /** True only when the source `<p:sp>` actually carried `<a:xfrm>` with both
   *  `<a:off>` and `<a:ext>`. A layout placeholder routinely omits its
   *  geometry and inherits the master's, so "absent" has to be told apart
   *  from a legitimately declared 0 — otherwise the layout entry shadows the
   *  master's real box and the frame collapses to 0×0. */
  hasGeometry?: boolean
  /** Default typeface from `<a:lstStyle>/<a:lvl1pPr>/<a:defRPr>/<a:latin>`,
   *  with theme references (`+mn-lt`) already resolved. */
  defaultFontFamily?: string
  /** Default paragraph alignment from `<a:lstStyle>/<a:lvl1pPr algn="…">`. */
  textAlign?: 'left' | 'center' | 'right' | 'justify'
  /** Default font size from `<a:lstStyle>/<a:lvl1pPr>/<a:defRPr sz="…">`,
   *  expressed in PPTX 100ths of a point. */
  defaultFontSize100?: number
  /** Default vertical anchor from `<a:bodyPr anchor="…">` on the placeholder. */
  bodyAnchor?: 'top' | 'middle' | 'bottom'
  /** `<a:bodyPr wrap="…">` on the placeholder — a master's slide-number box
   *  declares `none` there and every slide's copy inherits it. */
  bodyWrap?: 'none' | 'square'
  /** `<a:bodyPr lIns/tIns/rIns/bIns>` on the placeholder (EMU), per side. */
  bodyInsets?: Partial<BodyInsets>
  /** Default run colour from `<a:lvl1pPr>/<a:defRPr>/<a:solidFill>`. */
  defaultColor?: number
  defaultColorAlpha?: number
  /** Default bold flag from `<a:lvl1pPr>/<a:defRPr b="1">`. */
  defaultBold?: boolean
  /** Default text transform from `<a:lvl1pPr>/<a:defRPr cap="all|small">`.
   *  Inherited by slide shapes whose own runs don't specify cap. Drives
   *  the "title is always uppercase" pattern PowerPoint templates use. */
  defaultTextTransform?: 'uppercase' | 'lowercase'
  /** Default letter spacing from `<a:lvl1pPr>/<a:defRPr spc>`, 100ths of a point. */
  defaultLetterSpacing100?: number
  /** Bullet marker from `<a:lvl1pPr>` (`<a:buChar>` / `<a:buAutoNum>` /
   *  `<a:buNone>`). 'none' = explicitly suppressed; missing = not declared. */
  defaultListStyle?: 'bullet' | 'numbered' | 'none'
  /** Line spacing from `<a:lstStyle>/<a:lvl1pPr>/<a:lnSpc>`. A slide that
   *  restyles the placeholder's size in its own `lvl1pPr` still inherits
   *  this unless it declares an `lnSpc` of its own. */
  defaultLineSpacing?: LineSpacingDecl
  /** Per-level `marL` (EMU) from the placeholder's `<a:lstStyle>`. */
  levelMargins?: Array<number | undefined>
  /**
   * The placeholder's own `<p:spPr>` fill. A slide shape bound to this
   * placeholder that declares no fill of its own inherits it, as PowerPoint
   * does — the Proseware deck's black corner mark is a body placeholder whose
   * slide copy carries only the path, the black living on the layout.
   */
  fill?: PlaceholderFill
  /** Placeholder type declared on the source `<p:ph type="…">`. Used by the
   *  txStyles bucket lookup so a slide-side title placeholder that ends up
   *  matching an `idx`-only master entry still routes to `titleStyle`. */
  phType?: string
}

/** A placeholder's declared fill: a colour, a gradient, or explicitly none. */
type PlaceholderFill =
  | { kind: 'solid'; color: number; alpha?: number }
  | { kind: 'gradient'; gradient: ParsedGradient }
  | { kind: 'none' }

/**
 * Per-slide bundle of everything inherited from the layout/master chain.
 * Built once in `buildSlideContexts` and consumed by `parseSlide`. Keeping
 * the chain resolution out of `parseSlide` lets us cache layout/master parse
 * results across slides that share them.
 */
interface SlideContext {
  placeholders: PlaceholderMap
  /** Master non-placeholder shapes (logo, decorations) — paint FIRST. */
  masterShapes: ParsedShape[]
  /** Layout non-placeholder shapes — paint SECOND, above master, below slide. */
  layoutShapes: ParsedShape[]
  /** Slide's `<p:bg>` falls through to this when absent. */
  fallbackBackground: ParsedBackground
  /** Master `<p:txStyles>` buckets — final fallback for placeholder text. */
  txStyles: TxStylesByBucket
}

/**
 * Two-key indexed placeholder lookup. We index every placeholder by both its
 * `type` and its `idx` attribute (when set) because pptx authors are sloppy:
 * sometimes a slide refs by type alone, sometimes by idx alone, sometimes
 * both. Either key resolves to the same entry. The unkeyed `__any__` slot
 * holds the first placeholder we see, as a last-ditch fallback.
 */
type PlaceholderMap = Map<string, PlaceholderEntry>

/**
 * Layer a layout placeholder on top of the master's, field by field.
 *
 * Geometry moves as one unit (a box is only meaningful whole) and is taken
 * from the layout only when it actually declared `<a:xfrm>` — see
 * `PlaceholderEntry.hasGeometry`. Every text default falls back to the
 * master's when the layout leaves it undefined.
 */
function mergePlaceholderEntries(
  master: PlaceholderEntry,
  layout: PlaceholderEntry,
): PlaceholderEntry {
  const geometry = layout.hasGeometry === true ? layout : master
  const merged: PlaceholderEntry = {
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
  }
  if (geometry.hasGeometry === true) merged.hasGeometry = true
  const pick = <K extends keyof PlaceholderEntry>(key: K): void => {
    const value = layout[key] ?? master[key]
    if (value !== undefined) merged[key] = value
  }
  pick('textAlign')
  pick('defaultFontSize100')
  pick('defaultFontFamily')
  pick('bodyAnchor')
  pick('bodyWrap')
  // Per side: a layout that sets one inset still inherits the master's others.
  if (layout.bodyInsets !== undefined || master.bodyInsets !== undefined) {
    merged.bodyInsets = { ...master.bodyInsets, ...layout.bodyInsets }
  }
  pick('defaultColor')
  pick('defaultColorAlpha')
  pick('defaultBold')
  pick('defaultTextTransform')
  pick('defaultLetterSpacing100')
  pick('defaultListStyle')
  pick('defaultLineSpacing')
  pick('fill')
  pick('phType')
  // Per level, not per list: a layout that restyles level 1 still inherits
  // the master's level-2 margin.
  if (layout.levelMargins !== undefined || master.levelMargins !== undefined) {
    merged.levelMargins = Array.from({ length: 9 }, (_, i) =>
      firstLevelMargin(i, [layout.levelMargins, master.levelMargins]),
    )
  }
  return merged
}

function placeholderKey(type: string | undefined, idx: string | undefined): string {
  if (type !== undefined && idx !== undefined) return `t:${type}+i:${idx}`
  if (type !== undefined) return `t:${type}`
  if (idx !== undefined) return `i:${idx}`
  return '__any__'
}

/** `<a:pPr algn>` through the shared vocabulary (justified text renders left-aligned). */
function mapAlgn(raw: string): 'left' | 'center' | 'right' {
  return ALIGN.fromXml(raw) ?? 'left'
}

/** `<a:custGeom>` anchors in slide-local source px (`ooxml/shapes.ts` reads it). */
function parseCustGeomAnchors(
  custGeom: XmlNode,
  shapeWidthPx: number,
  shapeHeightPx: number,
  shapeXPx: number,
  shapeYPx: number,
): { anchors: ParsedPathAnchor[]; closed: boolean } {
  return readCustGeom(custGeom, {
    x: shapeXPx,
    y: shapeYPx,
    width: shapeWidthPx,
    height: shapeHeightPx,
  })
}

/**
 * Detect a bullet declaration inside a `<a:pPr>` / `<a:lvl1pPr>` node.
 * Returns 'bullet' for `<a:buChar>`, 'numbered' for `<a:buAutoNum>`, 'none'
 * for explicit `<a:buNone>`, undefined when no declaration is present. The
 * caller distinguishes "explicit none" from "missing" so a higher-priority
 * layer's bullet can be suppressed by a lower-priority layer's `<a:buNone>`.
 */
function detectBulletDecl(
  pPrLike: XmlNode,
  tag: string,
): 'bullet' | 'numbered' | 'none' | undefined {
  const children = getChildren(pPrLike, tag)
  for (const ch of children) {
    const t = getTag(ch)
    if (t === 'a:buNone') return 'none'
    if (t === 'a:buChar') return 'bullet'
    if (t === 'a:buAutoNum') return 'numbered'
  }
  return undefined
}

/**
 * OOXML `<a:buAutoNum type="…">` token → Narrative {@link ListNumberFormat}.
 * Covers the period + right-paren variants we round-trip; the two-sided
 * `arabicParenBoth` (e.g. `(1)`) collapses to `decimalParen` since Narrative
 * models only a trailing delimiter. Unknown / unmapped tokens fall back to
 * `decimal` so an exotic numbering scheme still imports as an ordered list.
 */
/** `<a:buAutoNum type>` through the shared vocabulary; an unknown type numbers 1. 2. 3. */
function mapBuAutoNumType(raw: string | undefined): ListNumberFormat {
  return (raw !== undefined ? AUTONUM.fromXml(raw) : undefined) ?? 'decimal'
}

/**
 * A fully-detailed bullet declaration extracted from a `<a:pPr>` /
 * `<a:lvlNpPr>` node. Distinct from {@link detectBulletDecl} (which only
 * returns the coarse kind) — this carries the glyph / autonum format /
 * startAt so the per-paragraph importer can populate {@link ParagraphAttrs}
 * with full fidelity. `kind === 'none'` is an explicit `<a:buNone/>` that
 * vetoes an inherited bullet; `undefined` means "no declaration here".
 */
interface BulletDecl {
  kind: 'bullet' | 'numbered' | 'none'
  /** Glyph from `<a:buChar char="…">` (bullet kind only). */
  bulletChar?: string
  /** Mapped format from `<a:buAutoNum type="…">` (numbered kind only). */
  numberFormat?: ListNumberFormat
  /** `<a:buAutoNum startAt="N">` when present and ≥ 1 (numbered kind only). */
  startAt?: number
}

/**
 * Like {@link detectBulletDecl} but returns the full declaration (glyph /
 * autonum format / startAt) rather than just the coarse kind. First matching
 * child wins (buNone / buChar / buAutoNum are mutually exclusive in valid
 * OOXML).
 */
function extractBulletDecl(pPrLike: XmlNode, tag: string): BulletDecl | undefined {
  for (const ch of getChildren(pPrLike, tag)) {
    const t = getTag(ch)
    if (t === 'a:buNone') return { kind: 'none' }
    if (t === 'a:buChar') {
      const ch2 = getAttrs(ch)['@char']
      const out: BulletDecl = { kind: 'bullet' }
      if (typeof ch2 === 'string' && ch2.length > 0) out.bulletChar = ch2
      return out
    }
    if (t === 'a:buAutoNum') {
      const a = getAttrs(ch)
      const out: BulletDecl = {
        kind: 'numbered',
        numberFormat: mapBuAutoNumType(
          typeof a['@type'] === 'string' ? (a['@type'] as string) : undefined,
        ),
      }
      const startRaw = a['@startAt']
      if (typeof startRaw === 'string') {
        const n = Number(startRaw)
        if (Number.isFinite(n) && n >= 1) out.startAt = Math.floor(n)
      }
      return out
    }
  }
  return undefined
}

/** Read the `lvl` attribute off a `<a:pPr>` and clamp to 0..MAX_LIST_LEVEL. */
function readParagraphLevel(pPr: XmlNode | undefined): number {
  if (pPr === undefined) return 0
  const raw = getAttrs(pPr)['@lvl']
  if (typeof raw !== 'string') return 0
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_LIST_LEVEL, Math.floor(n))
}

/** `<a:bodyPr anchor>` through the shared vocabulary. */
function mapBodyAnchor(raw: string): 'top' | 'middle' | 'bottom' | undefined {
  return ANCHOR.fromXml(raw)
}

/** Non-visual wrapper element for each shape tag that can carry `<p:ph>`. */
const NV_WRAPPER_BY_SHAPE_TAG: Record<string, string> = {
  'p:sp': 'p:nvSpPr',
  'p:pic': 'p:nvPicPr',
  'p:cxnSp': 'p:nvCxnSpPr',
  'p:graphicFrame': 'p:nvGraphicFramePr',
}

/**
 * The shape's `<p:ph>` node (`<nvXxxPr>/<p:nvPr>/<p:ph>`), or undefined when
 * it is not a placeholder. Every shape type has its own non-visual wrapper —
 * `<p:pic>` uses `<p:nvPicPr>`, not `<p:nvSpPr>` — so reading only the
 * `<p:sp>` spelling silently treats a picture placeholder as a free shape
 * and drops the geometry it should inherit from its layout.
 */
function findPlaceholderNode(shape: XmlNode, shapeTag: string): XmlNode | undefined {
  const nvTag = NV_WRAPPER_BY_SHAPE_TAG[shapeTag]
  if (nvTag === undefined) return undefined
  const nv = findFirst(getChildren(shape, shapeTag), nvTag)
  if (nv === undefined) return undefined
  const nvPr = findFirst(getChildren(nv, nvTag), 'p:nvPr')
  if (nvPr === undefined) return undefined
  return findFirst(getChildren(nvPr, 'p:nvPr'), 'p:ph')
}

/** Walk a slide/layout/master XML and extract every `<p:sp>` / `<p:pic>`
 *  that has a `<p:ph>` non-visual node. Returns a map keyed by (type, idx). */
function collectPlaceholders(xml: string, theme: ThemeColourMap): PlaceholderMap {
  const xmlParser = ooxmlParser({ trimValues: false })
  const tree = xmlParser.parse(xml) as XmlNode[]
  const map: PlaceholderMap = new Map()

  // Find spTree (could be under p:sld, p:sldLayout, or p:sldMaster).
  let spTreeChildren: XmlNode[] | null = null
  for (const node of walk(tree)) {
    if (getTag(node) === 'p:spTree') {
      spTreeChildren = getChildren(node, 'p:spTree')
      break
    }
  }
  if (spTreeChildren === null) return map

  for (const sp of spTreeChildren) {
    // A picture placeholder may be declared as a `<p:sp>` (what PowerPoint
    // writes into layouts) or as a `<p:pic>` (what Keynote and some
    // generators write); both carry the same `<p:ph>` under their own
    // non-visual wrapper.
    const spTag = getTag(sp)
    if (spTag !== 'p:sp' && spTag !== 'p:pic') continue
    const spChildren = getChildren(sp, spTag)

    const ph = findPlaceholderNode(sp, spTag)
    if (!ph) continue

    const phAttrs = getAttrs(ph)
    const type = typeof phAttrs['@type'] === 'string' ? (phAttrs['@type'] as string) : undefined
    const idx = typeof phAttrs['@idx'] === 'string' ? (phAttrs['@idx'] as string) : undefined

    // Geometry from spPr.xfrm — optional. A master/layout placeholder can omit
    // its own `<a:xfrm>` and still carry text-style defaults that the slide
    // wants to inherit; we record the entry either way and only skip the
    // geometry portion when there's no xfrm.
    const entry: PlaceholderEntry = { x: 0, y: 0, width: 0, height: 0 }
    if (type !== undefined) entry.phType = type

    const spPr = findFirst(spChildren, 'p:spPr')
    if (spPr) {
      const spPrKids = getChildren(spPr, 'p:spPr')
      const solid = findFirst(spPrKids, 'a:solidFill')
      const grad = findFirst(spPrKids, 'a:gradFill')
      if (solid !== undefined) {
        const c = parseColourAndAlphaFrom(solid, theme)
        if (c !== undefined) {
          entry.fill =
            c.alpha !== undefined
              ? { kind: 'solid', color: c.color, alpha: c.alpha }
              : { kind: 'solid', color: c.color }
        }
      } else if (grad !== undefined) {
        const g = parseGradient(grad, theme)
        if (g !== undefined) entry.fill = { kind: 'gradient', gradient: g }
      } else if (findFirst(spPrKids, 'a:noFill') !== undefined) {
        entry.fill = { kind: 'none' }
      }
      const xfrm = findFirst(getChildren(spPr, 'p:spPr'), 'a:xfrm')
      if (xfrm) {
        const xfrmChildren = getChildren(xfrm, 'a:xfrm')
        const off = findFirst(xfrmChildren, 'a:off')
        const ext = findFirst(xfrmChildren, 'a:ext')
        if (off && ext) {
          const offAttrs = getAttrs(off)
          const extAttrs = getAttrs(ext)
          entry.x = Number(offAttrs['@x'] ?? 0)
          entry.y = Number(offAttrs['@y'] ?? 0)
          entry.width = Number(extAttrs['@cx'] ?? 0)
          entry.height = Number(extAttrs['@cy'] ?? 0)
          entry.hasGeometry = true
        }
      }
    }

    // Default text styling: look in <p:txBody>/<a:lstStyle>/<a:lvl1pPr ...>
    // for `algn` (paragraph alignment) and `<a:defRPr sz="…">/<a:solidFill>`
    // (font size + colour), plus the placeholder's bodyPr `anchor` (vertical
    // alignment). Picks up both layout-side and master-side defaults; the
    // builder layers master under layout so layout wins.
    const txBody = findFirst(spChildren, 'p:txBody')
    if (txBody) {
      const txBodyChildren = getChildren(txBody, 'p:txBody')
      const bodyPr = findFirst(txBodyChildren, 'a:bodyPr')
      if (bodyPr) {
        const anchor = getAttrs(bodyPr)['@anchor']
        if (typeof anchor === 'string') {
          const va = mapBodyAnchor(anchor)
          if (va !== undefined) entry.bodyAnchor = va
        }
        const wrap = getAttrs(bodyPr)['@wrap']
        if (wrap === 'none' || wrap === 'square') entry.bodyWrap = wrap
        const insets = readBodyInsets(bodyPr)
        if (Object.keys(insets).length > 0) entry.bodyInsets = insets
      }
      const lstStyle = findFirst(txBodyChildren, 'a:lstStyle')
      if (lstStyle) {
        const margins = readLevelMargins(getChildren(lstStyle, 'a:lstStyle'))
        if (margins.some((m) => m !== undefined)) entry.levelMargins = margins
        const lvl1 = findFirst(getChildren(lstStyle, 'a:lstStyle'), 'a:lvl1pPr')
        if (lvl1) {
          const algn = getAttrs(lvl1)['@algn']
          if (typeof algn === 'string') {
            entry.textAlign = mapAlgn(algn)
          }
          const bullet = detectBulletDecl(lvl1, 'a:lvl1pPr')
          if (bullet !== undefined) entry.defaultListStyle = bullet
          const lineSpacing = readLineSpacingDecl(getChildren(lvl1, 'a:lvl1pPr'))
          if (lineSpacing !== undefined) entry.defaultLineSpacing = lineSpacing
          const defRPr = findFirst(getChildren(lvl1, 'a:lvl1pPr'), 'a:defRPr')
          if (defRPr) {
            const defAttrs = getAttrs(defRPr)
            const sz = defAttrs['@sz']
            if (typeof sz === 'string') entry.defaultFontSize100 = Number(sz)
            if (defAttrs['@b'] === '1' || defAttrs['@b'] === 'true') entry.defaultBold = true
            // `cap="all"` on the layout/master `<a:defRPr>` is how templates
            // express "this placeholder is always uppercase". Inherited by
            // any slide shape whose runs don't override it.
            const dcap = defAttrs['@cap']
            if (dcap === 'all') entry.defaultTextTransform = 'uppercase'
            else if (dcap === 'small') entry.defaultTextTransform = 'lowercase'
            const dspc = Number(defAttrs['@spc'])
            if (typeof defAttrs['@spc'] === 'string' && Number.isFinite(dspc))
              entry.defaultLetterSpacing100 = dspc
            // Default typeface for this placeholder. Templates overwhelmingly
            // express it as a theme reference (`+mn-lt`), which resolveTypeface
            // maps onto the theme's real font name.
            const phLatin = findFirst(getChildren(defRPr, 'a:defRPr'), 'a:latin')
            if (phLatin !== undefined) {
              const tf = resolveTypeface(getAttrs(phLatin)['@typeface'], theme)
              if (tf !== undefined) entry.defaultFontFamily = tf
            }
            // Run colour is inside `<a:defRPr>`'s subtree as `<a:solidFill>`.
            const defRPrChildren = getChildren(defRPr, 'a:defRPr')
            const dfSolid = findFirst(defRPrChildren, 'a:solidFill')
            if (dfSolid) {
              const c = parseColourAndAlphaFrom(dfSolid, theme)
              if (c !== undefined) {
                entry.defaultColor = c.color
                if (c.alpha !== undefined) entry.defaultColorAlpha = c.alpha
              }
            }
          }
        }
      }
    }

    // Index under every applicable key so lookup tolerates type-only,
    // idx-only, and combined refs.
    if (type !== undefined && idx !== undefined) {
      map.set(`t:${type}+i:${idx}`, entry)
      map.set(`t:${type}`, entry)
      map.set(`i:${idx}`, entry)
    } else if (type !== undefined) {
      map.set(`t:${type}`, entry)
    } else if (idx !== undefined) {
      map.set(`i:${idx}`, entry)
    }
    if (!map.has('__any__')) map.set('__any__', entry)
  }
  return map
}

/**
 * Walk a slide/layout/master XML and parse every shape on its `<p:spTree>`
 * that DOES NOT carry a `<p:ph>` non-visual node — i.e. everything that is
 * NOT a placeholder definition. These are the static decorative shapes
 * (logos, footer lines, accent blocks) that PowerPoint composites onto every
 * slide that uses the layout/master. Narrative has no concept of a master,
 * so we bake them into each slide as regular objects.
 *
 * Image rels are resolved against the XML file's own `_rels` companion so
 * `<a:blip r:embed>` references on master/layout shapes point at the right
 * zip path (each XML has its own rels namespace).
 */
function parseNonPlaceholderShapes(
  xml: string,
  theme: ThemeColourMap,
  imageRels: ImageRelMap,
): ParsedShape[] {
  const xmlParser = ooxmlParser({ trimValues: false })
  const tree = xmlParser.parse(xml) as XmlNode[]

  // Find spTree (under p:sld / p:sldLayout / p:sldMaster).
  let spTreeChildren: XmlNode[] | null = null
  for (const node of walk(tree)) {
    if (getTag(node) === 'p:spTree') {
      spTreeChildren = getChildren(node, 'p:spTree')
      break
    }
  }
  if (spTreeChildren === null) return []

  const shapes: ParsedShape[] = []
  for (const node of spTreeChildren) {
    const tag = getTag(node)
    if (tag !== 'p:sp' && tag !== 'p:pic' && tag !== 'p:cxnSp') continue

    // Skip a shape with a `<p:ph>` child — that's a placeholder definition,
    // not a paintable shape (PowerPoint shows an empty layout placeholder
    // only as an editing prompt, never on the slide). Slides override
    // placeholders by carrying their own shape with a matching `<p:ph>`,
    // handled by the placeholder-inheritance path. A picture placeholder
    // can be a `<p:pic>`, so this applies to every shape tag.
    if (findPlaceholderNode(node, tag) !== undefined) continue

    // Baked shapes don't participate in placeholder inheritance — they have
    // their own concrete spPr/xfrm. Pass an empty placeholder map.
    const shape = parseShape(node, tag, theme, new Map(), imageRels)
    if (shape !== null) pushWithGeometry(shapes, shape)
  }
  return shapes
}

/**
 * Parse a master's `<p:txStyles>` block into title/body/other run-style
 * defaults. PowerPoint uses these as the **final** fallback when a slide's
 * placeholder text has no inline run colour / size / bold and the matched
 * layout/master placeholder definition didn't set them either.
 *
 * Returns an empty bucket map when `<p:txStyles>` is absent (which is the
 * case for layouts — only the master defines it).
 */
function parseTxStyles(xml: string, theme: ThemeColourMap): TxStylesByBucket {
  const xmlParser = ooxmlParser()
  const tree = xmlParser.parse(xml) as XmlNode[]
  const out: TxStylesByBucket = {}

  for (const node of walk(tree)) {
    if (getTag(node) !== 'p:txStyles') continue
    const txChildren = getChildren(node, 'p:txStyles')
    for (const styleNode of txChildren) {
      const tag = getTag(styleNode)
      let bucket: keyof TxStylesByBucket | null = null
      if (tag === 'p:titleStyle') bucket = 'title'
      else if (tag === 'p:bodyStyle') bucket = 'body'
      else if (tag === 'p:otherStyle') bucket = 'other'
      if (bucket === null || tag === null) continue

      const styleChildren = getChildren(styleNode, tag)
      const lvl1 = findFirst(styleChildren, 'a:lvl1pPr')
      if (!lvl1) continue

      const defaults: TextStyleDefaults = {}
      const margins = readLevelMargins(styleChildren)
      if (margins.some((m) => m !== undefined)) defaults.levelMargins = margins
      const bullet = detectBulletDecl(lvl1, 'a:lvl1pPr')
      if (bullet !== undefined) defaults.listStyle = bullet
      const lineSpacing = readLineSpacingDecl(getChildren(lvl1, 'a:lvl1pPr'))
      if (lineSpacing !== undefined) defaults.lineSpacing = lineSpacing

      const defRPr = findFirst(getChildren(lvl1, 'a:lvl1pPr'), 'a:defRPr')
      if (defRPr) {
        const defAttrs = getAttrs(defRPr)
        const sz = defAttrs['@sz']
        if (typeof sz === 'string') defaults.fontSize100 = Number(sz)
        if (defAttrs['@b'] === '1' || defAttrs['@b'] === 'true') defaults.bold = true
        const spc = Number(defAttrs['@spc'])
        if (typeof defAttrs['@spc'] === 'string' && Number.isFinite(spc))
          defaults.letterSpacing100 = spc
        const cap = defAttrs['@cap']
        if (typeof cap === 'string')
          defaults.textTransform =
            cap === 'all' ? 'uppercase' : cap === 'small' ? 'lowercase' : 'none'
        const dfChildren = getChildren(defRPr, 'a:defRPr')
        // Master txStyles is where a template usually states its typeface,
        // as a `+mn-lt` / `+mj-lt` theme reference.
        const dfLatin = findFirst(dfChildren, 'a:latin')
        if (dfLatin !== undefined) {
          const tf = resolveTypeface(getAttrs(dfLatin)['@typeface'], theme)
          if (tf !== undefined) defaults.fontFamily = tf
        }
        const dfSolid = findFirst(dfChildren, 'a:solidFill')
        if (dfSolid) {
          const c = parseColourAndAlphaFrom(dfSolid, theme)
          if (c !== undefined) {
            defaults.color = c.color
            if (c.alpha !== undefined) defaults.colorAlpha = c.alpha
          }
        }
      }
      // Only record the bucket if it carries something usable — a totally
      // empty <p:titleStyle/> would otherwise zero out useful defaults from
      // future merges (currently we only have master txStyles, so this is
      // defensive against hand-written / partial XML in the wild).
      if (
        defaults.fontSize100 !== undefined ||
        defaults.color !== undefined ||
        defaults.bold === true ||
        defaults.listStyle !== undefined ||
        defaults.fontFamily !== undefined ||
        defaults.lineSpacing !== undefined ||
        defaults.levelMargins !== undefined ||
        defaults.letterSpacing100 !== undefined ||
        defaults.textTransform !== undefined
      ) {
        out[bucket] = defaults
      }
    }
    break // first <p:txStyles> wins; master has at most one
  }

  return out
}

/**
 * Build the per-slide hyperlink rels map (rel-id → URL string). PPTX
 * stamps `<a:hlinkClick r:id="rIdN"/>` on a run; rIdN maps to a
 * `…/hyperlink` Relationship whose Target IS the URL (TargetMode="External").
 *
 * Returns an empty map when the slide has no rels file or no hyperlink
 * relationships — `parseShape` then silently skips emitting `hyperlink`
 * on the parsed runs.
 */
async function loadHyperlinkRels(zip: JSZip, xmlPath: string): Promise<HyperlinkRelMap> {
  const dir = xmlPath.substring(0, xmlPath.lastIndexOf('/'))
  const file = xmlPath.substring(xmlPath.lastIndexOf('/') + 1)
  const relsPath = `${dir}/_rels/${file}.rels`
  const relsEntry = zip.file(relsPath)
  const rels: HyperlinkRelMap = new Map()
  if (relsEntry === null) return rels

  const xmlParser = ooxmlParser()
  const tree = xmlParser.parse(await relsEntry.async('string')) as XmlNode[]
  for (const node of walk(tree)) {
    if (getTag(node) !== 'Relationship') continue
    const a = getAttrs(node)
    const id = a['@Id']
    const target = a['@Target']
    const type = a['@Type']
    if (typeof id !== 'string' || typeof target !== 'string' || typeof type !== 'string') continue
    // External hyperlinks have TargetMode="External"; the Target is the
    // literal URL.
    if (type.endsWith('/hyperlink')) rels.set(id, { kind: 'url', href: target })
    // A jump to another slide (`action="ppaction://hlinksldjump"`) points
    // at that slide's part; the writer maps it to the imported slide's id.
    else if (type.endsWith('/slide'))
      rels.set(id, { kind: 'slide', slidePath: resolveRelPath(dir, target) })
  }
  return rels
}

/**
 * Build the per-file image-relationship map used by `parseShape` /
 * `parseBackground` to resolve `<a:blip r:embed>` refs to zip paths. Each
 * XML file (slide/layout/master) carries its own `_rels/<name>.rels`.
 */
async function loadImageRels(zip: JSZip, xmlPath: string): Promise<ImageRelMap> {
  const dir = xmlPath.substring(0, xmlPath.lastIndexOf('/'))
  const file = xmlPath.substring(xmlPath.lastIndexOf('/') + 1)
  const relsPath = `${dir}/_rels/${file}.rels`
  const relsEntry = zip.file(relsPath)
  const rels: ImageRelMap = new Map()
  if (relsEntry === null) return rels

  const xmlParser = ooxmlParser()
  const tree = xmlParser.parse(await relsEntry.async('string')) as XmlNode[]
  for (const node of walk(tree)) {
    if (getTag(node) !== 'Relationship') continue
    const a = getAttrs(node)
    const id = a['@Id']
    const target = a['@Target']
    const type = a['@Type']
    if (
      typeof id === 'string' &&
      typeof target === 'string' &&
      typeof type === 'string' &&
      // Same rel map carries image + video + audio refs since each shape
      // references rel ids by their schema-typed parent element
      // (`<a:blip r:embed>` only sees image rels, `<a:videoFile r:embed>`
      // only sees video rels in practice). Cross-type collisions don't
      // happen — pptxgenjs / PowerPoint never re-use a rel id across
      // types in the same .rels file.
      (type.endsWith('/image') || type.endsWith('/video') || type.endsWith('/audio'))
    ) {
      rels.set(id, resolveRelPath(dir, target))
    }
  }
  return rels
}

/**
 * Read the `<p:sld>` / `<p:sldLayout>` element's `showMasterSp` attribute.
 * Default is `true` per OOXML spec — only `0` / `"false"` opts out. Used to
 * gate whether master shapes get baked onto a slide.
 */
function readShowMasterSp(xml: string, rootTag: 'p:sld' | 'p:sldLayout'): boolean {
  const xmlParser = ooxmlParser()
  const tree = xmlParser.parse(xml) as XmlNode[]
  const root = findFirst(tree, rootTag)
  if (!root) return true
  const v = getAttrs(root)[`@showMasterSp`]
  if (v === '0' || v === 'false') return false
  return true
}

/**
 * Per-XML cache entry — parsed once, shared across slides. PPTX decks
 * typically have many slides referencing the same layout, and many layouts
 * referencing the same master, so caching is a real win for big decks.
 */
interface LayoutMasterCacheEntry {
  placeholders: PlaceholderMap
  shapes: ParsedShape[]
  background: ParsedBackground
  /** Only set on the master entry. */
  txStyles?: TxStylesByBucket
  /** showMasterSp attribute on `<p:sldLayout>` (master entries leave this true). */
  showMasterSp: boolean
}

/**
 * Build a per-slide `SlideContext` (placeholder map + baked master/layout
 * shapes + fallback bg + txStyles). Caches layout/master parse results so
 * repeated references don't re-parse.
 */
async function buildSlideContexts(
  zip: JSZip,
  slidePaths: string[],
  theme: ThemeColourMap,
  imagePathSink: Set<string>,
): Promise<Map<string, SlideContext>> {
  const xmlParser = ooxmlParser()

  const layoutCache = new Map<string, LayoutMasterCacheEntry>()
  const masterCache = new Map<string, LayoutMasterCacheEntry>()

  async function loadLayoutOrMaster(
    xmlPath: string,
    kind: 'layout' | 'master',
  ): Promise<LayoutMasterCacheEntry> {
    const cache = kind === 'layout' ? layoutCache : masterCache
    const cached = cache.get(xmlPath)
    if (cached !== undefined) return cached

    const entry = zip.file(xmlPath)
    const empty: LayoutMasterCacheEntry = {
      placeholders: new Map(),
      shapes: [],
      background: { kind: 'none' },
      showMasterSp: true,
    }
    if (entry === null) {
      cache.set(xmlPath, empty)
      return empty
    }
    const xml = await entry.async('string')
    const imageRels = await loadImageRels(zip, xmlPath)

    // Parse the layout/master XML into a root tree once and reuse for
    // placeholders + shapes + background.
    const tree = xmlParser.parse(xml) as XmlNode[]
    const rootTag = kind === 'layout' ? 'p:sldLayout' : 'p:sldMaster'
    const root = findFirst(tree, rootTag)
    const rootChildren = root ? getChildren(root, rootTag) : []

    const placeholders = collectPlaceholders(xml, theme)
    const shapes = parseNonPlaceholderShapes(xml, theme, imageRels)
    const background = parseBackground(rootChildren, theme, imageRels)
    const result: LayoutMasterCacheEntry = {
      placeholders,
      shapes,
      background,
      showMasterSp: kind === 'layout' ? readShowMasterSp(xml, 'p:sldLayout') : true,
    }
    if (kind === 'master') {
      result.txStyles = parseTxStyles(xml, theme)
    }

    // Surface any image paths the baked shapes reference so the master
    // upload pass can pull their bytes out of the zip.
    for (const sh of shapes) {
      if (sh.imagePath !== undefined) imagePathSink.add(sh.imagePath)
    }
    if (background.imagePath !== undefined) imagePathSink.add(background.imagePath)

    cache.set(xmlPath, result)
    return result
  }

  async function resolveLayoutAndMaster(
    slidePath: string,
  ): Promise<{ layoutPath?: string; masterPath?: string }> {
    const dir = slidePath.substring(0, slidePath.lastIndexOf('/'))
    const file = slidePath.substring(slidePath.lastIndexOf('/') + 1)
    const relsPath = `${dir}/_rels/${file}.rels`
    const relsEntry = zip.file(relsPath)
    if (relsEntry === null) return {}
    const relsXml = await relsEntry.async('string')
    const tree = xmlParser.parse(relsXml) as XmlNode[]
    let layoutPath: string | undefined
    for (const node of walk(tree)) {
      if (getTag(node) !== 'Relationship') continue
      const a = getAttrs(node)
      const type = a['@Type']
      const target = a['@Target']
      if (typeof type === 'string' && type.endsWith('/slideLayout') && typeof target === 'string') {
        layoutPath = resolveRelPath('ppt/slides', target)
        break
      }
    }
    if (layoutPath === undefined) return {}

    const layoutDir = layoutPath.substring(0, layoutPath.lastIndexOf('/'))
    const layoutFile = layoutPath.substring(layoutPath.lastIndexOf('/') + 1)
    const layoutRelsPath = `${layoutDir}/_rels/${layoutFile}.rels`
    const layoutRelsEntry = zip.file(layoutRelsPath)
    let masterPath: string | undefined
    if (layoutRelsEntry !== null) {
      const lXml = await layoutRelsEntry.async('string')
      const lTree = xmlParser.parse(lXml) as XmlNode[]
      for (const node of walk(lTree)) {
        if (getTag(node) !== 'Relationship') continue
        const a = getAttrs(node)
        const type = a['@Type']
        const target = a['@Target']
        if (
          typeof type === 'string' &&
          type.endsWith('/slideMaster') &&
          typeof target === 'string'
        ) {
          masterPath = resolveRelPath('ppt/slideLayouts', target)
          break
        }
      }
    }

    return masterPath !== undefined ? { layoutPath, masterPath } : { layoutPath }
  }

  const out = new Map<string, SlideContext>()

  for (const slidePath of slidePaths) {
    const { layoutPath, masterPath } = await resolveLayoutAndMaster(slidePath)

    const layout = layoutPath !== undefined ? await loadLayoutOrMaster(layoutPath, 'layout') : null
    const master = masterPath !== undefined ? await loadLayoutOrMaster(masterPath, 'master') : null

    // Merge placeholders: layout over master, PER FIELD.
    //
    // OOXML inheritance is property-by-property: a layout placeholder that
    // declares only text defaults still inherits the master's geometry, and
    // vice versa. Replacing the whole entry (which is what this used to do)
    // let a layout entry with no `<a:xfrm>` shadow the master's real box, so
    // the frame came out 0×0 — a title placeholder then wrapped at width 0
    // (one glyph per line) and its clip mask cut everything away, i.e. the
    // text silently vanished. Same story for the default typeface.
    const placeholders: PlaceholderMap = new Map()
    if (master) for (const [k, v] of master.placeholders) placeholders.set(k, v)
    if (layout) {
      for (const [k, layoutEntry] of layout.placeholders) {
        const masterEntry = placeholders.get(k)
        placeholders.set(
          k,
          masterEntry === undefined
            ? layoutEntry
            : mergePlaceholderEntries(masterEntry, layoutEntry),
        )
      }
    }

    // Background cascade: layout > master.
    const fallbackBackground: ParsedBackground =
      layout && layout.background.kind !== 'none'
        ? layout.background
        : (master?.background ?? { kind: 'none' })

    // Master shapes get suppressed if the layout opts out via showMasterSp.
    const masterShapes = master && layout?.showMasterSp !== false ? master.shapes : []
    const layoutShapes = layout ? layout.shapes : []

    const txStyles: TxStylesByBucket = master?.txStyles ?? {}

    out.set(slidePath, {
      placeholders,
      masterShapes,
      layoutShapes,
      fallbackBackground,
      txStyles,
    })
  }

  return out
}

/** Resolve a relationship's relative `Target` (e.g. `../slideLayouts/slideLayout1.xml`)
 *  against the source directory (e.g. `ppt/slides`). */
function resolveRelPath(sourceDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const stack = sourceDir.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '..') stack.pop()
    else if (segment !== '.') stack.push(segment)
  }
  return stack.join('/')
}

/** rel-id → zip path for image relationships in a single slide's rels file. */
type ImageRelMap = Map<string, string>

/** rel-id → where an `<a:hlinkClick r:id>` leads: a URL (`…/hyperlink`,
 *  external target) or another slide of the deck (`…/slide`, a zip path). */
type HyperlinkRelMap = Map<string, ParsedHyperlink>

/**
 * Pick the master `<p:txStyles>` bucket for a placeholder type. PowerPoint:
 *   title / ctrTitle              → titleStyle
 *   body  / subTitle              → bodyStyle
 *   anything else (obj / chart / tbl / clipArt / dgm / media / pic / sldImg)
 *                                  → otherStyle
 */
function txStylesBucketFor(phType: string | undefined): keyof TxStylesByBucket {
  if (phType === 'title' || phType === 'ctrTitle') return 'title'
  if (phType === 'body' || phType === 'subTitle') return 'body'
  return 'other'
}

/**
 * Fill inherited from an enclosing `<p:grpSp>` — children that declare
 * `<a:grpFill/>` (instead of an inline `<a:solidFill>` / `<a:gradFill>`)
 * pull their fill from this. PowerPoint uses this pattern for vector
 * logos baked as a `<p:grpSp>` of letterform `<p:sp>` paths: the group
 * carries one `<a:solidFill>` so the whole logo recolors uniformly.
 */
interface GroupFill {
  color?: number
  alpha?: number
  gradient?: ParsedGradient
}

function parseShape(
  sp: XmlNode,
  sourceTag: string,
  theme: ThemeColourMap,
  placeholders: PlaceholderMap,
  imageRels: ImageRelMap,
  txStyles: TxStylesByBucket = {},
  hyperlinkRels: HyperlinkRelMap = new Map(),
  inheritedGroupFill: GroupFill | undefined = undefined,
): ParsedShape | null {
  const children = getChildren(sp, sourceTag)
  const spPr = findFirst(children, 'p:spPr')
  if (!spPr) return null

  const spPrChildren = getChildren(spPr, 'p:spPr')

  // ─── `<p:cNvPr>` non-visual props: integer spId + author name ──────────
  // The id integer is what `<p:spTgt spid>` animation targets reference;
  // the name (e.g. "Title 1") surfaces in PowerPoint's selection pane.
  let parsedSpId: number | undefined
  let parsedCnvName: string | undefined
  let cNvPrNode: XmlNode | undefined
  let parsedDescr: string | undefined
  let aspectLocked = false
  let shapeHyperlink: ParsedHyperlink | undefined
  {
    // `<p:cNvPr>` lives inside `<p:nvSpPr>` / `<p:nvPicPr>` / `<p:nvCxnSpPr>`
    // depending on shape source tag. Walk all candidates.
    const nvSpPr = findFirst(children, 'p:nvSpPr')
    const nvPicPr = findFirst(children, 'p:nvPicPr')
    const nvCxnSpPr = findFirst(children, 'p:nvCxnSpPr')
    const nvHolder = nvSpPr ?? nvPicPr ?? nvCxnSpPr
    aspectLocked = readAspectLocked(nvHolder)
    if (nvHolder) {
      const nvTag = getTag(nvHolder) ?? 'p:nvSpPr'
      const cNvPr = findFirst(getChildren(nvHolder, nvTag), 'p:cNvPr')
      cNvPrNode = cNvPr
      if (cNvPr) {
        const a = getAttrs(cNvPr)
        const idStr = a['@id']
        if (typeof idStr === 'string') {
          const n = Number(idStr)
          if (Number.isFinite(n)) parsedSpId = n
        }
        const nm = a['@name']
        if (typeof nm === 'string' && nm.length > 0) parsedCnvName = nm
        const descr = a['@descr']
        if (typeof descr === 'string' && descr.length > 0) parsedDescr = descr
        // A click action on the whole shape (as opposed to a text run).
        const hlink = findFirst(getChildren(cNvPr, 'p:cNvPr'), 'a:hlinkClick')
        const rId = hlink !== undefined ? getAttrs(hlink)['@r:id'] : undefined
        if (typeof rId === 'string' && rId !== '') shapeHyperlink = hyperlinkRels.get(rId)
      }
    }
  }

  // ─── Transform ─────────────────────────────────────────────────────────
  const xfrm = findFirst(spPrChildren, 'a:xfrm')
  let x = 0,
    y = 0,
    width = 0,
    height = 0,
    rotation = 0
  if (xfrm) {
    const rotAttr = getAttrs(xfrm)['@rot']
    if (typeof rotAttr === 'string') rotation = Number(rotAttr) / PPTX_ROT_PER_DEG
    const xfrmChildren = getChildren(xfrm, 'a:xfrm')
    const off = findFirst(xfrmChildren, 'a:off')
    if (off) {
      const a = getAttrs(off)
      x = emuToPx(Number(a['@x'] ?? 0))
      y = emuToPx(Number(a['@y'] ?? 0))
    }
    const ext = findFirst(xfrmChildren, 'a:ext')
    if (ext) {
      const a = getAttrs(ext)
      width = emuToPx(Number(a['@cx'] ?? 0))
      height = emuToPx(Number(a['@cy'] ?? 0))
    }
  }

  // ─── Narrative extension ───────────────────────────────────────────────
  // Model values a Narrative export could not say natively, kept only while
  // the frame they were written for is still the shape's own.
  const narrative =
    xfrm !== undefined ? readNarrativeExt(cNvPrNode, frameFingerprintOf(xfrm)) : undefined

  // ─── Placeholder inheritance ───────────────────────────────────────────
  // When this shape has a <p:ph> AND no inline <a:xfrm> (the common case for
  // unmoved title/body placeholders), look up the matching placeholder in
  // the slide layout / master and inherit its geometry. We also capture the
  // matched entry so its default text styling can fill in later if the slide
  // didn't set `<a:pPr algn>` or `<a:rPr sz>` directly.
  let inheritedPh: PlaceholderEntry | undefined
  /** Captured from the slide shape's `<p:ph type="…">`. Drives master
   *  `<p:txStyles>` bucket lookup (title vs body vs other) below. */
  let slideShapePhType: string | undefined
  {
    const ph = findPlaceholderNode(sp, sourceTag)
    if (ph) {
      const phAttrs = getAttrs(ph)
      const type = typeof phAttrs['@type'] === 'string' ? (phAttrs['@type'] as string) : undefined
      const idx = typeof phAttrs['@idx'] === 'string' ? (phAttrs['@idx'] as string) : undefined
      slideShapePhType = type
      // Try most-specific key first, then less-specific, then __any__.
      const candidates = [
        placeholderKey(type, idx),
        type !== undefined ? `t:${type}` : null,
        idx !== undefined ? `i:${idx}` : null,
        '__any__',
      ].filter((k): k is string => k !== null)
      for (const k of candidates) {
        const got = placeholders.get(k)
        if (got !== undefined) {
          inheritedPh = got
          break
        }
      }
      if (inheritedPh !== undefined && (width === 0 || height === 0)) {
        x = emuToPx(inheritedPh.x)
        y = emuToPx(inheritedPh.y)
        width = emuToPx(inheritedPh.width)
        height = emuToPx(inheritedPh.height)
      }
      // If the slide shape didn't carry its own `type` attr, fall back to
      // the placeholder entry's recorded type so the txStyles bucket
      // lookup still routes correctly (a slide may ref by `idx` only).
      if (slideShapePhType === undefined && inheritedPh?.phType !== undefined) {
        slideShapePhType = inheritedPh.phType
      }
    }
  }

  // ─── Geometry → tentative kind (text overrides this below) ─────────────
  const prstGeom = findFirst(spPrChildren, 'a:prstGeom')
  const prst = prstGeom ? String(getAttrs(prstGeom)['@prst'] ?? '') : undefined
  const custGeom = findFirst(spPrChildren, 'a:custGeom')

  // Regular-polygon preset → sides count. PPTX's "diamond" is conceptually
  // a 4-sided polygon but its bounding-box geometry differs from the
  // generic regular polygon we'd emit on round-trip, so we keep it as
  // 'unknown' for now (the importer leaves it on the ignored list).
  const POLYGON_SIDES: Record<string, number> = {
    pentagon: 5,
    hexagon: 6,
    heptagon: 7,
    octagon: 8,
    decagon: 10,
    dodecagon: 12,
  }

  let kind: ParsedShapeKind = 'unknown'
  let sides: number | undefined
  if (sourceTag === 'p:pic') kind = 'image'
  else if (sourceTag === 'p:cxnSp') kind = 'line'
  else if (prst === 'rect' || prst === 'roundRect') kind = 'rectangle'
  else if (prst === 'ellipse') kind = 'ellipse'
  else if (prst === 'triangle' || prst === 'isoscelesTriangle') kind = 'triangle'
  else if (prst !== undefined && POLYGON_SIDES[prst] !== undefined) {
    kind = 'polygon'
    sides = POLYGON_SIDES[prst]
  } else if (prst === 'line' || prst === 'straightConnector1') kind = 'line'
  else if (custGeom !== undefined) kind = 'path'
  // A polygon with no preset was drawn as a path; the extension names it.
  if (kind === 'path' && typeof narrative?.['polygonSides'] === 'number') {
    kind = 'polygon'
    sides = narrative['polygonSides']
  }

  // ─── Fill ──────────────────────────────────────────────────────────────
  let fillColor: number | undefined
  let fillAlpha: number | undefined
  let fillGradient: ParsedGradient | undefined
  let blipRelId: string | undefined
  // `<a:noFill/>` is the explicit "transparent" signal — common on
  // stroke-only outline shapes (e.g. the concentric circle decoration
  // on slide 5). Capture it as fillAlpha=0 so the writer doesn't fall
  // back to DEFAULT_FILL (brand blue) and stamp a fully-opaque blue
  // disc across the slide.
  const noFillExplicit = findFirst(spPrChildren, 'a:noFill') !== undefined
  const solidFill = findFirst(spPrChildren, 'a:solidFill')
  if (solidFill) {
    const c = parseColourAndAlphaFrom(solidFill, theme)
    if (c !== undefined) {
      fillColor = c.color
      if (c.alpha !== undefined) fillAlpha = c.alpha
    }
  }
  const gradFill = findFirst(spPrChildren, 'a:gradFill')
  if (gradFill) fillGradient = parseGradient(gradFill, theme)
  // Apply the noFill signal AFTER reading solidFill/gradFill so an
  // accidental "<a:noFill/><a:solidFill>red</a:solidFill>" pairing
  // (malformed but observed in the wild) still picks the explicit
  // color. The signal only kicks in when nothing else was set.
  if (noFillExplicit && fillColor === undefined && fillGradient === undefined) {
    fillAlpha = 0
  }
  // `<a:grpFill/>` inherits the enclosing `<p:grpSp>`'s fill — common for
  // vector logos baked as a group of letterform `<p:sp>` paths. Without
  // this, every glyph renders fill-less and the logo becomes invisible.
  if (
    fillColor === undefined &&
    fillGradient === undefined &&
    inheritedGroupFill !== undefined &&
    findFirst(spPrChildren, 'a:grpFill') !== undefined
  ) {
    if (inheritedGroupFill.color !== undefined) {
      fillColor = inheritedGroupFill.color
      if (inheritedGroupFill.alpha !== undefined) fillAlpha = inheritedGroupFill.alpha
    } else if (inheritedGroupFill.gradient !== undefined) {
      fillGradient = inheritedGroupFill.gradient
    }
  }
  // A placeholder that declares no fill of its own takes its layout/master
  // placeholder's — the same inheritance its geometry and text defaults get.
  // Only when the slide says nothing: any own fill element (even noFill, or
  // grpFill, or a picture/pattern fill) is the shape's own decision.
  const ownFillDeclared =
    noFillExplicit ||
    solidFill !== undefined ||
    gradFill !== undefined ||
    findFirst(spPrChildren, 'a:grpFill') !== undefined ||
    findFirst(spPrChildren, 'a:blipFill') !== undefined ||
    findFirst(spPrChildren, 'a:pattFill') !== undefined
  if (!ownFillDeclared && inheritedPh?.fill !== undefined) {
    const f = inheritedPh.fill
    if (f.kind === 'solid') {
      fillColor = f.color
      if (f.alpha !== undefined) fillAlpha = f.alpha
    } else if (f.kind === 'gradient') {
      fillGradient = f.gradient
    } else {
      fillAlpha = 0
    }
  }
  let imagePath: string | undefined
  let imageAlpha: number | undefined
  // PPTX expresses image opacity as `<a:blip>/<a:alphaModFix amt="N">`
  // where N is parts-per-100000 (so amt="10000" = 10%). We capture it from
  // whichever blip the picture is sourced from (spPr's blipFill OR p:pic's
  // p:blipFill) and let the writer apply it as the image object's opacity.
  const readBlipAlpha = (blip: XmlNode): number | undefined => {
    for (const child of getChildren(blip, 'a:blip')) {
      if (getTag(child) !== 'a:alphaModFix') continue
      const amt = getAttrs(child)['@amt']
      if (typeof amt !== 'string') continue
      const v = Number(amt)
      if (!Number.isFinite(v)) continue
      return clamp01(v / 100000)
    }
    return undefined
  }
  const blipFill = findFirst(spPrChildren, 'a:blipFill')
  if (blipFill) {
    for (const desc of walk([blipFill])) {
      if (getTag(desc) === 'a:blip') {
        const embed = getAttrs(desc)['@r:embed']
        if (typeof embed === 'string') {
          blipRelId = embed
          imagePath = imageRels.get(embed)
        }
        const a = readBlipAlpha(desc)
        if (a !== undefined) imageAlpha = a
      }
    }
    if (kind === 'unknown') kind = 'image'
  }
  // p:pic shapes carry their image ref in `<p:blipFill>` inside the shape
  // body (sibling of p:spPr), not inside spPr like normal shape fills.
  if (sourceTag === 'p:pic' && imagePath === undefined) {
    const picBlipFill = findFirst(children, 'p:blipFill')
    if (picBlipFill) {
      for (const desc of walk([picBlipFill])) {
        if (getTag(desc) === 'a:blip') {
          const embed = getAttrs(desc)['@r:embed']
          if (typeof embed === 'string') {
            blipRelId = embed
            imagePath = imageRels.get(embed)
          }
          const a = readBlipAlpha(desc)
          if (a !== undefined) imageAlpha = a
        }
      }
    }
  }

  // Videos live as `<p:pic>` with `<p:nvPicPr>/<p:nvPr>/<a:videoFile>`.
  // The `<p:blipFill>` underneath is a poster frame — we keep its
  // `imagePath` around but flip `kind` to 'video' and capture the video
  // file's own embed rel into `videoPath`. Same rels map carries both.
  let videoPath: string | undefined
  if (sourceTag === 'p:pic') {
    const nvPicPr = findFirst(children, 'p:nvPicPr')
    if (nvPicPr) {
      const nvPr = findFirst(getChildren(nvPicPr, 'p:nvPicPr'), 'p:nvPr')
      if (nvPr) {
        const videoFile = findFirst(getChildren(nvPr, 'p:nvPr'), 'a:videoFile')
        if (videoFile) {
          const va = getAttrs(videoFile)
          const rid = (va['@r:embed'] ?? va['@r:link']) as string | undefined
          if (typeof rid === 'string') {
            const path = imageRels.get(rid)
            if (path !== undefined) {
              videoPath = path
              kind = 'video'
            }
          }
        }
      }
    }
  }

  // ─── Stroke ────────────────────────────────────────────────────────────
  // `ooxml/line.ts` reads `<a:ln>` with the vocabulary the exporter writes.
  let strokeColor: number | undefined
  let strokeAlpha: number | undefined
  let strokeWidth: number | undefined
  let strokeDash: boolean | undefined
  let startCap: ParsedShape['startCap']
  let endCap: ParsedShape['endCap']
  const ln = findFirst(spPrChildren, 'a:ln')
  if (ln) {
    const line = readLine(ln, theme)
    strokeWidth = line.width
    strokeColor = line.color
    strokeAlpha = line.alpha
    if (line.dash === true) strokeDash = true
    startCap = line.head
    endCap = line.tail
  }
  // A line with any arrow cap is logically an ArrowObject, not a LineObject.
  if (kind === 'line' && (startCap === 'arrow' || endCap === 'arrow')) {
    kind = 'arrow'
  }
  // Which of the two the object was, when its ends alone do not say.
  if (
    (kind === 'line' || kind === 'arrow') &&
    (narrative?.['type'] === 'line' || narrative?.['type'] === 'arrow')
  ) {
    kind = narrative['type']
  }

  // Connector flips from `<a:xfrm flipH="1" flipV="1">` — the writer needs
  // these to derive p1/p2 (PPTX draws the line from the bbox corner pair
  // indicated by the flip flags).
  let flipH: boolean | undefined
  let flipV: boolean | undefined
  if (xfrm) {
    const a = getAttrs(xfrm)
    if (a['@flipH'] === '1' || a['@flipH'] === 'true') flipH = true
    if (a['@flipV'] === '1' || a['@flipV'] === 'true') flipV = true
  }

  // ─── Effects: drop shadow + gaussian blur ──────────────────────────────
  let shadow: ParsedShape['shadow']
  let blurRadius: number | undefined
  const effectLst = findFirst(spPrChildren, 'a:effectLst')
  if (effectLst) {
    const fx = readEffects(effectLst, theme)
    shadow = fx.shadow
    blurRadius = fx.blur
  }

  // ─── Image crop: <a:blipFill>/<a:srcRect l t r b> → imageRect ──────────
  // PPTX `srcRect` is per-side percentage × 1000 of the SOURCE bitmap. The
  // remaining (uncropped) source region is then scaled to fill the frame.
  // Narrative's imageRect describes where the UNCROPPED source would land
  // on the slide; the frame's bounding box clips visible pixels. We solve
  // for that imageRect from `frame + srcRect` here.
  let imageRect: ParsedShape['imageRect']
  let pictureMask: ImageMask | undefined
  if (sourceTag === 'p:pic') {
    const picBlipFill = findFirst(children, 'p:blipFill')
    const srcRect =
      picBlipFill !== undefined
        ? findFirst(getChildren(picBlipFill, 'p:blipFill'), 'a:srcRect')
        : undefined
    imageRect = readImageRect(srcRect, { x, y, width, height })
    pictureMask = readPictureMask(spPrChildren, { x, y, width, height })
    // A Narrative export's exact crop, while the picture is still cropped
    // exactly as written (`srcRect`'s percentages round).
    if (narrative !== undefined) {
      const crop = imageCrop(narrative['crop'])
      delete narrative['crop']
      delete narrative['imageRect']
      if (crop !== undefined && crop.src === srcRectSignature(srcRect)) {
        if (crop.rect === null) imageRect = undefined
        else narrative['imageRect'] = crop.rect
      }
    }
  }

  // ─── Theme style references ────────────────────────────────────────────
  // PowerPoint shapes often have NO inline solidFill / gradFill / ln-fill in
  // spPr. Instead they reference theme styles via `<p:style>` (sibling of
  // p:spPr, p:txBody). The references look like:
  //   <p:style>
  //     <a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef>
  //     <a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>
  //     <a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef>
  //     <a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>
  //   </p:style>
  // The `idx` selects a fill/line/effect TEMPLATE in `theme1.xml`'s
  // <a:fmtScheme> (1=subtle, 2=moderate, 3=intense; 0 = none). For v1 we
  // ignore the template variations and just pick the embedded scheme colour
  // — which is already a faithful "what should this shape look like"
  // approximation.
  //
  // A style is only the default: whatever the shape says for itself wins.
  // A shape that declares its own fill (any kind, `<a:noFill/>` included)
  // takes nothing from `fillRef`; one whose `<a:ln>` declares a fill takes
  // no outline colour from `lnRef` — `<a:ln><a:noFill/></a:ln>` with an
  // accent `lnRef` is "no outline", and drawing the accent colour put a red
  // frame round every grey box of the Proseware deck's wireframes.
  // `styleFontColor` is captured here and consumed in the text-parsing block
  // below as the fall-back run colour when `<a:rPr><a:solidFill>` is absent.
  let styleFontColor: number | undefined
  const style = findFirst(children, 'p:style')
  if (style) {
    const styleChildren = getChildren(style, 'p:style')
    const styleIdx = (ref: XmlNode): number => {
      const v = Number(getAttrs(ref)['@idx'])
      return Number.isFinite(v) ? v : 1
    }
    if (!ownFillDeclared && fillColor === undefined && fillGradient === undefined) {
      const fillRef = findFirst(styleChildren, 'a:fillRef')
      if (fillRef && styleIdx(fillRef) !== 0) fillColor = parseColourFrom(fillRef, theme)
    }
    const lnChildren = ln !== undefined ? getChildren(ln, 'a:ln') : []
    const lnFillDeclared = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:pattFill'].some(
      (t) => findFirst(lnChildren, t) !== undefined,
    )
    if (strokeColor === undefined && !lnFillDeclared) {
      const lnRef = findFirst(styleChildren, 'a:lnRef')
      if (lnRef && styleIdx(lnRef) !== 0) {
        strokeColor = parseColourFrom(lnRef, theme)
        // Stroke width was never declared in spPr/ln either → use the
        // idx-mapped default. PowerPoint subtle line = ~9525 EMU = 1px.
        if (strokeWidth === undefined && strokeColor !== undefined) {
          const idxRaw = getAttrs(lnRef)['@idx']
          const idx = typeof idxRaw === 'string' ? Number(idxRaw) : 1
          strokeWidth = idx >= 3 ? 3 : idx >= 2 ? 2 : 1
        }
      }
    }
    const fontRef = findFirst(styleChildren, 'a:fontRef')
    if (fontRef) styleFontColor = parseColourFrom(fontRef, theme)
  }

  // ─── Text ──────────────────────────────────────────────────────────────
  // Text frames in pptxgenjs output (and most exporters) carry a
  // `prstGeom="rect"` for layout. The presence of an `<p:txBody>` with
  // non-empty content takes priority over preset-geometry kind inference,
  // so a text label doesn't get rendered as a filled rectangle.
  let text: string | undefined
  let textColor: number | undefined
  let textColorAlpha: number | undefined
  let fontSize: number | undefined
  let bold = false
  let textAlign: 'left' | 'center' | 'right' | 'justify' | undefined
  let textVerticalAlign: 'top' | 'middle' | 'bottom' | undefined
  /** Bullet resolution holds the explicit decl from the highest-priority
   *  layer that set one; consumers downstream of the resolution chain skip
   *  emitting `listStyle` when this lands as 'none' or stays undefined.
   *  LEGACY frame-wide field — kept for the `shape.listStyle` diagnostic and
   *  derived from the FIRST paragraph's resolved decl (see post-loop). */
  let listStyleResolved: 'bullet' | 'numbered' | 'none' | undefined
  /** Per-paragraph bullet declaration parsed from each `<a:p>/<a:pPr>`. One
   *  entry per source paragraph, in document order. `undefined` = the
   *  paragraph carried no own buChar/buAutoNum/buNone, so it falls back to
   *  the inherited (placeholder/master/txStyles) declaration. */
  const paraBulletDecls: (BulletDecl | undefined)[] = []
  /** A Narrative export's exact attributes per paragraph (`ooxml/text.ts`). */
  const paraExts: Array<ReturnType<typeof readParagraphExt>> = []
  /** Per-paragraph nesting level from each `<a:p>/<a:pPr lvl="N">`. 0 = no
   *  indent. Index-aligned with `paraBulletDecls`. */
  const paraLevels: number[] = []
  /** Each paragraph's own `<a:pPr marL>` (EMU), undefined when not declared. */
  const paraOwnMargins: Array<number | undefined> = []
  /** Bullet kind inherited from the placeholder / master-txStyles chain.
   *  Only a coarse kind ('bullet' | 'numbered' | 'none') is recoverable from
   *  those layers (they store no glyph / autonum detail). Applied per
   *  paragraph post-loop to any paragraph that didn't declare its own bullet,
   *  matching PowerPoint's "inherit lvl1pPr bullet" behaviour. */
  let inheritedBulletKind: 'bullet' | 'numbered' | 'none' | undefined
  /** Per-run rich-text breakdown — populated alongside the existing
   *  paragraph string accumulator; survives to the shape output so the
   *  writer can lay it onto a Y.Text. */
  let allRuns: ParsedTextRun[] = []
  /** First hyperlink seen during run walk — surfaces as the TextObject's
   *  collapsed `hyperlink` (Narrative models one hyperlink per object). */
  let firstHyperlink: ParsedHyperlink | undefined
  /** Frame-level text properties captured during the run / paragraph walk.
   *  These collapse from PPTX's per-run / per-paragraph schema onto
   *  TextObject's single-value root fields — the FIRST run / paragraph
   *  with each property wins, matching the rest of the parser's
   *  first-occurrence convention. */
  let frameFontFamily: string | undefined
  let frameLetterSpacing: number | undefined
  let frameLineHeight: number | undefined
  let frameLineSpacing: number | undefined
  /** Whether the frame's text is a `<a:fld type="slidenum">` and nothing
   *  else (whitespace aside) — the one case the model can show live, as
   *  `isSlideNumber`. A number inside other text keeps its cached digits. */
  let slideNumberFieldSeen = false
  let otherTextSeen = false
  let frameWrap: 'none' | 'square' | undefined
  /** The shape's own geometry kind, when its text makes it a text frame. */
  let geometryKind: ParsedShapeKind | undefined
  let textInsets: BodyInsets | undefined
  /** First `<a:lnSpc>` found down the chain paragraph → shape lstStyle →
   *  layout/master placeholder → master txStyles; resolved into
   *  frameLineSpacing / frameLineHeight once the font size is final. */
  let lineSpacingDecl: LineSpacingDecl | undefined
  let frameSpaceBefore: number | undefined
  let frameSpaceAfter: number | undefined
  let frameTextTransform: ParsedShape['textTransform']
  let frameItalic: boolean | undefined
  let frameUnderline: boolean | undefined
  let frameTextStrokeColor: number | undefined
  let frameTextStrokeAlpha: number | undefined
  let frameTextStrokeWidth: number | undefined
  const txBody = findFirst(children, 'p:txBody')
  if (txBody) {
    const txBodyChildren = getChildren(txBody, 'p:txBody')
    // Slide-level bodyPr `anchor` wins over the placeholder default.
    const bodyPr = findFirst(txBodyChildren, 'a:bodyPr')
    if (bodyPr) {
      const anchorRaw = getAttrs(bodyPr)['@anchor']
      if (typeof anchorRaw === 'string') {
        const va = mapBodyAnchor(anchorRaw)
        if (va !== undefined) textVerticalAlign = va
      }
      const ownWrap = getAttrs(bodyPr)['@wrap']
      if (ownWrap === 'none' || ownWrap === 'square') frameWrap = ownWrap
    }
    // Where the text sits inside the frame: the body's own insets, else its
    // placeholder's, else PowerPoint's default, side by side.
    textInsets = { ...DEFAULT_BODY_INSETS, ...inheritedPh?.bodyInsets, ...readBodyInsets(bodyPr) }
    // A placeholder's copy usually leaves wrap to its layout/master.
    if (frameWrap === undefined && inheritedPh?.bodyWrap !== undefined) {
      frameWrap = inheritedPh.bodyWrap
    }
    const paragraphs = findAll(txBodyChildren, 'a:p')
    const slideNumberOnly = isSlideNumberOnly(paragraphs)
    const paraStrings: string[] = []
    let firstRunStyled = false
    for (let pi = 0; pi < paragraphs.length; pi++) {
      const p = paragraphs[pi]!
      const pChildren = getChildren(p, 'a:p')
      // ─── Per-paragraph list resolution ──────────────────────────────────
      // Capture THIS paragraph's own bullet declaration + nesting level so
      // the writer can stamp per-paragraph block attrs onto the Y.Text. The
      // inheritance fallback (placeholder/master/txStyles → only a coarse
      // kind is available there) is applied post-loop, once per paragraph,
      // for any paragraph that didn't declare its own bullet here.
      {
        const ownPPr = findFirst(pChildren, 'a:pPr')
        paraExts.push(readParagraphExt(ownPPr))
        paraBulletDecls.push(ownPPr ? extractBulletDecl(ownPPr, 'a:pPr') : undefined)
        paraLevels.push(readParagraphLevel(ownPPr))
        const ownMarL = ownPPr !== undefined ? getAttrs(ownPPr)['@marL'] : undefined
        const ownMarLNum = typeof ownMarL === 'string' ? Number(ownMarL) : Number.NaN
        paraOwnMargins.push(Number.isFinite(ownMarLNum) ? ownMarLNum : undefined)
      }
      // First-paragraph explicit `<a:pPr algn="..">` wins over layout defaults.
      // Bullet decl on first paragraph likewise wins over any inherited default.
      // Line height + paragraph space are also paragraph-level; we capture
      // them from the first paragraph (Narrative models them frame-wide).
      if (
        textAlign === undefined ||
        listStyleResolved === undefined ||
        lineSpacingDecl === undefined ||
        frameSpaceBefore === undefined ||
        frameSpaceAfter === undefined
      ) {
        const pPr = findFirst(pChildren, 'a:pPr')
        if (pPr) {
          if (textAlign === undefined) {
            const algn = getAttrs(pPr)['@algn']
            if (typeof algn === 'string') textAlign = mapAlgn(algn)
          }
          if (listStyleResolved === undefined) {
            const bullet = detectBulletDecl(pPr, 'a:pPr')
            if (bullet !== undefined) listStyleResolved = bullet
          }
          const pPrChildren = getChildren(pPr, 'a:pPr')
          // <a:lnSpc> — spcPct (× the font's normal line height) or spcPts
          //   (absolute). Kept as a declaration; see LineSpacingDecl.
          if (lineSpacingDecl === undefined) lineSpacingDecl = readLineSpacingDecl(pPrChildren)
          // <a:spcBef>/<a:spcAft> use the same <a:spcPts val="100ths of pt">
          //  format. Narrative paragraphSpaceBefore/After is in px.
          if (frameSpaceBefore === undefined)
            frameSpaceBefore = readSpacingPts(pPrChildren, 'a:spcBef')
          if (frameSpaceAfter === undefined)
            frameSpaceAfter = readSpacingPts(pPrChildren, 'a:spcAft')
        }
      }
      // Paragraph-break separator uses Unicode U+2029 (PARAGRAPH
      // SEPARATOR) so the renderer can tell apart:
      //   - PPTX <a:br>  soft line breaks      -> '\n' (within a paragraph),
      //   - PPTX <a:p>   paragraph boundaries  -> U+2029.
      // Critical for bullet lists: each <a:p> carries its own
      // <a:buChar>, but a <a:br> continuation line inside the same
      // paragraph SHARES the bullet (visually the second line of
      // one item, unbulleted under the bullet). Without a distinct
      // separator the renderer would bullet every soft-break line
      // (the 'bullet everywhere' bug on the audit deck slide 5).
      //
      // NEVER embed the literal U+2029 character in source - it is
      // a JS line terminator and tsc splits single-line comments
      // on it. The '\u2029' escape is the only safe form.
      if (pi > 0) allRuns.push({ text: '\u2029' })

      // Per-paragraph default run properties from `<a:pPr>/<a:defRPr>` —
      // PowerPoint applies these to any run in THIS paragraph whose own
      // `<a:rPr>` doesn't override them. Distinct level in the inheritance
      // chain from the shape's `<a:lstStyle>` lvl1 defaults (handled
      // post-loop) and from the run-level rPr (highest, handled below).
      const paraDefaults: ParagraphRunDefaults = {}
      {
        const paraPPr = findFirst(pChildren, 'a:pPr')
        if (paraPPr !== undefined) {
          const paraPPrChildren = getChildren(paraPPr, 'a:pPr')
          const paraDefRPr = findFirst(paraPPrChildren, 'a:defRPr')
          if (paraDefRPr !== undefined) {
            const da = getAttrs(paraDefRPr)
            const dsz = da['@sz']
            if (typeof dsz === 'string') {
              const v = Number(dsz)
              if (Number.isFinite(v)) paraDefaults.fontSize = v * PPTX_FONT_TO_PX
            }
            if (da['@b'] === '1' || da['@b'] === 'true') paraDefaults.bold = true
            if (da['@i'] === '1' || da['@i'] === 'true') paraDefaults.italic = true
            if (typeof da['@u'] === 'string' && da['@u'] !== 'none') paraDefaults.underline = true
            const dspc = da['@spc']
            if (typeof dspc === 'string') {
              const v = Number(dspc)
              if (Number.isFinite(v)) paraDefaults.letterSpacing = v * PPTX_FONT_TO_PX
            }
            const dcap = da['@cap']
            if (dcap === 'all') paraDefaults.textTransform = 'uppercase'
            else if (dcap === 'small') paraDefaults.textTransform = 'lowercase'
            const paraDefChildren = getChildren(paraDefRPr, 'a:defRPr')
            const paraSolid = findFirst(paraDefChildren, 'a:solidFill')
            if (paraSolid !== undefined) {
              const c = parseColourAndAlphaFrom(paraSolid, theme)
              if (c !== undefined) {
                paraDefaults.color = c.color
                if (c.alpha !== undefined) paraDefaults.colorAlpha = c.alpha
              }
            }
            const paraLatin = findFirst(paraDefChildren, 'a:latin')
            if (paraLatin !== undefined) {
              const tf = resolveTypeface(getAttrs(paraLatin)['@typeface'], theme)
              if (tf !== undefined) paraDefaults.fontFamily = tf
            }
          }
        }
      }

      // Walk paragraph children in document order. We handle three kinds
      // of inline text-bearing elements:
      //   a:r   — standard styled run
      //   a:fld — text field (slide number, date, etc) — same internal shape
      //   a:br  — soft line break — emits a '\n' run
      // Anything else (a:pPr, a:endParaRPr) is skipped here; pPr is
      // already handled above.
      const runStrings: string[] = []
      for (const child of pChildren) {
        const childTag = getTag(child)
        if (childTag === 'a:br') {
          // Soft line break inside a paragraph. PowerPoint authors hit
          // Shift+Enter to insert one; PPTX serialises it as an empty
          // `<a:br/>` sibling to the surrounding `<a:r>` runs. Preserve
          // it as a `\n` in both the run array (so the rich-text body
          // breaks at the same point) and the plain-string accumulator
          // (so the fallback `text` field stays consistent).
          // The break has formatting of its own (`<a:br><a:rPr>`): the
          // model's '\n' character is part of a run like any other.
          const brPr = findFirst(getChildren(child, 'a:br'), 'a:rPr')
          const brAttrs: ParsedTextRun = {
            ...(brPr !== undefined ? readRunProperties(brPr, theme, hyperlinkRels).attrs : {}),
            text: '\n',
          }
          applyParagraphRunDefaults(brAttrs, paraDefaults)
          allRuns.push(brAttrs)
          runStrings.push('\n')
          continue
        }
        if (childTag !== 'a:r' && childTag !== 'a:fld') continue
        const r = child
        const rChildren = getChildren(r, childTag)
        // Per-run style attrs — captured ONCE on the first run as the
        // "default" for the TextObject (top-level color / fontSize / bold)
        // AND captured per-run into `allRuns` for the Y.Text format pass.
        const rPr = findFirst(rChildren, 'a:rPr')
        const own = rPr !== undefined ? readRunProperties(rPr, theme, hyperlinkRels) : undefined
        const runAttrs: ParsedTextRun = { ...(own?.attrs ?? {}), text: '' }
        let runTextTransform = own?.textTransform
        const rPrLn = own?.ln
        applyParagraphRunDefaults(runAttrs, paraDefaults)
        if (runTextTransform === undefined && paraDefaults.textTransform !== undefined) {
          runTextTransform = paraDefaults.textTransform
        }
        // First-run promotion to frame-level. Runs out at this point, so
        // the run inherits whatever rPr / pPr-defRPr together produced —
        // not silently empty when the run had no <a:rPr> of its own.
        if (!firstRunStyled) {
          if (runAttrs.bold === true) bold = true
          if (runAttrs.fontSize !== undefined) fontSize = runAttrs.fontSize
          if (runAttrs.color !== undefined) {
            textColor = runAttrs.color
            if (runAttrs.colorAlpha !== undefined) textColorAlpha = runAttrs.colorAlpha
          }
          if (runAttrs.fontFamily !== undefined) frameFontFamily = runAttrs.fontFamily
          if (runAttrs.letterSpacing !== undefined) {
            frameLetterSpacing = runAttrs.letterSpacing
          }
          if (runTextTransform !== undefined) frameTextTransform = runTextTransform
          if (rPrLn) {
            const lnAttrs = getAttrs(rPrLn)
            const lnW = lnAttrs['@w']
            if (typeof lnW === 'string') frameTextStrokeWidth = emuToPx(Number(lnW))
            const lnChildren = getChildren(rPrLn, 'a:ln')
            const lnSolid = findFirst(lnChildren, 'a:solidFill')
            if (lnSolid) {
              const c = parseColourAndAlphaFrom(lnSolid, theme)
              if (c !== undefined) {
                frameTextStrokeColor = c.color
                if (c.alpha !== undefined) frameTextStrokeAlpha = c.alpha
              }
            }
          }
          firstRunStyled = true
        }
        if (firstHyperlink === undefined && runAttrs.hyperlink !== undefined) {
          firstHyperlink = runAttrs.hyperlink
        }
        const tNode = findFirst(rChildren, 'a:t')
        const runTextParts: string[] = []
        if (tNode) {
          const tChildren = getChildren(tNode, 'a:t')
          for (const tc of tChildren) {
            const tx = (tc as { '#text'?: unknown })['#text']
            if (typeof tx === 'string') runTextParts.push(tx)
          }
        }
        let runText = runTextParts.join('')
        if (childTag === 'a:fld' && getAttrs(r)['@type'] === 'slidenum') {
          slideNumberFieldSeen = true
          // A frame that is only the number holds PowerPoint's own stand-in,
          // `‹#›`, whatever digits the file cached (Keynote caches none, a
          // Narrative export caches the slide's number): the renderer shows
          // the live number, the text is only the field's marker. A number
          // inside other text keeps its cached digits.
          if (slideNumberOnly || runText.trim() === '') runText = '‹#›'
        } else if (runText.trim() !== '') {
          otherTextSeen = true
        }
        if (runText.length > 0) {
          runStrings.push(runText)
          runAttrs.text = runText
          allRuns.push(runAttrs)
        }
      }
      if (runStrings.length > 0) paraStrings.push(runStrings.join(''))
    }
    if (paraStrings.length > 0) {
      text = paraStrings.join('\n')
      // Override geom-derived kind — a text-bearing shape IS a text
      // frame. Callers that need the original rect/roundRect outline
      // (e.g. slide 8's lime-bordered "1 - AUGMENTATION" labels)
      // recover it via `splitTextShapeWithGeometry` post-process,
      // which uses the preserved `prst`, stroke, fill, and corner-
      // radius on the returned shape to emit a sibling rectangle
      // beneath the text frame. Narrative's TextObject schema only
      // models stroke around glyph fills (textStroke), not around
      // the bounding box.
      geometryKind = kind
      kind = 'text'
    }
    // Shape-inline lstStyle fallback: the text body's own `<a:lstStyle>/
    // <a:lvl1pPr>/<a:defRPr>` defines run properties that apply when the
    // paragraph's runs didn't supply them at the run-level `<a:rPr>`. This
    // is the standard OOXML inheritance for non-placeholder shapes that
    // author their own text style. Higher priority than `<p:style>/
    // <a:fontRef>`, inherited placeholder defaults, and `<p:txStyles>`;
    // run-level `<a:rPr>` (already processed above) still wins.
    // ─── The frame tier: the shape's own `<a:lstStyle>/<a:lvl1pPr>` ───────
    // What applies to a run that says nothing about itself. PowerPoint's
    // inheritance puts it under the runs' own `<a:rPr>` (captured per run
    // above) and over the placeholder / master / theme layers below. The
    // model's frame fields ARE this tier, so where the shape declares a
    // value here it is the frame's value — the first run's own formatting
    // (promoted above as a stand-in for decks that declare no frame tier)
    // only belongs to that run. A Narrative export always writes this tier,
    // so an export whose first run differs from its frame reads back
    // exactly; a deck without one keeps the first-run promotion.
    const lstStyleNode = findFirst(txBodyChildren, 'a:lstStyle')
    const lvl1 =
      lstStyleNode !== undefined
        ? findFirst(getChildren(lstStyleNode, 'a:lstStyle'), 'a:lvl1pPr')
        : undefined
    if (lvl1 !== undefined) {
      const lvl1Children = getChildren(lvl1, 'a:lvl1pPr')
      // Paragraph-level frame values: a first paragraph's own `<a:pPr>`
      // still wins (it was read above), the lstStyle fills what it left.
      if (textAlign === undefined) {
        const algn = getAttrs(lvl1)['@algn']
        if (typeof algn === 'string') textAlign = mapAlgn(algn)
      }
      if (lineSpacingDecl === undefined) lineSpacingDecl = readLineSpacingDecl(lvl1Children)
      if (frameSpaceBefore === undefined)
        frameSpaceBefore = readSpacingPts(lvl1Children, 'a:spcBef')
      if (frameSpaceAfter === undefined) frameSpaceAfter = readSpacingPts(lvl1Children, 'a:spcAft')

      const defRPr = findFirst(lvl1Children, 'a:defRPr')
      if (defRPr !== undefined) {
        const a = getAttrs(defRPr)
        const sz = Number(a['@sz'])
        if (typeof a['@sz'] === 'string' && Number.isFinite(sz)) fontSize = sz * PPTX_FONT_TO_PX
        const b = readOnOff(a['@b'])
        if (b !== undefined) bold = b
        const i = readOnOff(a['@i'])
        if (i !== undefined) frameItalic = i
        if (typeof a['@u'] === 'string') frameUnderline = a['@u'] !== 'none'
        const spc = Number(a['@spc'])
        if (typeof a['@spc'] === 'string' && Number.isFinite(spc))
          frameLetterSpacing = spc * PPTX_FONT_TO_PX
        const cap = a['@cap']
        if (typeof cap === 'string') {
          frameTextTransform = cap === 'all' ? 'uppercase' : cap === 'small' ? 'lowercase' : 'none'
        }
        const defRPrChildren = getChildren(defRPr, 'a:defRPr')
        const solid = findFirst(defRPrChildren, 'a:solidFill')
        if (solid !== undefined) {
          const c = parseColourAndAlphaFrom(solid, theme)
          if (c !== undefined) {
            textColor = c.color
            textColorAlpha = c.alpha
          }
        }
        const latinNode = findFirst(defRPrChildren, 'a:latin')
        if (latinNode !== undefined) {
          const tf = resolveTypeface(getAttrs(latinNode)['@typeface'], theme)
          if (tf !== undefined) frameFontFamily = tf
        }
        const glyphLn = findFirst(defRPrChildren, 'a:ln')
        if (glyphLn !== undefined) {
          const line = readLine(glyphLn, theme)
          frameTextStrokeColor = line.color
          frameTextStrokeAlpha = line.alpha
          frameTextStrokeWidth = line.width
        }
      }
    }
    // Fall through to the theme-style font colour when no run-level rPr
    // colour was set (the common case for placeholder text).
    if (textColor === undefined && styleFontColor !== undefined) {
      textColor = styleFontColor
    }
    // Fall through to placeholder defaults for paragraph alignment + size +
    // vertical anchor + colour + bold. Layout-side placeholder defaults take
    // priority over master-side defaults because the merge in
    // `buildSlideContexts` already layers layout on top of master.
    if (inheritedPh !== undefined) {
      if (textAlign === undefined && inheritedPh.textAlign !== undefined) {
        textAlign = inheritedPh.textAlign
      }
      if (lineSpacingDecl === undefined && inheritedPh.defaultLineSpacing !== undefined) {
        lineSpacingDecl = inheritedPh.defaultLineSpacing
      }
      if (fontSize === undefined && inheritedPh.defaultFontSize100 !== undefined) {
        fontSize = inheritedPh.defaultFontSize100 * PPTX_FONT_TO_PX
      }
      if (frameFontFamily === undefined && inheritedPh.defaultFontFamily !== undefined) {
        frameFontFamily = inheritedPh.defaultFontFamily
      }
      if (textVerticalAlign === undefined && inheritedPh.bodyAnchor !== undefined) {
        textVerticalAlign = inheritedPh.bodyAnchor
      }
      if (textColor === undefined && inheritedPh.defaultColor !== undefined) {
        textColor = inheritedPh.defaultColor
        if (inheritedPh.defaultColorAlpha !== undefined) {
          textColorAlpha = inheritedPh.defaultColorAlpha
        }
      }
      if (!bold && inheritedPh.defaultBold === true) bold = true
      if (frameTextTransform === undefined && inheritedPh.defaultTextTransform !== undefined) {
        frameTextTransform = inheritedPh.defaultTextTransform
      }
      if (frameLetterSpacing === undefined && inheritedPh.defaultLetterSpacing100 !== undefined) {
        frameLetterSpacing = inheritedPh.defaultLetterSpacing100 * PPTX_FONT_TO_PX
      }
      if (listStyleResolved === undefined && inheritedPh.defaultListStyle !== undefined) {
        listStyleResolved = inheritedPh.defaultListStyle
      }
      if (inheritedBulletKind === undefined && inheritedPh.defaultListStyle !== undefined) {
        inheritedBulletKind = inheritedPh.defaultListStyle
      }
    }
    // Master `<p:txStyles>` is the FINAL fallback for placeholder text — only
    // consulted when the slide has a `<p:ph>` and none of the layout/master
    // placeholder entries (or the slide itself) supplied the property. The
    // bucket is keyed by the slide shape's placeholder type, with the
    // standard PowerPoint title/body/other mapping.
    if (slideShapePhType !== undefined) {
      const bucket = txStyles[txStylesBucketFor(slideShapePhType)]
      if (bucket !== undefined) {
        if (textColor === undefined && bucket.color !== undefined) {
          textColor = bucket.color
          if (bucket.colorAlpha !== undefined) textColorAlpha = bucket.colorAlpha
        }
        if (fontSize === undefined && bucket.fontSize100 !== undefined) {
          fontSize = bucket.fontSize100 * PPTX_FONT_TO_PX
        }
        if (frameFontFamily === undefined && bucket.fontFamily !== undefined) {
          frameFontFamily = bucket.fontFamily
        }
        if (!bold && bucket.bold === true) bold = true
        if (lineSpacingDecl === undefined && bucket.lineSpacing !== undefined) {
          lineSpacingDecl = bucket.lineSpacing
        }
        if (frameLetterSpacing === undefined && bucket.letterSpacing100 !== undefined) {
          frameLetterSpacing = bucket.letterSpacing100 * PPTX_FONT_TO_PX
        }
        if (frameTextTransform === undefined && bucket.textTransform !== undefined) {
          frameTextTransform = bucket.textTransform
        }
        if (listStyleResolved === undefined && bucket.listStyle !== undefined) {
          listStyleResolved = bucket.listStyle
        }
        if (inheritedBulletKind === undefined && bucket.listStyle !== undefined) {
          inheritedBulletKind = bucket.listStyle
        }
      }
    }
    // Theme `<a:txDef>/<a:lstStyle>/<a:defPPr>/<a:defRPr>` is the LAST
    // resort for text shapes without explicit colour anywhere. OOXML uses
    // it as the default for `<p:cNvSpPr txBox="1">` shapes (the text-box
    // type). Lower priority than placeholder/master/style fallbacks above;
    // higher than Narrative's hard-coded DEFAULT_TEXT_COLOR (writer-side).
    const themeDef = themeTxDefStore.get(theme)
    if (themeDef !== undefined) {
      if (textColor === undefined && themeDef.color !== undefined) {
        textColor = themeDef.color
        if (themeDef.colorAlpha !== undefined) textColorAlpha = themeDef.colorAlpha
      }
      if (fontSize === undefined && themeDef.fontSize !== undefined) {
        fontSize = themeDef.fontSize
      }
      if (!bold && themeDef.bold === true) bold = true
      if (frameFontFamily === undefined && themeDef.fontFamily !== undefined) {
        frameFontFamily = themeDef.fontFamily
      }
    }
  }

  // Resolve the winning `<a:lnSpc>` now that the frame's font size is final:
  // a percentage is already in `lineSpacing` units; points become the
  // per-font-size `lineHeight` ratio, which needs the size it applies to.
  if (lineSpacingDecl !== undefined) {
    if (lineSpacingDecl.kind === 'pct') frameLineSpacing = lineSpacingDecl.value
    else if (fontSize !== undefined && fontSize > 0) {
      frameLineHeight = (lineSpacingDecl.value100 * PPTX_FONT_TO_PX) / fontSize
    }
  }

  const shape: ParsedShape = {
    kind,
    x,
    y,
    width,
    height,
    rotation,
    sourceTag,
  }
  if (fillColor !== undefined) shape.fillColor = fillColor
  if (fillAlpha !== undefined) shape.fillAlpha = fillAlpha
  if (fillGradient !== undefined) shape.fillGradient = fillGradient
  if (strokeColor !== undefined) shape.strokeColor = strokeColor
  if (strokeAlpha !== undefined) shape.strokeAlpha = strokeAlpha
  if (strokeWidth !== undefined) shape.strokeWidth = strokeWidth
  if (strokeDash === true) shape.strokeDash = true
  if (prst === 'roundRect' && prstGeom !== undefined) {
    shape.cornerRadius = readRoundRectRadius(prstGeom, width, height)
  }
  if (narrative !== undefined) shape.narrative = narrative
  if (geometryKind !== undefined) shape.geometryKind = geometryKind
  if (shapeHyperlink !== undefined) shape.hyperlink = shapeHyperlink
  if (parsedDescr !== undefined) shape.alt = parsedDescr
  if (aspectLocked) shape.aspectLocked = true
  if (text !== undefined) shape.text = text
  if (textColor !== undefined) shape.textColor = textColor
  if (textColorAlpha !== undefined) shape.textColorAlpha = textColorAlpha
  if (textAlign !== undefined) shape.textAlign = textAlign
  if (textVerticalAlign !== undefined) shape.textVerticalAlign = textVerticalAlign
  if (fontSize !== undefined) shape.fontSize = fontSize
  if (bold) shape.bold = true
  if (listStyleResolved === 'bullet' || listStyleResolved === 'numbered') {
    shape.listStyle = listStyleResolved
  }
  if (prst !== undefined) shape.prstGeom = prst
  if (blipRelId !== undefined) shape.blipRelId = blipRelId
  if (imagePath !== undefined) shape.imagePath = imagePath
  if (imageAlpha !== undefined && imageAlpha < 1) shape.imageAlpha = imageAlpha
  if (videoPath !== undefined) shape.videoPath = videoPath
  if (shadow !== undefined) shape.shadow = shadow
  if (blurRadius !== undefined && blurRadius > 0) shape.blur = blurRadius
  if (imageRect !== undefined) shape.imageRect = imageRect
  if (pictureMask !== undefined) shape.mask = pictureMask
  if (parsedSpId !== undefined) shape.spId = parsedSpId
  if (parsedCnvName !== undefined) shape.cnvName = parsedCnvName
  if (sides !== undefined) shape.sides = sides
  // Custom path geometry — only emitted when the shape is a path; we
  // parse anchors lazily here so non-path shapes don't pay the cost.
  if (
    (kind === 'path' || geometryKind === 'path') &&
    custGeom !== undefined &&
    width > 0 &&
    height > 0
  ) {
    const { anchors, closed } = parseCustGeomAnchors(custGeom, width, height, x, y)
    if (anchors.length > 0) {
      shape.pathAnchors = anchors
      if (closed) shape.pathClosed = true
    }
  }
  // Line/arrow caps + flips — needed by the writer to construct
  // ArrowObject / LineObject endpoints correctly.
  if (kind === 'line' || kind === 'arrow') {
    if (startCap !== undefined) shape.startCap = startCap
    if (endCap !== undefined) shape.endCap = endCap
  }
  if (flipH !== undefined) shape.flipH = flipH
  if (flipV !== undefined) shape.flipV = flipV
  // Rich runs + collapsed hyperlink — only attached for text-kind shapes
  // since they're meaningless on rect/ellipse/image/line outputs and would
  // just bloat the parser JSON in debug dumps.
  if (kind === 'text') {
    if (allRuns.length > 0) shape.textRuns = allRuns
    // ─── Per-paragraph block attributes ──────────────────────────────────
    // Resolve each source paragraph's effective list kind/level/glyph/format.
    // Own `<a:pPr>` declaration wins; absent ⇒ fall back to the inherited
    // (placeholder/master/txStyles) coarse kind. An explicit `<a:buNone/>`
    // (own or inherited-vetoed) yields a plain paragraph.
    //
    // `lvl` does not indent anything by itself in PowerPoint: it selects the
    // outline level whose `marL` applies. Narrative renders `level` as a fixed
    // per-level indent, so on a plain paragraph the level is kept only when
    // that level's margin, resolved down the same chain PowerPoint uses, is
    // actually non-zero. Keeping it unconditionally pushed the Proseware deck's
    // "We made it to our first Camp!" (lvl 1, marL 0, indent 0) 108 px right.
    const shapeLstStyle =
      txBody !== undefined ? findFirst(getChildren(txBody, 'p:txBody'), 'a:lstStyle') : undefined
    const shapeMargins =
      shapeLstStyle !== undefined
        ? readLevelMargins(getChildren(shapeLstStyle, 'a:lstStyle'))
        : undefined
    const marginLayers: Array<Array<number | undefined> | undefined> =
      slideShapePhType !== undefined
        ? [
            shapeMargins,
            inheritedPh?.levelMargins,
            txStyles[txStylesBucketFor(slideShapePhType)]?.levelMargins,
          ]
        : [shapeMargins, presentationLevelMarginsStore.get(theme)]
    // The shape's own list style, per outline level: the layer between a
    // paragraph's own `<a:pPr>` and the placeholder / master chain.
    const lstLevelDecls: Array<BulletDecl | undefined> = []
    if (shapeLstStyle !== undefined) {
      const lvls = getChildren(shapeLstStyle, 'a:lstStyle')
      for (let n = 1; n <= 9; n++) {
        const node = findFirst(lvls, `a:lvl${n}pPr`)
        lstLevelDecls.push(node !== undefined ? extractBulletDecl(node, `a:lvl${n}pPr`) : undefined)
      }
    }
    const paraAttrs: ParagraphAttrs[] = paraBulletDecls.map((own, i) => {
      const attrs: ParagraphAttrs = {}
      const level = paraLevels[i] ?? 0
      // Effective declaration: the paragraph's own, else its level in the
      // shape's list style, else the inherited coarse kind. An own 'none'
      // suppresses inheritance. A glyph that comes from the list style and
      // is the renderer's default for the level is "whatever the level
      // uses" (how a Narrative export writes a list item without a glyph of
      // its own), not a glyph the paragraph chose.
      let fromLevel = lstLevelDecls[level]
      if (fromLevel?.kind === 'bullet' && fromLevel.bulletChar === defaultBulletGlyph(level)) {
        fromLevel = { kind: 'bullet' }
      }
      const decl =
        own ??
        fromLevel ??
        (inheritedBulletKind !== undefined ? { kind: inheritedBulletKind } : undefined)
      const isList = decl !== undefined && decl.kind !== 'none'
      if (level > 0) {
        // A list keeps its nesting. A plain paragraph keeps the level only
        // when its margin is non-zero — or unknown, where no layer declared
        // one and the historical indent is the safer guess.
        const margin = paraOwnMargins[i] ?? firstLevelMargin(level, marginLayers)
        if (isList || margin === undefined || margin > 0) attrs.level = level
      }
      if (decl !== undefined && decl.kind !== 'none') {
        if (decl.kind === 'bullet') {
          attrs.list = 'bullet'
          if (decl.bulletChar !== undefined) attrs.bulletChar = decl.bulletChar
        } else {
          attrs.list = 'number'
          if (decl.numberFormat !== undefined) attrs.numberFormat = decl.numberFormat
          if (decl.startAt !== undefined) attrs.startAt = decl.startAt
        }
      }
      // A Narrative export's exact attributes, while the native ones still
      // read as what was written next to them.
      const exact = paraExts[i]
      if (exact !== undefined && exact.native === paragraphAttrsKey(attrs)) {
        const model = paragraphAttrsSchema(exact.model)
        if (model !== undefined) return model
      }
      return attrs
    })
    // Only attach when at least one paragraph carries list / level data —
    // a wholly plain frame keeps `paragraphs` undefined so the writer's
    // string fast-path (no per-paragraph separators) still applies.
    if (paraAttrs.some((a) => a.list !== undefined || a.level !== undefined)) {
      shape.paragraphs = paraAttrs
    }
    if (firstHyperlink !== undefined && shape.hyperlink === undefined)
      shape.hyperlink = firstHyperlink
    if (slideNumberFieldSeen && !otherTextSeen) shape.isSlideNumber = true
    if (frameWrap === 'none') shape.wrap = 'none'
    if (textInsets !== undefined) {
      shape.textInsets = {
        l: emuToPx(textInsets.l),
        t: emuToPx(textInsets.t),
        r: emuToPx(textInsets.r),
        b: emuToPx(textInsets.b),
      }
    }
    if (frameFontFamily !== undefined) shape.fontFamily = frameFontFamily
    if (frameLetterSpacing !== undefined) shape.letterSpacing = frameLetterSpacing
    if (frameLineHeight !== undefined) shape.lineHeight = frameLineHeight
    if (frameLineSpacing !== undefined) shape.lineSpacing = frameLineSpacing
    if (frameSpaceBefore !== undefined) shape.paragraphSpaceBefore = frameSpaceBefore
    if (frameSpaceAfter !== undefined) shape.paragraphSpaceAfter = frameSpaceAfter
    if (frameTextTransform !== undefined) shape.textTransform = frameTextTransform
    if (frameItalic !== undefined) shape.italic = frameItalic
    if (frameUnderline !== undefined) shape.underline = frameUnderline
    if (frameTextStrokeColor !== undefined) shape.textStrokeColor = frameTextStrokeColor
    if (frameTextStrokeAlpha !== undefined) shape.textStrokeAlpha = frameTextStrokeAlpha
    if (frameTextStrokeWidth !== undefined) shape.textStrokeWidth = frameTextStrokeWidth
  }
  return shape
}

// ---------------------------------------------------------------------------
// Slide-level
// ---------------------------------------------------------------------------

function parseBackground(
  sldChildren: XmlNode[],
  theme: ThemeColourMap,
  imageRels: ImageRelMap,
): ParsedBackground {
  const cSld = findFirst(sldChildren, 'p:cSld')
  if (!cSld) return { kind: 'none' }
  const cSldChildren = getChildren(cSld, 'p:cSld')
  const bg = findFirst(cSldChildren, 'p:bg')
  if (!bg) return { kind: 'none' }
  const bgChildren = getChildren(bg, 'p:bg')

  // `<p:bg>` carries EITHER `<p:bgPr>` (inline fill) OR `<p:bgRef>` (theme
  // reference). Inline first — it's the common authoring case.
  const bgPr = findFirst(bgChildren, 'p:bgPr')
  if (bgPr) {
    const bgPrChildren = getChildren(bgPr, 'p:bgPr')
    const solid = findFirst(bgPrChildren, 'a:solidFill')
    if (solid) {
      const c = parseColourAndAlphaFrom(solid, theme)
      if (c === undefined) return { kind: 'none' }
      const out: ParsedBackground = { kind: 'solid', color: c.color }
      if (c.alpha !== undefined) out.alpha = c.alpha
      return out
    }
    const gradFill = findFirst(bgPrChildren, 'a:gradFill')
    if (gradFill) {
      const gradient = parseGradient(gradFill, theme)
      if (gradient !== undefined) return { kind: 'gradient', gradient }
    }
    const blip = findFirst(bgPrChildren, 'a:blipFill')
    if (blip) {
      let relId: string | undefined
      let dim: number | undefined
      for (const desc of walk([blip])) {
        if (getTag(desc) === 'a:blip') {
          const embed = getAttrs(desc)['@r:embed']
          if (typeof embed === 'string') relId = embed
        } else if (getTag(desc) === 'a:lum') {
          // Narrative's dim is written as negative brightness.
          const bright = Number(getAttrs(desc)['@bright'])
          if (Number.isFinite(bright) && bright < 0) dim = Math.min(1, -bright / 100_000)
        }
      }
      const out: ParsedBackground = { kind: 'image' }
      if (dim !== undefined) out.dim = dim
      if (relId !== undefined) {
        out.blipRelId = relId
        const path = imageRels.get(relId)
        if (path !== undefined) out.imagePath = path
      }
      return out
    }
    return { kind: 'none' }
  }

  // `<p:bgRef idx>` references the theme's `<a:bgFillStyleLst>` entry at
  // (idx - 1000) and overrides its colour with the inline descriptor.
  // PowerPoint's `<a:bgFillStyleLst>` typically has 3 entries: subtle solid,
  // moderate gradient, intense gradient. We don't fully model the chosen
  // template — for v1 we extract the inline colour descriptor and emit a
  // solid background, which is the right answer for `idx="1001"` (the only
  // common case) and a faithful approximation for the gradient variants
  // (the colour is the dominant visual signal). The full theme bg style
  // expansion is a documented gap.
  const bgRef = findFirst(bgChildren, 'p:bgRef')
  if (bgRef) {
    const c = parseColourAndAlphaFrom(bgRef, theme)
    if (c !== undefined) return { kind: 'solid', color: c.color }
  }
  return { kind: 'none' }
}

/**
 * The speaker notes linked from a slide's rels (`…/notesSlide`), read by
 * `ooxml/notes.ts` — the notes editor's document, exact for a Narrative
 * export, formatted paragraphs and lists for any other deck. Undefined when
 * the slide has no notes page or the page has no body text.
 */
async function parseSlideNotes(zip: JSZip, slidePath: string): Promise<NotesDoc | undefined> {
  const dir = slidePath.substring(0, slidePath.lastIndexOf('/'))
  const file = slidePath.substring(slidePath.lastIndexOf('/') + 1)
  const relsEntry = zip.file(`${dir}/_rels/${file}.rels`)
  if (relsEntry === null) return undefined

  const xmlParser = ooxmlParser({ trimValues: false })
  let notesPath: string | undefined
  const relsTree = xmlParser.parse(await relsEntry.async('string')) as XmlNode[]
  for (const node of walk(relsTree)) {
    if (getTag(node) !== 'Relationship') continue
    const a = getAttrs(node)
    const type = a['@Type']
    const target = a['@Target']
    if (typeof type === 'string' && type.endsWith('/notesSlide') && typeof target === 'string') {
      notesPath = resolveRelPath(dir, target)
      break
    }
  }
  if (notesPath === undefined) return undefined
  const notesEntry = zip.file(notesPath)
  if (notesEntry === null) return undefined
  const notesTree = xmlParser.parse(await notesEntry.async('string')) as XmlNode[]
  const notes = findFirst(notesTree, 'p:notes')
  if (notes === undefined) return undefined
  const links = await loadHyperlinkRels(zip, notesPath)
  return readNotes(getChildren(notes, 'p:notes'), (rId) => {
    const link = links.get(rId)
    return link?.kind === 'url' ? link.href : undefined
  })
}

/**
 * Parse a `<p:graphicFrame>` containing a table (`<a:graphicData uri=".../table">`)
 * into a series of cell shapes. PowerPoint's tables nest deep:
 *
 *   <p:graphicFrame>
 *     <p:xfrm><a:off x y/><a:ext cx cy/></p:xfrm>
 *     <a:graphic><a:graphicData>
 *       <a:tbl>
 *         <a:tblPr/>
 *         <a:tblGrid><a:gridCol w="EMU"/>…</a:tblGrid>
 *         <a:tr h="EMU">
 *           <a:tc>
 *             <a:txBody>…</a:txBody>
 *             <a:tcPr><a:fill/>…<a:lnL/>…</a:tcPr>
 *           </a:tc>
 *           …
 *         </a:tr>
 *         …
 *
 * Narrative has no native table object, so we explode the table into one
 * rectangle + one text shape per cell, all sharing a single `groupId` so
 * the editor treats them as a group (P6 implicit-group semantics — the
 * user can drag the whole table at once, duplicate it, etc.).
 *
 * Cell coordinates are computed against the grid: `cell.x = tableX +
 * sum(colWidths[0..ci])`, `cell.w = colWidths[ci]`, same for y/h.
 * Merged cells (`gridSpan` / `rowSpan`) get a wider/taller rect; their
 * continuation cells (`hMerge` / `vMerge`) are skipped entirely so the
 * group doesn't carry empty placeholders.
 *
 * v1 limitations:
 *   - No per-cell border parsing (we draw a uniform thin gray grid).
 *   - No per-cell fill parsing (cells default to transparent).
 *   - No `<a:tblPr>` styling (banded rows, header row, etc.).
 *   - No header-style fall-through to placeholder defaults.
 */
/**
 * Resolve a chart `<p:graphicFrame>` to an image. PPTX charts are pure
 * vector content (`<c:chart>`) referencing a separate `ppt/charts/chartN.xml`
 * file that PowerPoint renders on display — Narrative has no chart renderer,
 * so we fall back to a poster image when one exists in the source file.
 *
 * Where pptx exporters typically stash the poster:
 *   1. Inside `<a:graphicData>` next to the `<c:chart>` element — some
 *      Google Slides exports embed a `<p:blipFill>` sibling carrying the
 *      pre-rendered PNG.
 *   2. As an `<mc:Fallback>` adjacent block under a parent
 *      `<mc:AlternateContent>` (handled by the parseSlide caller). When
 *      THIS function is reached without that route, we still scan the
 *      chart graphicFrame's subtree for any `<a:blip r:embed>` reference.
 *
 * Returns a ParsedShape of kind 'image' with the resolved imagePath, or
 * `null` when no fallback image can be located. The caller then either
 * gets an importable image at the chart's bbox or — if null — falls
 * through to a "Chart" placeholder rectangle.
 */
function parseChartFallback(graphicFrame: XmlNode, imageRels: ImageRelMap): ParsedShape | null {
  const gfChildren = getChildren(graphicFrame, 'p:graphicFrame')

  // Chart position + size from `<p:xfrm>` (same shape as parseTable).
  let xEmu = 0,
    yEmu = 0,
    wEmu = 0,
    hEmu = 0
  const xfrm = findFirst(gfChildren, 'p:xfrm')
  if (xfrm) {
    const xc = getChildren(xfrm, 'p:xfrm')
    const off = findFirst(xc, 'a:off')
    if (off) {
      const a = getAttrs(off)
      xEmu = Number(a['@x'] ?? 0)
      yEmu = Number(a['@y'] ?? 0)
    }
    const ext = findFirst(xc, 'a:ext')
    if (ext) {
      const a = getAttrs(ext)
      wEmu = Number(a['@cx'] ?? 0)
      hEmu = Number(a['@cy'] ?? 0)
    }
  }

  // Walk the whole graphicFrame subtree for ANY `<a:blip r:embed>` —
  // some exporters tuck the poster inside `<a:graphicData>`, others
  // inside `<c:chart>/<c:externalData>`, neither location is guaranteed.
  let blipRelId: string | undefined
  let imagePath: string | undefined
  for (const desc of walk([graphicFrame])) {
    if (getTag(desc) !== 'a:blip') continue
    const embed = getAttrs(desc)['@r:embed']
    if (typeof embed === 'string') {
      blipRelId = embed
      imagePath = imageRels.get(embed)
      if (imagePath !== undefined) break // first hit wins
    }
  }
  if (imagePath === undefined) return null

  const shape: ParsedShape = {
    kind: 'image',
    x: emuToPx(xEmu),
    y: emuToPx(yEmu),
    width: emuToPx(wEmu),
    height: emuToPx(hEmu),
    rotation: 0,
    sourceTag: 'p:graphicFrame',
    imagePath,
  }
  if (blipRelId !== undefined) shape.blipRelId = blipRelId
  return shape
}

/**
 * M29 Phase 4 — parse `<a:tbl>` into a single first-class table shape.
 *
 * Returns `null` when the table is empty or malformed; the caller skips
 * the slot entirely (no fallback rectangle in v1). Each `tableCells[r][c]`
 * carries its own text, style, padding, border, fill, and merge info —
 * the writer turns that into a `TableObject` via `buildTable` +
 * `setTableCellStyle` + `mergeTableCells`.
 *
 * `tableColWidths` / `tableRowHeights` are in PX (post `emuToPx`,
 * pre-scale). The writer rescales them to fit the table's bbox.
 *
 * Merge handling: the parsed grid is FULLY POPULATED (cells[r][c] exists
 * for every (r,c) in the grid). The origin cell carries `gridSpan` and
 * `rowSpan`; every covered slot gets `mergeOriginR`/`mergeOriginC`
 * pointers back to the origin. PPTX uses two-step encoding for vMerge
 * (a covered row's `<a:tc vMerge="1">` follows the origin's `<a:tc
 * rowSpan="N">` in the next N-1 rows) — we resolve both representations
 * to the same canonical form.
 */
function parseTable(
  graphicFrame: XmlNode,
  theme: ThemeColourMap,
  hyperlinkRels: HyperlinkRelMap,
  imageRels: ImageRelMap,
): ParsedShape | null {
  const gfChildren = getChildren(graphicFrame, 'p:graphicFrame')

  // Table position + size from `<p:xfrm>` (NOT `<a:xfrm>` — the
  // graphicFrame uses the p: namespace for its transform). EMU.
  let tableX = 0,
    tableY = 0,
    tableW = 0,
    tableH = 0
  const xfrm = findFirst(gfChildren, 'p:xfrm')
  if (xfrm) {
    const xc = getChildren(xfrm, 'p:xfrm')
    const off = findFirst(xc, 'a:off')
    if (off) {
      const a = getAttrs(off)
      tableX = Number(a['@x'] ?? 0)
      tableY = Number(a['@y'] ?? 0)
    }
    const ext = findFirst(xc, 'a:ext')
    if (ext) {
      const a = getAttrs(ext)
      tableW = Number(a['@cx'] ?? 0)
      tableH = Number(a['@cy'] ?? 0)
    }
  }

  // Drill down to <a:tbl> via the standard graphicData hierarchy.
  const graphic = findFirst(gfChildren, 'a:graphic')
  if (!graphic) return null
  const graphicData = findFirst(getChildren(graphic, 'a:graphic'), 'a:graphicData')
  if (!graphicData) return null
  const tbl = findFirst(getChildren(graphicData, 'a:graphicData'), 'a:tbl')
  if (!tbl) return null
  const tblChildren = getChildren(tbl, 'a:tbl')

  // Column widths (EMU) from `<a:tblGrid>/<a:gridCol w>`.
  const colWidthsEmu: number[] = []
  const tblGrid = findFirst(tblChildren, 'a:tblGrid')
  if (tblGrid) {
    for (const col of findAll(getChildren(tblGrid, 'a:tblGrid'), 'a:gridCol')) {
      const w = Number(getAttrs(col)['@w'] ?? 0)
      colWidthsEmu.push(w)
    }
  }
  if (colWidthsEmu.length === 0) return null

  const preset = parseTblPr(tblChildren)
  const allRows = findAll(tblChildren, 'a:tr')
  if (allRows.length === 0) return null
  const totalRows = allRows.length
  const totalCols = colWidthsEmu.length
  const rowHeightsEmu: number[] = []
  for (const row of allRows) rowHeightsEmu.push(Number(getAttrs(row)['@h'] ?? 0))

  // Pre-build a fully-populated cell matrix and walk the PPTX `<a:tc>`
  // sequence, stamping merge pointers as we go. A row has one `<a:tc>` per
  // grid column: the columns a `gridSpan` origin covers follow it as
  // `hMerge="1"` cells, and a `vMerge="1"` cell holds its column too. `ci`
  // is the column of the current `<a:tc>`. Some generators leave the
  // `hMerge` cells out; `spanEnd` then moves the next cell past the span.
  const tableCells: ParsedTableCell[][] = []
  for (let r = 0; r < totalRows; r++) {
    const row: ParsedTableCell[] = []
    for (let c = 0; c < totalCols; c++) row.push({ text: '' })
    tableCells.push(row)
  }

  for (let r = 0; r < totalRows; r++) {
    const rowNode = allRows[r]!
    const tcs = findAll(getChildren(rowNode, 'a:tr'), 'a:tc')
    let ci = 0
    let spanEnd = 0
    for (const tc of tcs) {
      const tcAttrs = getAttrs(tc)
      const isHMergeCont = tcAttrs['@hMerge'] === '1' || tcAttrs['@hMerge'] === 'true'
      const isVMergeCont = tcAttrs['@vMerge'] === '1' || tcAttrs['@vMerge'] === 'true'
      if (!isHMergeCont && ci < spanEnd) ci = spanEnd
      if (isHMergeCont || isVMergeCont) {
        // Continuation cell — origin must already be present (above or to
        // the left, depending on direction). Stamp pointer; the writer
        // will resolve via the matrix scan below.
        ci++
        continue
      }
      const gridSpan = Math.max(1, Number(tcAttrs['@gridSpan'] ?? 1))
      const rowSpan = Math.max(1, Number(tcAttrs['@rowSpan'] ?? 1))

      const cellStyle = parseCellStyle(tc, theme, imageRels)
      const targetCell = tableCells[r]?.[ci]
      spanEnd = ci + gridSpan
      if (targetCell === undefined) {
        ci++
        continue
      }
      // Fill + border.
      if (cellStyle.fillColor !== undefined) targetCell.fill = cellStyle.fillColor
      if (cellStyle.imagePath !== undefined) targetCell.imagePath = cellStyle.imagePath
      if (cellStyle.fillAlpha !== undefined) targetCell.fillAlpha = cellStyle.fillAlpha
      if (cellStyle.fillGradient !== undefined) targetCell.fillGradient = cellStyle.fillGradient
      if (
        targetCell.fill === undefined &&
        cellStyle.fillGradient === undefined &&
        cellStyle.fillAlpha === undefined
      ) {
        const presetFill = computePresetFill(preset, r, ci, totalRows, totalCols, theme)
        if (presetFill !== undefined) targetCell.fill = presetFill
      }
      // Per-edge borders — copy whichever edges PPTX declared so the
      // writer can stamp them onto the TableCell's per-edge override.
      const edgeBorder: NonNullable<ParsedTableCell['border']> = {}
      if (cellStyle.borderTop !== undefined) edgeBorder.top = cellStyle.borderTop
      if (cellStyle.borderRight !== undefined) edgeBorder.right = cellStyle.borderRight
      if (cellStyle.borderBottom !== undefined) edgeBorder.bottom = cellStyle.borderBottom
      if (cellStyle.borderLeft !== undefined) edgeBorder.left = cellStyle.borderLeft
      if (Object.keys(edgeBorder).length > 0) targetCell.border = edgeBorder
      // Padding from `<a:tcPr marL/marR/marT/marB>`. PPTX defaults
      // (when unspecified) are 91440 EMU L/R + 45720 EMU T/B; v1 reads
      // explicit values only and lets the writer fall back to Narrative's
      // standard 8px when absent.
      const tcPr = findFirst(getChildren(tc, 'a:tc'), 'a:tcPr')
      if (tcPr) {
        const a = getAttrs(tcPr)
        const padTop = a['@marT'] !== undefined ? emuToPx(Number(a['@marT'])) : undefined
        const padRight = a['@marR'] !== undefined ? emuToPx(Number(a['@marR'])) : undefined
        const padBottom = a['@marB'] !== undefined ? emuToPx(Number(a['@marB'])) : undefined
        const padLeft = a['@marL'] !== undefined ? emuToPx(Number(a['@marL'])) : undefined
        if (
          padTop !== undefined ||
          padRight !== undefined ||
          padBottom !== undefined ||
          padLeft !== undefined
        ) {
          targetCell.padding = {
            top: padTop ?? 8,
            right: padRight ?? 8,
            bottom: padBottom ?? 8,
            left: padLeft ?? 8,
          }
        }
        // Vertical anchor on `<a:tcPr anchor="t|ctr|b">`.
        const anchor = a['@anchor']
        if (anchor === 't') targetCell.vAlign = 'top'
        else if (anchor === 'ctr') targetCell.vAlign = 'middle'
        else if (anchor === 'b') targetCell.vAlign = 'bottom'
      }

      // Cell text. Re-use `parseShape` on a synthesised `<p:sp>` so the
      // cell text picks up the full run/style/hyperlink pipeline — same
      // pattern the legacy exploded-cell path used. The synthesised x/y/w/h
      // doesn't matter for the table (the writer uses the table bbox);
      // just need parseShape to produce text + textRuns + style fields.
      const cellTxBody = findFirst(getChildren(tc, 'a:tc'), 'a:txBody')
      if (cellTxBody) {
        const synthSp = synthesiseCellShape(cellTxBody, 0, 0, 1, 1)
        const txt = parseShape(synthSp, 'p:sp', theme, new Map(), new Map(), {}, hyperlinkRels)
        if (txt !== null && txt.kind === 'text') {
          targetCell.text = txt.text ?? ''
          if (txt.textRuns !== undefined) targetCell.textRuns = txt.textRuns
          if (txt.textColor !== undefined) targetCell.color = txt.textColor
          if (txt.fontSize !== undefined) targetCell.fontSize = txt.fontSize
          if (txt.bold === true) targetCell.fontWeight = 'bold'
          if (txt.fontFamily !== undefined) targetCell.fontFamily = txt.fontFamily
          if (txt.textAlign === 'left' || txt.textAlign === 'center' || txt.textAlign === 'right') {
            targetCell.align = txt.textAlign
          }
          if (txt.textVerticalAlign !== undefined && targetCell.vAlign === undefined) {
            targetCell.vAlign = txt.textVerticalAlign
          }
          // Advanced typography — same fields parseShape captures on text
          // frames. Writer aggregates uniform values into TableDefaults and
          // keeps the rest as per-cell overrides.
          if (txt.lineHeight !== undefined) {
            targetCell.lineHeight = txt.lineHeight
          } else if (txt.lineSpacing !== undefined) {
            // Cells have no metric resolver yet — the historical fold.
            targetCell.lineHeight = txt.lineSpacing * TABLE_CELL_LEADING_APPROX
          }
          if (txt.letterSpacing !== undefined) targetCell.letterSpacing = txt.letterSpacing
          if (txt.paragraphSpaceBefore !== undefined) {
            targetCell.paragraphSpaceBefore = txt.paragraphSpaceBefore
          }
          if (txt.paragraphSpaceAfter !== undefined) {
            targetCell.paragraphSpaceAfter = txt.paragraphSpaceAfter
          }
          if (txt.textTransform !== undefined && txt.textTransform !== 'none') {
            targetCell.textTransform = txt.textTransform
          }
        }
      }

      // Merge stamping. Origin owns gridSpan/rowSpan; continuation cells
      // get pointers back. We populate the matrix unconditionally — even
      // when subsequent `<a:tc>` siblings carry their own hMerge/vMerge
      // flags, our matrix-based stamping is the canonical source.
      if (gridSpan > 1 || rowSpan > 1) {
        targetCell.gridSpan = gridSpan
        targetCell.rowSpan = rowSpan
        for (let rr = r; rr < r + rowSpan && rr < totalRows; rr++) {
          for (let cc = ci; cc < ci + gridSpan && cc < totalCols; cc++) {
            if (rr === r && cc === ci) continue
            const cont = tableCells[rr]?.[cc]
            if (cont !== undefined) {
              cont.mergeOriginR = r
              cont.mergeOriginC = ci
            }
          }
        }
      }

      ci++
    }
  }

  // Sanity guard — at least one cell with content (text or fill) OR a
  // non-zero bbox. Otherwise treat as garbage and drop.
  if (tableW <= 0 || tableH <= 0) return null

  const shape: ParsedShape = {
    kind: 'table',
    x: emuToPx(tableX),
    y: emuToPx(tableY),
    width: emuToPx(tableW),
    height: emuToPx(tableH),
    rotation: xfrm !== undefined ? Number(getAttrs(xfrm)['@rot'] ?? 0) / PPTX_ROT_PER_DEG || 0 : 0,
    sourceTag: 'a:tbl',
    tableColWidths: colWidthsEmu.map(emuToPx),
    tableRowHeights: rowHeightsEmu.map(emuToPx),
    tableCells,
  }
  // The frame's non-visual properties: the id animations target, name, alt
  // text, click action, aspect lock and a Narrative export's extension.
  const nv = findFirst(gfChildren, 'p:nvGraphicFramePr')
  const cNvPr =
    nv !== undefined ? findFirst(getChildren(nv, 'p:nvGraphicFramePr'), 'p:cNvPr') : undefined
  if (cNvPr !== undefined) {
    const a = getAttrs(cNvPr)
    const id = Number(a['@id'])
    if (Number.isFinite(id)) shape.spId = id
    if (typeof a['@name'] === 'string' && a['@name'] !== '') shape.cnvName = a['@name']
    if (typeof a['@descr'] === 'string' && a['@descr'] !== '') shape.alt = a['@descr']
    const hlink = findFirst(getChildren(cNvPr, 'p:cNvPr'), 'a:hlinkClick')
    const rId = hlink !== undefined ? getAttrs(hlink)['@r:id'] : undefined
    const link = typeof rId === 'string' && rId !== '' ? hyperlinkRels.get(rId) : undefined
    if (link !== undefined) shape.hyperlink = link
  }
  if (readAspectLocked(nv)) shape.aspectLocked = true
  const narrative =
    xfrm !== undefined ? readNarrativeExt(cNvPr, frameFingerprintOf(xfrm)) : undefined
  if (narrative !== undefined) shape.narrative = narrative
  return shape
}

/**
 * Build an in-memory `<p:sp>` node wrapping a cell's `<a:txBody>` with a
 * concrete `<a:xfrm>` (so parseShape doesn't try to fall through to
 * placeholder defaults) and a `<a:prstGeom prst="rect">` (so kind
 * inference produces a rect-then-text-override result).
 *
 * The XmlNode shape mirrors what fast-xml-parser produces in preserveOrder
 * mode — children arrays under their tag key, attrs under `:@`.
 */
function synthesiseCellShape(
  txBody: XmlNode,
  xEmu: number,
  yEmu: number,
  wEmu: number,
  hEmu: number,
): XmlNode {
  const spPr: XmlNode = {
    'p:spPr': [
      {
        'a:xfrm': [
          { 'a:off': [], ':@': { '@x': String(xEmu), '@y': String(yEmu) } },
          { 'a:ext': [], ':@': { '@cx': String(wEmu), '@cy': String(hEmu) } },
        ],
      },
      {
        'a:prstGeom': [{ 'a:avLst': [] }],
        ':@': { '@prst': 'rect' },
      },
      { 'a:noFill': [] },
    ],
  }
  // Table cells use `<a:txBody>` (drawingml namespace); slide shapes use
  // `<p:txBody>` (presentationml). `parseShape` looks for `p:txBody`, so
  // we rewrap the cell's body under the expected key while preserving
  // its children + attrs verbatim. The children themselves use `a:p` /
  // `a:r` etc. — same namespace as slide shapes — so no further remapping
  // is needed inside.
  const txBodyChildren = (txBody['a:txBody'] as XmlNode[] | undefined) ?? []
  const remappedTxBody: XmlNode = { 'p:txBody': txBodyChildren }
  return { 'p:sp': [spPr, remappedTxBody] }
}

/**
 * Toggles on `<a:tblPr firstRow="1" lastRow="1" firstCol="1" lastCol="1"
 * bandRow="1" bandCol="1">`. The full PPTX behaviour is "look these up
 * in `ppt/tableStyles.xml` keyed by `<a:tableStyleId>`" — out of v1
 * scope; the parser uses these flags to drive a heuristic fill instead.
 */
interface TblPresetFlags {
  firstRow: boolean
  lastRow: boolean
  firstCol: boolean
  lastCol: boolean
  bandRow: boolean
  bandCol: boolean
}

function parseTblPr(tblChildren: XmlNode[]): TblPresetFlags {
  const tblPr = findFirst(tblChildren, 'a:tblPr')
  const empty: TblPresetFlags = {
    firstRow: false,
    lastRow: false,
    firstCol: false,
    lastCol: false,
    bandRow: false,
    bandCol: false,
  }
  if (!tblPr) return empty
  const a = getAttrs(tblPr)
  return {
    firstRow: a['@firstRow'] === '1' || a['@firstRow'] === 'true',
    lastRow: a['@lastRow'] === '1' || a['@lastRow'] === 'true',
    firstCol: a['@firstCol'] === '1' || a['@firstCol'] === 'true',
    lastCol: a['@lastCol'] === '1' || a['@lastCol'] === 'true',
    bandRow: a['@bandRow'] === '1' || a['@bandRow'] === 'true',
    bandCol: a['@bandCol'] === '1' || a['@bandCol'] === 'true',
  }
}

/**
 * Heuristic preset fill for a table cell with no explicit `<a:tcPr>` fill.
 * Mirrors PowerPoint's "medium 2" default table style (the one Office
 * applies when you insert a fresh table): coloured first row, then
 * alternating shades for banded rows.
 *
 *   firstRow=true               → theme accent1 (solid)
 *   lastRow=true on last row    → theme accent1 (slightly darker)
 *   firstCol / lastCol          → theme accent1 (solid)
 *   bandRow on odd data rows    → 80% tint of accent1 (alternating)
 *   bandCol on odd data cols    → 80% tint of accent1 (alternating)
 *
 * Returns undefined when no preset slot applies — the caller leaves the
 * cell transparent (PowerPoint's "no fill" body cells).
 *
 * Note: full fidelity requires reading the deck's `ppt/tableStyles.xml`
 * and resolving `<a:tableStyleId>` against the matching `<a:tblStyle>`
 * entry. That XML carries per-slot `<a:fill>` blocks (header /
 * band1H / band2H / wholeTbl / etc.). v1 cheats with this heuristic
 * because the visual delta is small on Office defaults and the resolution
 * pipeline would be substantial work for a relatively niche gap.
 */
function computePresetFill(
  preset: TblPresetFlags,
  rowIndex: number,
  colIndex: number,
  totalRows: number,
  totalCols: number,
  theme: ThemeColourMap,
): number | undefined {
  const accent = resolveSchemeColour('accent1', theme) ?? 0x4472c4
  // First / last row + first / last col win over band toggles — they're
  // PowerPoint's "highlight slot" cells. Banded fills sit underneath.
  const isFirstRow = preset.firstRow && rowIndex === 0
  const isLastRow = preset.lastRow && rowIndex === totalRows - 1
  const isFirstCol = preset.firstCol && colIndex === 0
  const isLastCol = preset.lastCol && colIndex === totalCols - 1
  if (isFirstRow || isLastRow || isFirstCol || isLastCol) {
    return accent
  }
  // Banded rows / cols: alternating fills. With `bandRow` PowerPoint
  // fills EVEN data rows (the ones the user sees as "shaded"), where
  // "data rows" are rows AFTER the header. We approximate that here.
  const dataRow = preset.firstRow ? rowIndex - 1 : rowIndex
  const dataCol = preset.firstCol ? colIndex - 1 : colIndex
  if (preset.bandRow && dataRow >= 0 && dataRow % 2 === 1) {
    return tintColour(accent, 0.85)
  }
  if (preset.bandCol && dataCol >= 0 && dataCol % 2 === 1) {
    return tintColour(accent, 0.85)
  }
  return undefined
}

/**
 * Lighten a hex colour toward white by `amount` (0..1). 0 = unchanged,
 * 1 = white. Matches PowerPoint's banded-row "lighter shade of accent"
 * defaults at ~0.85.
 */
function tintColour(color: number, amount: number): number {
  const { r, g, b } = unpackRgb(color)
  const t = clamp01(amount)
  const nr = Math.round(r + (255 - r) * t)
  const ng = Math.round(g + (255 - g) * t)
  const nb = Math.round(b + (255 - b) * t)
  return packRgb(nr, ng, nb)
}

/**
 * Per-cell visual styling from `<a:tcPr>`. PPTX cells can declare:
 *   <a:tcPr>
 *     <a:lnL w="EMU"><a:solidFill>…</a:solidFill></a:lnL>  // left edge
 *     <a:lnR …/>  <a:lnT …/>  <a:lnB …/>                    // other edges
 *     <a:solidFill>…</a:solidFill>   OR  <a:gradFill>…</a:gradFill>
 *                                    OR  <a:noFill/>
 *   </a:tcPr>
 *
 * Narrative's RectangleObject has ONE stroke (uniform on all sides) plus
 * ONE fill — so we collapse the per-edge borders into a single
 * representative stroke. The rule: pick the first edge that declares a
 * solidFill (priority L→R→T→B). When all four edges are `<a:noFill/>` we
 * return `strokeColor = undefined` to drop the stroke entirely (border-less
 * cells, common in headerless tables).
 *
 * Returns an object with only the fields the caller should apply — the
 * cell rect retains its uniform-grid defaults for any unspecified field.
 */
interface CellStyle {
  fillColor?: number
  fillAlpha?: number
  fillGradient?: ParsedGradient
  /** Per-edge borders extracted from `<a:tcPr>/<a:lnL|R|T|B>`. An edge
   *  with `<a:noFill/>` and no override is absent here so the renderer
   *  can fall back to the table-wide default. The four-edges-all-noFill
   *  case still surfaces as fully absent — Narrative's renderer treats
   *  an undefined cell.border as "inherit", so explicit suppression on
   *  every edge collapses into the same behaviour. */
  borderTop?: ParsedCellBorder
  borderRight?: ParsedCellBorder
  borderBottom?: ParsedCellBorder
  borderLeft?: ParsedCellBorder
  /** Zip path of a `<a:blipFill>` picture. */
  imagePath?: string
}

function parseCellStyle(tc: XmlNode, theme: ThemeColourMap, imageRels: ImageRelMap): CellStyle {
  const tcChildren = getChildren(tc, 'a:tc')
  const tcPr = findFirst(tcChildren, 'a:tcPr')
  if (!tcPr) return {}
  const tcPrChildren = getChildren(tcPr, 'a:tcPr')

  const out: CellStyle = {}

  // ─── Fill (solid / gradient / explicit none) ─────────────────────────────
  const solid = findFirst(tcPrChildren, 'a:solidFill')
  if (solid) {
    const c = parseColourAndAlphaFrom(solid, theme)
    if (c !== undefined) {
      out.fillColor = c.color
      if (c.alpha !== undefined) out.fillAlpha = c.alpha
    }
  } else {
    const grad = findFirst(tcPrChildren, 'a:gradFill')
    if (grad) {
      const g = parseGradient(grad, theme)
      if (g !== undefined) out.fillGradient = g
    }
    // A picture fill: its bytes are imported like any picture's.
    const pictureFill = findFirst(tcPrChildren, 'a:blipFill')
    const blipNode =
      pictureFill !== undefined
        ? findFirst(getChildren(pictureFill, 'a:blipFill'), 'a:blip')
        : undefined
    const embed = blipNode !== undefined ? getAttrs(blipNode)['@r:embed'] : undefined
    if (typeof embed === 'string') {
      const path = imageRels.get(embed)
      if (path !== undefined) out.imagePath = path
    }
  }
  // `<a:noFill/>` is explicit "no background" — same as not setting fill,
  // so we leave fillColor/fillGradient unset. The cell rect's default
  // (no fill key) makes it transparent.

  // ─── Per-edge borders ─────────────────────────────────────────────────────
  // Each `<a:lnL/R/T/B>` is captured independently so the writer can
  // emit a per-edge override on the TableCell. `<a:noFill/>` on a given
  // edge leaves that edge undefined in our output — the renderer's
  // default-fallback then re-introduces the table-wide grid border.
  // (Explicitly suppressing the default on every edge would require a
  // schema sentinel; deferred until a test case demands it.)
  const edges: Array<{ tag: string; key: keyof CellStyle }> = [
    { tag: 'a:lnT', key: 'borderTop' },
    { tag: 'a:lnR', key: 'borderRight' },
    { tag: 'a:lnB', key: 'borderBottom' },
    { tag: 'a:lnL', key: 'borderLeft' },
  ]
  for (const { tag, key } of edges) {
    const ln = findFirst(tcPrChildren, tag)
    if (!ln) continue
    const line = readLine(ln, theme)
    if (line.noFill === true || line.color === undefined) continue
    const border: ParsedCellBorder = {
      color: line.color,
      width: line.width !== undefined && line.width > 0 ? line.width : 1,
    }
    const prstDash = findFirst(getChildren(ln, tag), 'a:prstDash')
    const dash =
      prstDash !== undefined
        ? BORDER_DASH.fromXml(String(getAttrs(prstDash)['@val'] ?? ''))
        : undefined
    if (dash !== undefined && dash !== 'solid') border.dash = dash
    if (line.alpha !== undefined && line.alpha < 1) border.alpha = line.alpha
    ;(out as Record<string, unknown>)[key] = border
  }

  return out
}

/**
 * Composable group-coordinate transform. A `<p:grpSp>` introduces its own
 * `<a:xfrm>` with `<a:off>` + `<a:ext>` (the group's slot in the parent's
 * coordinate frame) AND `<a:chOff>` + `<a:chExt>` (the child-local
 * coordinate frame). A child shape with its own `<a:off cx>` / `<a:ext cw>`
 * in the child-local frame maps to slide-space via:
 *
 *   slideX = parent.x + parent.scaleX * (cx - chOffX) * (extX / chExtX) + parent.scaleX * offX
 *
 * The same formula expressed as an affine transform `(offset, scale)` and
 * composed across nested groups. The slide-level transform is identity.
 */
interface GroupTransform {
  x: number
  y: number
  scaleX: number
  scaleY: number
}
const IDENTITY_GROUP_TRANSFORM: GroupTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 }

/**
 * PPTX allows a single `<p:sp>` to carry BOTH a `prstGeom` outline
 * (rect / roundRect / ellipse) AND a `<p:txBody>` with text. Narrative
 * splits these — TextObject doesn't model a stroke around its bounding
 * box, only around glyph fills. When the parser identified a text-
 * bearing shape that ALSO has a real geometry (stroke, fill, or a
 * roundRect prst), this helper returns the underlying outline as a
 * separate ParsedShape that callers slot in BEHIND the text frame.
 *
 * Returns `null` when there's nothing to recover (no stroke, no real
 * fill, and no rounded prst) — the common case for plain text
 * placeholders, which should stay as a single shape.
 *
 * Slide 8's "1 - AUGMENTATION" etc. labels surface this code path:
 * each is a `<p:sp prstGeom prst="roundRect">` with a lime-green
 * stroke + the label text inside. Without the split the lime borders
 * disappear and only the text remains.
 */
/**
 * Add a parsed shape to a slide's list. A text-bearing shape with geometry
 * of its own goes in as two: the geometry first (`extractGeometryUnderText`),
 * the text frame on top — children render in array order.
 */
function pushWithGeometry(shapes: ParsedShape[], shape: ParsedShape): void {
  const underlay = extractGeometryUnderText(shape)
  if (underlay !== null) shapes.push(underlay)
  shapes.push(shape)
}

function extractGeometryUnderText(shape: ParsedShape): ParsedShape | null {
  if (shape.kind !== 'text') return null
  const g = shape.geometryKind
  // Geometry the model can draw: a rectangle (rounded or not), ellipse,
  // triangle, regular polygon, or a custom path.
  if (g !== 'rectangle' && g !== 'ellipse' && g !== 'triangle' && g !== 'polygon' && g !== 'path')
    return null
  if (g === 'path' && (shape.pathAnchors === undefined || shape.pathAnchors.length === 0))
    return null
  const hasStroke = shape.strokeColor !== undefined && (shape.strokeWidth ?? 0) > 0
  const hasFill =
    shape.fillColor !== undefined ||
    shape.fillGradient !== undefined ||
    shape.imagePath !== undefined
  const wantsRoundedCorners = shape.prstGeom === 'roundRect'
  if (!hasStroke && !hasFill && !wantsRoundedCorners) return null
  const underlay: ParsedShape = {
    kind: g,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    rotation: shape.rotation,
    sourceTag: shape.sourceTag,
  }
  if (shape.fillColor !== undefined) underlay.fillColor = shape.fillColor
  if (shape.fillAlpha !== undefined) underlay.fillAlpha = shape.fillAlpha
  if (shape.fillGradient !== undefined) underlay.fillGradient = shape.fillGradient
  if (shape.imagePath !== undefined) underlay.imagePath = shape.imagePath
  if (shape.strokeColor !== undefined) underlay.strokeColor = shape.strokeColor
  if (shape.strokeAlpha !== undefined) underlay.strokeAlpha = shape.strokeAlpha
  if (shape.strokeWidth !== undefined) underlay.strokeWidth = shape.strokeWidth
  if (shape.strokeDash === true) underlay.strokeDash = true
  if (shape.flipH === true) underlay.flipH = true
  if (shape.flipV === true) underlay.flipV = true
  if (shape.groupId !== undefined) underlay.groupId = shape.groupId
  if (shape.shadow !== undefined) underlay.shadow = shape.shadow
  if (shape.blur !== undefined) underlay.blur = shape.blur
  if (shape.cornerRadius !== undefined) underlay.cornerRadius = shape.cornerRadius
  if (shape.sides !== undefined) underlay.sides = shape.sides
  if (shape.pathAnchors !== undefined) underlay.pathAnchors = shape.pathAnchors
  if (shape.pathClosed === true) underlay.pathClosed = true
  // The geometry belongs to the underlay now; the text frame keeps its text.
  delete shape.fillColor
  delete shape.fillAlpha
  delete shape.fillGradient
  delete shape.imagePath
  delete shape.strokeColor
  delete shape.strokeAlpha
  delete shape.strokeWidth
  delete shape.strokeDash
  delete shape.cornerRadius
  delete shape.sides
  delete shape.pathAnchors
  delete shape.pathClosed
  delete shape.prstGeom
  return underlay
}

function applyGroupTransform(shape: ParsedShape, t: GroupTransform): void {
  if (t === IDENTITY_GROUP_TRANSFORM) return
  shape.x = shape.x * t.scaleX + t.x
  shape.y = shape.y * t.scaleY + t.y
  shape.width = shape.width * t.scaleX
  shape.height = shape.height * t.scaleY
  // Path anchors live in slide-local px (see parseCustGeomAnchors), so
  // the group transform has to bake into them too — otherwise the writer
  // subtracts the *transformed* shape origin from the *untransformed*
  // anchor coords and the path explodes to the slide's top-left.
  // Control-point deltas are relative to their anchor and only need
  // scaling, not translation.
  if (shape.pathAnchors !== undefined) {
    for (const a of shape.pathAnchors) {
      a.x = a.x * t.scaleX + t.x
      a.y = a.y * t.scaleY + t.y
      if (a.cpIn !== undefined) {
        a.cpIn.x = a.cpIn.x * t.scaleX
        a.cpIn.y = a.cpIn.y * t.scaleY
      }
      if (a.cpOut !== undefined) {
        a.cpOut.x = a.cpOut.x * t.scaleX
        a.cpOut.y = a.cpOut.y * t.scaleY
      }
    }
  }
  // imageRect (from `<a:srcRect>` cropping) was computed in the same
  // local coord system as shape.x/y/w/h — see parseShape's srcRect
  // block. The group transform must apply to it too or the cropped
  // sprite renders at pre-group coordinates while the shape's bounding
  // box moves with the group → sprite lands far off-slide and looks
  // "missing" to the user. Slide 2's ACME logo (image5.png with
  // srcRect b="23%") was this case.
  if (shape.imageRect !== undefined) {
    shape.imageRect.x = shape.imageRect.x * t.scaleX + t.x
    shape.imageRect.y = shape.imageRect.y * t.scaleY + t.y
    shape.imageRect.width *= t.scaleX
    shape.imageRect.height *= t.scaleY
  }
}

/**
 * Recursively flattens a `<p:grpSp>` into a list of shapes whose coords
 * have been mapped to slide-space. Narrative has no native "group" object,
 * so we bake every descendant out and tag them with a shared `groupId`
 * (the OOXML `<p:cNvPr id>` of the outermost containing `<p:grpSp>`) so
 * the user can re-select the group with one click in the editor.
 */
function flattenGroupShape(
  grpSp: XmlNode,
  parentTransform: GroupTransform,
  groupId: string,
  theme: ThemeColourMap,
  placeholders: PlaceholderMap,
  imageRels: ImageRelMap,
  txStyles: TxStylesByBucket,
  hyperlinkRels: HyperlinkRelMap,
  inheritedGroupFill: GroupFill | undefined = undefined,
): ParsedShape[] {
  const out: ParsedShape[] = []
  const grpChildren = getChildren(grpSp, 'p:grpSp')
  // Compose the group's xfrm with the parent.
  const grpSpPr = findFirst(grpChildren, 'p:grpSpPr')
  let newTransform = parentTransform
  // Pull the group's own fill — used by any child that declares
  // `<a:grpFill/>` instead of an inline solidFill / gradFill. Inner
  // groups override outer groups (closest enclosing wins).
  let groupFill: GroupFill | undefined = inheritedGroupFill
  if (grpSpPr !== undefined) {
    const grpSpPrChildren = getChildren(grpSpPr, 'p:grpSpPr')
    const ownSolid = findFirst(grpSpPrChildren, 'a:solidFill')
    if (ownSolid !== undefined) {
      const c = parseColourAndAlphaFrom(ownSolid, theme)
      if (c !== undefined) {
        const next: GroupFill = { color: c.color }
        if (c.alpha !== undefined) next.alpha = c.alpha
        groupFill = next
      }
    } else {
      const ownGrad = findFirst(grpSpPrChildren, 'a:gradFill')
      if (ownGrad !== undefined) {
        const gradient = parseGradient(ownGrad, theme)
        if (gradient !== undefined) groupFill = { gradient }
      }
    }
  }
  if (grpSpPr !== undefined) {
    const xfrm = findFirst(getChildren(grpSpPr, 'p:grpSpPr'), 'a:xfrm')
    if (xfrm !== undefined) {
      const xc = getChildren(xfrm, 'a:xfrm')
      const off = findFirst(xc, 'a:off')
      const ext = findFirst(xc, 'a:ext')
      const chOff = findFirst(xc, 'a:chOff')
      const chExt = findFirst(xc, 'a:chExt')
      if (off !== undefined && ext !== undefined && chOff !== undefined && chExt !== undefined) {
        const offX = emuToPx(Number(getAttrs(off)['@x'] ?? 0))
        const offY = emuToPx(Number(getAttrs(off)['@y'] ?? 0))
        const extX = emuToPx(Number(getAttrs(ext)['@cx'] ?? 0))
        const extY = emuToPx(Number(getAttrs(ext)['@cy'] ?? 0))
        const chOffX = emuToPx(Number(getAttrs(chOff)['@x'] ?? 0))
        const chOffY = emuToPx(Number(getAttrs(chOff)['@y'] ?? 0))
        const chExtX = emuToPx(Number(getAttrs(chExt)['@cx'] ?? 0))
        const chExtY = emuToPx(Number(getAttrs(chExt)['@cy'] ?? 0))
        // Guard against degenerate xfrms (some authors emit zero extents
        // on outer wrappers). Treat as identity within the group rather
        // than collapsing every child to a single point.
        const scaleX = chExtX > 0 ? extX / chExtX : 1
        const scaleY = chExtY > 0 ? extY / chExtY : 1
        newTransform = {
          x: parentTransform.x + parentTransform.scaleX * (offX - chOffX * scaleX),
          y: parentTransform.y + parentTransform.scaleY * (offY - chOffY * scaleY),
          scaleX: parentTransform.scaleX * scaleX,
          scaleY: parentTransform.scaleY * scaleY,
        }
      }
    }
  }
  for (const node of grpChildren) {
    const tag = getTag(node)
    if (tag === 'p:sp' || tag === 'p:pic' || tag === 'p:cxnSp') {
      const shape = parseShape(
        node,
        tag,
        theme,
        placeholders,
        imageRels,
        txStyles,
        hyperlinkRels,
        groupFill,
      )
      if (shape !== null) {
        // Same text+geometry split as the slide-level traversal —
        // see `extractGeometryUnderText`. Split BEFORE applying the
        // group transform so both halves get the same translation +
        // scaling; underlay first so the text renders on top.
        const underlay = extractGeometryUnderText(shape)
        if (underlay !== null) {
          applyGroupTransform(underlay, newTransform)
          if (underlay.groupId === undefined) underlay.groupId = groupId
          out.push(underlay)
        }
        applyGroupTransform(shape, newTransform)
        if (shape.groupId === undefined) shape.groupId = groupId
        out.push(shape)
      }
    } else if (tag === 'p:graphicFrame') {
      // Tables / charts inside groups — same dispatch as the top-level
      // spTree handler; coords get transformed after the fact.
      const gfChildren = getChildren(node, 'p:graphicFrame')
      const graphic = findFirst(gfChildren, 'a:graphic')
      const gd = graphic ? findFirst(getChildren(graphic, 'a:graphic'), 'a:graphicData') : undefined
      const uri = gd !== undefined ? String(getAttrs(gd)['@uri'] ?? '') : ''
      if (uri.endsWith('/table')) {
        const tableShape = parseTable(node, theme, hyperlinkRels, imageRels)
        if (tableShape !== null) {
          applyGroupTransform(tableShape, newTransform)
          if (tableShape.groupId === undefined) tableShape.groupId = groupId
          out.push(tableShape)
        }
      } else if (uri.endsWith('/chart')) {
        const chartShape = parseChartFallback(node, imageRels)
        if (chartShape !== null) {
          applyGroupTransform(chartShape, newTransform)
          if (chartShape.groupId === undefined) chartShape.groupId = groupId
          out.push(chartShape)
        }
      }
    } else if (tag === 'p:grpSp') {
      out.push(
        ...flattenGroupShape(
          node,
          newTransform,
          groupId,
          theme,
          placeholders,
          imageRels,
          txStyles,
          hyperlinkRels,
          groupFill,
        ),
      )
    }
  }
  return out
}

function parseSlide(
  xml: string,
  sourceName: string,
  ignoredAcc: Set<string>,
  theme: ThemeColourMap,
  context: SlideContext,
  imageRels: ImageRelMap,
  hyperlinkRels: HyperlinkRelMap = new Map(),
): ParsedSlide {
  const xmlParser = ooxmlParser({ trimValues: false })
  const tree = xmlParser.parse(xml) as XmlNode[]

  // Track every tag for diagnostics.
  for (const node of walk(tree)) {
    const tag = getTag(node)
    if (tag !== null && !MVP_ELEMENTS.has(tag)) ignoredAcc.add(tag)
  }

  const sld = findFirst(tree, 'p:sld')
  if (!sld) {
    return { source: sourceName, background: { kind: 'none' }, shapes: [] }
  }
  const sldChildren = getChildren(sld, 'p:sld')

  // Background cascade: slide → layout → master. `parseBackground` returns
  // `{ kind: 'none' }` when the slide doesn't declare its own bg; that's the
  // signal to substitute the layout/master fallback from the context.
  let background = parseBackground(sldChildren, theme, imageRels)
  if (background.kind === 'none') {
    background = context.fallbackBackground
  }

  // Slide-level `showMasterSp` opt-out — when false, suppress master shapes
  // for THIS slide regardless of what the layout said. Layout-level opt-out
  // was already applied in `buildSlideContexts` (zeroed `masterShapes`).
  const slideShowMasterSp = getAttrs(sld)['@showMasterSp']
  const slideHidesMaster = slideShowMasterSp === '0' || slideShowMasterSp === 'false'

  const cSld = findFirst(sldChildren, 'p:cSld')
  const cSldChildren = cSld ? getChildren(cSld, 'p:cSld') : []
  const spTree = findFirst(cSldChildren, 'p:spTree')
  const spTreeChildren = spTree ? getChildren(spTree, 'p:spTree') : []

  // Paint order is back-to-front: master non-ph shapes → layout non-ph shapes
  // → slide's own shapes. The slide's own placeholder overrides naturally
  // sit on top because they appear after the baked layers in `shapes`.
  const shapes: ParsedShape[] = []
  if (!slideHidesMaster) {
    shapes.push(...context.masterShapes)
  }
  shapes.push(...context.layoutShapes)

  for (const node of spTreeChildren) {
    const tag = getTag(node)
    if (tag === 'p:sp' || tag === 'p:pic' || tag === 'p:cxnSp') {
      const shape = parseShape(
        node,
        tag,
        theme,
        context.placeholders,
        imageRels,
        context.txStyles,
        hyperlinkRels,
      )
      if (shape !== null) pushWithGeometry(shapes, shape)
    } else if (tag === 'p:graphicFrame') {
      // Tables nest inside graphicFrame → graphicData → tbl. Charts use
      // the same graphicFrame envelope but with a `/chart` URI; we route
      // those to `parseChartFallback`, which looks for a poster image
      // adjacent to the chart spec. SmartArt + embedded OLE fall to the
      // ignored list with no shape emitted.
      const gfChildren = getChildren(node, 'p:graphicFrame')
      const graphic = findFirst(gfChildren, 'a:graphic')
      const gd = graphic ? findFirst(getChildren(graphic, 'a:graphic'), 'a:graphicData') : undefined
      const uri = gd !== undefined ? String(getAttrs(gd)['@uri'] ?? '') : ''
      if (uri.endsWith('/table')) {
        const tableShape = parseTable(node, theme, hyperlinkRels, imageRels)
        if (tableShape !== null) shapes.push(tableShape)
      } else if (uri.endsWith('/chart')) {
        const chartShape = parseChartFallback(node, imageRels)
        if (chartShape !== null) shapes.push(chartShape)
      }
    } else if (tag === 'mc:AlternateContent') {
      // `<mc:AlternateContent>` wraps modern-format content (charts,
      // SmartArt) with a legacy `<mc:Fallback>` image. We always take the
      // fallback path — that's a pixel-perfect snapshot of the rendered
      // chart Office captured at save time. Modern viewers reopen the
      // chart spec instead, but our import doesn't currently render charts.
      const acChildren = getChildren(node, 'mc:AlternateContent')
      const fallback = findFirst(acChildren, 'mc:Fallback')
      if (fallback) {
        for (const fbChild of getChildren(fallback, 'mc:Fallback')) {
          const fbTag = getTag(fbChild)
          if (fbTag === 'p:pic') {
            const shape = parseShape(
              fbChild,
              'p:pic',
              theme,
              context.placeholders,
              imageRels,
              context.txStyles,
              hyperlinkRels,
            )
            if (shape !== null) pushWithGeometry(shapes, shape)
          } else if (fbTag === 'p:sp') {
            const shape = parseShape(
              fbChild,
              'p:sp',
              theme,
              context.placeholders,
              imageRels,
              context.txStyles,
              hyperlinkRels,
            )
            if (shape !== null) pushWithGeometry(shapes, shape)
          }
        }
      }
    } else if (tag === 'p:grpSp') {
      // OOXML groups — flatten recursively. Narrative has no native group
      // object; we bake every descendant out and tag them with a shared
      // `groupId` so the user can re-select the cluster in one click.
      const grpChildren = getChildren(node, 'p:grpSp')
      const nvGrpSpPr = findFirst(grpChildren, 'p:nvGrpSpPr')
      let groupId = `grp-${shapes.length}`
      if (nvGrpSpPr !== undefined) {
        const cNvPr = findFirst(getChildren(nvGrpSpPr, 'p:nvGrpSpPr'), 'p:cNvPr')
        if (cNvPr !== undefined) {
          const id = getAttrs(cNvPr)['@id']
          if (typeof id === 'string') groupId = `grp-${id}`
        }
      }
      const flat = flattenGroupShape(
        node,
        IDENTITY_GROUP_TRANSFORM,
        groupId,
        theme,
        context.placeholders,
        imageRels,
        context.txStyles,
        hyperlinkRels,
      )
      shapes.push(...flat)
    }
  }

  // ─── Slide name + skipped flag ─────────────────────────────────────────
  // `<p:cSld name="…">` carries an optional slide title. `<p:sld show="0">`
  // marks the slide as hidden in presenter mode (PowerPoint draws a
  // diagonal line over hidden slides in the slide-sorter view).
  let slideName: string | undefined
  if (cSld) {
    const v = getAttrs(cSld)['@name']
    if (typeof v === 'string' && v.length > 0) slideName = v
  }
  const showAttr = getAttrs(sld)['@show']
  const skipped = showAttr === '0' || showAttr === 'false'

  // ─── Slide transition ──────────────────────────────────────────────────
  const transition = readTransition(sldChildren)

  // ─── Animations (from `<p:timing>`) ────────────────────────────────────
  // We extract entrance / exit / emphasis presets keyed by their PPTX
  // presetID and presetClass. Each effect carries a target spId (the
  // integer `<p:cNvPr id>` of the shape it animates) which the writer
  // then resolves to the SlideObject.id assigned when shapes were
  // mapped. Lossy: the PPTX timing tree's nested click/withEffect
  // semantics collapse to Narrative's flat {trigger, delay} fields.
  const animations: ParsedAnimationStep[] = readTiming(sldChildren).map((step) => {
    const out: ParsedAnimationStep = {
      spId: step.spid,
      preset: step.preset,
      trigger: step.trigger,
      duration: step.duration,
      delay: step.delay,
    }
    if (step.easing !== undefined) out.easing = step.easing
    if (step.params !== undefined) out.params = step.params
    return out
  })
  const slideExt = readSlideExt(sldChildren)
  const narrative = slideExt !== undefined ? slideExtFields(slideExt) : undefined

  const out: ParsedSlide = { source: sourceName, background, shapes }
  if (narrative !== undefined && Object.keys(narrative).length > 0) out.narrative = narrative
  if (slideName !== undefined) out.name = slideName
  if (skipped) out.skipped = true
  if (transition !== undefined) out.transition = transition
  if (animations.length > 0) out.animations = animations
  return out
}

/**
 * Read `ppt/theme/theme1.xml` (if present) and build a scheme-name → hex map.
 * On error or absent theme, returns the empty map (callers fall through to
 * `DEFAULT_THEME` for resolution).
 */
async function parseThemeColours(zip: JSZip): Promise<ThemeColourMap> {
  const themeEntry = zip.file('ppt/theme/theme1.xml')
  if (themeEntry === null) return {}
  const xml = await themeEntry.async('string')
  const xmlParser = ooxmlParser()
  const tree = xmlParser.parse(xml) as XmlNode[]
  const map: ThemeColourMap = {}
  // Walk to the clrScheme node; its direct children are named slots whose
  // colour child is either srgbClr (hex) or sysClr (uses lastClr fallback).
  for (const node of walk(tree)) {
    if (getTag(node) !== 'a:clrScheme') continue
    const slots = getChildren(node, 'a:clrScheme')
    for (const slot of slots) {
      const slotName = getTag(slot)
      if (slotName === null || !slotName.startsWith('a:')) continue
      const bareName = slotName.slice(2) // 'a:accent1' → 'accent1'
      const slotChildren = getChildren(slot, slotName)
      for (const colourNode of slotChildren) {
        const cTag = getTag(colourNode)
        const a = getAttrs(colourNode)
        if (cTag === 'a:srgbClr') {
          const v = parseHexColour(typeof a['@val'] === 'string' ? (a['@val'] as string) : '')
          if (v !== undefined) {
            map[bareName] = v
            break
          }
        } else if (cTag === 'a:sysClr') {
          const lastClr =
            typeof a['@lastClr'] === 'string' ? parseHexColour(a['@lastClr'] as string) : undefined
          if (lastClr !== undefined) {
            map[bareName] = lastClr
            break
          }
        }
      }
    }
    break // first clrScheme is the active one
  }

  // Font scheme — the two typefaces `+mj-*` / `+mn-*` references resolve to.
  // Recorded on the side-band store keyed by this map (see themeFontStore).
  const fonts: ThemeFonts = {}
  for (const node of walk(tree)) {
    if (getTag(node) !== 'a:fontScheme') continue
    for (const slot of getChildren(node, 'a:fontScheme')) {
      const slotTag = getTag(slot)
      if (slotTag !== 'a:majorFont' && slotTag !== 'a:minorFont') continue
      const latin = findFirst(getChildren(slot, slotTag), 'a:latin')
      if (latin === undefined) continue
      const tf = getAttrs(latin)['@typeface']
      if (typeof tf !== 'string' || tf.trim().length === 0) continue
      if (slotTag === 'a:majorFont') fonts.major = tf.trim()
      else fonts.minor = tf.trim()
    }
    break // first fontScheme is the active one
  }
  if (fonts.major !== undefined || fonts.minor !== undefined) {
    themeFontStore.set(map, fonts)
  }

  return map
}

/**
 * Parse `<a:theme>/<a:objectDefaults>/<a:txDef>/<a:lstStyle>/<a:defPPr>/
 * <a:defRPr>` from theme1.xml. This is the OOXML-defined "default text
 * style for an unstyled text-box shape" — the lowest layer in the run
 * property inheritance chain for non-placeholder text. Returns `undefined`
 * when the theme has no `<a:txDef>` (older themes / non-Office sources).
 */
async function parseThemeTxDef(zip: JSZip, theme: ThemeColourMap): Promise<ThemeTxDef | undefined> {
  const themeEntry = zip.file('ppt/theme/theme1.xml')
  if (themeEntry === null) return undefined
  const xml = await themeEntry.async('string')
  const xmlParser = ooxmlParser()
  const tree = xmlParser.parse(xml) as XmlNode[]
  let txDef: XmlNode | undefined
  for (const node of walk(tree)) {
    if (getTag(node) === 'a:txDef') {
      txDef = node
      break
    }
  }
  if (txDef === undefined) return undefined
  // Find <a:txDef>/<a:lstStyle>/<a:defPPr>/<a:defRPr> (the no-explicit-lvl
  // default). Fall back to lvl1pPr's defRPr if defPPr is absent.
  const lstStyle = findFirst(getChildren(txDef, 'a:txDef'), 'a:lstStyle')
  if (lstStyle === undefined) return undefined
  const lstChildren = getChildren(lstStyle, 'a:lstStyle')
  const defPPr = findFirst(lstChildren, 'a:defPPr') ?? findFirst(lstChildren, 'a:lvl1pPr')
  if (defPPr === undefined) return undefined
  const defPPrTag = getTag(defPPr)
  if (defPPrTag === null) return undefined
  const defRPr = findFirst(getChildren(defPPr, defPPrTag), 'a:defRPr')
  if (defRPr === undefined) return undefined
  const out: ThemeTxDef = {}
  const a = getAttrs(defRPr)
  const sz = a['@sz']
  if (typeof sz === 'string') {
    const v = Number(sz)
    if (Number.isFinite(v)) out.fontSize = v * PPTX_FONT_TO_PX
  }
  if (a['@b'] === '1' || a['@b'] === 'true') out.bold = true
  if (a['@i'] === '1' || a['@i'] === 'true') out.italic = true
  if (typeof a['@u'] === 'string' && a['@u'] !== 'none') out.underline = true
  const defRPrChildren = getChildren(defRPr, 'a:defRPr')
  const solid = findFirst(defRPrChildren, 'a:solidFill')
  if (solid !== undefined) {
    const c = parseColourAndAlphaFrom(solid, theme)
    if (c !== undefined) {
      out.color = c.color
      if (c.alpha !== undefined) out.colorAlpha = c.alpha
    }
  }
  const latin = findFirst(defRPrChildren, 'a:latin')
  if (latin !== undefined) {
    // `+mn-lt` / `+mj-lt` are theme-font references; `resolveTypeface` maps
    // them onto the theme's minor/major faces so the deck gets a real font
    // name instead of raw OOXML markup (or nothing at all).
    const tf = resolveTypeface(getAttrs(latin)['@typeface'], theme)
    if (tf !== undefined) {
      out.fontFamily = tf
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Presentation-level (slide order + dimensions)
// ---------------------------------------------------------------------------

/**
 * Per-level `marL` from `ppt/presentation.xml` `<p:defaultTextStyle>`, or
 * undefined when the file has none.
 */
async function parseDefaultTextStyleMargins(
  zip: JSZip,
): Promise<Array<number | undefined> | undefined> {
  const entry = zip.file('ppt/presentation.xml')
  if (entry === null) return undefined
  const xmlParser = ooxmlParser()
  const tree = xmlParser.parse(await entry.async('string')) as XmlNode[]
  for (const node of walk(tree)) {
    if (getTag(node) !== 'p:defaultTextStyle') continue
    const margins = readLevelMargins(getChildren(node, 'p:defaultTextStyle'))
    return margins.some((m) => m !== undefined) ? margins : undefined
  }
  return undefined
}

async function parsePresentationXml(zip: JSZip): Promise<{
  slidePaths: string[]
  slideWidth: number
  slideHeight: number
}> {
  const presEntry = zip.file('ppt/presentation.xml')
  const relsEntry = zip.file('ppt/_rels/presentation.xml.rels')
  if (presEntry === null || relsEntry === null) {
    // Fall back: enumerate slides directly.
    const slidePaths = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const an = Number(a.match(/slide(\d+)\.xml/)?.[1] ?? 0)
        const bn = Number(b.match(/slide(\d+)\.xml/)?.[1] ?? 0)
        return an - bn
      })
    return { slidePaths, slideWidth: 1280, slideHeight: 720 }
  }

  const xmlParser = ooxmlParser()

  // ─── Dimensions ─────────────────────────────────────────────────────────
  const presXml = await presEntry.async('string')
  const presTree = xmlParser.parse(presXml) as XmlNode[]
  let slideWidth = 1280,
    slideHeight = 720
  for (const node of walk(presTree)) {
    if (getTag(node) === 'p:sldSz') {
      const a = getAttrs(node)
      const cx = Number(a['@cx'] ?? 0)
      const cy = Number(a['@cy'] ?? 0)
      if (cx > 0) slideWidth = emuToPx(cx)
      if (cy > 0) slideHeight = emuToPx(cy)
      break
    }
  }

  // ─── Slide order via rels ───────────────────────────────────────────────
  // <Relationship Id="rId1" Type=".../slide" Target="slides/slide1.xml"/>
  // Order: presentation.xml's <p:sldIdLst>/<p:sldId r:id="rId1" .../>
  const relsXml = await relsEntry.async('string')
  const relsTree = xmlParser.parse(relsXml) as XmlNode[]
  const relMap = new Map<string, string>()
  for (const node of walk(relsTree)) {
    if (getTag(node) === 'Relationship') {
      const a = getAttrs(node)
      const id = a['@Id']
      const target = a['@Target']
      const type = a['@Type']
      if (
        typeof id === 'string' &&
        typeof target === 'string' &&
        typeof type === 'string' &&
        type.endsWith('/slide')
      ) {
        relMap.set(id, target.startsWith('/') ? target.slice(1) : `ppt/${target}`)
      }
    }
  }

  const slidePaths: string[] = []
  for (const node of walk(presTree)) {
    if (getTag(node) === 'p:sldId') {
      const rId = getAttrs(node)['@r:id']
      if (typeof rId === 'string') {
        const path = relMap.get(rId)
        if (path !== undefined) slidePaths.push(path)
      }
    }
  }

  // Fall back to filename enumeration if rels-based extraction came up empty.
  if (slidePaths.length === 0) {
    const fromFiles = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const an = Number(a.match(/slide(\d+)\.xml/)?.[1] ?? 0)
        const bn = Number(b.match(/slide(\d+)\.xml/)?.[1] ?? 0)
        return an - bn
      })
    return { slidePaths: fromFiles, slideWidth, slideHeight }
  }

  return { slidePaths, slideWidth, slideHeight }
}

// ---------------------------------------------------------------------------
// Embedded fonts (`<p:embeddedFontLst>`)
// ---------------------------------------------------------------------------

/**
 * Walk ppt/presentation.xml's `<p:embeddedFontLst>` and pull every
 * embedded font file out of the zip. PowerPoint emits one `<p:font>`
 * per typeface with up to four variant children (`<p:regular>`,
 * `<p:bold>`, `<p:italic>`, `<p:boldItalic>`), each carrying an
 * `r:id` that resolves through `ppt/_rels/presentation.xml.rels` to
 * a font file at e.g. `ppt/fonts/font1.fntdata`.
 *
 * Bytes are returned as-is when the file already looks like raw
 * TrueType / OpenType (magic `\x00\x01\x00\x00`, `OTTO`, `true`,
 * `typ1`, or `ttcf`). When the source was wrapped in OOXML's
 * "obfuscatedFont" content type (a leftover from font subsetting),
 * the first 32 bytes are XOR'd with a key derived from the GUID in
 * the file name; we attempt deobfuscation and re-check the magic
 * before keeping the entry.
 *
 * Missing / malformed files are logged into `ignored` and skipped —
 * the import proceeds without that face, falling back to the font
 * registry's category heuristic (see `renderer/fontFallback.ts`).
 */
async function parseEmbeddedFonts(zip: JSZip, ignored: Set<string>): Promise<ParsedEmbeddedFont[]> {
  const presEntry = zip.file('ppt/presentation.xml')
  const relsEntry = zip.file('ppt/_rels/presentation.xml.rels')
  if (presEntry === null || relsEntry === null) return []
  const presXml = await presEntry.async('string')
  if (!presXml.includes('<p:embeddedFontLst')) return []

  const xmlParser = ooxmlParser()
  const presTree = xmlParser.parse(presXml) as XmlNode[]
  const relsXml = await relsEntry.async('string')
  const relsTree = xmlParser.parse(relsXml) as XmlNode[]

  // rId → zip path lookup. The `Target` is relative to ppt/, so we
  // prefix with `ppt/` when it's not absolute.
  const fontRels = new Map<string, string>()
  for (const node of walk(relsTree)) {
    if (getTag(node) !== 'Relationship') continue
    const a = getAttrs(node)
    const id = a['@Id']
    const target = a['@Target']
    const type = a['@Type']
    if (typeof id !== 'string' || typeof target !== 'string' || typeof type !== 'string') {
      continue
    }
    if (!type.endsWith('/font')) continue
    fontRels.set(id, target.startsWith('/') ? target.slice(1) : `ppt/${target}`)
  }
  if (fontRels.size === 0) return []

  const out: ParsedEmbeddedFont[] = []
  for (const node of walk(presTree)) {
    if (getTag(node) !== 'p:embeddedFont') continue
    const fontChildren = getChildren(node, 'p:embeddedFont')
    const fontMeta = findFirst(fontChildren, 'p:font')
    if (fontMeta === undefined) continue
    const typeface = String(getAttrs(fontMeta)['@typeface'] ?? '').trim()
    if (typeface === '') continue
    const variants: ReadonlyArray<{
      tag: string
      variant: ParsedEmbeddedFont['variant']
    }> = [
      { tag: 'p:regular', variant: 'regular' },
      { tag: 'p:bold', variant: 'bold' },
      { tag: 'p:italic', variant: 'italic' },
      { tag: 'p:boldItalic', variant: 'boldItalic' },
    ]
    for (const { tag, variant } of variants) {
      const variantNode = findFirst(fontChildren, tag)
      if (variantNode === undefined) continue
      const rid = getAttrs(variantNode)['@r:id']
      if (typeof rid !== 'string') continue
      const path = fontRels.get(rid)
      if (path === undefined) continue
      const entry = zip.file(path)
      if (entry === null) {
        ignored.add(`embeddedFont:missing:${path}`)
        continue
      }
      const raw = Buffer.from(await entry.async('nodebuffer'))
      const decoded = decodeFontBytes(raw, path)
      if (decoded === null) {
        ignored.add(`embeddedFont:unrecognised:${path}`)
        continue
      }
      const ext = (() => {
        const dot = path.lastIndexOf('.')
        return dot >= 0 ? path.slice(dot + 1).toLowerCase() : 'ttf'
      })()
      out.push({
        zipPath: path,
        bytes: decoded,
        ext: ext === 'fntdata' ? 'ttf' : ext,
        typeface,
        variant,
      })
    }
  }
  return out
}

/**
 * Return the font bytes ready for opentype.js parsing. When the raw
 * bytes already start with a recognised font magic, return as-is.
 * Otherwise attempt OOXML obfuscated-font deobfuscation: the first 32
 * bytes are XOR'd with a 16-byte key derived from the GUID portion of
 * the file's basename (used by `application/vnd.openxmlformats-officedocument.obfuscatedFont`).
 *
 * Returns `null` when neither path produces a recognised font header —
 * the importer then logs the file as unrecognised and skips it.
 */
function decodeFontBytes(raw: Buffer, zipPath: string): Buffer | null {
  if (looksLikeFont(raw)) return raw
  // GUID portion of the filename, e.g. `{1A2B3C4D-...}.fntdata` →
  // hex pairs `1A2B3C4D...`, reversed to little-endian per the OOXML
  // obfuscation algorithm.
  const baseName = zipPath.split('/').pop() ?? zipPath
  const guidMatch = /\{([0-9A-Fa-f-]{36})\}/.exec(baseName)
  if (guidMatch === null) return null
  const hex = guidMatch[1]!.replace(/-/g, '')
  if (hex.length !== 32) return null
  // Build a 16-byte key in the order the spec requires.
  const key = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) {
    key[15 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  const decoded = Buffer.from(raw)
  for (let i = 0; i < 32 && i < decoded.length; i++) {
    decoded[i] = decoded[i]! ^ key[i % 16]!
  }
  return looksLikeFont(decoded) ? decoded : null
}

/**
 * Quick magic-header check for the OpenType / TrueType file formats
 * we expect to see embedded in a .pptx. Supports the four canonical
 * sfnt versions plus TTC collections.
 */
function looksLikeFont(buf: Buffer): boolean {
  if (buf.length < 4) return false
  const tag = buf.subarray(0, 4)
  // TrueType: 0x00 0x01 0x00 0x00
  if (tag[0] === 0x00 && tag[1] === 0x01 && tag[2] === 0x00 && tag[3] === 0x00) return true
  const ascii = tag.toString('latin1')
  return ascii === 'OTTO' || ascii === 'true' || ascii === 'typ1' || ascii === 'ttcf'
}

// ---------------------------------------------------------------------------
// Zip-bomb guards (DoS hardening)
//
// A `.pptx` is a ZIP, and ZIP decompresses lazily in JSZip: each `.async()`
// inflates one entry on demand. A maliciously crafted archive can be a few KB
// on the wire yet declare terabytes of uncompressed content ("42.zip" class).
// We refuse such archives up front using the per-entry sizes recorded in the
// ZIP central directory (cheap — no inflation needed).
//
// IMPORTANT: the on-the-wire import cap stays at 2 GB by product requirement
// (large decks must import). These guards must therefore NOT impose a smaller
// size limit on legitimate files — the total/entry-count bounds are pure
// anti-bomb BACKSTOPS set far above any realistic 2 GB deck's decompression
// (a 2 GB deck is mostly already-compressed media → expands to ~5-15 GB). The
// meaningful detector is the per-entry COMPRESSION-RATIO check: a >1 MB entry
// declaring >200:1 expansion is the decompression-bomb signature and never
// occurs in a real deck (JPEG/PNG/MP4 ≈ 1:1, XML ≈ 5-10:1).
// ---------------------------------------------------------------------------

/** Backstop entry count. Real decks: low thousands; bombs: tens of thousands+. */
const MAX_ZIP_ENTRIES = 200_000
/** Backstop total *declared* uncompressed size — far above any legit 2 GB deck. */
const MAX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024 * 1024 // 32 GiB
/** Max declared compression ratio (uncompressed / compressed) for any one entry. */
const MAX_ENTRY_COMPRESSION_RATIO = 200
/** Only ratio-check entries above this size — tiny files have noisy ratios. */
const RATIO_CHECK_MIN_BYTES = 1024 * 1024

/** Throws if the loaded archive looks like a decompression bomb. */
function assertNotZipBomb(zip: JSZip): void {
  const names = Object.keys(zip.files)
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new Error(`Archive has too many entries (${names.length} > ${MAX_ZIP_ENTRIES})`)
  }
  let totalUncompressed = 0
  for (const name of names) {
    // `_data` carries the central-directory sizes; absent for synthetic dirs.
    const data = (
      zip.files[name] as unknown as {
        _data?: { uncompressedSize?: number; compressedSize?: number }
      }
    )._data
    const uncompressed = data?.uncompressedSize ?? 0
    const compressed = data?.compressedSize ?? 0
    totalUncompressed += uncompressed
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Archive uncompressed size exceeds backstop (> ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes) — refusing to expand`,
      )
    }
    // A single tiny-compressed/huge-uncompressed entry is the bomb signature.
    if (
      compressed > 0 &&
      uncompressed > RATIO_CHECK_MIN_BYTES &&
      uncompressed / compressed > MAX_ENTRY_COMPRESSION_RATIO
    ) {
      throw new Error(
        `Archive entry "${name}" has a suspicious compression ratio (${Math.round(uncompressed / compressed)}:1) — refusing to expand`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a `.pptx` buffer into the intermediate form consumed by the writer
 * and the spike. Throws on invalid input (not a ZIP, no `ppt/` tree, etc.).
 */
export async function parsePptx(buffer: Buffer): Promise<ParsedPptx> {
  // Cheap front-line validation — `.pptx` must start with the ZIP local-file
  // header (PK\x03\x04). Saves a confusing JSZip stacktrace on a non-zip blob.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('Not a ZIP archive (.pptx files start with PK\\x03\\x04)')
  }

  const zip = await JSZip.loadAsync(buffer)
  // DoS: reject decompression bombs before touching any entry contents.
  assertNotZipBomb(zip)
  if (
    zip.file('ppt/presentation.xml') === null &&
    Object.keys(zip.files).every((n) => !/^ppt\//.test(n))
  ) {
    throw new Error('Archive does not look like a .pptx (missing ppt/ tree)')
  }

  const { slidePaths, slideWidth, slideHeight } = await parsePresentationXml(zip)
  const theme = await parseThemeColours(zip)
  // Side-band: tag the theme map with its `<a:txDef>` defaults so parseShape
  // can fall back to them for non-placeholder text without re-threading a
  // new parameter through the dozen functions that take a ThemeColourMap.
  const themeTxDef = await parseThemeTxDef(zip, theme)
  if (themeTxDef !== undefined) themeTxDefStore.set(theme, themeTxDef)
  const defaultMargins = await parseDefaultTextStyleMargins(zip)
  if (defaultMargins !== undefined) presentationLevelMarginsStore.set(theme, defaultMargins)
  // `referencedImagePaths` collects every image referenced anywhere in the
  // deck — slide bodies AND baked master/layout shapes — so the next pass
  // can pull the matching bytes out of the zip and the route handler can
  // upload them to MinIO under their generated asset ids.
  const referencedImagePaths = new Set<string>()
  const slideContexts = await buildSlideContexts(zip, slidePaths, theme, referencedImagePaths)
  const slideImageRels = await buildSlideImageRels(zip, slidePaths)

  const ignored = new Set<string>()
  const slides: ParsedSlide[] = []
  const distinctTags = new Set<string>()
  for (const path of slidePaths) {
    const entry = zip.file(path)
    if (entry === null) continue
    const xml = await entry.async('string')
    const ctx: SlideContext = slideContexts.get(path) ?? {
      placeholders: new Map(),
      masterShapes: [],
      layoutShapes: [],
      fallbackBackground: { kind: 'none' },
      txStyles: {},
    }
    const hyperlinkRels = await loadHyperlinkRels(zip, path)
    const slide = parseSlide(
      xml,
      path.split('/').pop() ?? path,
      ignored,
      theme,
      ctx,
      slideImageRels.get(path) ?? new Map(),
      hyperlinkRels,
    )
    // Speaker notes — independent rels path; loaded per-slide so a deck
    // with notes on only some slides doesn't pay the parse cost on every
    // slide.
    slide.path = path
    const notes = await parseSlideNotes(zip, path)
    if (notes !== undefined) slide.notes = notes
    slides.push(slide)
    // Collect every imagePath the slide's OWN shapes/background reference
    // (master/layout image paths were already added inside buildSlideContexts).
    if (slide.background.imagePath !== undefined) {
      referencedImagePaths.add(slide.background.imagePath)
    }
    for (const sh of slide.shapes) {
      if (sh.imagePath !== undefined) referencedImagePaths.add(sh.imagePath)
      if (sh.videoPath !== undefined) referencedImagePaths.add(sh.videoPath)
      for (const row of sh.tableCells ?? []) {
        for (const cell of row)
          if (cell.imagePath !== undefined) referencedImagePaths.add(cell.imagePath)
      }
    }
    // Track distinct tags across the whole deck for the report metric.
    const xmlParser = ooxmlParser()
    const tree = xmlParser.parse(xml) as XmlNode[]
    for (const node of walk(tree)) {
      const tag = getTag(node)
      if (tag !== null) distinctTags.add(tag)
    }
  }

  // Extract every referenced image's bytes from the zip. We do this AFTER
  // all slides are parsed so we know exactly which images are reachable
  // (the .pptx may contain unused media — we skip them).
  const embeddedImages = new Map<string, ParsedEmbeddedImage>()
  for (const zipPath of referencedImagePaths) {
    const entry = zip.file(zipPath)
    if (entry === null) continue
    const bytes = Buffer.from(await entry.async('nodebuffer'))
    const { mimeType, ext } = sniffImageType(bytes, zipPath)
    embeddedImages.set(zipPath, { zipPath, bytes, mimeType, ext })
  }

  // Embedded TrueType / OpenType faces from `<p:embeddedFontLst>`.
  // Independent of the image extraction — fonts live in their own
  // relationships namespace and don't appear anywhere in the slide
  // bodies. importDeck uploads each as a `media_assets` row with
  // `kind='font'`, and the deck's font registry (FolderFontLoader)
  // picks them up on next render.
  const embeddedFonts = await parseEmbeddedFonts(zip, ignored)

  return {
    slideWidth,
    slideHeight,
    slides,
    ignoredElements: Array.from(ignored).sort(),
    distinctElementCount: distinctTags.size,
    embeddedImages,
    embeddedFonts,
  }
}

// ---------------------------------------------------------------------------
// Image rels + magic-header sniffing
// ---------------------------------------------------------------------------

/**
 * For each slide, parse its `_rels/slideN.xml.rels` and build a map of
 * `rel-id → resolved zip path` for every relationship of type `…/image`.
 */
async function buildSlideImageRels(
  zip: JSZip,
  slidePaths: string[],
): Promise<Map<string, ImageRelMap>> {
  const xmlParser = ooxmlParser()
  const out = new Map<string, ImageRelMap>()
  for (const slidePath of slidePaths) {
    const dir = slidePath.substring(0, slidePath.lastIndexOf('/'))
    const file = slidePath.substring(slidePath.lastIndexOf('/') + 1)
    const relsPath = `${dir}/_rels/${file}.rels`
    const relsEntry = zip.file(relsPath)
    const rels: ImageRelMap = new Map()
    if (relsEntry !== null) {
      const relsXml = await relsEntry.async('string')
      const tree = xmlParser.parse(relsXml) as XmlNode[]
      for (const node of walk(tree)) {
        if (getTag(node) !== 'Relationship') continue
        const a = getAttrs(node)
        const id = a['@Id']
        const target = a['@Target']
        const type = a['@Type']
        if (
          typeof id === 'string' &&
          typeof target === 'string' &&
          typeof type === 'string' &&
          (type.endsWith('/image') || type.endsWith('/video') || type.endsWith('/audio'))
        ) {
          rels.set(id, resolveRelPath(dir, target))
        }
      }
    }
    out.set(slidePath, rels)
  }
  return out
}

/**
 * Read the file's magic header bytes to determine the real MIME type. Falls
 * back to the extension if the header isn't recognised. We only need to
 * distinguish PNG / JPEG / GIF / WebP for v1 — vector formats (EMF/WMF/SVG)
 * are unsupported and pass through with the extension-based MIME so the
 * importer can decide whether to drop them.
 */
function sniffImageType(bytes: Buffer, zipPath: string): { mimeType: string; ext: string } {
  if (bytes.length >= 12) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { mimeType: 'image/png', ext: 'png' }
    }
    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { mimeType: 'image/jpeg', ext: 'jpg' }
    }
    // GIF: 47 49 46 38
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return { mimeType: 'image/gif', ext: 'gif' }
    }
    // WebP: "RIFF" .. "WEBP"
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return { mimeType: 'image/webp', ext: 'webp' }
    }
    // MP4 / MOV: bytes 4-7 = 'ftyp'
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return { mimeType: 'video/mp4', ext: 'mp4' }
    }
    // WebM: 1A 45 DF A3 (EBML header)
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return { mimeType: 'video/webm', ext: 'webm' }
    }
  }
  // Extension fallback.
  const extFromPath = zipPath.split('.').pop()?.toLowerCase() ?? 'bin'
  const mimeByExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    emf: 'image/x-emf',
    wmf: 'image/x-wmf',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/mp4',
  }
  return {
    mimeType: mimeByExt[extFromPath] ?? 'application/octet-stream',
    ext: extFromPath,
  }
}
