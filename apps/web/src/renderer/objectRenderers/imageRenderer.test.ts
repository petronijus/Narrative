/**
 * objectRenderers/imageRenderer.test.ts
 *
 * Unit tests for imageRenderer.
 *
 * Pixi.js is mocked — tests run in Node/jsdom without GPU.
 * ResourceManager and imageUrl resolver are mocked/installed before each test.
 *
 * Tests:
 * - mount: Container with placeholder Graphics initially
 * - mount: Sprite added after resolver + texture resolve
 * - mount: Error indicator shown when resolver fails
 * - mount: Error indicator shown when acquireTexture fails
 * - mount: destroy before resolver resolves → no sprite added (aborted flag)
 * - applyPatch: x/y/rotation/opacity → container transform only
 * - applyPatch: width/height → pivot recalculated, placeholder resized
 * - applyPatch: assetId change → re-load triggered
 * - applyPatch: fit change → applyFit + mask applied
 * - destroy: releaseTexture called for acquired URL
 * - destroy: container.destroy called
 * - fit: cover — mask applied to sprite wrap
 * - fit: contain — no mask
 * - thumbnailMount: returns Container with placeholder, no async load
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  setDefaultImageUrlResolver,
  _resetDefaultImageUrlResolver,
  type ImageUrlResolver,
} from '../imageUrl'
import { setDefaultResourceManager, _resetDefaultResourceManager } from '../ResourceManager'
import { imageRenderer } from './imageRenderer'
import { withPixelDensity } from '../pixelDensityContext'

// ---------------------------------------------------------------------------
// Pixi.js mock
// ---------------------------------------------------------------------------

vi.mock('pixi.js', () => {
  class MockContainer {
    children: MockContainer[] = []
    destroyed = false
    x = 0
    y = 0
    rotation = 0
    alpha = 1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock
    mask: any = null
    pivot = {
      x: 0,
      y: 0,
      set: vi.fn(function (this: { x: number; y: number }, x: number, y: number) {
        this.x = x
        this.y = y
      }),
    }
    scale = { set: vi.fn() }

    addChild(child: MockContainer): MockContainer {
      this.children.push(child)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock
      ;(child as any).parent = this
      return child
    }

    removeChild(child: MockContainer): MockContainer {
      this.children = this.children.filter((c) => c !== child)
      return child
    }

    destroy(_opts?: unknown): void {
      this.destroyed = true
      for (const child of this.children) {
        child.destroy()
      }
    }
  }

  class MockGraphics extends MockContainer {
    clear = vi.fn().mockReturnThis()
    rect = vi.fn().mockReturnThis()
    fill = vi.fn().mockReturnThis()
    stroke = vi.fn().mockReturnThis()
    circle = vi.fn().mockReturnThis()
  }

  class MockSprite extends MockContainer {
    width = 0
    height = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock texture
    texture: any

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock texture
    constructor(texture: any) {
      super()
      this.texture = texture
    }
  }

  const MockTexture = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock source
    from: vi.fn((src: any) => ({ width: 400, height: 225, source: src, destroyed: false })),
  }

  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    Sprite: MockSprite,
    Application: vi.fn(),
    Texture: MockTexture,
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTexture(w = 400, h = 300) {
  return { width: w, height: h, destroyed: false }
}

function makeResourceManager(texture = makeTexture()) {
  return {
    acquireTexture: vi.fn().mockResolvedValue(texture),
    releaseTexture: vi.fn(),
    hasTexture: vi.fn().mockReturnValue(false),
  }
}

/** A resolver (imageUrl.ts) around `fn`: the source is 3000 × 2000 unless `size` says. */
function asResolver(
  fn: ReturnType<typeof vi.fn>,
  size: { width: number | null; height: number | null } = { width: 3000, height: 2000 },
) {
  return Object.assign(fn, {
    asset: vi.fn(async (assetId: string) => ({ assetId, ...size })),
    prefetch: vi.fn(async () => undefined),
    peek: vi.fn((assetId: string, variant: string) => `https://img.test/${variant}/${assetId}`),
  }) as unknown as ReturnType<typeof vi.fn> & ImageUrlResolver
}

function makeResolver(url = 'https://imgproxy.example.com/image.jpg') {
  return asResolver(vi.fn().mockResolvedValue(url))
}

/** A resolver whose URLs name the variant: `https://img.test/<variant>/<id>`. */
function variantResolver() {
  return asResolver(
    vi.fn(async ({ assetId, variant }: { assetId: string; variant?: string }) => {
      return `https://img.test/${variant ?? 'display'}/${assetId}`
    }),
  )
}

