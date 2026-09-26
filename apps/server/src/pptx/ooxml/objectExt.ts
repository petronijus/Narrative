/**
 * pptx/ooxml/objectExt.ts
 *
 * Which model fields ride in an object's Narrative extension, both ways.
 *
 * The native XML is the first carrier of every value: it is what PowerPoint
 * shows, and what the importer reads. A value goes into the extension only
 * where the native form cannot say it exactly — a field OOXML has no place
 * for, a state it cannot distinguish (`false` where only `true` has a form,
 * a solid fallback colour next to a gradient), or a value it would round.
 * `objectExtValues` is that decision for every field of every object type,
 * in one table; `objectExtFields` reads the same fields back, each checked
 * against the model type it lands in (the extension is untrusted file
 * content).
 *
 * `implicit` names the fields the object does not have, each with the
 * value the import will nevertheless produce for it — a default the
 * importer fills in for any PowerPoint shape (`fit`, `muted`), or a value
 * the native XML had to state (a connector's line ends). The importer drops
 * such a field while it still holds exactly that value; one edited in
 * PowerPoint since is kept.
 *
 * Pictures are always written natively (`<a:blipFill>`); the extension
 * never names an asset — asset ids are the exporting deck's, and the import
 * gets its own from the native picture. It carries only how a picture is
 * fitted.
 *
 * `roundtrip.test.ts` holds every field to this: model → export → import
 * must give the model back.
 */

import type { FillStyle, PathAnchor, SlideObject } from '@narrative/shared'
import {
  anchor,
  arr,
  bool,
  color,
  cornerRadius,
  idRef,
  lineBox,
  mask,
  MAX_ANCHORS,
  nonNeg,
  num,
  oneOf,
  rect,
  str,
  table,
  unit,
  vAlign,
  type Schema,
} from './extSchema.js'
import { POLYGON_PRST } from './vocabulary.js'
import { pxToEmu } from './units.js'
import type { NarrativeObjectExt } from './narrativeExt.js'
import { familyIsNative } from './text.js'
import { maskIsNative } from './shapes.js'

// ---------------------------------------------------------------------------
// Writing: what the native XML cannot say
// ---------------------------------------------------------------------------

/** Whether the object's outline is drawn natively (colour and a positive width). */
function visibleStroke(stroke: unknown, width: number | undefined): boolean {
  return stroke !== undefined && width !== undefined && width > 0
}

/** Anchor handles the native path cannot carry: a handle with no cubic segment to shape. */
export function hasDetachedHandles(anchors: readonly PathAnchor[]): boolean {
  return anchors.some((a, i) => {
    const next = anchors[i + 1]
    const prev = anchors[i - 1]
    const outUsed = next !== undefined && next.moveTo !== true && next.cpIn !== undefined
    const inUsed = prev !== undefined && a.moveTo !== true && prev.cpOut !== undefined
    return (a.cpOut !== undefined && !outUsed) || (a.cpIn !== undefined && !inUsed)
  })
}

/** The polygon presets PowerPoint has; any other side count is drawn as a path. */
export function polygonPreset(sides: number): string | undefined {
  return POLYGON_PRST.entries.find(([n]) => Number(n) === sides)?.[1]
}

/**
 * The frame a connector is drawn in: its endpoints' bounding box, with
 * flips naming the direction.
 */
export function connectorFrame(o: Extract<SlideObject, { type: 'line' | 'arrow' }>): {
  x: number
  y: number
  width: number
  height: number
  flipH: boolean
  flipV: boolean
} {
  const x1 = o.x + o.p1.x
  const y1 = o.y + o.p1.y
  const x2 = o.x + o.p2.x
  const y2 = o.y + o.p2.y
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    flipH: x1 > x2,
    flipV: y1 > y2,
  }
}

/** The line ends a connector draws when the model leaves them unset. */
export function connectorEnds(o: Extract<SlideObject, { type: 'line' | 'arrow' }>): {
  start: 'none' | 'arrow' | 'round' | 'square'
  end: 'none' | 'arrow' | 'round' | 'square'
} {
  return { start: o.startCap ?? 'none', end: o.endCap ?? (o.type === 'arrow' ? 'arrow' : 'none') }
}

