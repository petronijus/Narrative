import { afterEach, describe, expect, it, vi } from 'vitest'

const pixi = vi.hoisted(() => {
  const cache = new Map<string, unknown>()
  return {
    fontCss: new Map<string, Promise<string>>(),
    cache,
    Cache: {
      has: (key: string) => cache.has(key),
      get: (key: string) => cache.get(key),
      set: (key: string, value: unknown) => void cache.set(key, value),
      remove: (key: string) => void cache.delete(key),
    },
  }
})
vi.mock('pixi.js', () => ({ FontStylePromiseCache: pixi.fontCss, Cache: pixi.Cache }))

import {
  _resetFontChangesForTests,
  announceFontFamilyChanged,
  isEmbeddableFamilyName,
  removeHtmlTextFace,
  setHtmlTextFace,
  subscribeFontFamilyChanges,
} from './fontChanges'
import { _resetRenderWorkForTests, whenRenderWorkIdle } from './renderWork'

afterEach(() => {
  _resetFontChangesForTests()
  _resetRenderWorkForTests()
  pixi.fontCss.clear()
  pixi.cache.clear()
})

const ttf = (marker: number) => new Uint8Array([0, 1, 0, 0, marker]).buffer

describe('fontChanges', () => {
  it('delivers announcements made together once per family, as tracked render work', async () => {
    const seen: string[] = []
    subscribeFontFamilyChanges((family) => seen.push(family))
    announceFontFamilyChanged('Inter')
    announceFontFamilyChanged('Inter')
    announceFontFamilyChanged('Proseware Pro')
    expect(seen).toEqual([])
    // The render page waits for the redraw: it is render work until delivered.
    await whenRenderWorkIdle()
    expect(seen).toEqual(['Inter', 'Proseware Pro'])
  })

  it('lets Pixi rebuild the CSS of a family it embeds itself (the bundled Inter)', async () => {
    pixi.fontCss.set('Inter', Promise.resolve('@font-face{}'))
    announceFontFamilyChanged('Inter')
    await whenRenderWorkIdle()
    expect(pixi.fontCss.has('Inter')).toBe(false)
  })

  it('embeds registered faces from their bytes — every face of the family, no URL for Pixi to fetch', async () => {
    const seen: string[] = []
    subscribeFontFamilyChanges((family) => seen.push(family))
    setHtmlTextFace({
      key: 'a',
      family: 'Proseware Pro',
      weight: '400',
      style: 'normal',
      bytes: ttf(1),
    })
    setHtmlTextFace({
      key: 'b',
      family: 'Proseware Pro',
      weight: '700',
      style: 'italic',
      bytes: ttf(2),
    })
    const css = await pixi.fontCss.get('Proseware Pro')!
    expect(css.match(/@font-face/g)).toHaveLength(2)
    expect(css).toContain('font-family: "Proseware Pro"; font-weight: 700; font-style: italic;')
    expect(css).toContain("src: url('data:font/ttf;base64,")
    expect(pixi.cache.get('Proseware Pro-and-url')).toEqual({ entries: [] })
    await whenRenderWorkIdle()
    expect(seen).toEqual(['Proseware Pro'])
    // Registered CSS is not dropped by its own announcement.
    expect(pixi.fontCss.has('Proseware Pro')).toBe(true)

    removeHtmlTextFace('b')
    expect((await pixi.fontCss.get('Proseware Pro')!).match(/@font-face/g)).toHaveLength(1)
    removeHtmlTextFace('a')
    expect(pixi.fontCss.has('Proseware Pro')).toBe(false)
    expect(pixi.cache.has('Proseware Pro-and-url')).toBe(false)
  })

  it('gives Pixi only names it can write into its SVG unescaped', () => {
    expect(isEmbeddableFamilyName('Northwind Sans ST Pro 60 Black')).toBe(true)
    expect(isEmbeddableFamilyName('Noto_Serif-Display')).toBe(true)
    expect(isEmbeddableFamilyName("O'Brien Sans")).toBe(false)
    expect(isEmbeddableFamilyName('X</style><img src=x>')).toBe(false)
    expect(isEmbeddableFamilyName('a"b')).toBe(false)
    expect(isEmbeddableFamilyName(' Leading')).toBe(false)
    setHtmlTextFace({
      key: 'x',
      family: 'X</style>',
      weight: '400',
      style: 'normal',
      bytes: ttf(3),
    })
    expect(pixi.fontCss.size).toBe(0)
  })
})
