/**
 * lib/fontLineMetrics.test.ts
 *
 * The resolver's precedence is a contract four consumers rely on (renderer,
 * edit overlay, clip mask, Inspector); pin it here. jsdom lays nothing out,
 * so "normal" measures as 0 and falls back — which is itself part of the
 * contract: environments without layout render exactly as before (1.2).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  resolveLineHeightPx,
  effectiveLineHeightMultiple,
  normalLineHeightRatio,
  registerDeclaredLineMetrics,
  powerpointLineOffsetPx,
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
  it('follows the line font for a multiple of the normal height', () => {
    // A 150 px frame default holding 60 px text is spaced for 60 px.
    expect(resolveLineHeightPx({ fontSize: 150, lineSpacing: 0.68 }, 60)).toBeCloseTo(
      0.68 * FALLBACK_NORMAL_RATIO * 60,
      6,
    )
    expect(resolveLineHeightPx({ fontSize: 150 }, 60)).toBeCloseTo(FALLBACK_NORMAL_RATIO * 60, 6)
  })

  it('keeps an absolute line height whatever the line holds', () => {
    // `lineHeight` is PowerPoint's spcPts: a height, not a multiple of the line's font.
    expect(resolveLineHeightPx({ fontSize: 150, lineHeight: 1.2 }, 60)).toBe(180)
  })

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

describe('registerDeclaredLineMetrics', () => {
  it('declared file metrics win over measurement and the fallback', () => {
    registerDeclaredLineMetrics('Proseware Pro Regular', 400, 'normal', {
      lineHeight: 1.162,
      descent: 0.2,
    })
    expect(normalLineHeightRatio('Proseware Pro Regular', 400, false)).toBeCloseTo(1.162, 6)
    // Keyed by weight and style: the italic face is still unknown here.
    expect(normalLineHeightRatio('Proseware Pro Regular', 400, true)).toBe(FALLBACK_NORMAL_RATIO)
    // And it flows through the resolver: 0.75 × 1.162 × 158.
    expect(
      resolveLineHeightPx({ fontSize: 158, fontFamily: 'Proseware Pro Regular', lineSpacing: 0.75 }),
    ).toBeCloseTo(0.75 * 1.162 * 158, 4)
  })

  it('ignores a non-positive line height', () => {
    registerDeclaredLineMetrics('Broken', 400, 'normal', { lineHeight: 0, descent: 0.2 })
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
    registerDeclaredLineMetrics('Proseware Pro Regular', 400, 'normal', {
      lineHeight: 1.162,
      descent: 0.2,
    })
    expect(normalLineHeightRatio('Proseware Pro Regular', 'normal', false)).toBeCloseTo(1.162, 6)
  })

  it('falls back to the nearest declared weight of the same family and style', () => {
    registerDeclaredLineMetrics('Face', 300, 'normal', { lineHeight: 1.1, descent: 0.2 })
    registerDeclaredLineMetrics('Face', 700, 'normal', { lineHeight: 1.3, descent: 0.2 })
    expect(normalLineHeightRatio('Face', 400, false)).toBeCloseTo(1.1, 6)
    expect(normalLineHeightRatio('Face', 'bold', false)).toBeCloseTo(1.3, 6)
    expect(normalLineHeightRatio('Face', 600, false)).toBeCloseTo(1.3, 6)
    // A different style is a different face; nothing declared → fallback.
    expect(normalLineHeightRatio('Face', 400, true)).toBe(FALLBACK_NORMAL_RATIO)
  })
})

describe('forgetMeasuredLineHeight', () => {
  it('drops measurements but keeps what the font file declared', () => {
    registerDeclaredLineMetrics('Proseware Pro Regular', 400, 'normal', {
      lineHeight: 1.162,
      descent: 0.2,
    })
    // jsdom measures nothing, so the only thing there is to forget is the
    // declared ratio — which must survive: it describes the file, not a probe.
    forgetMeasuredLineHeight('Proseware Pro Regular')
    expect(normalLineHeightRatio('Proseware Pro Regular', 400, false)).toBeCloseTo(1.162, 6)
    // Unknown families are a no-op, not an error.
    expect(() => forgetMeasuredLineHeight(undefined)).not.toThrow()
  })
})

describe('powerpointLineOffsetPx', () => {
  // The jsdom canvas stub is one shared object; a spy left on it would leak.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Make the canvas report a face's layout ascent/descent, in ems. */
  function browserReports(ascentEm: number, descentEm: number): void {
    const ctx = document.createElement('canvas').getContext('2d')!
    vi.spyOn(ctx, 'measureText').mockImplementation(
      () =>
        ({
          width: 0,
          fontBoundingBoxAscent: ascentEm * 1000,
          fontBoundingBoxDescent: descentEm * 1000,
        }) as TextMetrics,
    )
  }

  it('puts the Proseware deck headline where PowerPoint does', () => {
    // Proseware Pro: the browser lays it out with typo 0.704 / 0.198 (the font
    // sets USE_TYPO_METRICS); PowerPoint uses hhea, descent 0.198. The
    // headline is 72 px with exactly 65 pt lines = 130 px at 1920.
    browserReports(0.704, 0.198)
    registerDeclaredLineMetrics('Proseware Pro Regular', 400, 'normal', {
      lineHeight: 1.162,
      descent: 0.198,
    })
    const offset = powerpointLineOffsetPx({
      fontSize: 72,
      fontFamily: 'Proseware Pro Regular',
      lineHeight: 130 / 72,
    })
    // PowerPoint baseline 130 − 14.256; CSS baseline (130 − 64.944)/2 + 50.688.
    expect(offset).toBeCloseTo(130 - 14.256 - ((130 - 64.944) / 2 + 50.688), 3)
  })

  it('is plain half-leading when the file was not read', () => {
    browserReports(0.8, 0.2)
    // 150 px lines, 100 px of glyph box: CSS leaves 25 above, PowerPoint 50.
    expect(powerpointLineOffsetPx({ fontSize: 100, lineHeight: 1.5 })).toBeCloseTo(25, 6)
  })

  it('moves text up when the line height is below the glyph box', () => {
    browserReports(0.8, 0.2)
    expect(powerpointLineOffsetPx({ fontSize: 100, lineHeight: 0.8 })).toBeCloseTo(-10, 6)
  })

  it('is zero where the browser cannot report font metrics', () => {
    // The jsdom canvas stub reports none.
    expect(powerpointLineOffsetPx({ fontSize: 72, lineHeight: 1.8 })).toBe(0)
  })
})