/**
 * The picture-crop fingerprint an exact `imageRect` is tied to — the
 * `srcRect` insets as written — or '' for no `srcRect`.
 */
export type CropSignature = string

/**
 * The extension values for one object: every model value the native XML
 * written for it cannot carry exactly. `cropSignature` is the image's
 * `srcRect` as written (shapes.ts decides it).
 */
export function objectExtValues(
  o: SlideObject,
  cropSignature: CropSignature = '',
): NarrativeObjectExt {
  const ext: NarrativeObjectExt = {}
  const put = (k: string, v: unknown): void => {
    if (v !== undefined) ext[k] = v
  }
  const record = o as unknown as Record<string, unknown>

  const implicit: Record<string, unknown> = {}
  const absent = (k: string): boolean => record[k] === undefined
  for (const [k, v] of Object.entries(IMPORTER_DEFAULTS[o.type] ?? {}))
    if (absent(k)) implicit[k] = v
  if (o.type === 'line' || o.type === 'arrow') {
    // Both ends are always written; unset ones as what they draw.
    const ends = connectorEnds(o)
    if (absent('startCap')) implicit['startCap'] = ends.start
    if (absent('endCap')) implicit['endCap'] = ends.end
  }
  if (Object.keys(implicit).length > 0) ext['implicit'] = implicit

  // ─── Every object ──────────────────────────────────────────────────────
  // The native name is always written (PowerPoint's selection pane needs
  // one), so a model without a name cannot be told apart natively.
  put('name', o.name)
  put('locked', o.locked)
  // Only a lock has a native form.
  if (o.aspectLocked === false) ext['aspectLocked'] = false
  // A picture's opacity is its `alphaModFix`; nothing else has one.
  if (o.type !== 'image' && o.opacity !== 1) ext['opacity'] = o.opacity
  // Mirroring: native for shapes and pictures, but a connector's flips name
  // its direction and PowerPoint does not mirror text.
  if (o.type === 'text' || o.type === 'line' || o.type === 'arrow') {
    put('flipH', o.flipH)
    put('flipV', o.flipV)
  } else {
    if (o.flipH === false) ext['flipH'] = false
    if (o.flipV === false) ext['flipV'] = false
  }
  // OOXML links open wherever the viewer opens them.
  if (o.hyperlink?.kind === 'url') ext['hyperlinkTarget'] = o.hyperlink.target ?? 'none'

  switch (o.type) {
    case 'rectangle':
    case 'ellipse':
    case 'triangle':
    case 'polygon': {
      const drawn = visibleStroke(o.stroke, o.strokeWidth)
      if (!drawn) {
        put('stroke', o.stroke)
        put('strokeWidth', o.strokeWidth)
        put('strokeAlpha', o.strokeAlpha)
        put('strokeDash', o.strokeDash)
      } else {
        if (o.strokeAlpha !== undefined && o.strokeAlpha >= 1) ext['strokeAlpha'] = o.strokeAlpha
        if (o.strokeDash === false) ext['strokeDash'] = false
      }
      fillExt(o, ext)
      if (o.type === 'rectangle' && o.cornerRadius !== undefined) {
        const r = o.cornerRadius
        // roundRect draws one radius up to half the shorter side.
        if (typeof r !== 'number' || !(r > 0) || r > Math.min(o.width, o.height) / 2)
          ext['cornerRadius'] = r
      }
      if (o.type === 'polygon' && polygonPreset(o.sides) === undefined)
        ext['polygonSides'] = o.sides
      break
    }
    case 'path': {
      if (hasDetachedHandles(o.anchors)) ext['anchors'] = o.anchors
      if (o.closed === false) ext['closed'] = false
      if (!visibleStroke(o.stroke, o.strokeWidth)) {
        ext['stroke'] = o.stroke
        put('strokeAlpha', o.strokeAlpha)
        put('dash', o.dash)
      } else {
        if (o.strokeAlpha !== undefined && o.strokeAlpha >= 1) ext['strokeAlpha'] = o.strokeAlpha
        if (o.dash === false) ext['dash'] = false
      }
      fillExt(o, ext)
      break
    }
    case 'line':
    case 'arrow': {
      const ends = connectorEnds(o)
      // The importer calls a connector with an arrowhead an arrow.
      if ((o.type === 'arrow') !== (ends.start === 'arrow' || ends.end === 'arrow'))
        ext['type'] = o.type
      const f = connectorFrame(o)
      if (
        pxToEmu(o.x) !== pxToEmu(f.x) ||
        pxToEmu(o.y) !== pxToEmu(f.y) ||
        pxToEmu(o.width) !== pxToEmu(f.width) ||
        pxToEmu(o.height) !== pxToEmu(f.height)
      ) {
        ext['box'] = { x: o.x, y: o.y, width: o.width, height: o.height, p1: o.p1, p2: o.p2 }
      }
      if (!visibleStroke(o.stroke, o.strokeWidth)) {
        // A line with no visible stroke is `<a:ln><a:noFill/>`: nothing of it survives natively.
        ext['stroke'] = o.stroke
        ext['strokeWidth'] = o.strokeWidth
        put('strokeAlpha', o.strokeAlpha)
        put('dash', o.dash)
        put('startCap', o.startCap)
        put('endCap', o.endCap)
      } else {
        if (o.strokeAlpha !== undefined && o.strokeAlpha >= 1) ext['strokeAlpha'] = o.strokeAlpha
        if (o.dash === false) ext['dash'] = false
      }
      break
    }
    case 'text': {
      if (typeof o.fontWeight === 'number') ext['fontWeight'] = o.fontWeight
      if (o.textTransform === 'capitalize') ext['textTransform'] = 'capitalize'
      // Only `lineHeight` is written when both are set.
      if (o.lineHeight !== undefined && o.lineSpacing !== undefined)
        ext['lineSpacing'] = o.lineSpacing
      // The importer leaves top alignment unset.
      if (o.vAlign === 'top') ext['vAlign'] = 'top'
      if (o.colorAlpha !== undefined && o.colorAlpha >= 1) ext['colorAlpha'] = o.colorAlpha
      // Glyph outline: written only with a colour, always with a width.
      if (o.stroke === undefined) {
        put('strokeWidth', o.strokeWidth)
        put('strokeAlpha', o.strokeAlpha)
      } else if (o.strokeAlpha !== undefined && o.strokeAlpha >= 1) {
        ext['strokeAlpha'] = o.strokeAlpha
      }
      // Zero spacing is no element at all natively.
      if (o.letterSpacing === 0) ext['letterSpacing'] = 0
      if (o.paragraphSpaceBefore !== undefined && !(o.paragraphSpaceBefore > 0)) {
        ext['paragraphSpaceBefore'] = o.paragraphSpaceBefore
      }
      if (o.paragraphSpaceAfter !== undefined && !(o.paragraphSpaceAfter > 0)) {
        ext['paragraphSpaceAfter'] = o.paragraphSpaceAfter
      }
      if (o.lineHeight !== undefined && !(o.lineHeight > 0)) ext['lineHeight'] = o.lineHeight
      if (o.lineSpacing !== undefined && !(o.lineSpacing > 0)) ext['lineSpacing'] = o.lineSpacing
      // `<a:latin>` names one face; a CSS stack, or no face, is kept whole.
      if (o.fontFamily !== undefined && !familyIsNative(o.fontFamily))
        ext['fontFamily'] = o.fontFamily
      if (o.isSlideNumber === false) ext['isSlideNumber'] = false
      // The legacy frame-wide list style is written onto the paragraphs.
      put('listStyle', o.listStyle)
      // The link to a folder text style, and which of its fields the box
      // overrides: PowerPoint has no notion of either.
      put('textStyleId', o.textStyleId)
      put('textStyleOverrides', o.textStyleOverrides)
      break
    }
    case 'image': {
      put('variant', o.variant)
      put('fit', o.fit)
      put('imageRotation', o.imageRotation)
      // A mask the picture's own geometry cannot draw exactly.
      if (o.mask !== undefined && !maskIsNative(o.mask, o.width, o.height)) ext['mask'] = o.mask
      // The crop exactly: `srcRect`'s percentages round, a rectangle equal
      // to the frame is no crop at all natively, and a picture fitted into
      // its frame is cropped natively without having a crop rectangle.
      if (o.imageRect !== undefined || cropSignature !== '') {
        ext['crop'] = { src: cropSignature, rect: o.imageRect ?? null }
      }
      break
    }
    case 'video': {
      for (const k of VIDEO_FIELDS) put(k, o[k])
      break
    }
    case 'table': {
      ext['table'] = {
        defaults: o.defaults,
        colWidths: o.colWidths,
        rowHeights: o.rowHeights,
        ...(o.borderSegments !== undefined ? { borderSegments: o.borderSegments } : {}),
        ...(o.defaults.fillStyle !== undefined
          ? { defaults: { ...o.defaults, fillStyle: withoutAsset(o.defaults.fillStyle) } }
          : {}),
        cells: o.rows.map((row) =>
          row.map((cell) => {
            const { text: _text, ...style } = cell
            void _text
            return style.fillStyle !== undefined
              ? { ...style, fillStyle: withoutAsset(style.fillStyle) }
              : style
          }),
        ),
      }
      break
    }
  }
  return ext
}

