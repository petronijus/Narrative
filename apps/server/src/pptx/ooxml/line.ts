/**
 * pptx/ooxml/line.ts
 *
 * `<a:ln>`, both directions: colour, alpha, width, dash and the two line
 * ends. Reader and writer share the end vocabulary (`LINE_END`) and the
 * unit conversion, so what one side writes the other reads back unchanged.
 */

import { el, tag, type XmlElement } from './xml.js'
import { type XmlNode, findFirst, getAttrs, getChildren, getTag } from './read.js'
import { parseColourAndAlphaFrom, writeSolidFill, type ThemeColourMap } from './color.js'
import { emuToSourcePx, pxToEmu } from './units.js'
import { LINE_END } from './vocabulary.js'

export type LineEnd = 'none' | 'arrow' | 'round' | 'square'

export interface LineSpec {
  color: number | undefined
  alpha: number | undefined
  width: number | undefined
  dash: boolean
  head?: LineEnd
  tail?: LineEnd
}

/**
 * `<a:ln>`. A stroke is drawn only with a colour and a positive width — the
 * renderer's rule — anything else is an explicit `<a:noFill/>` line so
 * PowerPoint does not reach for a theme line style.
 */
export function writeLine(s: LineSpec): XmlElement {
  const visible = s.color !== undefined && s.width !== undefined && s.width > 0
  if (!visible) return tag('a:ln', tag('a:noFill'))
  return el(
    'a:ln',
    { w: pxToEmu(s.width!) },
    writeSolidFill(s.color!, s.alpha),
    s.dash && el('a:prstDash', { val: 'dash' }),
    s.head !== undefined && el('a:headEnd', { type: LINE_END.toXml(s.head) }),
    s.tail !== undefined && el('a:tailEnd', { type: LINE_END.toXml(s.tail) }),
  )
}

/** What an `<a:ln>` says. Fields it does not declare stay undefined. */
export interface ReadLine {
  color?: number
  alpha?: number
  /** Source px (see `emuToSourcePx`). */
  width?: number
  /** True for any `prstDash` other than solid, and for a custom dash. */
  dash?: boolean
  /** `<a:noFill/>`: the shape explicitly has no outline. */
  noFill?: boolean
  head?: LineEnd
  tail?: LineEnd
}

/** Reads `<a:ln>` and its kin with the same content (`<a:lnL>`, `<a:lnT>`, … on table cells). */
export function readLine(ln: XmlNode, theme: ThemeColourMap): ReadLine {
  const out: ReadLine = {}
  const w = Number(getAttrs(ln)['@w'])
  if (Number.isFinite(w)) out.width = emuToSourcePx(w)
  const kids = getChildren(ln, getTag(ln) ?? 'a:ln')
  if (findFirst(kids, 'a:noFill') !== undefined) out.noFill = true
  const solid = findFirst(kids, 'a:solidFill')
  if (solid !== undefined) {
    const c = parseColourAndAlphaFrom(solid, theme)
    if (c !== undefined) {
      out.color = c.color
      if (c.alpha !== undefined) out.alpha = c.alpha
    }
  }
  const prstDash = findFirst(kids, 'a:prstDash')
  if (prstDash !== undefined) {
    const v = String(getAttrs(prstDash)['@val'] ?? 'solid')
    out.dash = v !== 'solid'
  } else if (findFirst(kids, 'a:custDash') !== undefined) {
    out.dash = true
  }
  const head = findFirst(kids, 'a:headEnd')
  if (head !== undefined)
    out.head = LINE_END.fromXml(String(getAttrs(head)['@type'] ?? 'none')) ?? 'none'
  const tail = findFirst(kids, 'a:tailEnd')
  if (tail !== undefined)
    out.tail = LINE_END.fromXml(String(getAttrs(tail)['@type'] ?? 'none')) ?? 'none'
  return out
}
