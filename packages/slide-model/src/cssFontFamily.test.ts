import { describe, expect, it } from 'vitest'
import { fontFamilyNames, quoteCssFamilyName } from './cssFontFamily.js'

describe('quoteCssFamilyName', () => {
  it('leaves identifiers and generic families bare, quotes everything else', () => {
    expect(quoteCssFamilyName('Inter')).toBe('Inter')
    expect(quoteCssFamilyName('sans-serif')).toBe('sans-serif')
    expect(quoteCssFamilyName('Proseware Pro')).toBe('"Proseware Pro"')
    expect(quoteCssFamilyName('Northwind Sans ST Pro 60 Black', "'")).toBe(
      "'Northwind Sans ST Pro 60 Black'",
    )
  })

  it('re-quotes a quoted name safely, and keeps a quoted generic a name', () => {
    expect(quoteCssFamilyName('"Proseware Pro"')).toBe('"Proseware Pro"')
    expect(quoteCssFamilyName("'serif'")).toBe('"serif"')
  })

  it('escapes what could end the string or the declaration', () => {
    expect(quoteCssFamilyName('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(quoteCssFamilyName("O'Hare Sans", "'")).toBe("'O\\'Hare Sans'")
    expect(quoteCssFamilyName('line\nbreak')).toBe('"line\\a break"')
    // Inside a <style> set through innerHTML: no `</style>` can survive.
    expect(quoteCssFamilyName('X</style><img src=x>')).toBe(
      '"X\\3c /style\\3e \\3c img src=x\\3e "',
    )
  })
})

describe('fontFamilyNames', () => {
  it('splits a stack into unquoted names, in order, each once', () => {
    expect(fontFamilyNames(' "Proseware Pro", Arial, \'Proseware Pro\' , sans-serif,, ')).toEqual([
      'Proseware Pro',
      'Arial',
      'sans-serif',
    ])
    expect(fontFamilyNames('')).toEqual([])
  })
})