/**
 * What the importer produces for a PowerPoint shape of each type when the
 * file says nothing (writer.ts).
 */
const IMPORTER_DEFAULTS: Partial<Record<SlideObject['type'], Record<string, unknown>>> = {
  image: { variant: 'display', fit: 'cover' },
  video: { fit: 'contain', muted: true, autoplay: false },
}

/** Fill values the native `<a:solidFill>` / `<a:gradFill>` / `<a:blipFill>` cannot carry. */
function fillExt(
  o: Extract<SlideObject, { type: 'rectangle' | 'ellipse' | 'triangle' | 'polygon' | 'path' }>,
  ext: NarrativeObjectExt,
): void {
  if (o.fillStyle !== undefined) {
    // The native fill is the gradient or picture; the solid colour the
    // model keeps as its fallback, and that colour's alpha, ride here.
    if (o.fill !== undefined) ext['fill'] = o.fill
    if (o.fillAlpha !== undefined) ext['fillAlpha'] = o.fillAlpha
    if (o.fillStyle.kind === 'image') {
      if (o.fillStyle.fit !== undefined) ext['fillFit'] = o.fillStyle.fit
      // A picture fill still waiting for its upload has no picture to write.
      if (o.fillStyle.assetId === '') ext['fillPicturePending'] = true
    }
    return
  }
  // An alpha with no colour, or a full one (no `<a:alpha>` is written).
  if (o.fillAlpha !== undefined && (o.fill === undefined || o.fillAlpha >= 1))
    ext['fillAlpha'] = o.fillAlpha
}

