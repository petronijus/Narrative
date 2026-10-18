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
  createFontLoadFilter,
  isEmbeddableFamilyName,
  removeHtmlTextFace,
  setHtmlTextFace,
  subscribeFontFamilyChanges,
} from './fontChanges'
import './pixiFontSink'
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
    announceFontFamilyChanged('Brand Sans')
    expect(seen).toEqual([])
    // The render page waits for the redraw: it is render work until delivered.
    await whenRenderWorkIdle()
    expect(seen).toEqual(['Inter', 'Brand Sans'])
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
      family: 'Brand Sans',
      weight: '400',
      style: 'normal',
      bytes: ttf(1),
    })
    setHtmlTextFace({
      key: 'b',
      family: 'Brand Sans',
      weight: '700',
      style: 'italic',
      bytes: ttf(2),
    })
    const css = await pixi.fontCss.get('Brand Sans')!
    expect(css.match(/@font-face/g)).toHaveLength(2)
    expect(css).toContain('font-family: "Brand Sans"; font-weight: 700; font-style: italic;')
    expect(css).toContain("src: url('data:font/ttf;base64,")
    expect(pixi.cache.get('Brand Sans-and-url')).toEqual({ entries: [] })
    await whenRenderWorkIdle()
    expect(seen).toEqual(['Brand Sans'])
    // Registered CSS is not dropped by its own announcement.
    expect(pixi.fontCss.has('Brand Sans')).toBe(true)

    removeHtmlTextFace('b')
    expect((await pixi.fontCss.get('Brand Sans')!).match(/@font-face/g)).toHaveLength(1)
    removeHtmlTextFace('a')
    expect(pixi.fontCss.has('Brand Sans')).toBe(false)
    expect(pixi.cache.has('Brand Sans-and-url')).toBe(false)
  })

  it('hands Pixi every family registered before the renderer loaded', async () => {
    // The app registers Inter at boot and the folder pages their fonts long
    // before (or without ever) loading Pixi: the sink gets them on install.
    vi.resetModules()
    const early = await import('./fontChanges')
    const inter = [{ url: '/assets/inter.woff2', faces: [{ weight: '100 900', style: 'normal' }] }]
    early.setHtmlTextUrlFamily('Inter', inter)
    early.setHtmlTextFace({
      key: 'k',
      family: 'Brand Sans',
      weight: '400',
      style: 'normal',
      bytes: ttf(4),
    })
    expect(pixi.cache.size).toBe(0)
    expect(pixi.fontCss.size).toBe(0)

    await import('./pixiFontSink')
    expect(pixi.cache.get('Inter-and-url')).toEqual({ entries: inter })
    expect(pixi.cache.get('Brand Sans-and-url')).toEqual({ entries: [] })
    expect(await pixi.fontCss.get('Brand Sans')!).toContain('font-family: "Brand Sans"')
    // Pixi builds Inter's CSS itself, from the URLs.
    expect(pixi.fontCss.has('Inter')).toBe(false)
    early._resetFontChangesForTests()
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

describe('createFontLoadFilter', () => {
  const face = (family: string, weight = '400', status: FontFaceLoadStatus = 'loaded') =>
    ({
      family,
      weight,
      style: 'normal',
      stretch: 'normal',
      unicodeRange: 'U+0-10FFFF',
      status,
    }) as FontFace

  it('reports a face once, however often the same face loads again', () => {
    const isNews = createFontLoadFilter()
    expect(isNews([face('Inter', '100 900')])).toBe(true)
    // HTMLText's measurements add the same faces to the document again.
    expect(isNews([face('Inter', '100 900'), face('Inter', '100 900')])).toBe(false)
    expect(isNews([face('Inter', '100 900'), face('Inter', '700')])).toBe(true)
  })

  it('ignores faces that did not load', () => {
    const isNews = createFontLoadFilter()
    expect(isNews([face('Brand', '400', 'error')])).toBe(false)
    expect(isNews([face('Brand', '400')])).toBe(true)
  })
})
