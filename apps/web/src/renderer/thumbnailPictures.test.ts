// @vitest-environment node
/**
 * renderer/thumbnailPictures.test.ts — the thumbnail renderer's shared
 * pictures: one load per url, refcounted, kept within a pixel budget after the
 * last release, freed on destroy, a failed load not kept.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('pixi.js', () => ({ Texture: { EMPTY: { empty: true } } }))

import {
  createThumbnailPictures,
  currentThumbnailPictures,
  withThumbnailPictures,
} from './thumbnailPictures.js'

interface FakeTexture {
  url: string
  destroyed: boolean
  destroy: () => void
  source: { pixelWidth: number; pixelHeight: number }
}

function harness(px = 100) {
  const loads: string[] = []
  const textures: FakeTexture[] = []
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()
  const load = (url: string) => {
    loads.push(url)
    return new Promise((resolve, reject) => {
      const texture: FakeTexture = {
        url,
        destroyed: false,
        destroy() {
          this.destroyed = true
        },
        source: { pixelWidth: px, pixelHeight: 1 },
      }
      textures.push(texture)
      pending.set(url, { resolve: () => resolve(texture), reject })
    })
  }
  return { loads, textures, pending, load: load as never }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createThumbnailPictures', () => {
  it('loads a url once for every thumbnail that draws it', async () => {
    const h = harness()
    const pictures = createThumbnailPictures({ load: h.load })
    const a = pictures.acquire('u1')
    const b = pictures.acquire('u1')
    h.pending.get('u1')!.resolve()
    expect(await a).toBe(await b)
    pictures.release('u1')
    pictures.release('u1')
    // Kept after the last release: the next slide's acquire loads nothing.
    await pictures.acquire('u1')
    expect(h.loads).toEqual(['u1'])
    expect(h.textures[0]!.destroyed).toBe(false)
  })

  it('frees the oldest unused pictures beyond the pixel budget, never one in use', async () => {
    const h = harness(100)
    const pictures = createThumbnailPictures({ load: h.load, keepUnusedPx: 250 })
    for (const url of ['a', 'b', 'c', 'd']) {
      const p = pictures.acquire(url)
      h.pending.get(url)!.resolve()
      await p
    }
    pictures.release('a')
    pictures.release('b')
    pictures.release('c')
    // 300 px unused > 250: the oldest (a) goes; d is in use and stays.
    expect(h.textures.map((t) => t.destroyed)).toEqual([true, false, false, false])
    // b used again: out of the unused list, so c is the next to go.
    await pictures.acquire('b')
    pictures.release('d')
    expect(h.textures.map((t) => t.destroyed)).toEqual([true, false, false, false])
    expect(pictures.size).toBe(3)
  })

  it('keeps a picture released before it loaded within the budget', async () => {
    const h = harness(100)
    const pictures = createThumbnailPictures({ load: h.load, keepUnusedPx: 0 })
    const p = pictures.acquire('a')
    pictures.release('a')
    h.pending.get('a')!.resolve()
    await p
    // Unused and over a budget of 0: freed as it lands.
    expect(h.textures[0]!.destroyed).toBe(true)
    expect(pictures.size).toBe(0)
  })

  it('does not keep a failed load: the next acquire tries again', async () => {
    const h = harness()
    const pictures = createThumbnailPictures({ load: h.load })
    const p = pictures.acquire('a')
    h.pending.get('a')!.reject(new Error('404'))
    await expect(p).rejects.toThrow('404')
    const again = pictures.acquire('a')
    h.pending.get('a')!.resolve()
    await again
    expect(h.loads).toEqual(['a', 'a'])
  })

  it('frees everything on destroy, a load landing later too', async () => {
    const h = harness()
    const pictures = createThumbnailPictures({ load: h.load })
    const a = pictures.acquire('a')
    h.pending.get('a')!.resolve()
    await a
    const late = pictures.acquire('late')
    pictures.destroy()
    expect(h.textures[0]!.destroyed).toBe(true)
    h.pending.get('late')!.resolve()
    await expect(late).rejects.toThrow('gone')
    await tick()
    expect(h.textures[1]!.destroyed).toBe(true)
    await expect(pictures.acquire('b')).rejects.toThrow('gone')
  })

  it('is current only while a mount runs', () => {
    const pictures = createThumbnailPictures({ load: harness().load })
    expect(currentThumbnailPictures()).toBeNull()
    const seen = withThumbnailPictures(pictures, () => currentThumbnailPictures())
    expect(seen).toBe(pictures)
    expect(currentThumbnailPictures()).toBeNull()
  })
})
