/**
 * commands/src/text/fontWeights.test.ts
 *
 * The weight picker shows a DERIVED weight when the stored one is not a
 * cut the family has (it used to write a "fixed" weight from an effect,
 * i.e. on mere display). The derived value must be the face the browser
 * actually renders, so these pin the CSS Fonts 4 weight-matching rule and
 * the family → available-weights resolution.
 */

import { describe, expect, it } from 'vitest'
import {
  SYSTEM_FONTS,
  allowedWeightsFor,
  effectiveFontWeight,
  matchFontWeight,
  pickPrimaryFamily,
  stretchRangeFor,
  type FontFaceWeight,
} from './fontWeights.js'

describe('matchFontWeight (CSS Fonts 4 §5.2)', () => {
  it('returns an available weight unchanged', () => {
    expect(matchFontWeight(700, [400, 700])).toBe(700)
  })

  it('400..500: first up to 500, then down, then above 500', () => {
    expect(matchFontWeight(400, [300, 500, 700])).toBe(500)
    expect(matchFontWeight(450, [300, 700])).toBe(300)
    expect(matchFontWeight(500, [600, 800])).toBe(600)
  })

  it('below 400: first down, then up', () => {
    expect(matchFontWeight(300, [200, 400])).toBe(200)
    expect(matchFontWeight(300, [400, 700])).toBe(400)
  })

  it('above 500: first up, then down', () => {
    expect(matchFontWeight(600, [400, 700])).toBe(700)
    // A tie by distance goes UP, as the browser does — plain "nearest"
    // would pick 500 and name a face that is not on screen.
    expect(matchFontWeight(600, [500, 700])).toBe(700)
    expect(matchFontWeight(800, [400, 700])).toBe(700)
  })

  it('ignores input order', () => {
    expect(matchFontWeight(600, [700, 400])).toBe(700)
  })

  it('returns the request when nothing is available', () => {
    expect(matchFontWeight(600, [])).toBe(600)
  })
})

describe('allowedWeightsFor', () => {
  const folderFonts = [
    { family: 'Brand Sans', weight: 400 },
    { family: 'Brand Sans', weight: 700 },
    { family: 'Brand Sans', weight: 700 },
    { family: 'Odd Cut', weight: 350 },
  ]

  it('uses the uploaded cuts of a folder family, deduplicated and sorted', () => {
    expect(allowedWeightsFor('"Brand Sans", sans-serif', folderFonts)).toEqual([400, 700])
  })

  it('uses the curated list of a system stack', () => {
    const helvetica = SYSTEM_FONTS.find((f) => f.label === 'Helvetica')!
    expect(allowedWeightsFor(helvetica.value, [])).toEqual([400, 700])
  })

  it('means "any weight" for an unknown family or no family', () => {
    expect(allowedWeightsFor('Unknown Family', folderFonts)).toBeNull()
    expect(allowedWeightsFor(undefined, folderFonts)).toBeNull()
    expect(allowedWeightsFor('', folderFonts)).toBeNull()
  })

  it('degrades to "any weight" when a family has no standard cut', () => {
    expect(allowedWeightsFor('Odd Cut', folderFonts)).toBeNull()
  })
})

describe('effectiveFontWeight', () => {
  it('keeps a weight the family has, and legacy keywords as numbers', () => {
    expect(effectiveFontWeight(300, null)).toBe(300)
    expect(effectiveFontWeight('bold', [400, 700])).toBe(700)
    expect(effectiveFontWeight('normal', null)).toBe(400)
  })

  it('shows the fallback face for a weight the family lacks', () => {
    expect(effectiveFontWeight(600, [400, 700])).toBe(700)
    expect(effectiveFontWeight(300, [400, 700])).toBe(400)
  })
})

describe('pickPrimaryFamily', () => {
  it('unquotes the first family of a stack', () => {
    expect(pickPrimaryFamily("'Helvetica Neue', Helvetica, Arial")).toBe('Helvetica Neue')
    expect(pickPrimaryFamily('  ')).toBeNull()
  })
})

describe('variable faces (A4.2c)', () => {
  const fabrikam = [
    { family: 'Acme Type', weight: 400, axes: { wght: [300, 700], wdth: [100, 130] } },
  ] as Array<FontFaceWeight>

  it('a variable face covers every standard weight in its range', () => {
    expect(allowedWeightsFor('Acme Type', fabrikam)).toEqual([300, 400, 500, 600, 700])
  })

  it('the widths a family can be drawn at are its faces’ wdth ranges', () => {
    expect(stretchRangeFor('Acme Type', fabrikam)).toEqual([100, 130])
    expect(
      stretchRangeFor('Acme Type', [
        ...fabrikam,
        { family: 'Acme Type', weight: 400, axes: { wdth: [75, 100] } },
      ]),
    ).toEqual([75, 130])
    expect(stretchRangeFor('Inter', fabrikam)).toBeNull()
    expect(stretchRangeFor('Acme Type', [{ family: 'Acme Type', weight: 400 }])).toBeNull()
  })
})
