/**
 * pptx/ooxml/text.ts
 *
 * Text bodies: Narrative TextObject ↔ `<p:txBody>`.
 *
 * The model keeps two tiers of text formatting and OOXML has matching ones:
 *
 *   TextObject frame fields (fontSize, color, fontFamily, …)
 *       ↔ `<a:lstStyle>/<a:lvlNpPr>/<a:defRPr>` — what applies to a run
 *         that says nothing about itself
 *   Y.Text run attributes (fontWeight, italic, color, …)
 *       ↔ `<a:r>/<a:rPr>` — the run's own differences
 *
 * The writer keeps them in those places, and the importer reads the shape's
 * lstStyle as the frame tier before anything else (see parser.ts), so a
 * frame whose first run happens to be larger does not come back with the
 * larger size as its default.
 *
 * Paragraph structure is written as the model holds it: one `<a:p>` per
 * paragraph (U+2029 in the Y.Text), `<a:br/>` for a soft break ('\n'), the
 * paragraph's list attributes on its `<a:pPr>`.
 */

import * as Y from 'yjs'
import {
  defaultBulletGlyph,
  effectiveParagraphAttrs,
  getParagraphDeltas,
  PARAGRAPH_SEP,
} from '@narrative/slide-model'
import type { RichDeltaOp } from '@narrative/slide-model'
import type { ParagraphAttrs, TextListLevel, TextObject } from '@narrative/shared'
import { el, tag, type XmlChild, type XmlElement } from './xml.js'
import { type XmlNode, findFirst, getAttrs, getChildren, getTag } from './read.js'
import { writeColor, writeSolidFill } from './color.js'
import { pxToCentipoints, pxToEmu } from './units.js'
import { ALIGN, ANCHOR, AUTONUM, CAPS } from './vocabulary.js'

/** Resolved colour: token refs are resolved to numbers before export. */
type Colour = number

export interface TextWriteContext {
  /** Relationship id for a URL hyperlink, allocated on the slide part. */
  hyperlinkRelId(href: string): string
  /** Relationship id of another slide in the deck, for jump links. */
  slideRelId(slideId: string): string | undefined
  /** The slide's 1-based number, for the cached text of a slide-number field. */
  slideNumber: number
}

/** Font weight → OOXML bold. OOXML has only bold / not bold. */
export function isBoldWeight(w: TextObject['fontWeight'] | number | undefined): boolean {
  if (w === 'bold') return true
  if (typeof w === 'number') return w >= 600
  return false
}

/**
 * First family of a CSS font-family stack, unquoted: the one face PowerPoint
 * can be told to use. "Proseware Pro Regular" stays as it is.
 */