/** A fill style as the extension may name it: a picture only by how it is fitted. */
function withoutAsset(fs: FillStyle): unknown {
  if (fs.kind !== 'image') return fs
  return fs.fit !== undefined ? { kind: 'image', fit: fs.fit } : { kind: 'image' }
}

const VIDEO_FIELDS = [
  'fit',
  'autoplay',
  'playOnClick',
  'videoTrigger',
  'videoDelay',
  'loop',
  'muted',
  'volume',
  'showControls',
  'posterTime',
  'trimStart',
  'trimEnd',
] as const

// ---------------------------------------------------------------------------
// Reading: the same fields, validated
// ---------------------------------------------------------------------------

const lineCap = oneOf('none', 'arrow', 'round', 'square')

const COMMON: Record<string, Schema> = {
  name: str(500),
  locked: bool,
  aspectLocked: bool,
  opacity: unit,
  flipH: bool,
  flipV: bool,
  hyperlinkTarget: oneOf('_self', '_blank', 'none'),
}
const FILLED: Record<string, Schema> = {
  ...COMMON,
  stroke: color,
  strokeWidth: nonNeg,
  strokeAlpha: unit,
  strokeDash: bool,
  fill: color,
  fillAlpha: unit,
  fillFit: oneOf('cover', 'contain'),
  fillPicturePending: bool,
}

