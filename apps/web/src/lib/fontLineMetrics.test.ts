/**
 * lib/fontLineMetrics.test.ts
 *
 * The resolver's precedence is a contract four consumers rely on (renderer,
 * edit overlay, clip mask, Inspector); pin it here. jsdom lays nothing out,
 * so "normal" measures as 0 and falls back — which is itself part of the
 * contract: environments without layout render exactly as before (1.2).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveLineHeightPx,
  effectiveLineHeightMultiple,
  normalLineHeightRatio,
  registerDeclaredLineHeight,
  forgetMeasuredLineHeight,
  numericWeight,
  FALLBACK_NORMAL_RATIO,
  __resetFontLineMetricsForTests,
} from './fontLineMetrics.js'

beforeEach(() => {
  __resetFontLineMetricsForTests()
})

describe('normalLineHeightRatio', () => {
  it('falls back where the browser cannot lay text out', () => {
    // jsdom has no layout engine: the probe measures 0 → fallback.
    expect(normalLineHeightRatio('Proseware Pro', 400, false)).toBe(FALLBACK_NORMAL_RATIO)
  })
})

describe('resolveLineHeightPx', () => {
  it('lineHeight is a multiple of the font size and wins over lineSpacing', () => {
    expect(resolveLineHeightPx({ fontSize: 60, lineHeight: 1.5, lineSpacing: 0.75 })).toBe(90)
  })

  it('lineSpacing is a multiple of the font’s normal line height', () => {
    // normal falls back to 1.2 here, so 0.75 × 1.2 × 100.
    expect(resolveLineHeightPx({ fontSize: 100, lineSpacing: 0.75 })).toBeCloseTo(90, 6)
  })

  it('neither set → the font’s normal line height', () => {
    expect(resolveLineHeightPx({ fontSize: 100 })).toBeCloseTo(FALLBACK_NORMAL_RATIO * 100, 6)
  })

  it('ignores non-positive values as unset', () => {
    expect(resolveLineHeightPx({ fontSize: 100, lineHeight: 0, lineSpacing: -1 })).toBeCloseTo(
      FALLBACK_NORMAL_RATIO * 100,
      6,
    )
    expect(resolveLineHeightPx({ fontSize: 0, lineHeight: 2 })).toBe(0)
  })
})

describe('effectiveLineHeightMultiple', () => {
  it('reports what the Inspector should show, whichever field drives it', () => {
    expect(effectiveLineHeightMultiple({ fontSize: 40, lineHeight: 1.35 })).toBeCloseTo(1.35, 6)
    expect(effectiveLineHeightMultiple({ fontSize: 40, lineSpacing: 1 })).toBeCloseTo(
      FALLBACK_NORMAL_RATIO,
      6,
    )
    expect(effectiveLineHeightMultiple({ fontSize: 40 })).toBeCloseTo(FALLBACK_NORMAL_RATIO, 6)
  })
})

describe('registerDeclaredLineHeight', () => {
  it('declared file metrics win over measurement and the fallback', () => {
    registerDeclaredLineHeight('Proseware Pro Regular', 400, 'normal', 1.162)
    expect(normalLineHeightRatio('Proseware Pro Regular', 400, false)).toBeCloseTo(1.162, 6)
    // Keyed by weight and style: the italic face is still unknown here.
    expect(normalLineHeightRatio('Proseware Pro Regular', 400, true)).toBe(FALLBACK_NORMAL_RATIO)
    // And it flows through the resolver: 0.75 × 1.162 × 158.
    expect(
      resolveLineHeightPx({ fontSize: 158, fontFamily: 'Proseware Pro Regular', lineSpacing: 0.75 }),
    ).toBeCloseTo(0.75 * 1.162 * 158, 4)
  })

  it('ignores a non-positive ratio', () => {
    registerDeclaredLineHeight('Broken', 400, 'normal', 0)
    expect(normalLineHeightRatio('Broken', 400, false)).toBe(FALLBACK_NORMAL_RATIO)
  })
})

describe('weight matching', () => {
  it('meets CSS keywords and numeric folder-font weights on one scale', () => {
    expect(numericWeight('normal')).toBe(400)
    expect(numericWeight('regular')).toBe(400)
    expect(numericWeight('bold')).toBe(700)
    expect(numericWeight('600')).toBe(600)
    expect(numericWeight(300)).toBe(300)
    expect(numericWeight(undefined)).toBe(400)
    // The reported case: object says "normal", the installed face says 400.
    registerDeclaredLineHeight('Proseware Pro Regular', 400, 'normal', 1.162)
    expect(normalLineHeightRatio('Proseware Pro Regular', 'normal', false)).toBeCloseTo(1.162, 6)
  })

  it('falls back to the nearest declared weight of the same family and style', () => {
    registerDeclaredLineHeight('Face', 300, 'normal', 1.1)
    registerDeclaredLineHeight('Face', 700, 'normal', 1.3)
    expect(normalLineHeightRatio('Face', 400, false)).toBeCloseTo(1.1, 6)
    expect(normalLineHeightRatio('Face', 'bold', false)).toBeCloseTo(1.3, 6)
    expect(normalLineHeightRatio('Face', 600, false)).toBeCloseTo(1.3, 6)
    // A different style is a different face; nothing declared → fallback.
    expect(normalLineHeightRatio('Face', 400, true)).toBe(FALLBACK_NORMAL_RATIO)
  })
})

describe('forgetMeasuredLineHeight', () => {
  it('drops measurements but keeps what the font file declared', () => {
    registerDeclaredLineHeight('Proseware Pro Regular', 400, 'normal', 1.162)
    // jsdom measures nothing, so the only thing there is to forget is the
    // declared ratio — which must survive: it describes the file, not a probe.
    forgetMeasuredLineHeight('Proseware Pro Regular')
    expect(normalLineHeightRatio('Proseware Pro Regular', 400, false)).toBeCloseTo(1.162, 6)
    // Unknown families are a no-op, not an error.
    expect(() => forgetMeasuredLineHeight(undefined)).not.toThrow()
  })
})
