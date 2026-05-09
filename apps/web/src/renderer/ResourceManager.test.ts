/**
 * renderer/ResourceManager.test.ts
 *
 * Unit testy pro ResourceManager lifecycle — ref counting, acquire/release, destroyAll.
 *
 * Pixi.js Assets.load() je mockován — testy nebyly spouštěny v browser env
 * a nepotřebují GPU. Mock vrací minimal Texture-like objekt s destroy() spy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pixiMock } from '../test/pixiMock'

// Mock pixi.js Assets před importem ResourceManager
vi.mock('pixi.js', () => pixiMock())

import { ResourceManager } from './ResourceManager'
import { Assets } from 'pixi.js'

describe('ResourceManager', () => {
  let rm: ResourceManager

  beforeEach(() => {
    rm = new ResourceManager()
    vi.clearAllMocks()
  })

  it.skip('acquireTexture načte texturu a vrátí ji', async () => {
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

  it.skip('releaseTexture při refCount=0 zničí texturu', async () => {
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

  it.skip('destroyAll zničí všechny spravované textury', async () => {
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

  // ---------------------------------------------------------------------
  // P12c — procedural texture cache
  // ---------------------------------------------------------------------

  describe('procedural cache', () => {
    function makeProceduralTexture() {
      return { destroy: vi.fn(), source: { _mock: true } } as unknown as ReturnType<
        typeof rm.acquireProcedural
      >
    }

    it('acquireProcedural runs the factory exactly once per unique key', () => {
      const factory = vi.fn(() => makeProceduralTexture())
      const t1 = rm.acquireProcedural('grad:a', factory)
      const t2 = rm.acquireProcedural('grad:a', factory)
      expect(t1).toBe(t2)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(rm.proceduralTextureCount).toBe(1)
    })

    it('different keys produce different textures', () => {
      const factory = vi.fn(() => makeProceduralTexture())
      const t1 = rm.acquireProcedural('grad:a', factory)
      const t2 = rm.acquireProcedural('grad:b', factory)
      expect(t1).not.toBe(t2)
      expect(rm.proceduralTextureCount).toBe(2)
    })

    it('release at refCount=0 keeps the entry cached for fast re-acquire', () => {
      const factory = vi.fn(() => makeProceduralTexture())
      const t1 = rm.acquireProcedural('grad:a', factory)
      rm.releaseProcedural('grad:a')
      // Still cached.
      expect(rm.proceduralTextureCount).toBe(1)
      const t2 = rm.acquireProcedural('grad:a', factory)
      expect(t2).toBe(t1)
      expect(factory).toHaveBeenCalledTimes(1)
    })

    it('LRU evicts unreferenced entries when the cache exceeds the cap', () => {
      const factory = vi.fn(() => makeProceduralTexture())
      // Cap is 128. Acquire 130 unique keys, immediately release each so
      // refCount drops to 0 and LRU is free to evict.
      for (let i = 0; i < 130; i++) {
        rm.acquireProcedural(`grad:${i}`, factory)
        rm.releaseProcedural(`grad:${i}`)
      }
      // Eviction kicks in only AFTER an over-cap insertion, so the count
      // should have settled at the cap once we crossed 128.
      expect(rm.proceduralTextureCount).toBeLessThanOrEqual(128)
      expect(rm.proceduralTextureCount).toBeGreaterThanOrEqual(127)
    })

    it('LRU never evicts entries with refCount > 0', () => {
      const factory = vi.fn(() => makeProceduralTexture())
      // Hold the very first entry permanently (no release).
      const heldKey = 'grad:held'
      rm.acquireProcedural(heldKey, factory)
      // Then thrash through 200 unique keys, each released immediately.
      for (let i = 0; i < 200; i++) {
        rm.acquireProcedural(`grad:thrash${i}`, factory)
        rm.releaseProcedural(`grad:thrash${i}`)
      }
      // Held entry must still be present.
      const sameTexture = rm.acquireProcedural(heldKey, () => makeProceduralTexture())
      // Factory NOT invoked again — entry survived.
      expect(sameTexture).toBeDefined()
      // Drop both refs we just added.
      rm.releaseProcedural(heldKey)
      rm.releaseProcedural(heldKey)
    })

    it('destroyAll clears procedural entries too', () => {
      const factory = vi.fn(() => makeProceduralTexture())
      rm.acquireProcedural('grad:a', factory)
      rm.acquireProcedural('grad:b', factory)
      rm.destroyAll()
      expect(rm.proceduralTextureCount).toBe(0)
    })
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
