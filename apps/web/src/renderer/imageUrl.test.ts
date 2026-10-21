/**
 * renderer/imageUrl.test.ts — the batched signed-URL resolver
 * (GET /api/media/urls; performance.md → L3).
 *
 * - every asset asked for within one task goes out in one request, ids
 *   sorted, with the screen variants (and any other variant asked for);
 * - the answer fills the cache of every variant it holds (later asks, an
 *   upgrade, `peek` need no request), and the asset's size (`asset`);
 * - asks while a request is in flight share it;
 * - more than MEDIA_URLS_MAX_IDS assets go out in several requests;
 * - an unavailable asset, a failed request and an answer without `assets`
 *   reject, and drop their entries so the next ask retries;
 * - a share token's answers are not served to another token;
 * - credentials and the render page's cap; the default-resolver lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MEDIA_URLS_MAX_IDS, type MediaUrlsResponse } from '@narrative/shared'
import {
  createImageUrlResolver,
  setDefaultImageUrlResolver,
  getDefaultImageUrlResolver,
  _resetDefaultImageUrlResolver,
  setImageVariantCap,
} from './imageUrl'

/** What the server signs: `https://img.test/<variant>/<id>`. */
function answer(url: string, unavailable: readonly string[] = []): MediaUrlsResponse {
  const u = new URL(url, 'http://page.test')
  const ids = (u.searchParams.get('ids') ?? '').split(',')
  const variants = (u.searchParams.get('variants') ?? '').split(',')
  const out: MediaUrlsResponse = { assets: {}, unavailable: [] }
  for (const id of ids) {
    if (unavailable.includes(id)) {
      out.unavailable.push(id)
      continue
    }
    out.assets[id] = {
      urls: Object.fromEntries(variants.map((v) => [v, `https://img.test/${v}/${id}`])),
      width: 3000,
      height: 2000,
    }
  }
  return out
}

function serverFetch(opts: { unavailable?: string[]; status?: number } = {}) {
  return vi.fn(async (url: string) => {
    const status = opts.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer(url, opts.unavailable),
    } as Response
  })
}

const calls = (): string[] =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
const query = (url: string) => new URL(url, 'http://page.test').searchParams

