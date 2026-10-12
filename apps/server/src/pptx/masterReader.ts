/**
 * pptx/masterReader.ts — a template's slide masters and layouts, read for a
 * style pack (agentic A4.7, docs/plans/a4-style-packs.md): what the Fabrikam
 * and Tailspin bootstraps map to layouts, text styles and colours. The deck
 * import (parser.ts) reads slides and resolves the chain down to each
 * shape; this reads the chain itself, including layouts no slide uses.
 *
 *   - `sldMasterIdLst` → each master, its own theme through its rels (not
 *     `theme1.xml`), its `clrMap` applied (a dark master maps `tx1` to a
 *     light colour), its `txStyles` per level (1–9).
 *   - Each master's layouts in order: name, `type`, background, every
 *     placeholder with its geometry (inherited from the master's
 *     placeholder of the same type or idx when the layout omits it), body
 *     properties, and its text levels merged layout → master placeholder →
 *     master `txStyles`; and the layout's other shapes (decoration, logos,
 *     rules) with group transforms applied.
 *
 * Geometry is in canvas fractions of `sldSz`; sizes stay in the source's
 * units (points, EMU) for the brand mapper to convert.
 */

import JSZip from 'jszip'
import {
  findFirst,
  getAttrs,
  getChildren,
  getTag,
  ooxmlParser,
  walk,
  type XmlNode,
} from './ooxml/read.js'
import { parseColourAndAlphaFrom, type ThemeColourMap } from './ooxml/color.js'
import { readBodyInsets } from './ooxml/text.js'
import {
  extractBulletDecl,
  readLineSpacingDecl,
  resolveTypeface,
  themeFromXml,
  type BulletDecl,
  type LineSpacingDecl,
} from './parser.js'

/** A colour as read: its hex, and the scheme slot it names when it names one. */
export interface ReadColour {
  hex: string
  alpha?: number
  /** `accent6`, `tx1`, … — before the master's `clrMap`. */
  scheme?: string
}

/** One text level (0 = `lvl1pPr`), every field the source states, inherited ones merged in. */
export interface MasterLevel {
  sizePt?: number
  bold?: boolean
  italic?: boolean
  caps?: boolean
  typeface?: string
  colour?: ReadColour
  bullet?: BulletDecl & { colour?: ReadColour; sizePct?: number; typeface?: string }
  /** EMU. */
  marL?: number
  /** EMU; negative: a hanging marker. */
  indent?: number
  lineSpacing?: LineSpacingDecl
  spaceBeforePt?: number
  spaceAfterPt?: number
  align?: 'left' | 'center' | 'right' | 'justify'
}

export type Rect = [x: number, y: number, w: number, h: number]

export interface MasterPlaceholder {
  /** `title`, `ctrTitle`, `subTitle`, `body`, `pic`, `dt`, `ftr`, `sldNum`, `obj`, … */
  type: string
  idx?: string
  name: string
  /** Canvas fractions. */
  rect: Rect
  /** The layout gave no geometry: it is the master placeholder's. */
  inherited: boolean
  anchor?: 'top' | 'middle' | 'bottom'
  /** EMU, the 0.1 in / 0.05 in defaults filled in. */
  insets: { l: number; t: number; r: number; b: number }
  autofit?: 'shape' | 'normal' | 'none'
  levels: MasterLevel[]
  /** The prompt text PowerPoint shows in an empty placeholder. */
  prompt?: string
}

export interface MasterShape {
  kind: 'sp' | 'pic' | 'cxnSp'
  name: string
  rect: Rect
  /** `<a:prstGeom prst>`: rect, ellipse, line, … */
  geometry?: string
  fill?: ReadColour
  line?: { colour?: ReadColour; widthEmu?: number }
  text?: string
  /** How a text shape's first run is set (size, face, colour, alignment), as one level. */
  levels?: MasterLevel[]
  /** A picture's media part. */
  image?: string
}

export interface MasterLayout {
  part: string
  name: string
  type?: string
  background?: ReadColour
  showMasterShapes: boolean
  placeholders: MasterPlaceholder[]
  shapes: MasterShape[]
}

