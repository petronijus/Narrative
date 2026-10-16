import { describe, it, expect } from 'vitest'
import {
  categoriseFont,
  cssFontFamily,
  fontFallbackArray,
  withFontFallback,
} from './fontFallback.js'

describe('categoriseFont', () => {
  it('detects serif family names from well-known substrings', () => {
    expect(categoriseFont('Georgia')).toBe('serif')
    expect(categoriseFont('Times New Roman')).toBe('serif')
    expect(categoriseFont('Garamond')).toBe('serif')
    expect(categoriseFont('Playfair Display')).toBe('serif')
    expect(categoriseFont('Source Serif Pro')).toBe('serif')
  })

  it('detects monospace family names', () => {
    expect(categoriseFont('Courier New')).toBe('monospace')
    expect(categoriseFont('JetBrains Mono')).toBe('monospace')
    expect(categoriseFont('Fira Code')).toBe('monospace')
    expect(categoriseFont('Consolas')).toBe('monospace')
  })

  it('detects sans-serif family names from common substrings', () => {
    expect(categoriseFont('Helvetica Neue')).toBe('sans-serif')
    expect(categoriseFont('Inter')).toBe('sans-serif')
    expect(categoriseFont('Roboto Condensed')).toBe('sans-serif')
    expect(categoriseFont('Druk Wide')).toBe('sans-serif')
    expect(categoriseFont('Montserrat Light')).toBe('sans-serif')
    expect(categoriseFont('Northwind Sans ST Pro 36 Bold')).toBe('sans-serif')
    expect(categoriseFont('Asterisk Sans Variable Black')).toBe('sans-serif')
  })

  it('returns undefined for unknown names', () => {
    expect(categoriseFont('Foobar Display')).toBeUndefined()
    expect(categoriseFont('XYZ123')).toBeUndefined()
  })

  it('is case-insensitive', () => {
    expect(categoriseFont('GEORGIA')).toBe('serif')
    expect(categoriseFont('inter')).toBe('sans-serif')
    expect(categoriseFont('FIRA CODE')).toBe('monospace')
  })
})

describe('withFontFallback', () => {
  it('returns undefined for undefined / empty', () => {
    expect(withFontFallback(undefined)).toBeUndefined()
    expect(withFontFallback('')).toBeUndefined()
    expect(withFontFallback('   ')).toBeUndefined()
  })

  it('appends the sans-serif stack for unknown sans-looking names', () => {
    const out = withFontFallback('Druk Wide')
    expect(out?.startsWith('Druk Wide,')).toBe(true)
    expect(out).toContain('sans-serif')
  })

  it('appends the serif stack for known serif names', () => {
    const out = withFontFallback('Georgia')
    expect(out?.startsWith('Georgia,')).toBe(true)
    expect(out).toContain('serif')
    expect(out).not.toContain('sans-serif')
  })

  it('appends the monospace stack for known mono names', () => {
    const out = withFontFallback('JetBrains Mono')
    expect(out?.startsWith('JetBrains Mono,')).toBe(true)
    expect(out).toContain('monospace')
  })

  it('defaults to sans-serif for fully unrecognised names', () => {
    const out = withFontFallback('Mystery Display')
    expect(out?.startsWith('Mystery Display,')).toBe(true)
    expect(out).toContain('sans-serif')
  })

  it('is a no-op when the caller already supplied a comma-separated stack', () => {
    const original = 'Custom Brand Font, sans-serif'
    expect(withFontFallback(original)).toBe(original)
  })
})

describe('fontFallbackArray', () => {
  it('returns an empty array for undefined / empty', () => {
    expect(fontFallbackArray(undefined)).toEqual([])
    expect(fontFallbackArray('')).toEqual([])
  })

  it('returns the original family then the category stack entries', () => {
    const arr = fontFallbackArray('Druk Wide')
    expect(arr[0]).toBe('Druk Wide')
    expect(arr[arr.length - 1]).toBe('sans-serif')
    expect(arr.length).toBeGreaterThan(2)
  })

  it('splits a pre-supplied stack into entries without expanding', () => {
    const arr = fontFallbackArray('Custom, Arial, sans-serif')
    expect(arr).toEqual(['Custom', 'Arial', 'sans-serif'])
  })

  it('returns serif stack entries for serif-categorised names', () => {
    const arr = fontFallbackArray('Georgia')
    expect(arr[0]).toBe('Georgia')
    expect(arr).toContain('serif')
  })
})

describe('cssFontFamily', () => {
  it('returns undefined for undefined / empty', () => {
    expect(cssFontFamily(undefined)).toBeUndefined()
    expect(cssFontFamily('')).toBeUndefined()
  })

  it('double-quotes multi-word PPTX face names', () => {
    const out = cssFontFamily('Northwind Sans ST Pro 36 Regular')
    expect(out?.startsWith('"Northwind Sans ST Pro 36 Regular"')).toBe(true)
    expect(out).toContain('sans-serif')
  })

  it('leaves single-word identifiers unquoted', () => {
    const out = cssFontFamily('Inter')
    expect(out?.startsWith('Inter,')).toBe(true)
  })

  it('does not quote CSS generics in the fallback stack', () => {
    const out = cssFontFamily('Druk Wide')
    // `sans-serif` should appear as a bare generic, not quoted.
    expect(out).toMatch(/,\s*sans-serif\s*$/)
    expect(out).not.toMatch(/"sans-serif"/)
  })

  it('serif-categorises Georgia and emits a serif stack', () => {
    const out = cssFontFamily('Georgia')
    expect(out?.startsWith('Georgia,')).toBe(true)
    expect(out).toMatch(/,\s*serif\s*$/)
    expect(out).not.toContain('sans-serif')
  })

  it('passes through a caller-supplied stack, quoting per entry', () => {
    const out = cssFontFamily('Custom Brand, Arial, sans-serif')
    expect(out).toBe('"Custom Brand", Arial, sans-serif')
  })

  it('handles family names that start with digits via quoting', () => {
    // Unlikely in the wild but the CSS identifier rules forbid leading
    // digits — make sure we quote rather than emit broken CSS.
    const out = cssFontFamily('42 Display')
    expect(out?.startsWith('"42 Display"')).toBe(true)
  })

  it('cannot be broken out of: quotes, backslashes and line breaks are escaped', () => {
    // Family names reach a <style> element in the HTMLText SVG.
    expect(cssFontFamily('"x"; } * { color: red } a {, serif')).toBe(
      '"\\"x\\"; } * { color: red } a {", serif',
    )
    expect(cssFontFamily('Evil\\, serif')).toBe('"Evil\\\\", serif')
    expect(cssFontFamily('Line\nbreak, serif')).toBe('"Line\\a break", serif')
  })

  it('re-quotes a quoted name, and keeps a quoted generic a name', () => {
    expect(cssFontFamily("'Brand Sans', sans-serif")).toBe('"Brand Sans", sans-serif')
    expect(cssFontFamily('"serif", serif')).toBe('"serif", serif')
  })
})
