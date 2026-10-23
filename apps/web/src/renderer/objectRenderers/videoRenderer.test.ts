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
import { attachLiveVideo, releaseLiveVideoElement, videoRenderer } from './videoRenderer'

/** Every VideoSource the renderer made (the mock's), in order. */
const videoSources = vi.hoisted(
  () =>
    [] as Array<{
      resource: HTMLVideoElement
      autoUpdate: boolean
      destroyed: boolean
      unload: ReturnType<typeof import('vitest').vi.fn>
      destroy: () => void
    }>,
)

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

  class MockTexture {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock source
    static from = vi.fn((src: any) => ({ width: 400, height: 225, source: src, destroyed: false }))
    width = 1920
    height = 1080
    destroyed = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock source
    source: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock source
    constructor(opts: { source: any }) {
      this.source = opts.source
    }
    destroy(destroySource = false): void {
      this.destroyed = true
      if (destroySource) this.source.destroy()
    }
  }

  // As Pixi's: destroying it stops its element and empties its src.
  class MockVideoSource {
    resource: HTMLVideoElement
    autoUpdate = true
    destroyed = false
    unload = vi.fn()
    constructor(opts: { resource: HTMLVideoElement }) {
      this.resource = opts.resource
      videoSources.push(this)
    }
    destroy(): void {
      this.destroyed = true
      this.resource.pause()
      this.resource.removeAttribute('src')
    }
  }

  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    Sprite: MockSprite,
    Text: MockText,
    Application: vi.fn(),
    Texture: MockTexture,
    VideoSource: MockVideoSource,
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

  beforeEach(() => {
    rm = makeResourceManager()
    setDefaultResourceManager(rm as never)
  })

  afterEach(() => {
    _resetDefaultVideoInfoResolver()
    _resetDefaultResourceManager()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  it('mount: returns Container with placeholder Graphics before load', async () => {
    const resolver = makeResolver(makePendingResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = videoRenderer
    const node = vr.mount({ ...baseVideo, assetId: '' }) // empty assetId

    expect(node).toBeTruthy()
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: empty assetId stays in placeholder — resolver not called', async () => {
    const resolver = makeResolver(makeDoneResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = videoRenderer
    vr.mount({ ...baseVideo, assetId: '' })

    await new Promise((r) => setTimeout(r, 10))

    expect(resolver).not.toHaveBeenCalled()
    expect(rm.acquireTexture).not.toHaveBeenCalled()
  })

  it('mount: pending status — placeholder shown, no texture acquired', async () => {
    const resolver = makeResolver(makePendingResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = videoRenderer
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

    const vr = videoRenderer
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    expect(resolver).toHaveBeenCalledWith({ assetId: 'asset-vid-1' })
    expect(rm.acquireTexture).toHaveBeenCalledWith(
      'https://imgproxy.example.com/poster.jpg',
      expect.anything(),
    )
    // Container should have sprite wrap + play icon children.
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: done status without posterUrl — gray placeholder + play icon, no texture', async () => {
    const resolver = makeResolver(makeDoneResult(null as unknown as string))
    setDefaultVideoInfoResolver(resolver)

    const vr = videoRenderer
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    expect(rm.acquireTexture).not.toHaveBeenCalled()
    // Play icon should have been added.
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: failed status — error placeholder shown', async () => {
    const resolver = makeResolver(makeFailedResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = videoRenderer
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    expect(rm.acquireTexture).not.toHaveBeenCalled()
    // Container still has placeholder child.
    expect(node.children.length).toBeGreaterThanOrEqual(1)
  })

  it('mount: resolver error — error placeholder shown', async () => {
    const resolver = vi.fn().mockRejectedValue(new Error('Network error'))
    setDefaultVideoInfoResolver(resolver)

    const vr = videoRenderer
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

    const vr = videoRenderer
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

    const vr = videoRenderer
    const node = vr.mount(baseVideo)

    await new Promise((r) => setTimeout(r, 10))

    vr.destroy(node)

    expect(rm.releaseTexture).toHaveBeenCalledWith('https://imgproxy.example.com/poster.jpg')
  })

  it('destroy: container.destroy called', async () => {
    const resolver = makeResolver(makeDoneResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = videoRenderer
    const node = vr.mount(baseVideo)
    vr.destroy(node)

    expect(node.destroyed).toBe(true)
  })

  it('applyPatch: x/y updates container position', async () => {
    const resolver = makeResolver(makePendingResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = videoRenderer
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

    const vr = videoRenderer
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

    const vr = videoRenderer
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

    const vr = videoRenderer
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

  describe('a live video (present mode attaches its buffered element at mount)', () => {
    function playingElement(): HTMLVideoElement {
      const el = document.createElement('video')
      el.setAttribute('src', 'https://s/playback.mp4')
      vi.spyOn(el, 'pause').mockImplementation(() => undefined)
      return el
    }
    /** Whether the container draws `el` (a sprite over its VideoSource). */
    const draws = (node: unknown, el: HTMLVideoElement): boolean => {
      const walk = (c: { children?: unknown[]; texture?: { source?: unknown } }): boolean =>
        c.texture?.source !== undefined &&
        (c.texture.source as { resource?: unknown }).resource === el
          ? !(c as { destroyed?: boolean }).destroyed
          : (c.children ?? []).some((k) => walk(k as typeof c))
      return walk(node as never)
    }

    // Its own object id per test: the renderer's registry is module-wide.
    let n = 0
    let live: typeof baseVideo
    beforeEach(() => {
      videoSources.length = 0
      live = { ...baseVideo, id: `vid-live-${++n}` }
    })

    it('keeps showing when the video info lands after it: no poster over it', async () => {
      setDefaultVideoInfoResolver(makeResolver(makeDoneResult()))
      const el = playingElement()
      const node = videoRenderer.mount(live)
      attachLiveVideo(live.id, el)
      await new Promise((r) => setTimeout(r, 10))
      expect(rm.acquireTexture).not.toHaveBeenCalled()
      expect(draws(node, el)).toBe(true)
      videoRenderer.destroy(node)
    })

    it('wins over a poster still loading when it was attached', async () => {
      setDefaultVideoInfoResolver(makeResolver(makeDoneResult()))
      let landPoster!: (t: unknown) => void
      rm.acquireTexture.mockImplementation(() => new Promise((r) => (landPoster = r)))
      const el = playingElement()
      const node = videoRenderer.mount(live)
      await new Promise((r) => setTimeout(r, 10))
      expect(rm.acquireTexture).toHaveBeenCalledTimes(1)
      attachLiveVideo(live.id, el)
      landPoster(makeTexture())
      await new Promise((r) => setTimeout(r, 10))
      expect(rm.releaseTexture).toHaveBeenCalledWith('https://imgproxy.example.com/poster.jpg')
      expect(draws(node, el)).toBe(true)
      videoRenderer.destroy(node)
    })

    it('a torn-down scene leaves the element as it is; one source for every scene', async () => {
      setDefaultVideoInfoResolver(makeResolver(makeDoneResult()))
      const el = playingElement()
      // Two scenes of the slide (the one on stage and one prepared off stage).
      const a = videoRenderer.mount(live)
      const b = videoRenderer.mount(live)
      attachLiveVideo(live.id, el)
      expect(videoSources).toHaveLength(1)
      expect(draws(a, el) && draws(b, el)).toBe(true)

      videoRenderer.destroy(a)
      expect(el.getAttribute('src')).toBe('https://s/playback.mp4')
      expect(el.pause).not.toHaveBeenCalled()
      expect(videoSources[0]!.unload).not.toHaveBeenCalled()
      expect(draws(b, el)).toBe(true)

      // The last scene gone: off the GPU, no longer following frames, the element still whole.
      videoRenderer.destroy(b)
      expect(videoSources[0]!.unload).toHaveBeenCalledTimes(1)
      expect(videoSources[0]!.autoUpdate).toBe(false)
      expect(el.getAttribute('src')).toBe('https://s/playback.mp4')

      // A scene built again draws the same element through the same source.
      const c = videoRenderer.mount(live)
      attachLiveVideo(live.id, el)
      expect(videoSources).toHaveLength(1)
      expect(videoSources[0]!.autoUpdate).toBe(true)
      videoRenderer.destroy(c)

      // Its owner lets go of the element: the source goes with it.
      releaseLiveVideoElement(el)
      expect(videoSources[0]!.destroyed).toBe(true)
    })
  })

  it('thumbnailMount: fetches video info and loads thumbnailUrl (400×225) bypassing RM', async () => {
    const proto = HTMLImageElement.prototype as unknown as { decode?: () => Promise<void> }
    const decodeFn = vi.fn().mockResolvedValue(undefined)
    proto.decode = decodeFn

    const resolver = makeResolver(makeDoneResult())
    setDefaultVideoInfoResolver(resolver)

    const vr = videoRenderer
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