import type { ImageObject } from '@narrative/shared'

const baseImage: ImageObject = {
  id: 'img-1',
  type: 'image',
  x: 10,
  y: 20,
  width: 200,
  height: 150,
  rotation: 0,
  opacity: 1,
  assetId: 'asset-abc',
  variant: 'display',
  fit: 'cover',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('imageRenderer', () => {
  let rm: ReturnType<typeof makeResourceManager>
  let resolver: ReturnType<typeof makeResolver>

  beforeEach(() => {
    rm = makeResourceManager()
    resolver = makeResolver()

    setDefaultResourceManager(rm as never)
    setDefaultImageUrlResolver(resolver)
  })

  afterEach(() => {
    _resetDefaultImageUrlResolver()
    _resetDefaultResourceManager()
    vi.clearAllMocks()
  })

  it('mount: returns Container with placeholder Graphics before load', async () => {
    const ir = imageRenderer
    const node = ir.mount({ ...baseImage, assetId: '' }) // empty assetId stays in placeholder

    expect(node).toBeTruthy()
    // Should have placeholder child
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: sprite added after resolver and texture resolve', async () => {
    const ir = imageRenderer
    const node = ir.mount(baseImage)

    // Wait for microtasks — resolver + acquireTexture are async.
    await new Promise((r) => setTimeout(r, 10))

    expect(resolver).toHaveBeenCalledWith({
      assetId: 'asset-abc',
      variant: 'display',
    })
    expect(rm.acquireTexture).toHaveBeenCalledWith(
      'https://imgproxy.example.com/image.jpg',
      expect.anything(),
    )
    // Sprite wrap should have been added as child.
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: error indicator shown when resolver fails', async () => {
    resolver.mockRejectedValueOnce(new Error('Network error'))
    setDefaultImageUrlResolver(resolver)

    const ir = imageRenderer
    const node = ir.mount(baseImage)

    await new Promise((r) => setTimeout(r, 10))

    // acquireTexture should NOT have been called.
    expect(rm.acquireTexture).not.toHaveBeenCalled()
    // Placeholder should still exist (now showing error).
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: error indicator shown when acquireTexture fails', async () => {
    rm.acquireTexture.mockRejectedValueOnce(new Error('GPU out of memory'))
    setDefaultResourceManager(rm as never)

    const ir = imageRenderer
    const node = ir.mount(baseImage)

    await new Promise((r) => setTimeout(r, 10))

    expect(rm.acquireTexture).toHaveBeenCalled()
    // Placeholder still present (as error indicator).
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: destroy before resolver resolves — no sprite added', async () => {
    // Use a deferred resolver so we can destroy before it resolves.
    let resolveUrl!: (url: string) => void
    const deferred = new Promise<string>((res) => {
      resolveUrl = res
    })
    const slowResolver = asResolver(vi.fn().mockReturnValue(deferred))
    setDefaultImageUrlResolver(slowResolver)

    const ir = imageRenderer
    const node = ir.mount(baseImage)

    // Destroy immediately before resolver resolves.
    ir.destroy(node)

    // Now resolve.
    resolveUrl('https://imgproxy.example.com/late.jpg')
    await new Promise((r) => setTimeout(r, 10))

    // acquireTexture must NOT have been called.
    expect(rm.acquireTexture).not.toHaveBeenCalled()
    // Container should be destroyed.
    expect(node.destroyed).toBe(true)
  })

  it('destroy: releaseTexture called for acquired URL', async () => {
    const ir = imageRenderer
    const node = ir.mount(baseImage)

    await new Promise((r) => setTimeout(r, 10))

    ir.destroy(node)

    expect(rm.releaseTexture).toHaveBeenCalledWith('https://imgproxy.example.com/image.jpg')
  })

  it('destroy: container.destroy called', async () => {
    const ir = imageRenderer
    const node = ir.mount(baseImage)
    ir.destroy(node)
    expect(node.destroyed).toBe(true)
  })

  it('applyPatch: x/y updates container position', async () => {
    const ir = imageRenderer
    const node = ir.mount(baseImage)
    applyObjectTransformSetup(node)

    ir.applyPatch!(node, { x: 100 })
    // node.x = patch.x + pivot.x (pivot.x = width/2 = 100)
    expect(node.x).toBe(100 + node.pivot.x)

    ir.applyPatch!(node, { y: 200 })
    expect(node.y).toBe(200 + node.pivot.y)
  })

  it('applyPatch: rotation and opacity', async () => {
    const ir = imageRenderer
    const node = ir.mount(baseImage)

    ir.applyPatch!(node, { rotation: Math.PI / 2 })
    expect(node.rotation).toBeCloseTo(Math.PI / 2)

    ir.applyPatch!(node, { opacity: 0.5 })
    expect(node.alpha).toBe(0.5)
  })

  it('applyPatch: width/height recalculates pivot', async () => {
    const ir = imageRenderer
    const node = ir.mount(baseImage)
    // Simulate mount transform: pivot = (width/2, height/2)
    node.pivot.set(100, 75)
    node.x = 10 + 100 // data.x + pivotX
    node.y = 20 + 75

    ir.applyPatch!(node, { width: 300, height: 200 })

    expect(node.pivot.x).toBe(150)
    expect(node.pivot.y).toBe(100)
    // x should be data.x + newPivotX
    expect(node.x).toBe(10 + 150)
    expect(node.y).toBe(20 + 100)
  })

  it('applyPatch: assetId change triggers re-load', async () => {
    const ir = imageRenderer
    const node = ir.mount(baseImage)

    // Wait for first load.
    await new Promise((r) => setTimeout(r, 10))

    resolver.mockResolvedValueOnce('https://imgproxy.example.com/new.jpg')
    setDefaultImageUrlResolver(resolver)

    ir.applyPatch!(node, { assetId: 'asset-xyz' })
    await new Promise((r) => setTimeout(r, 10))

    // Old URL released before new acquire.
    expect(rm.releaseTexture).toHaveBeenCalledWith('https://imgproxy.example.com/image.jpg')
    expect(rm.acquireTexture).toHaveBeenCalledWith(
      'https://imgproxy.example.com/new.jpg',
      expect.anything(),
    )
  })

  it('fit: cover — mask applied to sprite wrap', async () => {
    const ir = imageRenderer
    const node = ir.mount({ ...baseImage, fit: 'cover' })
    await new Promise((r) => setTimeout(r, 10))

    // Find sprite wrap (second or later child — first is placeholder).
    const spriteWrap = node.children.find((c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock access
      return (c as any).mask !== null && (c as any).mask !== undefined
    })
    expect(spriteWrap).toBeDefined()
  })

  it('fit: contain — no mask on sprite wrap', async () => {
    const ir = imageRenderer
    const node = ir.mount({ ...baseImage, fit: 'contain' })
    await new Promise((r) => setTimeout(r, 10))

    // Sprite wrap children should not have a mask.
    const spriteWrap = node.children[node.children.length - 1]
    if (spriteWrap) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock access
      expect((spriteWrap as any).mask).toBeFalsy()
    }
  })

  it('thumbnailMount: loads the `preview` imgproxy variant async (bypasses shared RM)', async () => {
    // jsdom's HTMLImageElement lacks .decode — patch it for the duration of
    // the test so the thumbnail flow resolves without a network fetch.
    const proto = HTMLImageElement.prototype as unknown as { decode?: () => Promise<void> }
    const decodeFn = vi.fn().mockResolvedValue(undefined)
    proto.decode = decodeFn

    const ir = imageRenderer
    const node = ir.thumbnailMount!(baseImage)

    expect(node.children.length).toBeGreaterThanOrEqual(1)

    await new Promise((r) => setTimeout(r, 10))
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: baseImage.assetId, variant: 'preview' }),
    )
    // Thumbnails MUST NOT go through the main ResourceManager — its textures
    // are bound to the main Canvas WebGL context and can't cross into the
    // separate offscreen thumbnail Pixi app.
    expect(rm.acquireTexture).not.toHaveBeenCalled()
    expect(decodeFn).toHaveBeenCalled()

    delete proto.decode
  })

  describe('size variant (performance.md → L3)', () => {
    const tick = () => new Promise((r) => setTimeout(r, 10))
    /** 340 × 240 of a 3000 × 2000 photo: drawn 360 × 240 under cover. */
    const small = { ...baseImage, width: 340, height: 240 }

    beforeEach(() => {
      resolver = variantResolver()
      setDefaultImageUrlResolver(resolver)
    })

    it('draws a small picture from medium, a full-width one at 2× from display', async () => {
      withPixelDensity(2, () => imageRenderer.mount(small))
      withPixelDensity(2, () =>
        imageRenderer.mount({ ...baseImage, id: 'big', assetId: 'big', width: 1920, height: 1080 }),
      )
      await tick()
      expect(rm.acquireTexture).toHaveBeenCalledWith(
        'https://img.test/medium/asset-abc',
        expect.anything(),
      )
      expect(rm.acquireTexture).toHaveBeenCalledWith(
        'https://img.test/display/big',
        expect.anything(),
      )
    })

    it('draws from display without a density (a scene that did not say), and keeps a pin', async () => {
      imageRenderer.mount(small)
      withPixelDensity(1, () =>
        imageRenderer.mount({ ...small, id: 'o', assetId: 'pinned', variant: 'original' }),
      )
      await tick()
      expect(rm.acquireTexture).toHaveBeenCalledWith(
        'https://img.test/display/asset-abc',
        expect.anything(),
      )
      expect(rm.acquireTexture).toHaveBeenCalledWith(
        'https://img.test/original/pinned',
        expect.anything(),
      )
    })

    it('takes display when the source size is unknown', async () => {
      setDefaultImageUrlResolver(asResolver(variantResolver(), { width: null, height: null }))
      withPixelDensity(1, () => imageRenderer.mount(small))
      await tick()
      expect(rm.acquireTexture).toHaveBeenCalledWith(
        'https://img.test/display/asset-abc',
        expect.anything(),
      )
    })

    it("takes the scene's floor, and a larger variant the GPU holds already", async () => {
      withPixelDensity(
        1,
        () => imageRenderer.mount(small),
        () => 'display',
      )
      await tick()
      expect(rm.acquireTexture).toHaveBeenLastCalledWith(
        'https://img.test/display/asset-abc',
        expect.anything(),
      )

      rm.hasTexture.mockImplementation((url: string) => url === 'https://img.test/display/held')
      withPixelDensity(1, () => imageRenderer.mount({ ...small, id: 'h', assetId: 'held' }))
      await tick()
      expect(rm.acquireTexture).toHaveBeenLastCalledWith(
        'https://img.test/display/held',
        expect.anything(),
      )
    })

    it('loads display when the canvas density grows past medium, and swaps it in at the same drawn size', async () => {
      rm.acquireTexture.mockImplementation(async (url: string) =>
        url.includes('/medium/') ? makeTexture(1280, 853) : makeTexture(2560, 1707),
      )
      const node = withPixelDensity(1, () => imageRenderer.mount(small))
      await tick()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock access
      const sprite = (node.children as any[])
        .flatMap((c) => c.children ?? [])
        .find((c) => c.texture)
      expect(sprite.texture.width).toBe(1280)
      sprite.width = 360
      sprite.height = 240

      // 360 × 3 = 1080 px: medium still holds it.
      imageRenderer.setCanvasDensity!(node, 3, null)
      await tick()
      expect(rm.acquireTexture).toHaveBeenCalledTimes(1)

      // 360 × 4 = 1440 px: display.
      imageRenderer.setCanvasDensity!(node, 4, null)
      await tick()
      expect(rm.acquireTexture).toHaveBeenLastCalledWith(
        'https://img.test/display/asset-abc',
        expect.anything(),
      )
      expect(sprite.texture.width).toBe(2560)
      expect([sprite.width, sprite.height]).toEqual([360, 240])
      expect(rm.releaseTexture).toHaveBeenCalledWith('https://img.test/medium/asset-abc')

      // Never back down while mounted.
      imageRenderer.setCanvasDensity!(node, 1, null)
      await tick()
      expect(rm.acquireTexture).toHaveBeenCalledTimes(2)

      imageRenderer.destroy(node)
      expect(rm.releaseTexture).toHaveBeenLastCalledWith('https://img.test/display/asset-abc')
    })

    /**
     * A ResourceManager that counts references per URL and lets the test
     * decide when display's load lands.
     */
    function countingRm() {
      const refs = new Map<string, number>()
      let landDisplay: (() => void) | null = null
      const m = {
        refs,
        land: () => landDisplay?.(),
        acquireTexture: vi.fn(async (url: string) => {
          refs.set(url, (refs.get(url) ?? 0) + 1)
          if (url.includes('/display/')) {
            await new Promise<void>((resolve) => {
              const prev = landDisplay
              landDisplay = () => {
                prev?.()
                resolve()
              }
            })
            return makeTexture(2560, 1707)
          }
          return makeTexture(1280, 853)
        }),
        releaseTexture: vi.fn((url: string) => {
          const n = refs.get(url) ?? 0
          if (n <= 0) throw new Error(`released ${url} below zero`)
          refs.set(url, n - 1)
        }),
        hasTexture: vi.fn(() => false),
      }
      return m
    }
    const held = (m: ReturnType<typeof countingRm>) =>
      [...m.refs].filter(([, n]) => n > 0).map(([url, n]) => `${url}×${n}`)

    it('two density commits during one upgrade: one display reference, medium released once', async () => {
      const m = countingRm()
      setDefaultResourceManager(m as never)
      const node = withPixelDensity(1, () => imageRenderer.mount(small))
      await tick()
      imageRenderer.setCanvasDensity!(node, 4, null)
      imageRenderer.setCanvasDensity!(node, 5, null)
      await tick()
      m.land()
      await tick()
      expect(held(m)).toEqual(['https://img.test/display/asset-abc×1'])
      imageRenderer.destroy(node)
      expect(held(m)).toEqual([])
    })

    it('an upgrade the upload gate holds back keeps the smaller variant drawn until it is admitted', async () => {
      const m = countingRm()
      setDefaultResourceManager(m as never)
      const node = withPixelDensity(1, () => imageRenderer.mount(small))
      await tick()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock access
      const sprite = (node.children as any[])
        .flatMap((c) => c.children ?? [])
        .find((c) => c.texture)
      expect(sprite.texture.width).toBe(1280)
      // The first load asked as a placeholder's picture, the upgrade as an upgrade.
      expect(m.acquireTexture).toHaveBeenNthCalledWith(1, 'https://img.test/medium/asset-abc', {
        priority: { node },
      })

      imageRenderer.setCanvasDensity!(node, 4, null)
      await tick()
      expect(m.acquireTexture).toHaveBeenLastCalledWith('https://img.test/display/asset-abc', {
        priority: { node, upgrade: true },
      })
      // Waiting in the gate (the acquire has not resolved): medium stays, no placeholder.
      await tick()
      expect(sprite.texture.width).toBe(1280)
      expect(sprite.destroyed).toBe(false)
      expect(held(m)).toEqual([
        'https://img.test/medium/asset-abc×1',
        'https://img.test/display/asset-abc×1',
      ])

      m.land()
      await tick()
      expect(sprite.texture.width).toBe(2560)
      expect(held(m)).toEqual(['https://img.test/display/asset-abc×1'])
      imageRenderer.destroy(node)
    })

    it('an upgrade that lands after the node is gone gives its reference back', async () => {
      const m = countingRm()
      setDefaultResourceManager(m as never)
      const node = withPixelDensity(1, () => imageRenderer.mount(small))
      await tick()
      imageRenderer.setCanvasDensity!(node, 4, null)
      await tick()
      imageRenderer.destroy(node)
      m.land()
      await tick()
      expect(held(m)).toEqual([])
    })

    it('an upgrade that lands after the asset changed leaves the new picture alone', async () => {
      const m = countingRm()
      setDefaultResourceManager(m as never)
      const node = withPixelDensity(1, () => imageRenderer.mount(small))
      await tick()
      imageRenderer.setCanvasDensity!(node, 4, null)
      await tick()
      imageRenderer.update(node, small, { ...small, assetId: 'other' })
      await tick()
      m.land()
      await tick()
      // At density 4 the new picture wants display too: its own load, its own reference.
      expect(held(m)).toEqual(['https://img.test/display/other×1'])
    })

    it('a reload after an applyPatch asset change chooses with the whole object (its fit)', async () => {
      const node = withPixelDensity(1, () =>
        imageRenderer.mount({ ...small, width: 1000, height: 1000, fit: 'contain' }),
      )
      await tick()
      // contain: a 3:2 photo in 1000 × 1000 is drawn 1000 wide — medium; under
      // the synthetic object's default cover it would be 1500 — display.
      imageRenderer.applyPatch!(node, { assetId: 'swapped' })
      await tick()
      expect(rm.acquireTexture).toHaveBeenLastCalledWith(
        'https://img.test/medium/swapped',
        expect.anything(),
      )
    })

    it('loads display when a resize makes the picture larger than medium holds', async () => {
      const node = withPixelDensity(1, () => imageRenderer.mount(small))
      await tick()
      imageRenderer.update(node, small, { ...small, width: 1500, height: 1000 })
      await tick()
      expect(rm.acquireTexture).toHaveBeenLastCalledWith(
        'https://img.test/display/asset-abc',
        expect.anything(),
      )
    })
  })

  it('empty assetId stays in placeholder state (broken object)', async () => {
    const ir = imageRenderer
    const node = ir.mount({ ...baseImage, assetId: '' })
    await new Promise((r) => setTimeout(r, 10))

    expect(resolver).not.toHaveBeenCalled()
    expect(rm.acquireTexture).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Helper: simulate the pivot set that mount() performs
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock type
function applyObjectTransformSetup(node: any): void {
  node.pivot.x = baseImage.width / 2
  node.pivot.y = baseImage.height / 2
  node.x = baseImage.x + node.pivot.x
  node.y = baseImage.y + node.pivot.y
}
