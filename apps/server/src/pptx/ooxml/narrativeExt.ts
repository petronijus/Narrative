/**
 * pptx/ooxml/narrativeExt.ts
 *
 * Model values OOXML has no native form for, carried inside the shape.
 *
 * Most of a Narrative object maps onto DrawingML one to one. A few things do
 * not: whether a stroked two-point object is a `line` or an `arrow` object,
 * a polygon with a number of sides PowerPoint has no preset for, a different
 * radius per corner, a shape's overall opacity, numeric font weights, video
 * playback settings. For those the exporter writes the best native
 * approximation — what PowerPoint shows — and, next to it, the exact model
 * values in an extension on the shape's `<p:cNvPr>`: OOXML's own mechanism
 * (`<a:extLst>/<a:ext uri>`) for application data that other applications
 * must ignore and keep.
 *
 * A fingerprint of the shape's frame (offset, extent, rotation, in EMU) is
 * stored with the values. If the shape was moved, resized or rotated in
 * PowerPoint since, the importer ignores the extension and reads the native
 * XML alone: stale values never override an edit.
 */

import { el, type XmlElement } from './xml.js'
import { type XmlNode, findFirst, getAttrs, getChildren, getTag } from './read.js'

/** Our extension's identity. Fixed forever: files in the wild carry it. */
export const NARRATIVE_EXT_URI = '{2F5B9E4C-6A1D-4C3E-9B7A-8D0E1F2A3B4C}'
export const NARRATIVE_NS = 'urn:narrative:ooxml:object:1'

/** A shape frame as written in `<a:xfrm>`, EMU and angle units. */
export interface FrameFingerprint {
  x: number
  y: number
  cx: number
  cy: number
  rot: number
}

export function fingerprintOf(f: FrameFingerprint): string {
  return `${f.x},${f.y},${f.cx},${f.cy},${f.rot}`
}

/**
 * Model-only values for one object. Kept deliberately small: only what the
 * native XML cannot say. JSON-serialisable.
 */
export type NarrativeObjectExt = Record<string, unknown>

/** `<a:extLst>` for `<p:cNvPr>`, or null when there is nothing to carry. */
export function writeNarrativeExt(
  values: NarrativeObjectExt,
  frame: FrameFingerprint,
): XmlElement | null {
  const keys = Object.keys(values).filter((k) => values[k] !== undefined)
  if (keys.length === 0) return null
  const clean: NarrativeObjectExt = {}
  for (const k of keys.sort()) clean[k] = values[k]
  return el(
    'a:extLst',
    {},
    el(
      'a:ext',
      { uri: NARRATIVE_EXT_URI },
      el('nx:obj', {
        'xmlns:nx': NARRATIVE_NS,
        frame: fingerprintOf(frame),
        values: JSON.stringify(clean),
      }),
    ),
  )
}

/**
 * The extension's values when it is present and the frame still matches,
 * else undefined. `cNvPr` is the shape's `<p:cNvPr>` node.
 */
export function readNarrativeExt(
  cNvPr: XmlNode | undefined,
  frame: FrameFingerprint,
): NarrativeObjectExt | undefined {
  if (cNvPr === undefined) return undefined
  const extLst = findFirst(getChildren(cNvPr, 'p:cNvPr'), 'a:extLst')
  if (extLst === undefined) return undefined
  for (const ext of getChildren(extLst, 'a:extLst')) {
    if (getTag(ext) !== 'a:ext' || getAttrs(ext)['@uri'] !== NARRATIVE_EXT_URI) continue
    const obj = findFirst(getChildren(ext, 'a:ext'), 'nx:obj')
    if (obj === undefined) return undefined
    const a = getAttrs(obj)
    if (a['@frame'] !== fingerprintOf(frame)) return undefined
    try {
      const v = JSON.parse(String(a['@values'] ?? '{}')) as unknown
      return v !== null && typeof v === 'object' && !Array.isArray(v)
        ? (v as NarrativeObjectExt)
        : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Slide extension
// ---------------------------------------------------------------------------

/**
 * Slide-level model values with no native form: outline indent and
 * collapse, an explicit "no transition" with a duration, and background
 * details (a radial gradient's radius, an image's fit and dim). Carried in
 * the slide's own `<p:extLst>`. Background values name the background kind
 * they were written for and apply only while the slide still has one.
 */
export const NARRATIVE_SLIDE_EXT_URI = '{4D8E2A61-5B3C-4F7D-9E1A-6C2B8F0D3E47}'
export const NARRATIVE_SLIDE_NS = 'urn:narrative:ooxml:slide:1'

export function writeSlideExt(values: Record<string, unknown>): XmlElement | null {
  const keys = Object.keys(values).filter((k) => values[k] !== undefined)
  if (keys.length === 0) return null
  const clean: Record<string, unknown> = {}
  for (const k of keys.sort()) clean[k] = values[k]
  return el(
    'p:extLst',
    {},
    el(
      'p:ext',
      { uri: NARRATIVE_SLIDE_EXT_URI },
      el('nx:slide', { 'xmlns:nx': NARRATIVE_SLIDE_NS, values: JSON.stringify(clean) }),
    ),
  )
}

/** The slide extension's raw values (unvalidated — see `slideExtFields`). */
export function readSlideExt(sldChildren: XmlNode[]): Record<string, unknown> | undefined {
  const extLst = findFirst(sldChildren, 'p:extLst')
  if (extLst === undefined) return undefined
  for (const ext of getChildren(extLst, 'p:extLst')) {
    if (getTag(ext) !== 'p:ext' || getAttrs(ext)['@uri'] !== NARRATIVE_SLIDE_EXT_URI) continue
    const node = findFirst(getChildren(ext, 'p:ext'), 'nx:slide')
    if (node === undefined) return undefined
    try {
      const v = JSON.parse(String(getAttrs(node)['@values'] ?? '{}')) as unknown
      return v !== null && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}
