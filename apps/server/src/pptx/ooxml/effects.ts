/**
 * pptx/ooxml/effects.ts
 *
 * `<a:effectLst>`, both directions: a gaussian blur and an outer shadow.
 *
 * DrawingML places a shadow in polar form (`dist` + `dir`, clockwise from
 * the positive x axis); the model keeps cartesian offsets. The conversion
 * lives here once, in both directions.
 */

import type { SlideObject } from '@narrative/shared'
import { el, tag, type XmlChild } from './xml.js'
import { type XmlNode, findFirst, getAttrs, getChildren } from './read.js'
import { parseColourAndAlphaFrom, writeColor, type ThemeColourMap } from './color.js'
import { angleToDeg, degToAngle, emuToSourcePx, pxToEmu } from './units.js'

/** `<a:effectLst>` for an object's blur and shadow, in the schema's order. */
export function writeEffects(o: Pick<SlideObject, 'blur' | 'shadow'>): XmlChild {
  const blur = o.blur !== undefined && o.blur > 0 ? o.blur : undefined
  const sh = o.shadow
  if (blur === undefined && sh === undefined) return null
  let shadow: XmlChild = null
  if (sh !== undefined) {
    const dist = Math.hypot(sh.offsetX, sh.offsetY)
    const dirDeg = dist === 0 ? 0 : (Math.atan2(sh.offsetY, sh.offsetX) * 180) / Math.PI
    shadow = el(
      'a:outerShdw',
      {
        blurRad: pxToEmu(Math.max(0, sh.blur)),
        dist: pxToEmu(dist),
        dir: degToAngle(dirDeg),
        algn: 'ctr',
        rotWithShape: 0,
      },
      writeColor(sh.color as number, sh.opacity),
    )
  }
  return tag('a:effectLst', blur !== undefined && el('a:blur', { rad: pxToEmu(blur) }), shadow)
}

/** Lengths in source px (see `emuToSourcePx`). */
export interface ReadEffects {
  shadow?: { color: number; blur: number; offsetX: number; offsetY: number; opacity: number }
  blur?: number
}

export function readEffects(effectLst: XmlNode, theme: ThemeColourMap): ReadEffects {
  const out: ReadEffects = {}
  const kids = getChildren(effectLst, 'a:effectLst')
  const outer = findFirst(kids, 'a:outerShdw')
  if (outer !== undefined) {
    const a = getAttrs(outer)
    const dist = emuToSourcePx(Number(a['@dist'] ?? 0))
    const dir = (angleToDeg(Number(a['@dir'] ?? 0)) * Math.PI) / 180
    const c = parseColourAndAlphaFrom(outer, theme)
    out.shadow = {
      color: c?.color ?? 0x000000,
      blur: emuToSourcePx(Number(a['@blurRad'] ?? 0)),
      offsetX: dist * Math.cos(dir),
      offsetY: dist * Math.sin(dir),
      opacity: c?.alpha ?? 1,
    }
  }
  const blur = findFirst(kids, 'a:blur')
  if (blur !== undefined) out.blur = emuToSourcePx(Number(getAttrs(blur)['@rad'] ?? 0))
  return out
}