export interface MasterReading {
  part: string
  name?: string
  themePart: string
  /** The theme's colour slots (`dk1`, `accent1`, …) and the `clrMap` aliases (`tx1`, `bg1`, …), as hex. */
  colours: Record<string, string>
  fonts: { major?: string; minor?: string }
  txStyles: { title: MasterLevel[]; body: MasterLevel[]; other: MasterLevel[] }
  background?: ReadColour
  placeholders: MasterPlaceholder[]
  shapes: MasterShape[]
  layouts: MasterLayout[]
}

export interface TemplateReading {
  /** `sldSz` in EMU. */
  size: { cx: number; cy: number }
  masters: MasterReading[]
}

const DEFAULT_INSETS = { l: 91_440, t: 45_720, r: 91_440, b: 45_720 }
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = from.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

async function readRels(
  zip: JSZip,
  part: string,
): Promise<Map<string, { type: string; target: string }>> {
  const relsPath = part.replace(/([^/]+)$/, '_rels/$1.rels')
  const file = zip.file(relsPath)
  const out = new Map<string, { type: string; target: string }>()
  if (file === null) return out
  const tree = ooxmlParser().parse(await file.async('string')) as XmlNode[]
  for (const node of walk(tree)) {
    if (getTag(node) !== 'Relationship') continue
    const a = getAttrs(node)
    if (typeof a['@Id'] === 'string' && typeof a['@Target'] === 'string')
      out.set(a['@Id'], {
        type: typeof a['@Type'] === 'string' ? a['@Type'] : '',
        target: resolvePart(part, a['@Target']),
      })
  }
  return out
}

async function readXml(zip: JSZip, part: string): Promise<XmlNode[]> {
  const file = zip.file(part)
  if (file === null) throw new Error(`the template has no part ${part}`)
  return ooxmlParser().parse(await file.async('string')) as XmlNode[]
}

function first(tree: XmlNode[], tag: string): XmlNode | undefined {
  for (const n of walk(tree)) if (getTag(n) === tag) return n
  return undefined
}

/** The colour under `node` (a fill, `buClr`, …), with its scheme slot. */
function readColour(node: XmlNode | undefined, theme: ThemeColourMap): ReadColour | undefined {
  if (node === undefined) return undefined
  const c = parseColourAndAlphaFrom(node, theme)
  if (c === undefined) return undefined
  let scheme: string | undefined
  for (const n of walk([node])) {
    if (getTag(n) === 'a:schemeClr') {
      const v = getAttrs(n)['@val']
      if (typeof v === 'string') scheme = v
      break
    }
    if (getTag(n) === 'a:srgbClr' || getTag(n) === 'a:sysClr') break
  }
  return {
    hex: hex(c.color),
    ...(c.alpha !== undefined ? { alpha: c.alpha } : {}),
    ...(scheme !== undefined ? { scheme } : {}),
  }
}

