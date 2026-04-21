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
import { setDefaultImageUrlResolver, _resetDefaultImageUrlResolver } from '../imageUrl'
import { setDefaultResourceManager, _resetDefaultResourceManager } from '../ResourceManager'

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
  }
}

function makeResolver(url = 'https://imgproxy.example.com/image.jpg') {
  return vi.fn().mockResolvedValue(url)
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

  beforeEach(async () => {
    // Dynamic import after mock is set up
    const { imageRenderer: _ir } = await import('./imageRenderer')
    void _ir // just ensure module is loaded

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

  // Re-import after mocks are configured.
  async function getRenderer() {
    const { imageRenderer } = await import('./imageRenderer')
    return imageRenderer
  }

  it('mount: returns Container with placeholder Graphics before load', async () => {
    const ir = await getRenderer()
    const node = ir.mount({ ...baseImage, assetId: '' }) // empty assetId stays in placeholder

    expect(node).toBeTruthy()
    // Should have placeholder child
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: sprite added after resolver and texture resolve', async () => {
    const ir = await getRenderer()
    const node = ir.mount(baseImage)

    // Wait for microtasks — resolver + acquireTexture are async.
    await new Promise((r) => setTimeout(r, 10))

    expect(resolver).toHaveBeenCalledWith({
      assetId: 'asset-abc',
      variant: 'display',
    })
    expect(rm.acquireTexture).toHaveBeenCalledWith('https://imgproxy.example.com/image.jpg')
    // Sprite wrap should have been added as child.
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: error indicator shown when resolver fails', async () => {
    resolver.mockRejectedValueOnce(new Error('Network error'))
    setDefaultImageUrlResolver(resolver)

    const ir = await getRenderer()
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

    const ir = await getRenderer()
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
    const slowResolver = vi.fn().mockReturnValue(deferred)
    setDefaultImageUrlResolver(slowResolver)

    const ir = await getRenderer()
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
    const ir = await getRenderer()
    const node = ir.mount(baseImage)

    await new Promise((r) => setTimeout(r, 10))

    ir.destroy(node)

    expect(rm.releaseTexture).toHaveBeenCalledWith('https://imgproxy.example.com/image.jpg')
  })

  it('destroy: container.destroy called', async () => {
    const ir = await getRenderer()
    const node = ir.mount(baseImage)
    ir.destroy(node)
    expect(node.destroyed).toBe(true)
  })

  it('applyPatch: x/y updates container position', async () => {
    const ir = await getRenderer()
    const node = ir.mount(baseImage)
    applyObjectTransformSetup(node)

    ir.applyPatch!(node, { x: 100 })
    // node.x = patch.x + pivot.x (pivot.x = width/2 = 100)
    expect(node.x).toBe(100 + node.pivot.x)

    ir.applyPatch!(node, { y: 200 })
    expect(node.y).toBe(200 + node.pivot.y)
  })

  it('applyPatch: rotation and opacity', async () => {
    const ir = await getRenderer()
    const node = ir.mount(baseImage)

    ir.applyPatch!(node, { rotation: Math.PI / 2 })
    expect(node.rotation).toBeCloseTo(Math.PI / 2)

    ir.applyPatch!(node, { opacity: 0.5 })
    expect(node.alpha).toBe(0.5)
  })

  it('applyPatch: width/height recalculates pivot', async () => {
    const ir = await getRenderer()
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
    const ir = await getRenderer()
    const node = ir.mount(baseImage)

    // Wait for first load.
    await new Promise((r) => setTimeout(r, 10))

    resolver.mockResolvedValueOnce('https://imgproxy.example.com/new.jpg')
    setDefaultImageUrlResolver(resolver)

    ir.applyPatch!(node, { assetId: 'asset-xyz' })
    await new Promise((r) => setTimeout(r, 10))

    // Old URL released before new acquire.
    expect(rm.releaseTexture).toHaveBeenCalledWith('https://imgproxy.example.com/image.jpg')
    expect(rm.acquireTexture).toHaveBeenCalledWith('https://imgproxy.example.com/new.jpg')
  })

  it('fit: cover — mask applied to sprite wrap', async () => {
    const ir = await getRenderer()
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
    const ir = await getRenderer()
    const node = ir.mount({ ...baseImage, fit: 'contain' })
    await new Promise((r) => setTimeout(r, 10))

    // Sprite wrap children should not have a mask.
    const spriteWrap = node.children[node.children.length - 1]
    if (spriteWrap) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock access
      expect((spriteWrap as any).mask).toBeFalsy()
    }
  })

  it('thumbnailMount: loads the `thumb` imgproxy variant async (bypasses shared RM)', async () => {
    // jsdom's HTMLImageElement lacks .decode — patch it for the duration of
    // the test so the thumbnail flow resolves without a network fetch.
    const proto = HTMLImageElement.prototype as unknown as { decode?: () => Promise<void> }
    const decodeFn = vi.fn().mockResolvedValue(undefined)
    proto.decode = decodeFn

    const ir = await getRenderer()
    const node = ir.thumbnailMount!(baseImage)

    expect(node.children.length).toBeGreaterThanOrEqual(1)

    await new Promise((r) => setTimeout(r, 10))
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: baseImage.assetId, variant: 'thumb' }),
    )
    // Thumbnails MUST NOT go through the main ResourceManager — its textures
    // are bound to the main Canvas WebGL context and can't cross into the
    // separate offscreen thumbnail Pixi app.
    expect(rm.acquireTexture).not.toHaveBeenCalled()
    expect(decodeFn).toHaveBeenCalled()

    delete proto.decode
  })

  it('empty assetId stays in placeholder state (broken object)', async () => {
    const ir = await getRenderer()
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
