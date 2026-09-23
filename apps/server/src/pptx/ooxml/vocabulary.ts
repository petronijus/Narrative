/**
 * pptx/ooxml/vocabulary.ts
 *
 * Every enumeration Narrative and OOXML translate between, declared once and
 * used by both the importer and the exporter.
 *
 * Each table is a bijection between a model value and the OOXML token that
 * represents it — the exporter writes the token, the importer reads it back
 * to the same model value, and `bimap` refuses at load time to build a table
 * where two model values share a token or the reverse. Where PowerPoint has
 * several tokens for what Narrative models as one thing (`stealth` and
 * `triangle` arrowheads, `just` and `l` alignment), the extra tokens are
 * listed as import-only aliases: they are read, never written.
 */

import type { AnimationPreset, ListNumberFormat, SlideTransitionKind } from '@narrative/shared'

export interface BiMap<M extends string, X extends string> {
  /** Model value → the OOXML token written for it. */
  toXml(model: M): X
  /** OOXML token → model value, or undefined for a token outside the table. */
  fromXml(token: string): M | undefined
  readonly entries: ReadonlyArray<readonly [M, X]>
}

export function bimap<M extends string, X extends string>(
  name: string,
  pairs: ReadonlyArray<readonly [M, X]>,
  importAliases: Readonly<Record<string, M>> = {},
): BiMap<M, X> {
  const forward = new Map<M, X>()
  const backward = new Map<string, M>()
  for (const [m, x] of pairs) {
    if (forward.has(m)) throw new Error(`vocabulary ${name}: model value ${m} listed twice`)
    if (backward.has(x)) throw new Error(`vocabulary ${name}: token ${x} listed twice`)
    forward.set(m, x)
    backward.set(x, m)
  }
  for (const [token, m] of Object.entries(importAliases)) {
    if (backward.has(token)) throw new Error(`vocabulary ${name}: alias ${token} shadows a pair`)
    if (!forward.has(m)) throw new Error(`vocabulary ${name}: alias ${token} → unknown ${m}`)
  }
  return {
    toXml(model) {
      const x = forward.get(model)
      if (x === undefined) throw new Error(`vocabulary ${name}: no token for ${model}`)
      return x
    },
    fromXml(token) {
      return backward.get(token) ?? (importAliases[token] as M | undefined)
    },
    entries: pairs,
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** `<a:pPr algn>`. Justified text renders left-aligned in Narrative. */
export const ALIGN = bimap<'left' | 'center' | 'right', string>(
  'align',
  [
    ['left', 'l'],
    ['center', 'ctr'],
    ['right', 'r'],
  ],
  { just: 'left', justLow: 'left', dist: 'left', thaiDist: 'left' },
)

/** `<a:bodyPr anchor>`. */
export const ANCHOR = bimap<'top' | 'middle' | 'bottom', string>(
  'anchor',
  [
    ['top', 't'],
    ['middle', 'ctr'],
    ['bottom', 'b'],
  ],
  { just: 'top', dist: 'top' },
)

/** `<a:buAutoNum type>`. `arabicParenBoth` — "(1)" — has no two-sided form here. */
export const AUTONUM = bimap<ListNumberFormat, string>(
  'autonum',
  [
    ['decimal', 'arabicPeriod'],
    ['decimalParen', 'arabicParenR'],
    ['lowerAlpha', 'alphaLcPeriod'],
    ['lowerAlphaParen', 'alphaLcParenR'],
    ['upperAlpha', 'alphaUcPeriod'],
    ['upperAlphaParen', 'alphaUcParenR'],
    ['lowerRoman', 'romanLcPeriod'],
    ['upperRoman', 'romanUcPeriod'],
  ],
  { arabicParenBoth: 'decimalParen', arabicPlain: 'decimal' },
)

/** `<a:rPr cap>`. `capitalize` has no OOXML equivalent and is not listed. */
export const CAPS = bimap<'none' | 'uppercase' | 'lowercase', string>('caps', [
  ['none', 'none'],
  ['uppercase', 'all'],
  ['lowercase', 'small'],
])

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * Line ends: `<a:headEnd type>` / `<a:tailEnd type>`. A square end is written
 * as PowerPoint's diamond — the one closed, angular end it offers.
 */
export const LINE_END = bimap<'none' | 'arrow' | 'round' | 'square', string>(
  'lineEnd',
  [
    ['none', 'none'],
    ['arrow', 'triangle'],
    ['round', 'oval'],
    ['square', 'diamond'],
  ],
  { stealth: 'arrow', arrow: 'arrow' },
)

/** `<a:prstDash val>` for table borders. */
export const BORDER_DASH = bimap<'solid' | 'dash' | 'dot', string>(
  'borderDash',
  [
    ['solid', 'solid'],
    ['dash', 'dash'],
    ['dot', 'sysDot'],
  ],
  {
    sysDash: 'dash',
    lgDash: 'dash',
    dashDot: 'dash',
    lgDashDot: 'dash',
    lgDashDotDot: 'dash',
    sysDashDot: 'dash',
    sysDashDotDot: 'dash',
    dot: 'dot',
  },
)

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Regular polygons: sides ↔ `<a:prstGeom prst>`. */
export const POLYGON_PRST = bimap<string, string>('polygon', [
  ['5', 'pentagon'],
  ['6', 'hexagon'],
  ['7', 'heptagon'],
  ['8', 'octagon'],
  ['10', 'decagon'],
  ['12', 'dodecagon'],
])

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

/** Push / cube direction ↔ `dir`. */
export const DIRECTION = bimap<'left' | 'right' | 'up' | 'down', string>('direction', [
  ['left', 'l'],
  ['right', 'r'],
  ['up', 'u'],
  ['down', 'd'],
])

/**
 * Transitions with a native element in the base PresentationML schema. Cube
 * and Morph are PowerPoint 2010 / 2016 extensions and are written through
 * `mc:AlternateContent` (see ooxml/transition.ts), not listed here.
 */
export const BASE_TRANSITION = bimap<Extract<SlideTransitionKind, 'fade' | 'push'>, string>(
  'transition',
  [
    ['fade', 'fade'],
    ['push', 'push'],
  ],
)

/**
 * Animation presets ↔ PowerPoint's (presetClass, presetID, presetSubtype).
 * One unique triple per preset, so every preset survives a round trip; the
 * IDs are PowerPoint's own where it has the effect (Fade 10, Fly 2, Zoom 23,
 * Wipe 22, Dissolve 9, Wheel 21, Bounce 26, Grow/Turn 31, Split 16, Stretch 17)
 * so the file still means something to PowerPoint.
 */
export interface AnimationToken {
  presetClass: 'entr' | 'exit' | 'emph' | 'path'
  presetID: number
  presetSubtype: number
}

const ANIMATION_PAIRS: ReadonlyArray<readonly [AnimationPreset, AnimationToken]> = [
  ['fadeIn', { presetClass: 'entr', presetID: 10, presetSubtype: 0 }],
  ['fadeOut', { presetClass: 'exit', presetID: 10, presetSubtype: 0 }],
  ['slideIn', { presetClass: 'entr', presetID: 2, presetSubtype: 4 }],
  ['slideOut', { presetClass: 'exit', presetID: 2, presetSubtype: 4 }],
  ['scaleIn', { presetClass: 'entr', presetID: 23, presetSubtype: 16 }],
  ['scaleOut', { presetClass: 'exit', presetID: 23, presetSubtype: 16 }],
  ['zoomIn', { presetClass: 'entr', presetID: 23, presetSubtype: 0 }],
  ['rotateIn', { presetClass: 'entr', presetID: 21, presetSubtype: 1 }],
  ['bounceIn', { presetClass: 'entr', presetID: 26, presetSubtype: 0 }],
  ['flipIn', { presetClass: 'entr', presetID: 17, presetSubtype: 10 }],
  ['popIn', { presetClass: 'entr', presetID: 31, presetSubtype: 0 }],
  ['dissolveIn', { presetClass: 'entr', presetID: 9, presetSubtype: 0 }],
  ['wipeIn', { presetClass: 'entr', presetID: 22, presetSubtype: 8 }],
  ['moveTo', { presetClass: 'path', presetID: 0, presetSubtype: 0 }],
  ['rotateTo', { presetClass: 'emph', presetID: 8, presetSubtype: 0 }],
]

const animationKey = (t: AnimationToken): string =>
  `${t.presetClass}:${t.presetID}:${t.presetSubtype}`

const ANIMATION_BY_KEY = new Map<string, AnimationPreset>()
for (const [preset, token] of ANIMATION_PAIRS) {
  const key = animationKey(token)
  if (ANIMATION_BY_KEY.has(key)) throw new Error(`vocabulary animation: ${key} listed twice`)
  ANIMATION_BY_KEY.set(key, preset)
}
const ANIMATION_BY_PRESET = new Map(ANIMATION_PAIRS)

export const ANIMATION = {
  toXml(preset: AnimationPreset): AnimationToken {
    const t = ANIMATION_BY_PRESET.get(preset)
    if (t === undefined) throw new Error(`vocabulary animation: no token for ${preset}`)
    return t
  },
  /**
   * The preset for a PowerPoint effect. An exact triple comes back as the
   * preset that wrote it; an effect only PowerPoint knows falls back by
   * (class, ID) and then by class, so a foreign deck still animates.
   */
  fromXml(t: AnimationToken): AnimationPreset {
    const exact = ANIMATION_BY_KEY.get(animationKey(t))
    if (exact !== undefined) return exact
    const byId = ANIMATION_PAIRS.find(
      ([, x]) => x.presetClass === t.presetClass && x.presetID === t.presetID,
    )
    if (byId !== undefined) return byId[0]
    if (t.presetClass === 'exit') return 'fadeOut'
    if (t.presetClass === 'emph') return 'popIn'
    if (t.presetClass === 'path') return 'moveTo'
    return 'fadeIn'
  },
  entries: ANIMATION_PAIRS,
}