/** The nine levels of a list-style container (`a:lstStyle`, `p:bodyStyle`, …). */
function readLevels(container: XmlNode | undefined, theme: ThemeColourMap): MasterLevel[] {
  const out: MasterLevel[] = []
  if (container === undefined) return out
  const tag = getTag(container)!
  const children = getChildren(container, tag)
  for (let i = 0; i < 9; i++) {
    const lvlTag = `a:lvl${i + 1}pPr`
    const lvl = findFirst(children, lvlTag)
    if (lvl === undefined) continue
    const a = getAttrs(lvl)
    const kids = getChildren(lvl, lvlTag)
    const level: MasterLevel = {}
    const marL = num(a['@marL'])
    if (marL !== undefined) level.marL = marL
    const indent = num(a['@indent'])
    if (indent !== undefined) level.indent = indent
    const algn = a['@algn']
    if (algn === 'l') level.align = 'left'
    else if (algn === 'ctr') level.align = 'center'
    else if (algn === 'r') level.align = 'right'
    else if (algn === 'just') level.align = 'justify'
    const ls = readLineSpacingDecl(kids)
    if (ls !== undefined) level.lineSpacing = ls
    for (const [name, key] of [
      ['a:spcBef', 'spaceBeforePt'],
      ['a:spcAft', 'spaceAfterPt'],
    ] as const) {
      const sp = findFirst(kids, name)
      const pts = sp === undefined ? undefined : findFirst(getChildren(sp, name), 'a:spcPts')
      const v = pts === undefined ? undefined : num(getAttrs(pts)['@val'])
      if (v !== undefined) level[key] = v / 100
    }
    const bullet = extractBulletDecl(lvl, lvlTag)
    if (bullet !== undefined) {
      const b: NonNullable<MasterLevel['bullet']> = { ...bullet }
      const buClr = findFirst(kids, 'a:buClr')
      const colour = readColour(buClr, theme)
      if (colour !== undefined) b.colour = colour
      const buSz = findFirst(kids, 'a:buSzPct')
      const pct = buSz === undefined ? undefined : num(getAttrs(buSz)['@val'])
      if (pct !== undefined) b.sizePct = pct / 1000
      const buFont = findFirst(kids, 'a:buFont')
      const tf = buFont === undefined ? undefined : getAttrs(buFont)['@typeface']
      if (typeof tf === 'string') b.typeface = tf
      level.bullet = b
    }
    const defRPr = findFirst(kids, 'a:defRPr')
    if (defRPr !== undefined) {
      const r = getAttrs(defRPr)
      const sz = num(r['@sz'])
      if (sz !== undefined) level.sizePt = sz / 100
      if (r['@b'] !== undefined) level.bold = r['@b'] === '1' || r['@b'] === 'true'
      if (r['@i'] !== undefined) level.italic = r['@i'] === '1' || r['@i'] === 'true'
      if (r['@cap'] !== undefined) level.caps = r['@cap'] === 'all'
      const rk = getChildren(defRPr, 'a:defRPr')
      const latin = findFirst(rk, 'a:latin')
      const tf =
        latin === undefined ? undefined : resolveTypeface(getAttrs(latin)['@typeface'], theme)
      if (tf !== undefined) level.typeface = tf
      const colour = readColour(findFirst(rk, 'a:solidFill'), theme)
      if (colour !== undefined) level.colour = colour
    }
    out[i] = level
  }
  return out
}

/** Levels merged: every field of `over` wins over `under`, level by level. */
function mergeLevels(over: MasterLevel[], under: MasterLevel[]): MasterLevel[] {
  const out: MasterLevel[] = []
  for (let i = 0; i < Math.max(over.length, under.length); i++) {
    const o = over[i]
    const u = under[i]
    if (o === undefined && u === undefined) continue
    out[i] = {
      ...u,
      ...o,
      ...(o?.bullet !== undefined || u?.bullet !== undefined
        ? {
            bullet:
              o?.bullet?.kind === 'none'
                ? o.bullet
                : ({ ...u?.bullet, ...o?.bullet } as NonNullable<MasterLevel['bullet']>),
          }
        : {}),
    }
  }
  return out
}

interface Transform {
  /** Child space → slide EMU: x' = ox + (x − cx) * sx. */
  ox: number
  oy: number
  cx: number
  cy: number
  sx: number
  sy: number
}
const IDENTITY: Transform = { ox: 0, oy: 0, cx: 0, cy: 0, sx: 1, sy: 1 }

function readXfrm(
  spPr: XmlNode | undefined,
  spPrTag: string,
  t: Transform,
): { x: number; y: number; w: number; h: number } | undefined {
  if (spPr === undefined) return undefined
  const xfrm = findFirst(getChildren(spPr, spPrTag), 'a:xfrm')
  if (xfrm === undefined) return undefined
  const kids = getChildren(xfrm, 'a:xfrm')
  const off = findFirst(kids, 'a:off')
  const ext = findFirst(kids, 'a:ext')
  if (off === undefined || ext === undefined) return undefined
  const x = num(getAttrs(off)['@x']) ?? 0
  const y = num(getAttrs(off)['@y']) ?? 0
  const w = num(getAttrs(ext)['@cx']) ?? 0
  const h = num(getAttrs(ext)['@cy']) ?? 0
  return {
    x: t.ox + (x - t.cx) * t.sx,
    y: t.oy + (y - t.cy) * t.sy,
    w: w * t.sx,
    h: h * t.sy,
  }
}

