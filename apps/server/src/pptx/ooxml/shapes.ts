/**
 * pptx/ooxml/shapes.ts
 *
 * Slide objects → PresentationML shapes (`p:sp`, `p:pic`, `p:cxnSp`).
 *
 * Every function writes the object the way the importer reads it back: the
 * frame in exact EMU (`units.ts`), fills and lines through `fill.ts` /
 * `color.ts`, enumerations through `vocabulary.ts`. Values OOXML cannot hold
 * go into the object's Narrative extension (`narrativeExt.ts`) next to a
 * native approximation PowerPoint can show.
 *
 * Element order inside `<p:spPr>` is the CT_ShapeProperties sequence:
 * xfrm, geometry, fill, ln, effectLst.
 */

import type {
  ArrowObject,
  EllipseObject,
  ImageFocus,
  ImageMask,
  ImageObject,
  NormalizedPathAnchor,
  LineObject,
  PathAnchor,
  PathObject,
  PolygonObject,
  RectangleObject,
  SlideObject,
  TextObject,
  TriangleObject,
  VideoObject,
} from '@narrative/shared'
import { regularPolygonVertices, rotationToDegrees } from '@narrative/shared'
import { el, tag, type XmlChild, type XmlElement } from './xml.js'
import { type XmlNode, findFirst, getAttrs, getChildren, getTag } from './read.js'
import { writeFill, type FillModel, type GradientModel } from './fill.js'
import { degToAngle, fractionToPercent, percentToFraction, pxToEmu } from './units.js'
import { writeLine } from './line.js'
import { writeEffects } from './effects.js'
import { writeNarrativeExt, type FrameFingerprint } from './narrativeExt.js'
import {
  connectorEnds,
  connectorFrame,
  hasDetachedHandles,
  objectExtValues,
  polygonPreset,
  type CropSignature,
} from './objectExt.js'
import { POLYGON_PRST } from './vocabulary.js'
import { writeTextBody, type TextWriteContext } from './text.js'

export interface PixelSize {
  width: number
  height: number
}

