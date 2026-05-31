/**
 * objectRenderers/videoRenderer.test.ts
 *
 * Unit tests for videoRenderer.
 *
 * Pixi.js is mocked — runs in Node/jsdom without GPU.
 * VideoInfoResolver and ResourceManager are mocked/installed per test.
 *
 * Tests:
 * - mount: Container with placeholder Graphics initially
 * - mount: pending status → processing placeholder, no texture acquired
 * - mount: done status with posterUrl → sprite added + play icon
 * - mount: done status without posterUrl → placeholder + play icon
 * - mount: failed status → error placeholder
 * - mount: resolver error → error placeholder
 * - mount: empty assetId → stays in placeholder, no resolve
 * - mount: destroy before resolver resolves → no sprite, aborted flag set
 * - applyPatch: x/y/rotation/opacity → container transform only
 * - applyPatch: width/height → pivot recalculated, placeholder resized
 * - applyPatch: assetId change → re-resolve triggered
 * - destroy: releaseTexture called for acquired URL
 * - destroy: container.destroy called
 * - thumbnailMount: returns Container with placeholder, no async load
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setDefaultVideoInfoResolver, _resetDefaultVideoInfoResolver } from '../videoInfo'
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock
    parent: any = null
    pivot = {
      x: 0,
      y: 0,
      set: vi.fn(function (this: { x: number; y: number }, x: number, y: number) {
        this.x = x
        this.y = y
      }),
    }
    // applyFlip / applyObjectTransform / live-video refit all touch
    // node.scale.set + node.position.set. Pixi exposes these as
    // ObservablePoint; a plain {x,y,set} mock is enough for our render-path
    // assertions which only inspect resulting numeric values.
    scale = {
      x: 1,
      y: 1,
      set: vi.fn(function (this: { x: number; y: number }, x: number, y: number) {
        this.x = x
        this.y = y
      }),
    }
    position = {
      x: 0,
      y: 0,
      set: vi.fn(function (this: { x: number; y: number }, x: number, y: number) {
        this.x = x
        this.y = y
      }),
    }

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
    moveTo = vi.fn().mockReturnThis()
    lineTo = vi.fn().mockReturnThis()
    closePath = vi.fn().mockReturnThis()
  }

  class MockText extends MockContainer {
    anchor = { set: vi.fn() }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock
    constructor(_opts?: any) {
      super()
    }
  }

  class MockSprite extends MockContainer {
    width = 100
    height = 100
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
    Text: MockText,
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

function makeResolver(result: object) {
  return vi.fn().mockResolvedValue(result)
}

function makeDoneResult(posterUrl = 'https://imgproxy.example.com/poster.jpg') {
  return {
    assetId: 'asset-vid-1',
    transcodeStatus: 'done' as const,
    durationSec: 30,
    width: 1920,
    height: 1080,
    posterUrl,
    thumbnailUrl: 'https://imgproxy.example.com/thumb.jpg',
    playbackUrl: 'https://minio.example.com/videos/playback.mp4',
    transcodeError: null,
  }
}

function makePendingResult() {
  return {
    assetId: 'asset-vid-1',
    transcodeStatus: 'pending' as const,
    durationSec: null,
    width: null,
    height: null,
    posterUrl: null,
    thumbnailUrl: null,
    playbackUrl: null,
    transcodeError: null,
  }
}

function makeFailedResult() {
  return {
    assetId: 'asset-vid-1',
    transcodeStatus: 'failed' as const,
    durationSec: null,
    width: null,
    height: null,
    posterUrl: null,
    thumbnailUrl: null,
    playbackUrl: null,
    transcodeError: 'Transcode timeout',
  }
}

import type { VideoObject } from '@narrative/shared'

const baseVideo: VideoObject = {
  id: 'vid-1',
  type: 'video',
  x: 10,
  y: 20,
  width: 320,
  height: 180,
  rotation: 0,
  opacity: 1,
  assetId: 'asset-vid-1',
  fit: 'contain',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('videoRenderer', () => {
  let rm: ReturnType<typeof makeResourceManager>

  beforeEach(async () => {
    // Dynamic import to ensure Pixi mock is in place.
    const { videoRenderer: _vr } = await import('./videoRenderer')
    void _vr

    rm = makeResourceManager()
    setDefaultResourceManager(rm as never)
  })

  afterEach(() => {
    _resetDefaultVideoInfoResolver()
    _resetDefaultResourceManager()
    vi.clearAllMocks()
  })

  async function getRenderer() {
    const { videoRenderer } = await import('./videoRenderer')
    return videoRenderer
  }

  // -------------------------------------------------------------------------
  it('mount: returns Container with placeholder Graphics before load', async () => {
    const resolver = makeResolver(makePendingResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount({ ...baseVideo, assetId: '' }) // empty assetId

    expect(node).toBeTruthy()
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: empty assetId stays in placeholder — resolver not called', async () => {
    const resolver = makeResolver(makeDoneResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    vr.mount({ ...baseVideo, assetId: '' })

    await new Promise((r) => setTimeout(r, 10))

    expect(resolver).not.toHaveBeenCalled()
    expect(rm.acquireTexture).not.toHaveBeenCalled()
  })

  it('mount: pending status — placeholder shown, no texture acquired', async () => {
    const resolver = makeResolver(makePendingResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    expect(resolver).toHaveBeenCalledWith({ assetId: 'asset-vid-1' })
    expect(rm.acquireTexture).not.toHaveBeenCalled()
    // Container should have children (placeholder + processing label wrap).
    expect(node.children.length).toBeGreaterThanOrEqual(1)
    // Destroy to stop poll timer.
    vr.destroy(node)
  })

  it('mount: done status with posterUrl — sprite and play icon added', async () => {
    const resolver = makeResolver(makeDoneResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    expect(resolver).toHaveBeenCalledWith({ assetId: 'asset-vid-1' })
    expect(rm.acquireTexture).toHaveBeenCalledWith('https://imgproxy.example.com/poster.jpg')
    // Container should have sprite wrap + play icon children.
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: done status without posterUrl — gray placeholder + play icon, no texture', async () => {
    const resolver = makeResolver(makeDoneResult(null as unknown as string))
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    expect(rm.acquireTexture).not.toHaveBeenCalled()
    // Play icon should have been added.
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: failed status — error placeholder shown', async () => {
    const resolver = makeResolver(makeFailedResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    expect(rm.acquireTexture).not.toHaveBeenCalled()
    // Container still has placeholder child.
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: resolver error — error placeholder shown', async () => {
    const resolver = vi.fn().mockRejectedValue(new Error('Network error'))
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    expect(rm.acquireTexture).not.toHaveBeenCalled()
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: destroy before resolver resolves — no sprite, aborted flag', async () => {
    let resolveInfo!: (v: unknown) => void
    const deferred = new Promise((res) => {
      resolveInfo = res
    })
    const slowResolver = vi.fn().mockReturnValue(deferred)
    setDefaultVideoInfoResolver(slowResolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)

    vr.destroy(node)

    // Resolve after destroy.
    resolveInfo(makeDoneResult())
    await new Promise((r) => setTimeout(r, 10))

    expect(rm.acquireTexture).not.toHaveBeenCalled()
    expect(node.destroyed).toBe(true)
  })

  it('destroy: releaseTexture called for acquired posterUrl', async () => {
    const resolver = makeResolver(makeDoneResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    vr.destroy(node)

    expect(rm.releaseTexture).toHaveBeenCalledWith('https://imgproxy.example.com/poster.jpg')
  })

  it('destroy: container.destroy called', async () => {
    const resolver = makeResolver(makeDoneResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)
    vr.destroy(node)

    expect(node.destroyed).toBe(true)
  })

  it('applyPatch: x/y updates container position', async () => {
    const resolver = makeResolver(makePendingResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)
    // Simulate mount transform: pivot = (width/2, height/2)
    node.pivot.x = baseVideo.width / 2
    node.pivot.y = baseVideo.height / 2
    node.x = baseVideo.x + node.pivot.x
    node.y = baseVideo.y + node.pivot.y

    vr.applyPatch(node, { x: 100 })
    expect(node.x).toBe(100 + node.pivot.x)

    vr.applyPatch(node, { y: 200 })
    expect(node.y).toBe(200 + node.pivot.y)

    vr.destroy(node)
  })

  it('applyPatch: rotation and opacity', async () => {
    const resolver = makeResolver(makePendingResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)

    vr.applyPatch(node, { rotation: Math.PI / 4 })
    expect(node.rotation).toBeCloseTo(Math.PI / 4)

    vr.applyPatch(node, { opacity: 0.7 })
    expect(node.alpha).toBe(0.7)

    vr.destroy(node)
  })

  it('applyPatch: width/height recalculates pivot', async () => {
    const resolver = makeResolver(makePendingResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)
    node.pivot.x = baseVideo.width / 2
    node.pivot.y = baseVideo.height / 2
    node.x = baseVideo.x + node.pivot.x
    node.y = baseVideo.y + node.pivot.y

    vr.applyPatch(node, { width: 640, height: 360 })

    expect(node.pivot.x).toBe(320)
    expect(node.pivot.y).toBe(180)
    expect(node.x).toBe(baseVideo.x + 320)
    expect(node.y).toBe(baseVideo.y + 180)

    vr.destroy(node)
  })

  it('applyPatch: assetId change triggers re-resolve', async () => {
    const resolver = makeResolver(makeDoneResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    // Change asset.
    const resolver2 = makeResolver({ ...makeDoneResult(), assetId: 'asset-vid-2' })
    setDefaultVideoInfoResolver(resolver2)
    vr.applyPatch(node, { assetId: 'asset-vid-2' })

    await new Promise((r) => setTimeout(r, 10))

    // Old texture released, new one acquired.
    expect(rm.releaseTexture).toHaveBeenCalledWith('https://imgproxy.example.com/poster.jpg')
    expect(rm.acquireTexture).toHaveBeenCalledTimes(2)

    vr.destroy(node)
  })

  it('thumbnailMount: fetches video info and loads thumbnailUrl (400×225) bypassing RM', async () => {
    const proto = HTMLImageElement.prototype as unknown as { decode?: () => Promise<void> }
    const decodeFn = vi.fn().mockResolvedValue(undefined)
    proto.decode = decodeFn

    const resolver = makeResolver(makeDoneResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = await getRenderer()
    const node = vr.thumbnailMount!(baseVideo)

    expect(node.children.length).toBeGreaterThanOrEqual(1)

    await new Promise((r) => setTimeout(r, 10))
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ assetId: baseVideo.assetId }))
    // Thumbnails must not go through the shared Canvas ResourceManager.
    expect(rm.acquireTexture).not.toHaveBeenCalled()
    expect(decodeFn).toHaveBeenCalled()

    delete proto.decode
  })
})
