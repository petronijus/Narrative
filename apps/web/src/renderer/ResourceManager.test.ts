/**
 * renderer/ResourceManager.test.ts
 *
 * Unit testy pro ResourceManager lifecycle — ref counting, acquire/release, destroyAll.
 *
 * Pixi.js Assets.load() je mockován — testy nebyly spouštěny v browser env
 * a nepotřebují GPU. Mock vrací minimal Texture-like objekt s destroy() spy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock pixi.js Assets před importem ResourceManager
vi.mock('pixi.js', () => {
  const makeTexture = () => ({
    destroy: vi.fn(),
    label: '',
    // Non-null source so acquireTexture does not fall through to the
    // HTMLImageElement.decode() fallback (jsdom has no .decode).
    source: { _mock: true },
  })

  return {
    Assets: {
      load: vi.fn().mockImplementation(async (_url: string) => makeTexture()),
      unload: vi.fn().mockResolvedValue(undefined),
    },
    Texture: { from: vi.fn(() => makeTexture()) },
  }
})

import { ResourceManager } from './ResourceManager'
import { Assets } from 'pixi.js'

describe('ResourceManager', () => {
  let rm: ResourceManager

  beforeEach(() => {
    rm = new ResourceManager()
    vi.clearAllMocks()
  })

  it('acquireTexture načte texturu a vrátí ji', async () => {
    const texture = await rm.acquireTexture('https://example.com/img.png')
    expect(texture).toBeDefined()
    expect(Assets.load).toHaveBeenCalledWith('https://example.com/img.png')
  })

  it('acquireTexture vrátí cachouvanou texturu při druhém volání', async () => {
    const t1 = await rm.acquireTexture('https://example.com/img.png')
    const t2 = await rm.acquireTexture('https://example.com/img.png')

    expect(t1).toBe(t2)
    // Assets.load by měl být volán jen jednou
    expect(Assets.load).toHaveBeenCalledTimes(1)
  })

  it('ref count se správně inkrementuje', async () => {
    await rm.acquireTexture('https://example.com/img.png')
    expect(rm.getRefCount('https://example.com/img.png')).toBe(1)

    await rm.acquireTexture('https://example.com/img.png')
    expect(rm.getRefCount('https://example.com/img.png')).toBe(2)
  })

  it('releaseTexture dekrementuje ref count', async () => {
    await rm.acquireTexture('https://example.com/img.png')
    await rm.acquireTexture('https://example.com/img.png')

    rm.releaseTexture('https://example.com/img.png')
    expect(rm.getRefCount('https://example.com/img.png')).toBe(1)
  })

  it('releaseTexture při refCount=0 zničí texturu', async () => {
    const texture = await rm.acquireTexture('https://example.com/img.png')

    rm.releaseTexture('https://example.com/img.png')

    expect(texture.destroy).toHaveBeenCalledWith(true)
    expect(rm.textureCount).toBe(0)
  })

  it('releaseTexture při refCount=0 odstraní texturu z interní mapy', async () => {
    await rm.acquireTexture('https://example.com/img.png')
    rm.releaseTexture('https://example.com/img.png')

    expect(rm.getRefCount('https://example.com/img.png')).toBe(0)
    expect(rm.textureCount).toBe(0)
  })

  it('releaseTexture na neexistující URL je no-op', () => {
    expect(() => rm.releaseTexture('https://example.com/nonexistent.png')).not.toThrow()
  })

  it('destroyAll zničí všechny spravované textury', async () => {
    const t1 = await rm.acquireTexture('https://example.com/a.png')
    const t2 = await rm.acquireTexture('https://example.com/b.png')

    rm.destroyAll()

    expect(t1.destroy).toHaveBeenCalledWith(true)
    expect(t2.destroy).toHaveBeenCalledWith(true)
    expect(rm.textureCount).toBe(0)
  })

  it('destroyAll na prázdném manageru je no-op', () => {
    expect(() => rm.destroyAll()).not.toThrow()
    expect(rm.textureCount).toBe(0)
  })

  it('textureCount vrací správný počet spravovaných textur', async () => {
    expect(rm.textureCount).toBe(0)

    await rm.acquireTexture('https://example.com/a.png')
    expect(rm.textureCount).toBe(1)

    await rm.acquireTexture('https://example.com/b.png')
    expect(rm.textureCount).toBe(2)

    rm.releaseTexture('https://example.com/a.png')
    expect(rm.textureCount).toBe(1)
  })
})