/** A text shape's look: its first paragraph's alignment and first run's properties. */
function firstRunLevel(
  txBody: XmlNode | undefined,
  theme: ThemeColourMap,
): MasterLevel | undefined {
  if (txBody === undefined) return undefined
  const p = findFirst(getChildren(txBody, getTag(txBody)!), 'a:p')
  if (p === undefined) return undefined
  const pk = getChildren(p, 'a:p')
  const level: MasterLevel = {}
  const algn = getAttrs(findFirst(pk, 'a:pPr') ?? {})['@algn']
  if (algn === 'ctr') level.align = 'center'
  else if (algn === 'r') level.align = 'right'
  // The first run, or a field (a page number is `<a:fld type="slidenum">`).
  const r = pk.find((n) => getTag(n) === 'a:r' || getTag(n) === 'a:fld')
  const rPr = r === undefined ? undefined : findFirst(getChildren(r, getTag(r)!), 'a:rPr')
  if (rPr !== undefined) {
    const a = getAttrs(rPr)
    const sz = num(a['@sz'])
    if (sz !== undefined) level.sizePt = sz / 100
    if (a['@b'] !== undefined) level.bold = a['@b'] === '1' || a['@b'] === 'true'
    const rk = getChildren(rPr, 'a:rPr')
    const latin = findFirst(rk, 'a:latin')
    const tf =
      latin === undefined ? undefined : resolveTypeface(getAttrs(latin)['@typeface'], theme)
    if (tf !== undefined) level.typeface = tf
    const colour = readColour(findFirst(rk, 'a:solidFill'), theme)
    if (colour !== undefined) level.colour = colour
  }
  return level
}

function textOf(txBody: XmlNode | undefined): string | undefined {
  if (txBody === undefined) return undefined
  const paras: string[] = []
  for (const p of getChildren(txBody, getTag(txBody)!)) {
    if (getTag(p) !== 'a:p') continue
    let s = ''
    for (const n of walk(getChildren(p, 'a:p'))) {
      if (getTag(n) !== 'a:t') continue
      const kids = getChildren(n, 'a:t') as unknown as Array<Record<string, unknown>>
      for (const k of kids)
        if (typeof k['#text'] === 'string' || typeof k['#text'] === 'number')
          s += String(k['#text'])
    }
    paras.push(s)
  }
  const text = paras.join('\n').trim()
  return text === '' ? undefined : text
}

interface SpTreeReading {
  placeholders: Array<
    Omit<MasterPlaceholder, 'rect' | 'inherited' | 'insets' | 'levels'> & {
      box?: { x: number; y: number; w: number; h: number }
      insets: Partial<MasterPlaceholder['insets']>
      lstStyle: MasterLevel[]
    }
  >
  shapes: Array<Omit<MasterShape, 'rect'> & { box: { x: number; y: number; w: number; h: number } }>
}

