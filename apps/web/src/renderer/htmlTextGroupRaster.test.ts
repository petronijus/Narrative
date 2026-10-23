// @vitest-environment node
/**
 * renderer/htmlTextGroupRaster.test.ts — the pure parts of the grouped
 * raster: each cell's CSS confined to its own element in the shared SVG, the
 * packing, and which requests share an image. That the pixels are Pixi's is
 * e2e/table-raster-pixels.spec.ts's to prove.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Renderer, Texture } from 'pixi.js'
import { MEASUREMENT_SCOPE, scopeHtmlTextCss } from './pixiHtmlTextStyleScope.js'
import {
  createGroupRaster,
  GROUP_RASTER_SUPPORTED,
  groupRasterSupported,
  htmlTextRasterGroup,
  packShelves,
  scopeToCell,
  setHtmlTextRasterGroup,
} from './htmlTextGroupRaster.js'

describe('scopeToCell', () => {
  it("confines the container rule to the cell's element and its tag rules to its content", () => {
    const css = scopeHtmlTextCss(
      'div { padding: 8px; width: 176px } b { font-weight: 700 } i, em { font-style: italic }',
    )
    expect(scopeToCell(css, 'c3')).toBe(
      `${MEASUREMENT_SCOPE} div.c3 { padding: 8px; width: 176px } ` +
        `${MEASUREMENT_SCOPE} div.c3 b { font-weight: 700 } ` +
        `${MEASUREMENT_SCOPE} div.c3 i, ${MEASUREMENT_SCOPE} div.c3 em { font-style: italic }`,
    )
  })

  it('keeps a tag whose name starts with div a descendant rule', () => {
    const css = scopeHtmlTextCss('divider { color: red }')
    expect(scopeToCell(css, 'c0')).toBe(`${MEASUREMENT_SCOPE} div.c0 divider { color: red }`)
  })

  it('refuses CSS that is not scoped to the measurement (the cell is then drawn alone)', () => {
    expect(scopeToCell('div { padding: 8px }', 'c0')).toBeNull()
  })
})

describe('groupRasterSupported', () => {
  it('groups in Blink, never in WebKit (Safari, WKWebView, Playwright WebKit)', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
    const edge = `${chrome} Edg/156.0.0.0`
    const safari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
    const wkWebView =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
    const firefox =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'
    expect([chrome, edge, firefox].map(groupRasterSupported)).toEqual([true, true, true])
    expect([safari, wkWebView].map(groupRasterSupported)).toEqual([false, false])
  })
})

describe('packShelves', () => {
  it('places every image at whole pixels, apart, within the width', () => {
    const items = [
      { w: 300, h: 40, x: 0, y: 0 },
      { w: 250, h: 70, x: 0, y: 0 },
      { w: 120, h: 30, x: 0, y: 0 },
      { w: 400, h: 52, x: 0, y: 0 },
    ]
    const size = packShelves(items, 600)
    expect(size.w).toBeLessThanOrEqual(600)
    for (const [i, a] of items.entries()) {
      expect(Number.isInteger(a.x) && Number.isInteger(a.y)).toBe(true)
      expect(a.x + a.w).toBeLessThanOrEqual(size.w)
      expect(a.y + a.h).toBeLessThanOrEqual(size.h)
      for (const b of items.slice(i + 1)) {
        const apart =
          a.x + a.w + 2 <= b.x ||
          b.x + b.w + 2 <= a.x ||
          a.y + a.h + 2 <= b.y ||
          b.y + b.h + 2 <= a.y
        expect(apart, `${JSON.stringify(a)} and ${JSON.stringify(b)} overlap`).toBe(true)
      }
    }
  })

  it('gives an image wider than the limit a shelf of its own', () => {
    const items = [
      { w: 900, h: 10, x: 0, y: 0 },
      { w: 100, h: 10, x: 0, y: 0 },
    ]
    packShelves(items, 600)
    expect(items[1]).toMatchObject({ x: 0, y: 12 })
  })
})

describe('createGroupRaster', () => {
  const texture = {} as Texture
  const raster = () => {
    const single = vi.fn(() => Promise.resolve(texture))
    const g = createGroupRaster({} as Renderer, {
      onRaster: vi.fn(),
      onReady: vi.fn(),
      single,
      texture: vi.fn(),
    })
    return { g, single }
  }
  const text = (resolution: number) => ({ text: 'x', style: {}, resolution })

  it('draws a text alone when nothing else of its group asks in the same task', async () => {
    const { g, single } = raster()
    const a = {}
    const b = {}
    await Promise.all([g.request(text(1), a), g.request(text(1), b), g.request(text(2), a)])
    // Three groups of one: group a at two resolutions, group b.
    expect(single).toHaveBeenCalledTimes(3)
  })

  it('knows the group of a marked text, and none once unmarked or switched off', () => {
    const node = {} as Parameters<typeof setHtmlTextRasterGroup>[0]
    const group = {}
    setHtmlTextRasterGroup(node, group)
    expect(htmlTextRasterGroup(node)).toBe(GROUP_RASTER_SUPPORTED ? group : undefined)
    ;(globalThis as { __narrative_noGroupRaster?: boolean }).__narrative_noGroupRaster = true
    expect(htmlTextRasterGroup(node)).toBeUndefined()
    delete (globalThis as { __narrative_noGroupRaster?: boolean }).__narrative_noGroupRaster
    setHtmlTextRasterGroup(node, null)
    expect(htmlTextRasterGroup(node)).toBeUndefined()
  })
})