describe('createImageUrlResolver', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', serverFetch())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves every asset asked for in one task with one request, ids sorted, the screen variants included', async () => {
    const resolver = createImageUrlResolver('https://api.example.com')
    const [b, a, c] = await Promise.all([
      resolver({ assetId: 'b', variant: 'display' }),
      resolver({ assetId: 'a', variant: 'preview' }),
      resolver({ assetId: 'c' }),
    ])
    expect([a, b, c]).toEqual([
      'https://img.test/preview/a',
      'https://img.test/display/b',
      'https://img.test/display/c',
    ])
    expect(calls()).toHaveLength(1)
    const [url] = calls()
    expect(url).toMatch(/^https:\/\/api\.example\.com\/api\/media\/urls\?/)
    expect(query(url!).get('ids')).toBe('a,b,c')
    expect(query(url!).get('variants')).toBe('preview,medium,display')
  })

  it('caches every variant of the answer and the size: later asks, peek and asset need no request', async () => {
    const resolver = createImageUrlResolver('')
    await resolver({ assetId: 'a', variant: 'preview' })
    expect(resolver.peek('a', 'medium')).toBe('https://img.test/medium/a')
    expect(await resolver({ assetId: 'a', variant: 'display' })).toBe('https://img.test/display/a')
    expect(await resolver.asset('a')).toEqual({ assetId: 'a', width: 3000, height: 2000 })
    expect(calls()).toHaveLength(1)
    expect(resolver.peek('b', 'medium')).toBeUndefined()
  })

  it('shares a request in flight with what asks meanwhile', async () => {
    const resolver = createImageUrlResolver('')
    const first = resolver.asset('a')
    await new Promise((r) => setTimeout(r, 0)) // the request is out
    const [size, url] = await Promise.all([first, resolver({ assetId: 'a', variant: 'medium' })])
    expect(size.width).toBe(3000)
    expect(url).toBe('https://img.test/medium/a')
    expect(calls()).toHaveLength(1)
  })

  it('adds thumb or original to the request when asked for', async () => {
    const resolver = createImageUrlResolver('')
    await Promise.all([
      resolver({ assetId: 'a', variant: 'thumb' }),
      resolver({ assetId: 'b', variant: 'original' }),
    ])
    expect(query(calls()[0]!).get('variants')).toBe('thumb,preview,medium,display,original')
  })

  it('prefetches many assets in batches of MEDIA_URLS_MAX_IDS', async () => {
    const resolver = createImageUrlResolver('')
    const ids = Array.from({ length: MEDIA_URLS_MAX_IDS + 5 }, (_, i) => `id${i}`)
    await resolver.prefetch([...ids, ...ids, ''])
    expect(calls()).toHaveLength(2)
    const asked = calls().flatMap((u) => query(u).get('ids')!.split(','))
    expect(new Set(asked)).toEqual(new Set(ids))
    // A second prefetch of the same deck asks nothing.
    await resolver.prefetch(ids)
    expect(calls()).toHaveLength(2)
  })

  it('sends credentials so the session cookie travels', async () => {
    const resolver = createImageUrlResolver('')
    await resolver({ assetId: 'a' })
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(init.credentials).toBe('include')
  })

  it('rejects an unavailable asset, resolves the rest, and retries it on the next ask', async () => {
    vi.stubGlobal('fetch', serverFetch({ unavailable: ['gone'] }))
    const resolver = createImageUrlResolver('')
    const [ok, gone] = await Promise.allSettled([
      resolver({ assetId: 'ok' }),
      resolver({ assetId: 'gone' }),
    ])
    expect(ok).toMatchObject({ status: 'fulfilled', value: 'https://img.test/display/ok' })
    expect(gone).toMatchObject({ status: 'rejected' })
    await expect(resolver.asset('gone')).rejects.toThrow(/not available/)
    expect(calls()).toHaveLength(2)
  })

  it('rejects on a failed request and retries afterwards', async () => {
    vi.stubGlobal('fetch', serverFetch({ status: 500 }))
    const resolver = createImageUrlResolver('')
    await expect(resolver({ assetId: 'a' })).rejects.toThrow(/HTTP 500/)
    await expect(resolver.asset('a')).rejects.toThrow(/HTTP 500/)

    vi.stubGlobal('fetch', serverFetch())
    expect(await resolver({ assetId: 'a' })).toBe('https://img.test/display/a')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("keeps one share link's answers from another: a new token starts a fresh cache", async () => {
    const before = window.location.href
    try {
      window.history.replaceState({}, '', '/deck/d1?share_token=tok-a')
      const resolver = createImageUrlResolver('')
      await resolver({ assetId: 'a' })
      window.history.replaceState({}, '', '/deck/d2?share_token=tok-b')
      expect(resolver.peek('a', 'display')).toBeUndefined()
      await resolver({ assetId: 'a' })
      expect(calls().map((u) => query(u).get('share_token'))).toEqual(['tok-a', 'tok-b'])
    } finally {
      window.history.replaceState({}, '', before)
    }
  })

  it("rejects an answer without 'assets'", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ url: 'x' }) }) as Response),
    )
    const resolver = createImageUrlResolver('')
    await expect(resolver({ assetId: 'a' })).rejects.toThrow(/missing 'assets'/)
  })
})

describe('default resolver lifecycle', () => {
  beforeEach(() => {
    _resetDefaultImageUrlResolver()
  })

  it('getDefaultImageUrlResolver throws before setDefaultImageUrlResolver is called', () => {
    expect(() => getDefaultImageUrlResolver()).toThrow(/No default resolver installed/)
  })

  it('returns the installed resolver after setDefaultImageUrlResolver', () => {
    const resolver = createImageUrlResolver('')
    setDefaultImageUrlResolver(resolver)
    expect(getDefaultImageUrlResolver()).toBe(resolver)
  })

  it('replaces resolver on second setDefaultImageUrlResolver call', () => {
    const r1 = createImageUrlResolver('')
    const r2 = createImageUrlResolver('')
    setDefaultImageUrlResolver(r1)
    setDefaultImageUrlResolver(r2)
    expect(getDefaultImageUrlResolver()).toBe(r2)
  })
})

describe('setImageVariantCap', () => {
  afterEach(() => {
    setImageVariantCap(null)
    vi.unstubAllGlobals()
  })

  it('serves nothing larger than the cap while it is set, and the asked variant after', async () => {
    vi.stubGlobal('fetch', serverFetch())
    const resolve = createImageUrlResolver('')
    setImageVariantCap('preview')
    expect(await resolve({ assetId: 'a1' })).toBe('https://img.test/preview/a1')
    expect(await resolve({ assetId: 'a1', variant: 'original' })).toBe(
      'https://img.test/preview/a1',
    )
    expect(await resolve({ assetId: 'a1', variant: 'thumb' })).toBe('https://img.test/thumb/a1')
    expect(resolve.peek('a1', 'display')).toBe('https://img.test/preview/a1')
    setImageVariantCap(null)
    expect(await resolve({ assetId: 'a1', variant: 'display' })).toBe('https://img.test/display/a1')
  })
})