const FIELDS: Record<SlideObject['type'], Record<string, Schema>> = {
  rectangle: { ...FILLED, cornerRadius },
  ellipse: FILLED,
  triangle: FILLED,
  polygon: FILLED,
  path: {
    ...COMMON,
    stroke: color,
    strokeAlpha: unit,
    dash: bool,
    closed: bool,
    anchors: arr(anchor, MAX_ANCHORS),
    fill: color,
    fillAlpha: unit,
    fillFit: oneOf('cover', 'contain'),
    fillPicturePending: bool,
  },
  line: {
    ...COMMON,
    box: lineBox,
    stroke: color,
    strokeWidth: nonNeg,
    strokeAlpha: unit,
    dash: bool,
    startCap: lineCap,
    endCap: lineCap,
  },
  arrow: {
    ...COMMON,
    box: lineBox,
    stroke: color,
    strokeWidth: nonNeg,
    strokeAlpha: unit,
    dash: bool,
    startCap: lineCap,
    endCap: lineCap,
  },
  image: {
    ...COMMON,
    variant: oneOf('thumb', 'display', 'original'),
    fit: oneOf('cover', 'contain'),
    imageRotation: num,
    mask,
    // Set by the parser from `crop` once the crop is checked (parser.ts).
    imageRect: rect,
  },
  video: {
    ...COMMON,
    fit: oneOf('cover', 'contain'),
    autoplay: bool,
    playOnClick: bool,
    videoTrigger: oneOf('onEnter', 'withPrevious', 'afterPrevious', 'onClick'),
    videoDelay: nonNeg,
    loop: bool,
    muted: bool,
    volume: unit,
    showControls: bool,
    posterTime: nonNeg,
    trimStart: nonNeg,
    trimEnd: nonNeg,
  },
  text: {
    ...COMMON,
    fontWeight: oneOf(100, 200, 300, 400, 500, 600, 700, 800, 900),
    textTransform: oneOf('capitalize'),
    lineHeight: num,
    lineSpacing: num,
    vAlign,
    colorAlpha: unit,
    strokeWidth: nonNeg,
    strokeAlpha: unit,
    letterSpacing: num,
    paragraphSpaceBefore: num,
    paragraphSpaceAfter: num,
    fontFamily: str(200),
    isSlideNumber: bool,
    listStyle: oneOf('bullet', 'numbered'),
    textStyleId: idRef(200),
    textStyleOverrides: arr(
      oneOf(
        'fontFamily',
        'fontWeight',
        'fontSize',
        'lineHeight',
        'letterSpacing',
        'paragraphSpaceBefore',
        'paragraphSpaceAfter',
        'color',
        'textTransform',
      ),
      16,
    ),
  },
  table: { ...COMMON, table },
}

/**
 * The extension's fields that are valid for an object of `type`, each
 * parsed into its model shape. Unknown and malformed fields are left out.
 */
export function objectExtFields(
  type: SlideObject['type'],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const fields = FIELDS[type]
  if (fields === undefined) return {}
  const out: Record<string, unknown> = {}
  for (const [k, schema] of Object.entries(fields)) {
    if (!(k in values)) continue
    const parsed = schema(values[k])
    if (parsed !== undefined) out[k] = parsed
  }
  // `implicit`: each entry checked against the field's own shape.
  const implicit = values['implicit']
  if (implicit !== null && typeof implicit === 'object' && !Array.isArray(implicit)) {
    const checked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(implicit as Record<string, unknown>)) {
      const schema = IMPLICIT_FIELDS[k]
      const parsed = schema !== undefined ? schema(v) : undefined
      if (parsed !== undefined) checked[k] = parsed
    }
    out['implicit'] = checked
  }
  return out
}

/** Fields an `implicit` entry may name, with their shapes. */
const IMPLICIT_FIELDS: Record<string, Schema> = {
  variant: oneOf('thumb', 'display', 'original'),
  fit: oneOf('cover', 'contain'),
  muted: bool,
  autoplay: bool,
  startCap: lineCap,
  endCap: lineCap,
}
