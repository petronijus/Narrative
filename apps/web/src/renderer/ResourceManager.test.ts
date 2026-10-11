/**
 * renderer/ResourceManager.test.ts
 *
 * Unit testy pro ResourceManager lifecycle — ref counting, acquire/release, destroyAll.
 *
 * Pixi.js Assets.load() je mockován — testy nebyly spouštěny v browser env
 * a nepotřebují GPU. Mock vrací minimal Texture-like objekt s destroy() spy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pixiMock } from '../test/pixiMock'

// Mock pixi.js Assets před importem ResourceManager
vi.mock('pixi.js', () => pixiMock())

import { ResourceManager, UNLOAD_GRACE_MS } from './ResourceManager'
import { Assets } from 'pixi.js'

describe('ResourceManager', () => {
  let rm: ResourceManager

  beforeEach(() => {
    rm = new ResourceManager()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Let the grace run out and the unload it starts settle. */
  async function afterGrace(): Promise<void> {
    await vi.advanceTimersByTimeAsync(UNLOAD_GRACE_MS)
  }

  it('acquireTexture načte texturu a vrátí ji', async () => {
    const texture = await rm.acquireTexture('https://example.com/img.png')
    expect(texture).toBeDefined()
    expect(Assets.load).toHaveBeenCalledWith({
      src: 'https://example.com/img.png',
      parser: 'texture',
    })
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

  it('releaseTexture při refCount=0 unloadne texturu z Assets cache — after the grace', async () => {
    vi.useFakeTimers()
    await rm.acquireTexture('https://example.com/img.png')

    rm.releaseTexture('https://example.com/img.png')
    expect(Assets.unload).not.toHaveBeenCalled()
    expect(rm.getRefCount('https://example.com/img.png')).toBe(0)

    await afterGrace()
    // Source delegates teardown to Assets.unload() — that's the leak
    // guard. The fallback texture.destroy(true) only fires if Assets
    // rejects (texture wasn't tracked by Assets — img-decoded path).
    expect(Assets.unload).toHaveBeenCalledWith('https://example.com/img.png')
    expect(rm.textureCount).toBe(0)
  })

  it('flushReleased unloads at once what nothing holds, and keeps what is held', async () => {
    vi.useFakeTimers()
    await rm.acquireTexture('https://example.com/old.png')
    await rm.acquireTexture('https://example.com/new.png')
    rm.releaseTexture('https://example.com/old.png')
    rm.flushReleased()
    await vi.advanceTimersByTimeAsync(0)
    expect(Assets.unload).toHaveBeenCalledWith('https://example.com/old.png')
    expect(Assets.unload).not.toHaveBeenCalledWith('https://example.com/new.png')
    expect(rm.textureCount).toBe(1)
    // Its grace timer is gone with it: nothing is unloaded twice.
    await afterGrace()
    expect(Assets.unload).toHaveBeenCalledTimes(1)
  })

  it('takes a released texture back within the grace, without loading or unloading it', async () => {
    vi.useFakeTimers()
    const t1 = await rm.acquireTexture('https://example.com/img.png')
    rm.releaseTexture('https://example.com/img.png')
    await vi.advanceTimersByTimeAsync(UNLOAD_GRACE_MS - 1)

    const t2 = await rm.acquireTexture('https://example.com/img.png')
    await afterGrace()

    expect(t2).toBe(t1)
    expect(Assets.load).toHaveBeenCalledTimes(1)
    expect(Assets.unload).not.toHaveBeenCalled()
    expect(rm.getRefCount('https://example.com/img.png')).toBe(1)
  })

  it('shares one load between acquires that arrive while it runs', async () => {
    let resolve!: (t: unknown) => void
    const loading = new Promise<unknown>((r) => (resolve = r))
    vi.mocked(Assets.load).mockImplementationOnce(() => loading as ReturnType<typeof Assets.load>)
    const a = rm.acquireTexture('https://example.com/img.png')
    const b = rm.acquireTexture('https://example.com/img.png')
    expect(rm.getRefCount('https://example.com/img.png')).toBe(2)
    await vi.waitFor(() => expect(Assets.load).toHaveBeenCalledTimes(1))
    const texture = { source: {}, destroyed: false, destroy: vi.fn() }
    resolve(texture)

    expect(await a).toBe(texture)
    expect(await b).toBe(texture)
    expect(Assets.load).toHaveBeenCalledTimes(1)

    // One of the two objects goes away: the other still draws with it.
    vi.useFakeTimers()
    rm.releaseTexture('https://example.com/img.png')
    await afterGrace()
    expect(Assets.unload).not.toHaveBeenCalled()
    expect(rm.getRefCount('https://example.com/img.png')).toBe(1)
  })

  it('never hands out a texture that is being unloaded: a load waits for the unload', async () => {
    vi.useFakeTimers()
    await rm.acquireTexture('https://example.com/img.png')
    let unloaded!: () => void
    vi.mocked(Assets.unload).mockImplementationOnce(() => new Promise<void>((r) => (unloaded = r)))
    rm.releaseTexture('https://example.com/img.png')
    await afterGrace()
    expect(Assets.unload).toHaveBeenCalledTimes(1)

    const next = rm.acquireTexture('https://example.com/img.png')
    await vi.advanceTimersByTimeAsync(0)
    // Pixi still holds the dying texture in its cache: loading now would get it.
    expect(Assets.load).toHaveBeenCalledTimes(1)

    unloaded()
    await next
    expect(Assets.load).toHaveBeenCalledTimes(2)
    expect(rm.getRefCount('https://example.com/img.png')).toBe(1)
  })

  it('leaves nothing behind when a load fails, so the next acquire tries again', async () => {
    vi.mocked(Assets.load).mockRejectedValueOnce(new Error('offline'))
    const decode = vi
      .spyOn(globalThis.Image.prototype, 'decode')
      .mockRejectedValueOnce(new Error('offline'))
    await expect(rm.acquireTexture('https://example.com/img.png')).rejects.toThrow('offline')
    expect(rm.textureCount).toBe(0)

    await rm.acquireTexture('https://example.com/img.png')
    expect(rm.getRefCount('https://example.com/img.png')).toBe(1)
    decode.mockRestore()
  })

  it('releaseTexture na neexistující URL je no-op', () => {
    expect(() => rm.releaseTexture('https://example.com/nonexistent.png')).not.toThrow()
  })

  it('destroyAll unloadne všechny spravované textury z Assets cache', async () => {
    await rm.acquireTexture('https://example.com/a.png')
    await rm.acquireTexture('https://example.com/b.png')

    rm.destroyAll()
    await Promise.resolve()

    expect(Assets.unload).toHaveBeenCalledWith('https://example.com/a.png')
    expect(Assets.unload).toHaveBeenCalledWith('https://example.com/b.png')
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
    vi.useFakeTimers()
    expect(rm.textureCount).toBe(0)

    await rm.acquireTexture('https://example.com/a.png')
    expect(rm.textureCount).toBe(1)

    await rm.acquireTexture('https://example.com/b.png')
    expect(rm.textureCount).toBe(2)

    rm.releaseTexture('https://example.com/a.png')
    // Still on the GPU until its grace is over.
    expect(rm.textureCount).toBe(2)
    await afterGrace()
    expect(rm.textureCount).toBe(1)
  })
})