export interface ShapeWriteContext extends TextWriteContext {
  /** Relationship id of an image part for this asset, or undefined if it has no bytes. */
  imageRelId(assetId: string): Promise<string | undefined>
  /** A picture's pixel size, or undefined when it cannot be read. */
  pixelSize(assetId: string): Promise<PixelSize | undefined>
  /** Relationship ids for a video asset (`r:link` video + `r:embed` media), or undefined. */
  videoRelIds(assetId: string): Promise<{ video: string; media: string } | undefined>
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

interface Frame extends FrameFingerprint {
  flipH: boolean
  flipV: boolean
}

function frameOf(
  o: Pick<SlideObject, 'x' | 'y' | 'width' | 'height' | 'rotation'> & {
    flipH?: boolean
    flipV?: boolean
  },
): Frame {
  return {
    x: pxToEmu(o.x),
    y: pxToEmu(o.y),
    cx: Math.max(0, pxToEmu(o.width)),
    cy: Math.max(0, pxToEmu(o.height)),
    rot: o.rotation !== 0 ? degToAngle(rotationToDegrees(o.rotation)) : 0,
    flipH: o.flipH === true,
    flipV: o.flipV === true,
  }
}

function xfrm(f: Frame): XmlElement {
  return el(
    'a:xfrm',
    {
      rot: f.rot !== 0 ? f.rot : undefined,
      flipH: f.flipH ? 1 : undefined,
      flipV: f.flipV ? 1 : undefined,
    },
    el('a:off', { x: f.x, y: f.y }),
    el('a:ext', { cx: f.cx, cy: f.cy }),
  )
}

// ---------------------------------------------------------------------------
// Non-visual properties
// ---------------------------------------------------------------------------

function hyperlink(o: SlideObject, ctx: ShapeWriteContext): XmlChild {
  const h = o.hyperlink
  if (h === undefined || o.type === 'text') return null // text links ride on its runs
  if (h.kind === 'url') return el('a:hlinkClick', { 'r:id': ctx.hyperlinkRelId(h.href) })
  const rid = ctx.slideRelId(h.slideId)
  return rid === undefined
    ? null
    : el('a:hlinkClick', { 'r:id': rid, action: 'ppaction://hlinksldjump' })
}

/**
 * `<p:cNvPr>`: id, name, alt text, a click action on the whole shape, and
 * the Narrative extension with every model value the native XML written
 * for this object cannot carry exactly (objectExt.ts).
 */
function cNvPr(
  id: number,
  o: SlideObject,
  ctx: ShapeWriteContext,
  frame: Frame,
  cropSignature: CropSignature = '',
): XmlElement {
  return el(
    'p:cNvPr',
    {
      id,
      name: o.name ?? `${o.type} ${id}`,
      descr: 'alt' in o && typeof o.alt === 'string' && o.alt !== '' ? o.alt : undefined,
    },
    hyperlink(o, ctx),
    writeNarrativeExt(objectExtValues(o, cropSignature), frame),
  )
}

// ---------------------------------------------------------------------------
// Fill / line / effects
// ---------------------------------------------------------------------------

type Filled = RectangleObject | EllipseObject | TriangleObject | PolygonObject | PathObject

function gradientOf(o: Filled): GradientModel | undefined {
  const fs = o.fillStyle
  if (fs === undefined || fs.kind === 'image') return undefined
  if (fs.kind === 'linearGradient')
    return { kind: 'linearGradient', angleDeg: fs.angleDeg, stops: fs.stops }
  const g: GradientModel = { kind: 'radialGradient', stops: fs.stops }
  if (fs.centerX !== undefined) g.centerX = fs.centerX
  if (fs.centerY !== undefined) g.centerY = fs.centerY
  return g
}

/**
 * The fill. A shape whose fill is fully transparent still names its colour
 * (solid, alpha 0) — the model keeps that colour for when the alpha comes
 * back up, and `<a:noFill/>` would lose it. A picture fill is a
 * `<a:blipFill>` stretched over the shape.
 */
async function shapeFill(o: Filled, ctx: ShapeWriteContext): Promise<XmlChild> {
  const fs = o.fillStyle
  if (fs?.kind === 'image') {
    const box = { x: o.x, y: o.y, width: o.width, height: o.height }
    const picture = await pictureFill(fs.assetId, fs.fit ?? 'cover', box, ctx)
    if (picture !== null) return picture
  }
  const g = gradientOf(o)
  if (g !== undefined) return writeFill({ kind: 'gradient', gradient: g })
  if (o.fill === undefined) return writeFill({ kind: 'none' })
  const f: FillModel = { kind: 'solid', color: o.fill as number }
  if (o.fillAlpha !== undefined && o.fillAlpha < 1) f.alpha = o.fillAlpha
  return writeFill(f)
}

// ---------------------------------------------------------------------------
// Parametric shapes
// ---------------------------------------------------------------------------

function prstGeom(prst: string, adj?: Record<string, number>): XmlElement {
  return el(
    'a:prstGeom',
    { prst },
    tag(
      'a:avLst',
      adj !== undefined &&
        Object.entries(adj).map(([name, v]) => el('a:gd', { name, fmla: `val ${Math.round(v)}` })),
    ),
  )
}

/**
 * `roundRect`'s `adj` is the radius as a fraction of the shorter side, in
 * 1/100 000, capped at half. A per-corner radius has no preset; their
 * average is drawn (the four values ride in the extension).
 */
function roundRectGeom(o: RectangleObject): XmlElement {
  const cr = o.cornerRadius
  if (cr === undefined) return prstGeom('rect')
  const r = typeof cr === 'number' ? cr : (cr.tl + cr.tr + cr.br + cr.bl) / 4
  if (!(r > 0)) return prstGeom('rect')
  const short = Math.max(1e-6, Math.min(o.width, o.height))
  return prstGeom('roundRect', { adj: Math.min(50_000, (r / short) * 100_000) })
}

/** `roundRect`'s `adj` when the shape declares none (presetShapeDefinitions.xml). */
export const ROUND_RECT_DEFAULT_ADJ = 16_667

/**
 * The corner radius a `<a:prstGeom prst="roundRect">` draws, in the same
 * unit as `width` / `height`: `adj` of the shorter side, capped at half.
 */
export function readRoundRectRadius(prstGeom: XmlNode, width: number, height: number): number {
  let adj = ROUND_RECT_DEFAULT_ADJ
  const avLst = findFirst(getChildren(prstGeom, 'a:prstGeom'), 'a:avLst')
  if (avLst !== undefined) {
    for (const gd of getChildren(avLst, 'a:avLst')) {
      const a = getAttrs(gd)
      if (a['@name'] !== 'adj') continue
      const m = /^val\s+(-?\d+(?:\.\d+)?)$/.exec(String(a['@fmla'] ?? '').trim())
      if (m !== null) adj = Number(m[1])
    }
  }
  const clamped = Math.max(0, Math.min(50_000, adj))
  return (clamped / 100_000) * Math.min(width, height)
}

function regularPolygonAnchors(sides: number, w: number, h: number): PathAnchor[] {
  // The outline the canvas draws (@narrative/shared shapeGeometry).
  return regularPolygonVertices(sides, w, h)
}

export async function writeParametricShape(
  o: RectangleObject | EllipseObject | TriangleObject | PolygonObject,
  id: number,
  ctx: ShapeWriteContext,
): Promise<XmlElement> {
  const frame = frameOf(o)
  let geom: XmlElement
  if (o.type === 'rectangle') {
    geom = roundRectGeom(o)
  } else if (o.type === 'ellipse') {
    geom = prstGeom('ellipse')
  } else if (o.type === 'triangle') {
    geom = prstGeom('triangle')
  } else {
    const prst = polygonPreset(o.sides)
    // No preset for this many sides: draw it (the extension names it).
    geom =
      prst !== undefined
        ? prstGeom(prst)
        : custGeom(
            regularPolygonAnchors(Math.max(3, Math.round(o.sides)), o.width, o.height),
            true,
            o.width,
            o.height,
          )
  }
  return tag(
    'p:sp',
    tag(
      'p:nvSpPr',
      cNvPr(id, o, ctx, frame),
      aspectLocks('p:cNvSpPr', 'a:spLocks', o),
      tag('p:nvPr'),
    ),
    tag(
      'p:spPr',
      xfrm(frame),
      geom,
      await shapeFill(o, ctx),
      writeLine({
        color: o.stroke as number | undefined,
        alpha: o.strokeAlpha,
        width: o.strokeWidth,
        dash: o.strokeDash === true,
      }),
      writeEffects(o),
    ),
  )
}

/**
 * Whether a shape's non-visual properties lock its aspect ratio
 * (`noChangeAspect` on `a:spLocks` / `a:picLocks` / `a:cxnSpLocks` /
 * `a:graphicFrameLocks`). `nvHolder` is `p:nvSpPr`, `p:nvPicPr`, … .
 */
export function readAspectLocked(nvHolder: XmlNode | undefined): boolean {
  if (nvHolder === undefined) return false
  const holderTag = getTag(nvHolder)
  if (holderTag === null) return false
  for (const cNv of getChildren(nvHolder, holderTag)) {
    const t = getTag(cNv)
    if (t === null || !/^p:cNv\w+Pr$/.test(t) || t === 'p:cNvPr') continue
    for (const locks of getChildren(cNv, t)) {
      const a = getAttrs(locks)['@noChangeAspect']
      if (a === '1' || a === 'true') return true
    }
  }
  return false
}

function aspectLocks(
  outer: 'p:cNvSpPr' | 'p:cNvPicPr' | 'p:cNvCxnSpPr',
  inner: 'a:spLocks' | 'a:picLocks' | 'a:cxnSpLocks',
  o: SlideObject,
  extraAttrs: Record<string, string | number> = {},
): XmlElement {
  return el(outer, extraAttrs, o.aspectLocked === true && el(inner, { noChangeAspect: 1 }))
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `<a:custGeom>` for anchors relative to the frame's top-left, in canvas px.
 * The path's coordinate space is the frame in EMU, so coordinates are exact.
 * A segment is a cubic curve when its start has `cpOut` and its end `cpIn` —
 * the renderer's rule — and a straight line otherwise.
 */
function custGeom(
  anchors: readonly PathAnchor[],
  closed: boolean,
  w: number,
  h: number,
): XmlElement {
  const pw = Math.max(1, pxToEmu(w))
  const ph = Math.max(1, pxToEmu(h))
  const pt = (x: number, y: number): XmlElement => el('a:pt', { x: pxToEmu(x), y: pxToEmu(y) })
  const cmds: XmlElement[] = []
  anchors.forEach((a, i) => {
    if (i === 0 || a.moveTo === true) {
      if (i > 0 && closed) cmds.push(tag('a:close'))
      cmds.push(tag('a:moveTo', pt(a.x, a.y)))
      return
    }
    const prev = anchors[i - 1]!
    if (prev.cpOut !== undefined && a.cpIn !== undefined) {
      cmds.push(
        tag(
          'a:cubicBezTo',
          pt(prev.x + prev.cpOut.x, prev.y + prev.cpOut.y),
          pt(a.x + a.cpIn.x, a.y + a.cpIn.y),
          pt(a.x, a.y),
        ),
      )
    } else {
      cmds.push(tag('a:lnTo', pt(a.x, a.y)))
    }
  })
  if (closed && anchors.length > 0) cmds.push(tag('a:close'))
  return tag(
    'a:custGeom',
    tag('a:avLst'),
    tag('a:gdLst'),
    tag('a:ahLst'),
    tag('a:cxnLst'),
    el('a:rect', { l: 0, t: 0, r: 'r', b: 'b' }),
    tag('a:pathLst', el('a:path', { w: pw, h: ph }, cmds)),
  )
}

/** A path anchor as read, in the frame's space (see `readCustGeom`). */
export interface GeomAnchor {
  x: number
  y: number
  cpIn?: { x: number; y: number }
  cpOut?: { x: number; y: number }
  /** Subpath start marker — see `PathAnchor.moveTo` in slide-model. */
  moveTo?: boolean
}

/**
 * Parse a `<a:custGeom>/<a:pathLst>/<a:path>` into an array of anchors
 * matching Narrative's PathAnchor schema (with cubic-bezier handles when
 * the source used `<a:cubicBezTo>` segments).
 *
 * PPTX path coordinate model: `<a:path w="EMU" h="EMU">` declares a path
 * coordinate space that maps onto the shape's `<a:xfrm>/<a:ext>` bbox.
 * Children are `<a:moveTo>`, `<a:lnTo>`, `<a:cubicBezTo>`, `<a:quadBezTo>`,
 * `<a:arcTo>`, and `<a:close>`. Each `<a:pt x="..." y="..."/>` is a
 * coordinate in that EMU space. We:
 *   1. Convert each PPTX point from path-space EMU → slide-local px
 *      using `(emuToPx(coord) * shapeExtPx / emuToPx(pathW))` so the
 *      anchors map directly into the shape's bbox.
 *   2. For cubicBezTo: PPTX gives three points (cp1, cp2, end). cp1
 *      becomes the previous anchor's cpOut, cp2 becomes the new
 *      anchor's cpIn.
 *   3. quadBezTo gets converted to a cubic by the standard
 *      `1/3, 2/3` interpolation between the start, control, and end
 *      points. arcTo is not currently supported (drops the segment).
 *
 * Returns `{ anchors, closed }` in the frame's own unit and space (the
 * importer passes the shape's slide-local source px), NOT relative to the
 * frame's `(x, y)`. The writing counterpart is `custGeom` above.
 */
export function readCustGeom(
  custGeom: XmlNode,
  frame: Rect,
): { anchors: GeomAnchor[]; closed: boolean } {
  const shapeWidthPx = frame.width
  const shapeHeightPx = frame.height
  const shapeXPx = frame.x
  const shapeYPx = frame.y
  const cgChildren = getChildren(custGeom, 'a:custGeom')
  const pathLst = findFirst(cgChildren, 'a:pathLst')
  if (!pathLst) return { anchors: [], closed: false }
  const path = findFirst(getChildren(pathLst, 'a:pathLst'), 'a:path')
  if (!path) return { anchors: [], closed: false }

  const pathAttrs = getAttrs(path)
  const pathW = Number(pathAttrs['@w'] ?? 0) || 1
  const pathH = Number(pathAttrs['@h'] ?? 0) || 1
  const scaleX = shapeWidthPx / pathW
  const scaleY = shapeHeightPx / pathH
  // Convert a `<a:pt>` (EMU in path-space) to slide-local px.
  const toPx = (ptNode: XmlNode | undefined): { x: number; y: number } | undefined => {
    if (!ptNode) return undefined
    const a = getAttrs(ptNode)
    const px = Number(a['@x'] ?? 0)
    const py = Number(a['@y'] ?? 0)
    return { x: shapeXPx + px * scaleX, y: shapeYPx + py * scaleY }
  }

  const anchors: GeomAnchor[] = []
  let closed = false
  const pathChildren = getChildren(path, 'a:path')
  let cursor: { x: number; y: number } | undefined
  // `<a:custGeom>` can pack many disconnected subpaths into a single
  // `<a:path>` — each subpath is delimited by `<a:moveTo>` (start) and
  // `<a:close/>` (end). Slide 8's dot-grid icons take this shape:
  // ~1300 closed quads, one per dot, all in one <a:path>. Without
  // subpath tracking the renderer would draw straight lines between
  // each dot's closing corner and the next dot's start, producing the
  // diagonal-shear artefact the user saw. The first anchor of a
  // subpath gets a `moveTo: true` flag; the renderer's `tracePath`
  // emits a Graphics.moveTo for those instead of a lineTo.

  for (const cmd of pathChildren) {
    const tag = getTag(cmd)
    if (tag === null) continue
    const ptNodes = getChildren(cmd, tag).filter((n) => getTag(n) === 'a:pt')
    if (tag === 'a:moveTo') {
      const p = toPx(ptNodes[0])
      if (p !== undefined) {
        // First anchor of the whole path is implicitly a subpath start,
        // so no flag needed (tracePath always emits moveTo for index 0).
        // Subsequent moveTo's (post-close) DO need the flag.
        const a: GeomAnchor = { x: p.x, y: p.y }
        if (anchors.length > 0) a.moveTo = true
        anchors.push(a)
        cursor = p
      }
    } else if (tag === 'a:lnTo') {
      const p = toPx(ptNodes[0])
      if (p !== undefined) {
        anchors.push({ x: p.x, y: p.y })
        cursor = p
      }
    } else if (tag === 'a:cubicBezTo') {
      // cubicBezTo carries three `<a:pt>` children: cp1, cp2, end.
      const cp1 = toPx(ptNodes[0])
      const cp2 = toPx(ptNodes[1])
      const end = toPx(ptNodes[2])
      if (cp1 !== undefined && anchors.length > 0 && cursor !== undefined) {
        const prev = anchors[anchors.length - 1]!
        prev.cpOut = { x: cp1.x - prev.x, y: cp1.y - prev.y }
      }
      if (end !== undefined) {
        const next: GeomAnchor = { x: end.x, y: end.y }
        if (cp2 !== undefined) {
          next.cpIn = { x: cp2.x - end.x, y: cp2.y - end.y }
        }
        anchors.push(next)
        cursor = end
      }
    } else if (tag === 'a:quadBezTo') {
      // Quad → cubic conversion. Quad has cp + end; cubic equivalent:
      // cp1 = start + 2/3 (cp - start), cp2 = end + 2/3 (cp - end).
      const cp = toPx(ptNodes[0])
      const end = toPx(ptNodes[1])
      if (cp !== undefined && end !== undefined && cursor !== undefined) {
        const start = cursor
        const cp1 = {
          x: start.x + (2 / 3) * (cp.x - start.x),
          y: start.y + (2 / 3) * (cp.y - start.y),
        }
        const cp2 = {
          x: end.x + (2 / 3) * (cp.x - end.x),
          y: end.y + (2 / 3) * (cp.y - end.y),
        }
        if (anchors.length > 0) {
          const prev = anchors[anchors.length - 1]!
          prev.cpOut = { x: cp1.x - prev.x, y: cp1.y - prev.y }
        }
        anchors.push({
          x: end.x,
          y: end.y,
          cpIn: { x: cp2.x - end.x, y: cp2.y - end.y },
        })
        cursor = end
      }
    } else if (tag === 'a:close') {
      closed = true
    }
    // arcTo intentionally not handled — out of v1 scope; PowerPoint's
    // arcTo is rare on user-drawn paths (pen tool uses cubic).
  }

  return { anchors, closed }
}

export async function writePath(
  o: PathObject,
  id: number,
  ctx: ShapeWriteContext,
): Promise<XmlElement> {
  const frame = frameOf(o)
  return tag(
    'p:sp',
    tag(
      'p:nvSpPr',
      cNvPr(id, o, ctx, frame),
      aspectLocks('p:cNvSpPr', 'a:spLocks', o),
      tag('p:nvPr'),
    ),
    tag(
      'p:spPr',
      xfrm(frame),
      custGeom(o.anchors, o.closed === true, o.width, o.height),
      await shapeFill(o, ctx),
      writeLine({
        color: o.stroke as number,
        alpha: o.strokeAlpha,
        width: o.strokeWidth,
        dash: o.dash === true,
      }),
      writeEffects(o),
    ),
  )
}

// ---------------------------------------------------------------------------
// Lines and arrows
// ---------------------------------------------------------------------------

/**
 * A connector's direction is its frame plus flips: unflipped it runs from
 * the top-left corner to the bottom-right, `flipH` swaps left and right,
 * `flipV` top and bottom. The frame is the endpoints' own bounding box.
 */
export function writeLineObject(
  o: LineObject | ArrowObject,
  id: number,
  ctx: ShapeWriteContext,
): XmlElement {
  const f = connectorFrame(o)
  const frame: Frame = {
    x: pxToEmu(f.x),
    y: pxToEmu(f.y),
    cx: pxToEmu(f.width),
    cy: pxToEmu(f.height),
    rot: o.rotation !== 0 ? degToAngle(rotationToDegrees(o.rotation)) : 0,
    flipH: f.flipH,
    flipV: f.flipV,
  }
  const { start: startCap, end: endCap } = connectorEnds(o)
  return tag(
    'p:cxnSp',
    tag(
      'p:nvCxnSpPr',
      cNvPr(id, o, ctx, frame),
      aspectLocks('p:cNvCxnSpPr', 'a:cxnSpLocks', o),
      tag('p:nvPr'),
    ),
    tag(
      'p:spPr',
      xfrm(frame),
      prstGeom('line'),
      writeLine({
        color: o.stroke as number,
        alpha: o.strokeAlpha,
        width: o.strokeWidth,
        dash: o.dash === true,
        head: startCap,
        tail: endCap,
      }),
      writeEffects(o),
    ),
  )
}

// ---------------------------------------------------------------------------
// Picture masks
// ---------------------------------------------------------------------------

/**
 * A picture's own geometry — PowerPoint's "crop to shape" — for the model's
 * image mask, which clips the picture to a shape filling its frame.
 */
function maskGeom(mask: ImageMask | undefined, w: number, h: number): XmlElement {
  if (mask === undefined) return prstGeom('rect')
  switch (mask.kind) {
    case 'rectangle': {
      const cr = mask.cornerRadius
      const r =
        cr === undefined ? 0 : typeof cr === 'number' ? cr : (cr.tl + cr.tr + cr.br + cr.bl) / 4
      if (!(r > 0)) return prstGeom('rect')
      return prstGeom('roundRect', {
        adj: Math.min(50_000, (r / Math.max(1e-6, Math.min(w, h))) * 100_000),
      })
    }
    case 'ellipse':
      return prstGeom('ellipse')
    case 'triangle':
      return prstGeom('triangle')
    case 'polygon': {
      const prst = polygonPreset(mask.sides)
      return prst !== undefined
        ? prstGeom(prst)
        : custGeom(regularPolygonAnchors(Math.max(3, Math.round(mask.sides)), w, h), true, w, h)
    }
    case 'path':
      return custGeom(denormalizeAnchors(mask.anchors, w, h), mask.closed, w, h)
  }
}

function denormalizeAnchors(
  anchors: readonly NormalizedPathAnchor[],
  w: number,
  h: number,
): PathAnchor[] {
  return anchors.map((a) => {
    const out: PathAnchor = { x: a.x * w, y: a.y * h }
    if (a.cpIn !== undefined) out.cpIn = { x: a.cpIn.x * w, y: a.cpIn.y * h }
    if (a.cpOut !== undefined) out.cpOut = { x: a.cpOut.x * w, y: a.cpOut.y * h }
    return out
  })
}

/**
 * Whether `maskGeom` says a mask exactly — what `readPictureMask` reads
 * back is the same mask. The rest rides in the object's extension.
 */
export function maskIsNative(mask: ImageMask, w: number, h: number): boolean {
  switch (mask.kind) {
    case 'rectangle': {
      const r = mask.cornerRadius
      return typeof r === 'number' && r > 0 && r <= Math.min(w, h) / 2
    }
    case 'ellipse':
    case 'triangle':
      return true
    case 'polygon':
      return polygonPreset(mask.sides) !== undefined
    case 'path':
      return mask.anchors.length > 1 && !hasDetachedHandles(denormalizeAnchors(mask.anchors, w, h))
  }
}

/**
 * The mask a picture's geometry says, for a frame in source px: the model
 * clips the picture to it. Plain `rect` is no mask; a geometry the model
 * has no mask for (PowerPoint's other presets, a path of several subpaths)
 * is none either.
 */
export function readPictureMask(spPrChildren: XmlNode[], frame: Rect): ImageMask | undefined {
  const prst = findFirst(spPrChildren, 'a:prstGeom')
  if (prst !== undefined) {
    const name = String(getAttrs(prst)['@prst'] ?? '')
    if (name === 'roundRect')
      return {
        kind: 'rectangle',
        cornerRadius: readRoundRectRadius(prst, frame.width, frame.height),
      }
    if (name === 'ellipse') return { kind: 'ellipse' }
    if (name === 'triangle' || name === 'isoscelesTriangle') return { kind: 'triangle' }
    const sides = POLYGON_PRST.fromXml(name)
    if (sides !== undefined) return { kind: 'polygon', sides: Number(sides) }
    return undefined
  }
  const cust = findFirst(spPrChildren, 'a:custGeom')
  if (cust === undefined) return undefined
  const { anchors, closed } = readCustGeom(cust, frame)
  if (anchors.length < 2 || anchors.some((a) => a.moveTo === true)) return undefined
  const w = frame.width !== 0 ? frame.width : 1
  const h = frame.height !== 0 ? frame.height : 1
  return {
    kind: 'path',
    closed,
    anchors: anchors.map((a) => {
      const out: NormalizedPathAnchor = { x: (a.x - frame.x) / w, y: (a.y - frame.y) / h }
      if (a.cpIn !== undefined) out.cpIn = { x: a.cpIn.x / w, y: a.cpIn.y / h }
      if (a.cpOut !== undefined) out.cpOut = { x: a.cpOut.x / w, y: a.cpOut.y / h }
      return out
    }),
  }
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

interface SrcRectInsets {
  l: number
  t: number
  r: number
  b: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the renderer draws a picture of `size` pixels fitted into `box`
 * (web `mediaFit.applyFit`): scaled to cover the box or to fit inside it,
 * centred, or against the side `focus` keeps in view. Without a known size
 * the picture fills the box exactly.
 */
export function fittedRect(
  box: Rect,
  size: PixelSize | undefined,
  fit: 'cover' | 'contain',
  focus?: ImageFocus,
): Rect {
  if (size === undefined || !(size.width > 0) || !(size.height > 0)) return box
  const scale =
    fit === 'cover'
      ? Math.max(box.width / size.width, box.height / size.height)
      : Math.min(box.width / size.width, box.height / size.height)
  const width = size.width * scale
  const height = size.height * scale
  const spareX = box.width - width
  const spareY = box.height - height
  return {
    x: box.x + (focus === 'left' ? 0 : focus === 'right' ? spareX : spareX / 2),
    y: box.y + (focus === 'top' ? 0 : focus === 'bottom' ? spareY : spareY / 2),
    width,
    height,
  }
}

/**
 * `<a:srcRect>` insets (1/100 000 of the picture per side) that show
 * `picture` — the whole picture's rectangle — through `frame`. Positive
 * crops, negative pads (a letterboxed picture), as PowerPoint's own "Fit"
 * writes it. Null when the picture fills the frame exactly.
 */
function insetsOf(frame: Rect, picture: Rect): SrcRectInsets | null {
  if (!(picture.width > 0) || !(picture.height > 0)) return null
  const insets = {
    l: fractionToPercent((frame.x - picture.x) / picture.width),
    t: fractionToPercent((frame.y - picture.y) / picture.height),
    r: fractionToPercent((picture.x + picture.width - (frame.x + frame.width)) / picture.width),
    b: fractionToPercent((picture.y + picture.height - (frame.y + frame.height)) / picture.height),
  }
  return insets.l === 0 && insets.t === 0 && insets.r === 0 && insets.b === 0 ? null : insets
}

function srcRectElement(insets: SrcRectInsets | null): XmlChild {
  return insets === null ? null : el('a:srcRect', { ...insets })
}

/**
 * A picture fill (`<a:blipFill>`) showing an asset fitted into `box` the
 * way the renderer draws it, or null when the asset has no bytes.
 */
export async function pictureFill(
  assetId: string,
  fit: 'cover' | 'contain',
  box: Rect,
  ctx: Pick<ShapeWriteContext, 'imageRelId' | 'pixelSize'>,
  tagName: 'a:blipFill' | 'p:blipFill' = 'a:blipFill',
  opacity = 1,
): Promise<XmlElement | null> {
  if (assetId === '') return null
  const rel = await ctx.imageRelId(assetId)
  if (rel === undefined) return null
  const picture = fittedRect(box, await ctx.pixelSize(assetId), fit)
  return tag(
    tagName,
    blip(rel, opacity),
    srcRectElement(insetsOf(box, picture)),
    tag('a:stretch', tag('a:fillRect')),
  )
}

/**
 * The crop a `<a:srcRect>` says, as a fingerprint: the extension's exact
 * `imageRect` applies only while the picture is cropped exactly as it was
 * written (a re-crop in PowerPoint changes this).
 */
export function srcRectSignature(node: XmlNode | undefined): string {
  if (node === undefined) return ''
  const a = getAttrs(node)
  return ['@l', '@t', '@r', '@b'].map((k) => Number(a[k] ?? 0) || 0).join(',')
}

/**
 * Where the whole picture lands for a frame and its `<a:srcRect>`: the
 * insets are fractions of the picture, the visible remainder fills the
 * frame. Same unit as the frame. Undefined for no crop.
 */
export function readImageRect(
  node: XmlNode | undefined,
  frame: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } | undefined {
  if (node === undefined) return undefined
  const a = getAttrs(node)
  const f = (k: string): number => percentToFraction(Number(a[k] ?? 0) || 0)
  const l = f('@l')
  const t = f('@t')
  const r = f('@r')
  const b = f('@b')
  if (l === 0 && t === 0 && r === 0 && b === 0) return undefined
  const imgW = frame.width / Math.max(0.001, 1 - l - r)
  const imgH = frame.height / Math.max(0.001, 1 - t - b)
  return { x: frame.x - l * imgW, y: frame.y - t * imgH, width: imgW, height: imgH }
}

function blip(relId: string, opacity: number): XmlElement {
  return el(
    'a:blip',
    { 'r:embed': relId },
    opacity < 1 && el('a:alphaModFix', { amt: fractionToPercent(Math.max(0, opacity)) }),
  )
}

export async function writeImage(
  o: ImageObject,
  id: number,
  ctx: ShapeWriteContext,
): Promise<XmlElement | null> {
  if (o.assetId === '') return null
  const rel = await ctx.imageRelId(o.assetId)
  if (rel === undefined) return null
  const frame = frameOf(o)
  // The renderer fits the picture into its crop rectangle (or its frame)
  // and clips to the frame; `srcRect` says exactly that to PowerPoint.
  const box = { x: o.x, y: o.y, width: o.width, height: o.height }
  const picture = fittedRect(
    o.imageRect ?? box,
    await ctx.pixelSize(o.assetId),
    o.fit ?? 'cover',
    o.focus,
  )
  const insets = insetsOf(box, picture)
  const cropSignature = insets === null ? '' : `${insets.l},${insets.t},${insets.r},${insets.b}`
  return tag(
    'p:pic',
    tag(
      'p:nvPicPr',
      cNvPr(id, o, ctx, frame, cropSignature),
      aspectLocks('p:cNvPicPr', 'a:picLocks', o),
      tag('p:nvPr'),
    ),
    tag(
      'p:blipFill',
      blip(rel, o.opacity),
      srcRectElement(insets),
      tag('a:stretch', tag('a:fillRect')),
    ),
    tag('p:spPr', xfrm(frame), maskGeom(o.mask, o.width, o.height), writeEffects(o)),
  )
}

export async function writeVideo(
  o: VideoObject,
  id: number,
  ctx: ShapeWriteContext,
): Promise<XmlElement | null> {
  if (o.assetId === '') return null
  const rels = await ctx.videoRelIds(o.assetId)
  if (rels === undefined) return null
  const frame = frameOf(o)
  // The poster frame, fitted as the renderer fits the video (contain by
  // default); PowerPoint crops the playing video by the same `srcRect`.
  const box = { x: o.x, y: o.y, width: o.width, height: o.height }
  const poster =
    o.posterAssetId !== undefined
      ? await pictureFill(o.posterAssetId, o.fit ?? 'contain', box, ctx, 'p:blipFill')
      : null
  return tag(
    'p:pic',
    tag(
      'p:nvPicPr',
      cNvPr(id, o, ctx, frame),
      aspectLocks('p:cNvPicPr', 'a:picLocks', o),
      tag(
        'p:nvPr',
        el('a:videoFile', { 'r:link': rels.video }),
        tag(
          'p:extLst',
          el(
            'p:ext',
            { uri: '{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}' },
            el('p14:media', {
              'xmlns:p14': 'http://schemas.microsoft.com/office/powerpoint/2010/main',
              'r:embed': rels.media,
            }),
          ),
        ),
      ),
    ),
    poster ?? tag('p:blipFill', tag('a:stretch', tag('a:fillRect'))),
    tag('p:spPr', xfrm(frame), prstGeom('rect'), writeEffects(o)),
  )
}

// ---------------------------------------------------------------------------
// Text frames
// ---------------------------------------------------------------------------

export function writeTextShape(o: TextObject, id: number, ctx: ShapeWriteContext): XmlElement {
  // PowerPoint does not mirror text: `flipH` on a text box is ignored and
  // `flipV` turns it upside down. Narrative mirrors the glyphs, which OOXML
  // cannot say, so a text object's flips ride in the extension only.
  const frame = frameOf({ ...o, flipH: false, flipV: false })
  return tag(
    'p:sp',
    tag(
      'p:nvSpPr',
      cNvPr(id, o, ctx, frame),
      aspectLocks('p:cNvSpPr', 'a:spLocks', o, { txBox: 1 }),
      tag('p:nvPr'),
    ),
    tag(
      'p:spPr',
      xfrm(frame),
      prstGeom('rect'),
      tag('a:noFill'),
      tag('a:ln', tag('a:noFill')),
      writeEffects(o),
    ),
    writeTextBody(o, ctx),
  )
}