/** Placeholders and other shapes of a `p:spTree`, group transforms applied. */
function readSpTree(spTree: XmlNode | undefined, theme: ThemeColourMap): SpTreeReading {
  const out: SpTreeReading = { placeholders: [], shapes: [] }
  if (spTree === undefined) return out
  const visit = (container: XmlNode, t: Transform): void => {
    for (const node of getChildren(container, getTag(container)!)) {
      const tag = getTag(node)
      if (tag === 'p:grpSp') {
        const grpSpPr = findFirst(getChildren(node, 'p:grpSp'), 'p:grpSpPr')
        const xfrm =
          grpSpPr === undefined ? undefined : findFirst(getChildren(grpSpPr, 'p:grpSpPr'), 'a:xfrm')
        let inner = t
        if (xfrm !== undefined) {
          const k = getChildren(xfrm, 'a:xfrm')
          const g = (n: string, a: string) => num(getAttrs(findFirst(k, n) ?? {})[a]) ?? 0
          const [ox, oy, ex, ey] = [
            g('a:off', '@x'),
            g('a:off', '@y'),
            g('a:ext', '@cx'),
            g('a:ext', '@cy'),
          ]
          const [cx, cy, cex, cey] = [
            g('a:chOff', '@x'),
            g('a:chOff', '@y'),
            g('a:chExt', '@cx'),
            g('a:chExt', '@cy'),
          ]
          const sx = cex > 0 ? ex / cex : 1
          const sy = cey > 0 ? ey / cey : 1
          inner = {
            ox: t.ox + (ox - t.cx) * t.sx,
            oy: t.oy + (oy - t.cy) * t.sy,
            cx,
            cy,
            sx: sx * t.sx,
            sy: sy * t.sy,
          }
        }
        visit(node, inner)
        continue
      }
      if (tag !== 'p:sp' && tag !== 'p:pic' && tag !== 'p:cxnSp') continue
      const kids = getChildren(node, tag)
      const nvTag = tag === 'p:sp' ? 'p:nvSpPr' : tag === 'p:pic' ? 'p:nvPicPr' : 'p:nvCxnSpPr'
      const nv = findFirst(kids, nvTag)
      const nvKids = nv === undefined ? [] : getChildren(nv, nvTag)
      const cNvPr = findFirst(nvKids, 'p:cNvPr')
      const name = String(getAttrs(cNvPr ?? {})['@name'] ?? '')
      const nvPr = findFirst(nvKids, 'p:nvPr')
      const ph = nvPr === undefined ? undefined : findFirst(getChildren(nvPr, 'p:nvPr'), 'p:ph')
      const spPr = findFirst(kids, 'p:spPr')
      const box = readXfrm(spPr, 'p:spPr', t)
      const txBody = findFirst(kids, 'p:txBody')
      if (ph !== undefined) {
        const pa = getAttrs(ph)
        const bodyPr =
          txBody === undefined ? undefined : findFirst(getChildren(txBody, 'p:txBody'), 'a:bodyPr')
        const ba = getAttrs(bodyPr ?? {})
        const bk = bodyPr === undefined ? [] : getChildren(bodyPr, 'a:bodyPr')
        const anchor = ba['@anchor']
        const lst =
          txBody === undefined
            ? undefined
            : findFirst(getChildren(txBody, 'p:txBody'), 'a:lstStyle')
        const prompt = textOf(txBody)
        out.placeholders.push({
          type: typeof pa['@type'] === 'string' ? pa['@type'] : 'body',
          ...(typeof pa['@idx'] === 'string' ? { idx: pa['@idx'] } : {}),
          name,
          ...(box !== undefined ? { box } : {}),
          ...(anchor === 't'
            ? { anchor: 'top' as const }
            : anchor === 'ctr'
              ? { anchor: 'middle' as const }
              : anchor === 'b'
                ? { anchor: 'bottom' as const }
                : {}),
          insets: readBodyInsets(bodyPr),
          ...(findFirst(bk, 'a:spAutoFit') !== undefined
            ? { autofit: 'shape' as const }
            : findFirst(bk, 'a:normAutofit') !== undefined
              ? { autofit: 'normal' as const }
              : findFirst(bk, 'a:noAutofit') !== undefined
                ? { autofit: 'none' as const }
                : {}),
          lstStyle: readLevels(lst, theme),
          ...(prompt !== undefined ? { prompt } : {}),
        })
        continue
      }
      if (box === undefined) continue
      const spKids = spPr === undefined ? [] : getChildren(spPr, 'p:spPr')
      const prst = findFirst(spKids, 'a:prstGeom')
      const ln = findFirst(spKids, 'a:ln')
      const fill = readColour(findFirst(spKids, 'a:solidFill'), theme)
      const lineColour =
        ln === undefined
          ? undefined
          : readColour(findFirst(getChildren(ln, 'a:ln'), 'a:solidFill'), theme)
      const lineWidth = ln === undefined ? undefined : num(getAttrs(ln)['@w'])
      let image: string | undefined
      if (tag === 'p:pic') {
        const blipFill = findFirst(kids, 'p:blipFill')
        const blip =
          blipFill === undefined
            ? undefined
            : findFirst(getChildren(blipFill, 'p:blipFill'), 'a:blip')
        // An SVG (asvg:svgBlip in the blip's extLst) wins over its raster
        // fallback; some templates carry only the SVG.
        let embed: unknown
        for (const n of walk(blip === undefined ? [] : [blip]))
          if (getTag(n)?.endsWith(':svgBlip') === true) embed = getAttrs(n)['@r:embed']
        embed ??= getAttrs(blip ?? {})['@r:embed']
        if (typeof embed === 'string') image = embed
      }
      const text = textOf(txBody)
      const look = text === undefined ? undefined : firstRunLevel(txBody, theme)
      out.shapes.push({
        kind: tag === 'p:sp' ? 'sp' : tag === 'p:pic' ? 'pic' : 'cxnSp',
        name,
        box,
        ...(prst !== undefined && typeof getAttrs(prst)['@prst'] === 'string'
          ? { geometry: getAttrs(prst)['@prst'] as string }
          : {}),
        ...(fill !== undefined ? { fill } : {}),
        ...(ln !== undefined
          ? {
              line: {
                ...(lineColour !== undefined ? { colour: lineColour } : {}),
                ...(lineWidth !== undefined ? { widthEmu: lineWidth } : {}),
              },
            }
          : {}),
        ...(text !== undefined ? { text } : {}),
        ...(look !== undefined ? { levels: [look] } : {}),
        ...(image !== undefined ? { image } : {}),
      })
    }
  }
  visit(spTree, IDENTITY)
  return out
}