export function primaryFamily(stack: string): string {
  const first = stack.split(',')[0] ?? ''
  return first.trim().replace(/^["']|["']$/g, '')
}

function latin(family: string | undefined): XmlChild {
  if (family === undefined || family.trim() === '') return null
  const f = primaryFamily(family)
  if (f === '') return null
  return [el('a:latin', { typeface: f }), el('a:ea', { typeface: f }), el('a:cs', { typeface: f })]
}

// ---------------------------------------------------------------------------
// Frame tier → lstStyle
// ---------------------------------------------------------------------------

interface FrameDefaults {
  fontSize: number
  bold: boolean
  /** Undefined: the model says nothing, and neither does the frame tier. */
  italic: boolean | undefined
  underline: boolean | undefined
  color: Colour
  colorAlpha: number | undefined
  fontFamily: string | undefined
  letterSpacing: number | undefined
  textTransform: TextObject['textTransform']
  stroke: Colour | undefined
  strokeAlpha: number | undefined
  strokeWidth: number | undefined
}

function frameDefaults(obj: TextObject): FrameDefaults {
  return {
    fontSize: obj.fontSize,
    bold: isBoldWeight(obj.fontWeight),
    italic: obj.italic,
    underline: obj.underline,
    color: obj.color as Colour,
    colorAlpha: obj.colorAlpha,
    fontFamily: obj.fontFamily,
    letterSpacing: obj.letterSpacing,
    textTransform: obj.textTransform,
    stroke: obj.stroke as Colour | undefined,
    strokeAlpha: obj.strokeAlpha,
    strokeWidth: obj.strokeWidth,
  }
}

/** `cap`: `capitalize` has no OOXML form (it rides in the object extension). */
function capFor(t: TextObject['textTransform']): string | undefined {
  return t === 'none' || t === 'uppercase' || t === 'lowercase' ? CAPS.toXml(t) : undefined
}

/** `<a:ln>` for glyph outlines. */
function textStroke(
  color: Colour | undefined,
  alpha: number | undefined,
  width: number | undefined,
): XmlChild {
  if (color === undefined) return null
  return el('a:ln', { w: pxToEmu(width ?? 1) }, writeSolidFill(color, alpha))
}

function defRPr(d: FrameDefaults): XmlElement {
  return el(
    'a:defRPr',
    {
      sz: pxToCentipoints(d.fontSize),
      b: d.bold ? 1 : 0,
      i: d.italic !== undefined ? (d.italic ? 1 : 0) : undefined,
      u: d.underline !== undefined ? (d.underline ? 'sng' : 'none') : undefined,
      spc:
        d.letterSpacing !== undefined && d.letterSpacing !== 0
          ? pxToCentipoints(d.letterSpacing)
          : undefined,
      cap: capFor(d.textTransform),
    },
    textStroke(d.stroke, d.strokeAlpha, d.strokeWidth),
    writeSolidFill(d.color, d.colorAlpha),
    latin(d.fontFamily),
  )
}

/**
 * Line spacing: `lineHeight` (× font size) is absolute once the size is
 * known, so it goes out as points; `lineSpacing` (× the font's normal line
 * height) is PowerPoint's own percentage. `lineHeight` wins, as it does in
 * the renderer.
 */
function lnSpc(obj: TextObject, level?: TextListLevel): XmlChild {
  // A level with its own line spacing (A4.2b) sets its paragraphs by it.
  if (level?.lineSpacing !== undefined && level.lineSpacing > 0) {
    return tag('a:lnSpc', el('a:spcPct', { val: Math.round(level.lineSpacing * 100_000) }))
  }
  if (obj.lineHeight !== undefined && obj.lineHeight > 0) {
    return tag('a:lnSpc', el('a:spcPts', { val: pxToCentipoints(obj.lineHeight * obj.fontSize) }))
  }
  if (obj.lineSpacing !== undefined && obj.lineSpacing > 0) {
    return tag('a:lnSpc', el('a:spcPct', { val: Math.round(obj.lineSpacing * 100_000) }))
  }
  return null
}

function spacing(name: 'a:spcBef' | 'a:spcAft', px: number | undefined): XmlChild {
  if (px === undefined || px <= 0) return null
  return tag(name, el('a:spcPts', { val: pxToCentipoints(px) }))
}

/**
 * The frame tier for all nine outline levels. Each level also names the
 * renderer's default bullet glyph for that level: a list paragraph with no
 * glyph of its own (`bulletChar` absent — "whatever this level uses") writes
 * no `<a:buChar>` and inherits this one, which is how the importer can tell
 * it apart from a paragraph that chose the same glyph explicitly. Paragraphs
 * that are not list items say `<a:buNone/>` to opt out.
 */
function lstStyle(obj: TextObject): XmlElement {
  const d = frameDefaults(obj)
  const align = ALIGN.toXml(obj.align ?? 'left')
  const levels: XmlElement[] = []
  for (let n = 1; n <= 9; n++) {
    // The box's level defaults (A4.2b) are this level's: PowerPoint applies
    // them to every paragraph at the level that says nothing itself.
    const look = obj.listLevels?.[n - 1]
    levels.push(
      el(
        `a:lvl${n}pPr`,
        { algn: align },
        lnSpc(obj, look),
        spacing('a:spcBef', look?.spaceBefore ?? obj.paragraphSpaceBefore),
        spacing('a:spcAft', obj.paragraphSpaceAfter),
        typeof look?.bulletColor === 'number' ? tag('a:buClr', writeColor(look.bulletColor)) : null,
        look?.bulletScale !== undefined
          ? // Transitional OOXML writes the size as a percentage, 25–400 %.
            el('a:buSzPct', {
              val: `${Math.max(25, Math.min(400, Math.round(look.bulletScale * 100)))}%`,
            })
          : null,
        look?.list === 'number'
          ? el('a:buAutoNum', { type: AUTONUM.toXml(look.numberFormat ?? 'decimal') })
          : el('a:buChar', { char: look?.bulletChar ?? defaultBulletGlyph(n - 1) }),
        defRPr(levelDefaults(d, look)),
      ),
    )
  }
  return tag('a:lstStyle', levels)
}

/** The frame defaults with a level's own type over them. */
function levelDefaults(d: FrameDefaults, look: TextListLevel | undefined): FrameDefaults {
  if (look === undefined) return d
  return {
    ...d,
    ...(look.fontSize !== undefined ? { fontSize: look.fontSize } : {}),
    ...(look.fontWeight !== undefined ? { bold: isBoldWeight(look.fontWeight) } : {}),
    ...(typeof look.color === 'number' ? { color: look.color } : {}),
    ...(look.fontFamily !== undefined ? { fontFamily: look.fontFamily } : {}),
  }
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

/**
 * Indents for a paragraph, matching how the renderer lays it out
 * (`buildListedHtml`: 1.5 em per level, a 1.6 em hanging gutter for a list
 * marker), so PowerPoint places the text where Narrative does.
 */
const INDENT_PER_LEVEL_EM = 1.5
const MARKER_HANG_EM = 1.6

/**
 * The paragraph attributes an importer reads back from what
 * `paragraphProps` writes for `attrs` (see parser.ts): a numbered list
 * always names its format, a level shows only above 0.
 */
function nativeParagraphAttrs(attrs: ParagraphAttrs): ParagraphAttrs {
  const out: ParagraphAttrs = {}
  const level = clampLevel(attrs.level)
  if (level > 0) out.level = level
  if (attrs.list === 'bullet') {
    out.list = 'bullet'
    if (attrs.bulletChar !== undefined) out.bulletChar = attrs.bulletChar
  } else if (attrs.list === 'number') {
    out.list = 'number'
    out.numberFormat = attrs.numberFormat ?? 'decimal'
    if (attrs.startAt !== undefined) out.startAt = attrs.startAt
  }
  return out
}

function clampLevel(level: number | undefined): number {
  return Math.max(0, Math.min(8, level ?? 0))
}

/** Paragraph attributes as canonical JSON (sorted keys), for comparing. */
export function paragraphAttrsKey(attrs: ParagraphAttrs): string {
  const rec = attrs as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(rec).sort()) if (rec[k] !== undefined) out[k] = rec[k]
  return JSON.stringify(out)
}

/**
 * A paragraph's exact model attributes, where the native `<a:pPr>` reads
 * back as something else — a frame-wide legacy list style written onto the
 * paragraph, a numbered list with no format of its own (PowerPoint needs
 * one), an explicit level 0. `native` is what the importer will read from
 * the native XML; if that changes (the bullets were restyled in
 * PowerPoint), the model attributes no longer apply.
 */
export const NARRATIVE_PARAGRAPH_EXT_URI = '{5E2C7A94-1B3D-4F6E-8A0C-9D4B2E7F1C35}'
const NARRATIVE_PARAGRAPH_NS = 'urn:narrative:ooxml:paragraph:1'

function paragraphExt(model: ParagraphAttrs, native: ParagraphAttrs): XmlChild {
  const modelKey = paragraphAttrsKey(model)
  const nativeKey = paragraphAttrsKey(native)
  if (modelKey === nativeKey) return null
  return el(
    'a:extLst',
    {},
    el(
      'a:ext',
      { uri: NARRATIVE_PARAGRAPH_EXT_URI },
      el('nx:para', { 'xmlns:nx': NARRATIVE_PARAGRAPH_NS, model: modelKey, native: nativeKey }),
    ),
  )
}

/** The `{model, native}` pair a Narrative export put on this `<a:pPr>`, raw. */
export function readParagraphExt(
  pPr: XmlNode | undefined,
): { model: unknown; native: string } | undefined {
  if (pPr === undefined) return undefined
  const extLst = findFirst(getChildren(pPr, 'a:pPr'), 'a:extLst')
  if (extLst === undefined) return undefined
  for (const ext of getChildren(extLst, 'a:extLst')) {
    if (getTag(ext) !== 'a:ext' || getAttrs(ext)['@uri'] !== NARRATIVE_PARAGRAPH_EXT_URI) continue
    const node = findFirst(getChildren(ext, 'a:ext'), 'nx:para')
    if (node === undefined) return undefined
    const a = getAttrs(node)
    try {
      return {
        model: JSON.parse(String(a['@model'] ?? '{}')) as unknown,
        native: String(a['@native'] ?? ''),
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * `<a:pPr>` for a paragraph. `own` is the paragraph's model attributes,
 * `attrs` what is drawn (the legacy frame-wide list style applied).
 */
function paragraphProps(
  own: ParagraphAttrs,
  attrs: ParagraphAttrs,
  fontSize: number,
  look?: TextListLevel,
): XmlElement {
  const level = clampLevel(attrs.level)
  const isList = attrs.list === 'bullet' || attrs.list === 'number'
  const em = (n: number): number => pxToEmu(n * fontSize)
  // A level that sets its indents (A4.2b) places text and marker in px, as
  // the renderer does; otherwise the built-in em steps.
  const pxIndent = look?.indent !== undefined || look?.hanging !== undefined
  const marL = pxIndent
    ? pxToEmu(look?.indent ?? 0)
    : em(level * INDENT_PER_LEVEL_EM + (isList ? MARKER_HANG_EM : 0))
  const indent = !isList ? 0 : pxIndent ? -pxToEmu(look?.hanging ?? 0) : -em(MARKER_HANG_EM)
  // A bullet without a glyph of its own inherits its level's from the
  // lstStyle — but a numbered level would hand PowerPoint its numbering
  // instead: then the glyph Narrative draws is written.
  const ownGlyphNeeded =
    attrs.list === 'bullet' && attrs.bulletChar === undefined && look?.list === 'number'
  const glyph = ownGlyphNeeded ? defaultBulletGlyph(level) : attrs.bulletChar
  let bullet: XmlChild
  if (attrs.list === 'bullet') {
    bullet = glyph !== undefined ? el('a:buChar', { char: glyph }) : null
  } else if (attrs.list === 'number') {
    bullet = el('a:buAutoNum', {
      type: AUTONUM.toXml(attrs.numberFormat ?? 'decimal'),
      startAt: attrs.startAt,
    })
  } else {
    bullet = tag('a:buNone')
  }
  return el(
    'a:pPr',
    { marL, indent, lvl: level > 0 ? level : undefined },
    bullet,
    paragraphExt(
      own,
      nativeParagraphAttrs(
        ownGlyphNeeded && glyph !== undefined ? { ...attrs, bulletChar: glyph } : attrs,
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * A run's exact numeric weight, where OOXML's bold / not bold would lose it
 * (300, 500, …). Carried in the run's own `<a:rPr>/<a:extLst>`, which the
 * schema provides for application data.
 */
export const NARRATIVE_RUN_EXT_URI = '{9B3E6F21-4C8A-4D5E-A7B0-2E1F6C9D8A34}'
const NARRATIVE_RUN_NS = 'urn:narrative:ooxml:run:1'
const WEIGHTS = new Set([100, 200, 300, 400, 500, 600, 700, 800, 900])

function runExt(fontWeight: number | undefined, fontFamily: string | undefined): XmlChild {
  const weight =
    fontWeight !== undefined && fontWeight !== 400 && fontWeight !== 700 ? fontWeight : undefined
  const family = fontFamily !== undefined && !familyIsNative(fontFamily) ? fontFamily : undefined
  if (weight === undefined && family === undefined) return null
  return el(
    'a:extLst',
    {},
    el(
      'a:ext',
      { uri: NARRATIVE_RUN_EXT_URI },
      el('nx:run', { 'xmlns:nx': NARRATIVE_RUN_NS, fontWeight: weight, fontFamily: family }),
    ),
  )
}

/**
 * Whether `<a:latin typeface>` carries a family exactly: one face, as the
 * model names it. A CSS stack ("Inter, sans-serif") is written as its
 * first face and kept whole in an extension.
 */
export function familyIsNative(family: string): boolean {
  return family.trim() !== '' && primaryFamily(family) === family
}

/** What a Narrative export's run extension says about this `<a:rPr>`. */
export function readRunExt(rPr: XmlNode): { fontWeight?: number; fontFamily?: string } {
  const extLst = findFirst(getChildren(rPr, 'a:rPr'), 'a:extLst')
  if (extLst === undefined) return {}
  for (const ext of getChildren(extLst, 'a:extLst')) {
    if (getTag(ext) !== 'a:ext' || getAttrs(ext)['@uri'] !== NARRATIVE_RUN_EXT_URI) continue
    const run = findFirst(getChildren(ext, 'a:ext'), 'nx:run')
    if (run === undefined) return {}
    const a = getAttrs(run)
    const out: { fontWeight?: number; fontFamily?: string } = {}
    const w = Number(a['@fontWeight'])
    if (WEIGHTS.has(w)) out.fontWeight = w
    const f = a['@fontFamily']
    if (typeof f === 'string' && f.length <= 200) out.fontFamily = f
    return out
  }
  return {}
}

/**
 * `<a:rPr>`: exactly the attributes the run carries in the model — not
 * compared against the frame tier. A run attribute equal to the frame's
 * value is still the run's own statement (it survives a later change of the
 * frame), and the importer reads it back as one.
 */
function runProps(a: RichDeltaOp['attributes'], link: XmlChild): XmlElement {
  const attrs = a ?? {}
  return el(
    'a:rPr',
    {
      lang: 'en-US',
      sz: attrs.fontSize !== undefined ? pxToCentipoints(attrs.fontSize) : undefined,
      b: attrs.fontWeight !== undefined ? (attrs.fontWeight >= 600 ? 1 : 0) : undefined,
      i: attrs.italic !== undefined ? (attrs.italic ? 1 : 0) : undefined,
      u: attrs.underline !== undefined ? (attrs.underline ? 'sng' : 'none') : undefined,
      dirty: 0,
    },
    attrs.color !== undefined && writeSolidFill(attrs.color),
    latin(attrs.fontFamily),
    link,
    runExt(attrs.fontWeight, attrs.fontFamily),
  )
}

function hyperlinkFor(obj: TextObject, ctx: TextWriteContext): XmlChild {
  const h = obj.hyperlink
  if (h === undefined) return null
  if (h.kind === 'url') return el('a:hlinkClick', { 'r:id': ctx.hyperlinkRelId(h.href) })
  const rid = ctx.slideRelId(h.slideId)
  if (rid === undefined) return null
  return el('a:hlinkClick', { 'r:id': rid, action: 'ppaction://hlinksldjump' })
}

function textRuns(ops: readonly RichDeltaOp[], link: XmlChild): XmlElement[] {
  const out: XmlElement[] = []
  for (const op of ops) {
    if (typeof op.insert !== 'string' || op.insert.length === 0) continue
    // A run's text may carry soft breaks; each becomes an <a:br/>.
    const parts = op.insert.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) out.push(tag('a:br', runProps(op.attributes, null)))
      if (part.length > 0) {
        out.push(tag('a:r', runProps(op.attributes, link), tag('a:t', part)))
      }
    })
  }
  return out
}

function paragraphsOf(obj: TextObject): Array<{ attrs: ParagraphAttrs; ops: RichDeltaOp[] }> {
  const t = obj.text
  if (t instanceof Y.Text) {
    const paras = getParagraphDeltas(t)
    return paras.length > 0 ? paras : [{ attrs: {}, ops: [] }]
  }
  const s = typeof t === 'string' ? t : ''
  return s
    .split(PARAGRAPH_SEP)
    .map((p) => ({ attrs: {}, ops: p.length > 0 ? [{ insert: p }] : [] }))
}

/** Apply the legacy frame-wide `listStyle` to paragraphs that carry none. */
/**
 * What a paragraph is drawn with: its own attributes over its level's
 * defaults (A4.2b; `'none'` resolved to plain), then the legacy frame-wide
 * list style for a paragraph that is still no list.
 */
function drawnAttrs(obj: TextObject, attrs: ParagraphAttrs): ParagraphAttrs {
  const resolved = effectiveParagraphAttrs(attrs, obj.listLevels)
  // An explicit 'none' is plain even under the legacy frame-wide style.
  if (attrs.list === 'none') return resolved
  return withLegacyList(obj, resolved)
}

function withLegacyList(obj: TextObject, attrs: ParagraphAttrs): ParagraphAttrs {
  if (attrs.list !== undefined || obj.listStyle === undefined) return attrs
  return { ...attrs, list: obj.listStyle === 'numbered' ? 'number' : 'bullet' }
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Body insets
// ---------------------------------------------------------------------------

/** A text body's insets, EMU: the distance from the frame to its text. */
export interface BodyInsets {
  l: number
  t: number
  r: number
  b: number
}

/** PowerPoint's insets for a body that declares none: 0.1 in left/right, 0.05 in top/bottom. */
export const DEFAULT_BODY_INSETS: BodyInsets = { l: 91_440, t: 45_720, r: 91_440, b: 45_720 }

/**
 * The insets a `<a:bodyPr>` declares, side by side (`lIns`, `tIns`, …);
 * a side it leaves out is inherited. The writer declares all four as 0 —
 * the model's frame is where its text is.
 */
export function readBodyInsets(bodyPr: XmlNode | undefined): Partial<BodyInsets> {
  if (bodyPr === undefined) return {}
  const a = getAttrs(bodyPr)
  const out: Partial<BodyInsets> = {}
  for (const [side, attr] of [
    ['l', '@lIns'],
    ['t', '@tIns'],
    ['r', '@rIns'],
    ['b', '@bIns'],
  ] as const) {
    const v = Number(a[attr])
    if (typeof a[attr] === 'string' && Number.isFinite(v)) out[side] = v
  }
  return out
}

export function writeTextBody(
  obj: TextObject,
  ctx: TextWriteContext,
  bodyTag: 'p:txBody' | 'a:txBody' = 'p:txBody',
): XmlElement {
  const bodyPr = el(
    'a:bodyPr',
    {
      wrap: obj.wrap === 'none' ? 'none' : 'square',
      lIns: 0,
      tIns: 0,
      rIns: 0,
      bIns: 0,
      // A box that grows with its text has no room to align it in: top.
      anchor: ANCHOR.toXml(obj.autofit === 'grow-down' ? 'top' : (obj.vAlign ?? 'top')),
      rtlCol: 0,
    },
    // Autofit (A4.2) in PowerPoint's terms. A shrinking box is written
    // without a `fontScale`: only a layout engine knows it, and PowerPoint
    // works it out again when the text is next edited. The import reads
    // neither back (a PowerPoint deck's own autofit is not taken over); a
    // Narrative deck gets its autofit back from the extension.
    tag(
      obj.autofit === 'grow-down'
        ? 'a:spAutoFit'
        : obj.autofit === 'shrink'
          ? 'a:normAutofit'
          : 'a:noAutofit',
    ),
  )
  const link = hyperlinkFor(obj, ctx)
  const endPara = el('a:endParaRPr', { lang: 'en-US', dirty: 0 })

  let paragraphs: XmlElement[]
  if (obj.isSlideNumber === true) {
    // The field's cached text is this slide's number, as PowerPoint writes it.
    paragraphs = [
      tag(
        'a:p',
        paragraphProps({}, drawnAttrs(obj, {}), obj.fontSize, obj.listLevels?.[0]),
        el(
          'a:fld',
          { id: '{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}', type: 'slidenum' },
          el('a:rPr', { lang: 'en-US', dirty: 0 }),
          tag('a:t', String(ctx.slideNumber)),
        ),
        endPara,
      ),
    ]
  } else {
    paragraphs = paragraphsOf(obj).map((p) =>
      tag(
        'a:p',
        paragraphProps(
          p.attrs,
          drawnAttrs(obj, p.attrs),
          obj.fontSize,
          obj.listLevels?.[clampLevel(p.attrs.level)],
        ),
        textRuns(p.ops, link),
        endPara,
      ),
    )
  }
  return tag(bodyTag, bodyPr, lstStyle(obj), paragraphs)
}
