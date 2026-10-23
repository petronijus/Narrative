// @vitest-environment node
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
  htmlTextFontKeys,
  removeHtmlTextFace,
  setHtmlTextFace,
  subscribeFontFamilyChanges,
  subscribeHtmlTextFaces,
  type RegisteredFace,
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

  const brand = (key: string, weight: string, style = 'normal', marker = 1, stretch?: string) =>
    setHtmlTextFace({
      key,
      family: 'Brand Sans',
      weight,
      style,
      ...(stretch !== undefined ? { stretch } : {}),
      bytes: ttf(marker),
    })
  const request = (
    weights: number[],
    styles: ('normal' | 'italic')[] = ['normal'],
    families = ['Brand Sans'],
  ) => ({ families, weights, styles, stretch: 100 })
  const cssOf = async (key: string) => {
    expect(pixi.cache.get(`${key}-and-url`)).toEqual({ entries: [] })
    return pixi.fontCss.get(key)!
  }

  it('embeds only the faces a text matches, from their bytes, under the real family name', async () => {
    const seen: string[] = []
    subscribeFontFamilyChanges((family) => seen.push(family))
    brand('r', '400', 'normal', 1)
    brand('b', '700', 'normal', 2)
    brand('i', '400', 'italic', 3)
    brand('bi', '700', 'italic', 4)
    const keys = htmlTextFontKeys(request([400]))
    expect(keys).toHaveLength(1)
    const css = await cssOf(keys[0]!)
    expect(css.match(/@font-face/g)).toHaveLength(1)
    expect(css).toContain('font-family: "Brand Sans"; font-weight: 400; font-style: normal;')
    expect(css).toContain("src: url('data:font/ttf;base64,")
    // Bold and italic runs bring their faces; each face is embedded once.
    const mixed = await cssOf(htmlTextFontKeys(request([400, 700, 600], ['normal', 'italic']))[0]!)
    expect(mixed.match(/@font-face/g)).toHaveLength(4)
    await whenRenderWorkIdle()
    expect(seen).toEqual(['Brand Sans'])
  })

  it('gives the same request the same key, and nothing for a family with no faces', () => {
    brand('r', '400')
    brand('b', '700')
    const a = htmlTextFontKeys(request([400], ['normal'], ['Arial', 'Brand Sans']))
    expect(a).toHaveLength(1)
    // 500 matches the 400 face as well (no 500): the same faces, the same key.
    expect(htmlTextFontKeys(request([500]))).toEqual(a)
    expect(htmlTextFontKeys(request([400], ['normal'], ['Arial']))).toEqual([])
  })

  it('keeps a key current when its faces are replaced or removed', async () => {
    brand('r', '400', 'normal', 1)
    brand('b', '700', 'normal', 2)
    const [both] = htmlTextFontKeys(request([400, 700]))
    expect((await cssOf(both!)).match(/@font-face/g)).toHaveLength(2)
    removeHtmlTextFace('b')
    expect((await pixi.fontCss.get(both!)!).match(/@font-face/g)).toHaveLength(1)
    // With the bold face gone, bold now matches the regular one: a new key.
    expect(htmlTextFontKeys(request([400, 700]))).not.toEqual([both])
    removeHtmlTextFace('r')
    expect(pixi.fontCss.has(both!)).toBe(false)
    expect(pixi.cache.has(`${both}-and-url`)).toBe(false)
    expect(htmlTextFontKeys(request([400]))).toEqual([])
  })

  it('a variable face covers every weight: one face for any request', async () => {
    brand('v', '100 900', 'normal', 1)
    brand('vi', '100 900', 'italic', 2)
    const keys = htmlTextFontKeys(request([300, 400, 800]))
    expect((await cssOf(keys[0]!)).match(/@font-face/g)).toHaveLength(1)
    expect(await cssOf(keys[0]!)).toContain('font-weight: 100 900; font-style: normal;')
  })

  it('hands Pixi every key published before the renderer loaded', async () => {
    // The app registers Inter at boot and the folder pages their fonts long
    // before (or without ever) loading Pixi: the sink gets them on install.
    vi.resetModules()
    const early = await import('./fontChanges')
    early.setHtmlTextFace({
      key: 'k',
      family: 'Brand Sans',
      weight: '400',
      style: 'normal',
      bytes: ttf(4),
    })
    const [key] = early.htmlTextFontKeys(request([400]))
    expect(pixi.cache.size).toBe(0)
    expect(pixi.fontCss.size).toBe(0)

    await import('./pixiFontSink')
    expect(pixi.cache.get(`${key}-and-url`)).toEqual({ entries: [] })
    expect(await pixi.fontCss.get(key!)!).toContain('font-family: "Brand Sans"')
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

describe('subscribeHtmlTextFaces (the canvas text workers, ADR 0018)', () => {
  it('replays the faces there are, then reports each one added, replaced and removed', () => {
    setHtmlTextFace({ key: 'a', family: 'Brand', weight: '400', style: 'normal', bytes: ttf(1) })
    const seen: string[] = []
    let last: RegisteredFace | undefined
    const stop = subscribeHtmlTextFaces({
      added(face) {
        last = face
        seen.push(`+${face.key}:${face.family}:${face.weight}:${face.style}:${face.stretch}`)
      },
      removed(key) {
        seen.push(`-${key}`)
      },
    })
    expect(seen).toEqual(['+a:Brand:400:normal:100%'])
    expect(new Uint8Array(last!.bytes)[4]).toBe(1)
    setHtmlTextFace({
      key: 'b',
      family: 'Brand',
      weight: '100 900',
      style: 'italic',
      stretch: '75% 125%',
      bytes: ttf(2),
    })
    setHtmlTextFace({ key: 'a', family: 'Brand', weight: '700', style: 'normal', bytes: ttf(3) })
    removeHtmlTextFace('b')
    stop()
    removeHtmlTextFace('a')
    expect(seen).toEqual([
      '+a:Brand:400:normal:100%',
      '+b:Brand:100 900:italic:75% 125%',
      '+a:Brand:700:normal:100%',
      '-b',
    ])
  })

  it('reports no face whose name cannot be embedded', () => {
    const seen: string[] = []
    const stop = subscribeHtmlTextFaces({
      added: (face) => seen.push(face.key),
      removed: () => {},
    })
    setHtmlTextFace({ key: 'x', family: 'Bad"Name', weight: '400', style: 'normal', bytes: ttf(1) })
    stop()
    expect(seen).toEqual([])
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