function readBackground(cSld: XmlNode | undefined, theme: ThemeColourMap): ReadColour | undefined {
  if (cSld === undefined) return undefined
  const bg = findFirst(getChildren(cSld, 'p:cSld'), 'p:bg')
  if (bg === undefined) return undefined
  const bgKids = getChildren(bg, 'p:bg')
  const bgPr = findFirst(bgKids, 'p:bgPr')
  if (bgPr !== undefined)
    return readColour(findFirst(getChildren(bgPr, 'p:bgPr'), 'a:solidFill'), theme)
  const bgRef = findFirst(bgKids, 'p:bgRef')
  return bgRef === undefined ? undefined : readColour(bgRef, theme)
}

/** Read every master of a .pptx/.potx and all of its layouts. */
export async function readTemplate(bytes: Uint8Array | Buffer): Promise<TemplateReading> {
  const zip = await JSZip.loadAsync(bytes)
  const pres = await readXml(zip, 'ppt/presentation.xml')
  const sldSz = first(pres, 'p:sldSz')
  const size = {
    cx: num(getAttrs(sldSz ?? {})['@cx']) ?? 12_192_000,
    cy: num(getAttrs(sldSz ?? {})['@cy']) ?? 6_858_000,
  }
  const presRels = await readRels(zip, 'ppt/presentation.xml')
  const frac = (b: { x: number; y: number; w: number; h: number }): Rect => [
    b.x / size.cx,
    b.y / size.cy,
    b.w / size.cx,
    b.h / size.cy,
  ]

  const masters: MasterReading[] = []
  const idList = first(pres, 'p:sldMasterIdLst')
  for (const id of idList === undefined ? [] : getChildren(idList, 'p:sldMasterIdLst')) {
    const rid = getAttrs(id)['@r:id']
    const rel = typeof rid === 'string' ? presRels.get(rid) : undefined
    if (rel === undefined) continue
    const part = rel.target
    const tree = await readXml(zip, part)
    const rels = await readRels(zip, part)
    const themeRel = [...rels.values()].find((r) => r.type.endsWith('/theme'))
    if (themeRel === undefined) throw new Error(`master ${part} has no theme`)
    const themeXml = await zip.file(themeRel.target)!.async('string')
    // The same object themeFromXml registered its font scheme under (resolveTypeface looks it up by identity).
    const theme: ThemeColourMap = themeFromXml(themeXml)
    // The master's colour map: which theme slot tx1/bg1/tx2/bg2 (and the
    // accents) stand for on this master.
    const clrMap = getAttrs(first(tree, 'p:clrMap') ?? {})
    for (const [k, v] of Object.entries(clrMap)) {
      const alias = k.slice(1)
      if (typeof v === 'string' && theme[v] !== undefined) theme[alias] = theme[v]!
    }
    const fontScheme = first(ooxmlParser().parse(themeXml) as XmlNode[], 'a:fontScheme')
    const fonts: MasterReading['fonts'] = {}
    if (fontScheme !== undefined)
      for (const slot of getChildren(fontScheme, 'a:fontScheme')) {
        const st = getTag(slot)
        if (st !== 'a:majorFont' && st !== 'a:minorFont') continue
        const latin = findFirst(getChildren(slot, st), 'a:latin')
        const tf = getAttrs(latin ?? {})['@typeface']
        if (typeof tf === 'string') fonts[st === 'a:majorFont' ? 'major' : 'minor'] = tf
      }
    const colours: Record<string, string> = {}
    for (const [k, v] of Object.entries(theme)) colours[k] = hex(v)

    const txStylesNode = first(tree, 'p:txStyles')
    const txKids = txStylesNode === undefined ? [] : getChildren(txStylesNode, 'p:txStyles')
    const txStyles = {
      title: readLevels(findFirst(txKids, 'p:titleStyle'), theme),
      body: readLevels(findFirst(txKids, 'p:bodyStyle'), theme),
      other: readLevels(findFirst(txKids, 'p:otherStyle'), theme),
    }
    const bucket = (type: string): MasterLevel[] =>
      type === 'title' || type === 'ctrTitle'
        ? txStyles.title
        : type === 'body' || type === 'subTitle' || type === 'obj' || type === 'pic'
          ? txStyles.body
          : txStyles.other

    const masterCSld = first(tree, 'p:cSld')
    const masterTree = readSpTree(first(tree, 'p:spTree'), theme)
    const masterPh = masterTree.placeholders
    const resolve = (p: SpTreeReading['placeholders'][number]): MasterPlaceholder => {
      const base =
        masterPh.find((m) => m.type === p.type) ??
        (p.type === 'ctrTitle' ? masterPh.find((m) => m.type === 'title') : undefined) ??
        (p.type === 'subTitle' || p.type === 'obj'
          ? masterPh.find((m) => m.type === 'body')
          : undefined) ??
        (p.idx !== undefined ? masterPh.find((m) => m.idx === p.idx) : undefined)
      const box = p.box ?? base?.box ?? { x: 0, y: 0, w: size.cx, h: size.cy }
      const anchor = p.anchor ?? base?.anchor
      const autofit = p.autofit ?? base?.autofit
      const prompt = p.prompt
      return {
        type: p.type,
        ...(p.idx !== undefined ? { idx: p.idx } : {}),
        name: p.name,
        rect: frac(box),
        inherited: p.box === undefined,
        ...(anchor !== undefined ? { anchor } : {}),
        insets: { ...DEFAULT_INSETS, ...base?.insets, ...p.insets },
        ...(autofit !== undefined ? { autofit } : {}),
        levels: mergeLevels(p.lstStyle, mergeLevels(base?.lstStyle ?? [], bucket(p.type))),
        ...(prompt !== undefined ? { prompt } : {}),
      }
    }
    const shapes = (s: SpTreeReading['shapes']): MasterShape[] =>
      s.map(({ box, ...rest }) => ({ ...rest, rect: frac(box) }))

    const layouts: MasterLayout[] = []
    const layoutIds = first(tree, 'p:sldLayoutIdLst')
    for (const lid of layoutIds === undefined ? [] : getChildren(layoutIds, 'p:sldLayoutIdLst')) {
      const lrid = getAttrs(lid)['@r:id']
      const lrel = typeof lrid === 'string' ? rels.get(lrid) : undefined
      if (lrel === undefined) continue
      const ltree = await readXml(zip, lrel.target)
      const lrels = await readRels(zip, lrel.target)
      const root = first(ltree, 'p:sldLayout')
      const ra = getAttrs(root ?? {})
      const cSld = first(ltree, 'p:cSld')
      const reading = readSpTree(first(ltree, 'p:spTree'), theme)
      const background = readBackground(cSld, theme)
      layouts.push({
        part: lrel.target,
        name: String(getAttrs(cSld ?? {})['@name'] ?? lrel.target),
        ...(typeof ra['@type'] === 'string' ? { type: ra['@type'] } : {}),
        ...(background !== undefined ? { background } : {}),
        showMasterShapes: ra['@showMasterSp'] !== '0' && ra['@showMasterSp'] !== 'false',
        placeholders: reading.placeholders.map(resolve),
        shapes: shapes(reading.shapes).map((s) =>
          s.image !== undefined ? { ...s, image: lrels.get(s.image)?.target ?? s.image } : s,
        ),
      })
    }
    const background = readBackground(masterCSld, theme)
    masters.push({
      part,
      ...(typeof getAttrs(masterCSld ?? {})['@name'] === 'string'
        ? { name: getAttrs(masterCSld!)['@name'] as string }
        : {}),
      themePart: themeRel.target,
      colours,
      fonts,
      txStyles,
      ...(background !== undefined ? { background } : {}),
      placeholders: masterPh.map((p) => ({
        ...resolve(p),
        levels: mergeLevels(p.lstStyle, bucket(p.type)),
      })),
      shapes: shapes(masterTree.shapes).map((s) =>
        s.image !== undefined ? { ...s, image: rels.get(s.image)?.target ?? s.image } : s,
      ),
      layouts,
    })
  }
  return { size, masters }
}
