/**
 * media/fontMetadata.test.ts
 *
 * parseFontMetadata against fonts the test builds with opentype.js's own
 * writer, so every name-table platform, OS/2 field and fvar axis is known.
 */

import { describe, it, expect } from 'vitest'
import { Font, Glyph, Path, type FontOptions } from 'opentype.js/dist/opentype.mjs'
import { parseFontMetadata } from './fontMetadata.js'

function makeFont(options: Partial<FontOptions> = {}): Font {
  const notdef = new Glyph({ name: '.notdef', advanceWidth: 500, path: new Path() })
  return new Font({
    familyName: 'Acme Sans',
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    weightClass: 400,
    glyphs: [notdef],
    ...options,
  })
}

describe('parseFontMetadata', () => {
  it('reads a static font: family, postscript name, OS/2 weight, upright', () => {
    expect(parseFontMetadata(makeFont().toArrayBuffer())).toEqual({
      family: 'Acme Sans',
      weight: 400,
      style: 'normal',
      postscriptName: 'AcmeSansRegular',
    })
  })

  it('prefers the Windows names over the legacy Macintosh ones', () => {
    const font = makeFont()
    font.names.macintosh = {
      ...font.names.macintosh,
      fontFamily: { en: 'Acme Legacy' },
      preferredFamily: { en: 'Acme Legacy' },
      postScriptName: { en: 'AcmeLegacy' },
    }
    font.names.windows = {
      ...font.names.windows,
      preferredFamily: { en: 'Acme Sans Pro' },
      postScriptName: { en: 'AcmeSansPro-Regular' },
    }
    const meta = parseFontMetadata(font.toArrayBuffer())
    expect(meta.family).toBe('Acme Sans Pro')
    expect(meta.postscriptName).toBe('AcmeSansPro-Regular')
  })

  it('trusts a weight in the name over a contradicting OS/2 usWeightClass', () => {
    const font = makeFont({ styleName: 'Thin', weightClass: 300 })
    expect(parseFontMetadata(font.toArrayBuffer()).weight).toBe(100)
  })

  it('reads the italic bit of OS/2 fsSelection', () => {
    const font = makeFont({ styleName: 'Oblique', italicAngle: -12 })
    expect(parseFontMetadata(font.toArrayBuffer()).style).toBe('italic')
  })

  it('lists the weight and width ranges of a variable font', () => {
    const font = makeFont({
      tables: {
        fvar: {
          axes: [
            { tag: 'wght', minValue: 100, defaultValue: 400, maxValue: 900 },
            { tag: 'wdth', minValue: 75, defaultValue: 100, maxValue: 130 },
            { tag: 'opsz', minValue: 8, defaultValue: 12, maxValue: 72 },
          ],
          instances: [],
        },
      },
    })
    expect(parseFontMetadata(font.toArrayBuffer()).axes).toEqual({
      wght: [100, 900],
      wdth: [75, 130],
    })
  })

  it('throws on bytes that are not a font', () => {
    expect(() => parseFontMetadata(new TextEncoder().encode('not a font').buffer)).toThrow()
  })
})
