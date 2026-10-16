/**
 * tokensContext.test.ts — colour tokens that depend on where they are used
 * (A4.2d): the slide's surface, then the deck's variant, then the value;
 * `#rrggbbaa` alpha; the deck's meta.
 */

import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  colorTokenValue,
  isContextualColor,
  parseHexColor,
  resolveTokenValue,
  type FolderTokensSnapshot,
} from './tokens.js'
import { readDeckMeta, setDeckMeta, subscribeDeckMeta } from './deckMeta.js'

const text = {
  id: 'text',
  name: 'Text',
  value: '#001e50',
  byVariant: { axis: 'background', values: { nh: '#001e50', dc: '#ffffff' } },
  bySurface: { 'picture-dark': '#ffffff' },
}
const tokens: FolderTokensSnapshot = {
  colors: { text, muted: { id: 'muted', name: 'Muted', value: '#ffffff99' } },
  textStyles: { body: { id: 'body', name: 'Body', color: { $token: 'colors.text' } } },
  effectStyles: {},
}

describe('colour tokens per variant and surface', () => {
  it('the surface wins, then the deck variant on the token axis, then the value', () => {
    expect(colorTokenValue(text)).toBe('#001e50')
    expect(colorTokenValue(text, { variant: { background: 'dc' } })).toBe('#ffffff')
    expect(colorTokenValue(text, { variant: { background: 'white' } })).toBe('#001e50')
    expect(colorTokenValue(text, { variant: { background: 'nh' }, surface: 'picture-dark' })).toBe(
      '#ffffff',
    )
    // Through a text style, too.
    expect(
      resolveTokenValue({ $token: 'textStyles.body' }, tokens, { variant: { background: 'dc' } }),
    ).toBe('#ffffff')
    expect(isContextualColor(text)).toBe(true)
    expect(isContextualColor(tokens.colors['muted'])).toBe(false)
  })

  it('reads alpha off an eight-digit hex', () => {
    expect(parseHexColor('#ffffff99')).toEqual({ color: 0xffffff, alpha: 0.6 })
    expect(parseHexColor('#001e50')).toEqual({ color: 0x001e50, alpha: 1 })
    expect(parseHexColor('red')).toBeNull()
  })
})

describe('deck meta', () => {
  it('writes and reads variant, fields and language, and tells listeners', () => {
    const doc = new Y.Doc()
    const seen: unknown[] = []
    const off = subscribeDeckMeta(doc, (m) => seen.push(m))
    setDeckMeta(doc, { variant: { background: 'dc' }, fields: { client: 'Acme' }, lang: 'de' })
    expect(readDeckMeta(doc)).toEqual({
      variant: { background: 'dc' },
      fields: { client: 'Acme' },
      lang: 'de',
    })
    setDeckMeta(doc, { fields: null })
    expect(readDeckMeta(doc)).toEqual({ variant: { background: 'dc' }, lang: 'de' })
    off()
    expect(seen.length).toBe(2)
  })
})
