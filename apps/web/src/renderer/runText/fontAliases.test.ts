// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { aliasName, rewriteFontFamilies, splitFamilies } from './fontAliases.js'

describe('splitFamilies', () => {
  it('reads quoted and bare names, and knows the generic ones', () => {
    expect(
      splitFamilies(`"Narrative Var Test", Arial, Helvetica Neue, 'A "q"', sans-serif`),
    ).toEqual([
      { name: 'Narrative Var Test', generic: false },
      { name: 'Arial', generic: false },
      { name: 'Helvetica Neue', generic: false },
      { name: 'A "q"', generic: false },
      { name: 'sans-serif', generic: true },
    ])
    expect(splitFamilies(`"a \\"b\\""`)).toEqual([{ name: 'a "b"', generic: false }])
  })
})

describe('rewriteFontFamilies', () => {
  const aliases = new Map([['Narrative Var Test', aliasName(3)]])
  const alias = (f: string): string | undefined => aliases.get(f)

  it('renames the aliased families, keeps everything before the list', () => {
    expect(
      rewriteFontFamilies(
        'normal 400 24px "Narrative Var Test", Arial, Helvetica, "Helvetica Neue", sans-serif',
        alias,
      ),
    ).toBe('normal 400 24px "nrf alias 3", "Arial", "Helvetica", "Helvetica Neue", sans-serif')
    expect(rewriteFontFamilies('italic 700 13.5px/1.2 "Narrative Var Test"', alias)).toBe(
      'italic 700 13.5px/1.2 "nrf alias 3"',
    )
  })

  it('leaves a font with no aliased family untouched', () => {
    const font = 'normal 400 24px Inter, Arial, sans-serif'
    expect(rewriteFontFamilies(font, alias)).toBe(font)
  })
})
