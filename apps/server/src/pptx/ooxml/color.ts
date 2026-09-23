/**
 * pptx/ooxml/color.ts
 *
 * DrawingML colour, both directions.
 *
 * Reading resolves every colour form a deck can use — `srgbClr`, `sysClr`,
 * `schemeClr` against the deck's theme — through its modifiers (lumMod,
 * lumOff, shade, tint, alpha) to the plain 0xRRGGBB + alpha the model stores.
 * Writing is the inverse for what the model can hold: an `srgbClr` with an
 * `alpha` child when the colour is not opaque. The model has no theme
 * colours, so nothing is written as `schemeClr`.
 */

import { el, type XmlElement } from './xml.js'
import { fractionToPercent } from './units.js'
import { type XmlNode, getAttrs, getChildren, getTag, walk } from './read.js'

/** Scheme colour name → 0xRRGGBB, from the deck's `theme1.xml`. */
export type ThemeColourMap = Record<string, number>

const HEX_RE = /^[0-9a-fA-F]{6}$/

/** "0F172A" → 0x0F172A. Returns undefined on malformed input. */
export function parseHexColour(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const clean = s.replace(/^#/, '').toUpperCase()
  if (!HEX_RE.test(clean)) return undefined
  return parseInt(clean, 16)
}

/**
 * Office default scheme palette — fallback when theme1.xml is absent or a
 * scheme reference doesn't match any entry. Matches PowerPoint's Office
 * theme so unmapped accent colours stay visually plausible.
 */
export const DEFAULT_THEME: ThemeColourMap = {
  dk1: 0x000000,
  lt1: 0xffffff,
  dk2: 0x44546a,
  lt2: 0xe7e6e6,
  tx1: 0x000000, // text/background fall-throughs to dk1/lt1 — see resolveSchemeColour
  bg1: 0xffffff,
  tx2: 0x44546a,
  bg2: 0xe7e6e6,
  accent1: 0x4472c4,
  accent2: 0xed7d31,
  accent3: 0xa5a5a5,
  accent4: 0xffc000,
  accent5: 0x5b9bd5,
  accent6: 0x70ad47,
  hlink: 0x0563c1,
  folHlink: 0x954f72,
}

export function resolveSchemeColour(name: string, theme: ThemeColourMap): number | undefined {
  // OOXML themes physically store `dk1/lt1/dk2/lt2`; `tx1/bg1/tx2/bg2` are
  // *slot aliases* the slide-master `<p:clrMap>` (default mapping) points at.
  // Resolve direct + aliased against the *loaded* theme first — only then
  // fall through to DEFAULT_THEME — otherwise a deck whose `lt1` is non-white
  // (legal!) reads as white because DEFAULT_THEME.bg1 short-circuits the
  // alias lookup.
  const aliases: Record<string, string> = {
    tx1: 'dk1',
    bg1: 'lt1',
    tx2: 'dk2',
    bg2: 'lt2',
  }
  const aliased = aliases[name]
  if (theme[name] !== undefined) return theme[name]
  if (aliased !== undefined && theme[aliased] !== undefined) return theme[aliased]
  if (DEFAULT_THEME[name] !== undefined) return DEFAULT_THEME[name]
  if (aliased !== undefined && DEFAULT_THEME[aliased] !== undefined) return DEFAULT_THEME[aliased]
  return undefined
}

/**
 * Resolve the first colour descriptor found in the subtree, applying any
 * inline modifiers (lumMod / lumOff / shade / tint) and capturing alpha.
 * Handles:
 *   - `<a:srgbClr val="RRGGBB">[...mods...]</a:srgbClr>`
 *   - `<a:sysClr val="..." lastClr="RRGGBB">[...mods...]</a:sysClr>`
 *   - `<a:schemeClr val="accent1">[...mods...]</a:schemeClr>` — looked up in
 *     the deck's theme palette, fall-through to PowerPoint's Office defaults
 *
 * Modifiers (each value is `n / 100000`, so 50000 = 0.5):
 *   - `<a:lumMod val="N"/>` — multiplies luminance (HSL L) by N
 *   - `<a:lumOff val="N"/>` — adds N to luminance
 *   - `<a:shade   val="N"/>` — darken (mix toward black)
 *   - `<a:tint    val="N"/>` — lighten (mix toward white)
 *   - `<a:alpha   val="N"/>` — sets the result's alpha to N/100000 (0..1)
 *
 * Returns undefined if no colour descriptor is found anywhere in the subtree.
 */
export function parseColourAndAlphaFrom(
  node: XmlNode,
  theme: ThemeColourMap,
): { color: number; alpha?: number } | undefined {
  const colourNode = findFirstColourDescriptor(node)
  if (colourNode === null) return undefined
  const { tag, attrs, descriptor } = colourNode

  let base: number | undefined
  if (tag === 'a:srgbClr') {
    base = parseHexColour(typeof attrs['@val'] === 'string' ? (attrs['@val'] as string) : '')
  } else if (tag === 'a:sysClr') {
    base = parseHexColour(
      typeof attrs['@lastClr'] === 'string' ? (attrs['@lastClr'] as string) : '',
    )
  } else if (tag === 'a:schemeClr') {
    base =
      typeof attrs['@val'] === 'string'
        ? resolveSchemeColour(attrs['@val'] as string, theme)
        : undefined
  }
  if (base === undefined) return undefined

  // Apply modifiers in document order (PowerPoint's renderer does the same).
  let { r, g, b } = unpackRgb(base)
  let alpha: number | undefined
  for (const mod of getChildren(descriptor, tag)) {
    const mTag = getTag(mod)
    if (mTag === null) continue
    const v = Number(getAttrs(mod)['@val'])
    if (!Number.isFinite(v)) continue
    const frac = v / 100000 // PPTX uses parts-per-100000 for these
    if (mTag === 'a:lumMod') {
      const hsl = rgbToHsl(r, g, b)
      hsl.l *= frac
      ;({ r, g, b } = hslToRgb(hsl.h, hsl.s, hsl.l))
    } else if (mTag === 'a:lumOff') {
      const hsl = rgbToHsl(r, g, b)
      hsl.l = clamp01(hsl.l + frac)
      ;({ r, g, b } = hslToRgb(hsl.h, hsl.s, hsl.l))
    } else if (mTag === 'a:shade') {
      r = Math.round(r * frac)
      g = Math.round(g * frac)
      b = Math.round(b * frac)
    } else if (mTag === 'a:tint') {
      r = Math.round(r + (255 - r) * (1 - frac))
      g = Math.round(g + (255 - g) * (1 - frac))
      b = Math.round(b + (255 - b) * (1 - frac))
    } else if (mTag === 'a:alpha') {
      alpha = clamp01(frac)
    }
  }
  const out: { color: number; alpha?: number } = { color: packRgb(r, g, b) }
  if (alpha !== undefined) out.alpha = alpha
  return out
}

/** Backwards-compatible thin wrapper for call sites that don't need alpha. */
export function parseColourFrom(node: XmlNode, theme: ThemeColourMap): number | undefined {
  return parseColourAndAlphaFrom(node, theme)?.color
}

interface ColourDescriptor {
  tag: string
  attrs: Record<string, unknown>
  descriptor: XmlNode
}

export function findFirstColourDescriptor(node: XmlNode): ColourDescriptor | null {
  for (const desc of walk([node])) {
    const tag = getTag(desc)
    if (tag === 'a:srgbClr' || tag === 'a:sysClr' || tag === 'a:schemeClr') {
      return { tag, attrs: getAttrs(desc), descriptor: desc }
    }
  }
  return null
}

// ─── Tiny colour-space helpers (no external deps) ───────────────────────────

export function unpackRgb(v: number): { r: number; g: number; b: number } {
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff }
}
export function packRgb(r: number, g: number, b: number): number {
  const c = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
  return (c(r) << 16) | (c(g) << 8) | c(b)
}
export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  let h = 0,
    s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h /= 6
  }
  return { h, s, l }
}
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  let r: number, g: number, b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }
  return { r: r * 255, g: g * 255, b: b * 255 }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** 0xRRGGBB → "RRGGBB", as `srgbClr val` wants it. */
export function hex6(color: number): string {
  const c = Number.isFinite(color) ? Math.max(0, Math.min(0xffffff, Math.trunc(color))) : 0
  return c.toString(16).toUpperCase().padStart(6, '0')
}

/**
 * `<a:srgbClr>` for a model colour. Alpha is written only below 1, so an
 * opaque colour reads back with no alpha — which is how the importer
 * represents "opaque" too.
 */
export function writeColor(color: number, alpha?: number): XmlElement {
  return el(
    'a:srgbClr',
    { val: hex6(color) },
    alpha !== undefined &&
      alpha < 1 &&
      el('a:alpha', { val: fractionToPercent(Math.max(0, alpha)) }),
  )
}

/** `<a:solidFill>` around {@link writeColor}. */
export function writeSolidFill(color: number, alpha?: number): XmlElement {
  return el('a:solidFill', {}, writeColor(color, alpha))
}
