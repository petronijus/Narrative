/**
 * test/pixiMock.ts
 *
 * Shared Pixi.js mock factory for renderer + UI tests that exercise code
 * importing from `pixi.js`. Returns an object suitable for `vi.mock` to
 * spread:
 *
 *   import { pixiMock } from '../test/pixiMock'
 *   vi.mock('pixi.js', () => pixiMock())
 *
 * Why centralized: tests live alongside the file they cover and each used
 * to declare its own inline Pixi mock. Adding a new Pixi export to the
 * source (e.g. HTMLText for rich-text rendering) silently broke every
 * test mock that hadn't kept up — which is exactly how the codebase ended
 * up with ~120 tests failing on `Cannot read properties of undefined`
 * (mocks lacked `node.scale`, `node.position`) or
 * `No "HTMLText" export is defined`. One source of truth fixes that.
 *
 * Mock semantics:
 *  - MockContainer mimics enough of @pixi/display to make scene-graph
 *    reconciliation tests pass: addChild/removeChild, destroy, x/y/rotation/
 *    alpha/scale/position/pivot with `set()` writers.
 *  - Drawing-API mocks (Graphics, HTMLText) are `vi.fn().mockReturnThis()`
 *    so callers chain through .clear().rect().fill().stroke()… without
 *    needing each method individually.
 *  - Texture and Sprite are minimal data carriers — sufficient for
 *    asserting "this URL was acquired", not for actual GPU upload.
 *
 * If your test needs a method that's missing here, add it to the mock —
 * don't fork.
 */

import { vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock surface
type AnyObj = Record<string, any>

// ---------------------------------------------------------------------------
// Container & friends
// ---------------------------------------------------------------------------

function makePoint(initial = 0) {
  return {
    x: initial,
    y: initial,
    // Pixi's ObservablePoint.set(x, y = x): one argument sets both.
    set: vi.fn(function (this: { x: number; y: number }, x: number, y: number = x) {
      this.x = x
      this.y = y
    }),
  }
}

class MockContainer {
  // Public layout state — written by both source code and tests.
  children: MockContainer[] = []
  destroyed = false
  x = 0
  y = 0
  rotation = 0
  alpha = 1
  width = 0
  height = 0
  visible = true
  // applyFlip / applyObjectTransform read these as ObservablePoints; a
  // {x, y, set} mock is enough — tests inspect resulting numeric values,
  // not the live ObservablePoint API surface.
  // Pixi's containers start unscaled (1, 1), not collapsed.
  scale = makePoint(1)
  position = makePoint()
  pivot = makePoint()
  filters: unknown[] = []
  mask: unknown = null
  parent: MockContainer | null = null
  label = ''

  addChild(child: MockContainer): MockContainer {
    this.children.push(child)
    child.parent = this
    return child
  }

  addChildAt(child: MockContainer, index: number): MockContainer {
    this.children.splice(index, 0, child)
    child.parent = this
    return child
  }

  removeChild(child: MockContainer): MockContainer {
    this.children = this.children.filter((c) => c !== child)
    child.parent = null
    return child
  }

  removeChildAt(index: number): MockContainer | undefined {
    const removed = this.children.splice(index, 1)[0]
    if (removed) removed.parent = null
    return removed
  }

  setChildIndex(child: MockContainer, index: number): void {
    const cur = this.children.indexOf(child)
    if (cur === -1) return
    this.children.splice(cur, 1)
    this.children.splice(index, 0, child)
  }

  getChildIndex(child: MockContainer): number {
    return this.children.indexOf(child)
  }

  toGlobal(point: { x: number; y: number }): { x: number; y: number } {
    return { x: point.x + this.x, y: point.y + this.y }
  }

  // Inverse of toGlobal — used by SceneGraph.getBounds to project world
  // corners back into the object's local space when rotation is non-zero.
  // Tests assert exact AABB values for rotated objects, so we implement
  // the affine math here rather than returning the input unchanged.
  toLocal(
    worldPoint: { x: number; y: number },
    _fromContainer?: unknown,
    outPoint?: { x: number; y: number },
  ): { x: number; y: number } {
    const dx = worldPoint.x - this.x
    const dy = worldPoint.y - this.y
    const cos = Math.cos(-this.rotation)
    const sin = Math.sin(-this.rotation)
    const localX = dx * cos - dy * sin + this.pivot.x
    const localY = dx * sin + dy * cos + this.pivot.y
    const result = outPoint ?? { x: 0, y: 0 }
    result.x = localX
    result.y = localY
    return result
  }

  // Pixi v8 Container.getBounds returns a Bounds object with
  // {minX,minY,maxX,maxY,width,height,rectangle}. SceneGraph.hitTest reads
  // .rectangle to do a simple AABB pre-check before per-object precise hit.
  // Tests expect this to reflect the (mock) container's width/height.
  getBounds(): {
    minX: number
    minY: number
    maxX: number
    maxY: number
    width: number
    height: number
    rectangle: { x: number; y: number; width: number; height: number }
  } {
    const w = this.width || 0
    const h = this.height || 0
    return {
      minX: this.x,
      minY: this.y,
      maxX: this.x + w,
      maxY: this.y + h,
      width: w,
      height: h,
      rectangle: { x: this.x, y: this.y, width: w, height: h },
    }
  }

  destroy(_opts?: unknown): void {
    this.destroyed = true
    for (const child of this.children) child.destroy()
  }
}

class MockGraphics extends MockContainer {
  // Full Pixi v8 Graphics chainable API surface used across the codebase.
  clear = vi.fn().mockReturnThis()
  rect = vi.fn().mockReturnThis()
  ellipse = vi.fn().mockReturnThis()
  circle = vi.fn().mockReturnThis()
  roundRect = vi.fn().mockReturnThis()
  poly = vi.fn().mockReturnThis()
  moveTo = vi.fn().mockReturnThis()
  lineTo = vi.fn().mockReturnThis()
  closePath = vi.fn().mockReturnThis()
  fill = vi.fn().mockReturnThis()
  stroke = vi.fn().mockReturnThis()
  cut = vi.fn().mockReturnThis()
  setStrokeStyle = vi.fn().mockReturnThis()
  beginPath = vi.fn().mockReturnThis()
}

class MockText extends MockContainer {
  text: string
  style: AnyObj
  anchor = makePoint()

  constructor(opts: AnyObj = {}) {
    super()
    this.text = (opts['text'] as string) ?? ''
    this.style = (opts['style'] as AnyObj) ?? {}
  }
}

// HTMLText is the Pixi v8 SVG-rasterised rich-text class that textRenderer
// uses for kerning/wrap fidelity. Tests don't exercise its async raster
// pipeline — they only need the class to exist + the same MockContainer
// surface so addChild on a slide tree doesn't blow up.
class MockHTMLText extends MockContainer {
  text: string
  style: AnyObj
  anchor = makePoint()
  // Pipeline reads `_gpuData[uid].texturePromise` to decide whether to
  // wait for the SVG raster — return undefined so collectHtmlTextPromises
  // sees nothing to await.

  _gpuData: AnyObj = {}

  constructor(opts: AnyObj = {}) {
    super()
    this.text = (opts['text'] as string) ?? ''
    this.style = (opts['style'] as AnyObj) ?? {}
  }
}

class MockSprite extends MockContainer {
  texture: AnyObj
  // Sprite has its own width/height that override Container's; many tests
  // assert these directly (poster sizing in videoRenderer, etc.).
  override width = 100
  override height = 100
  anchor = makePoint()

  constructor(texture: AnyObj = { width: 100, height: 100, source: null, destroyed: false }) {
    super()
    this.texture = texture
  }
}

// ---------------------------------------------------------------------------
// Style + texture data carriers
// ---------------------------------------------------------------------------

class MockTextStyle {
  fontFamily?: string
  fontSize?: number
  fontWeight?: string
  fill?: string | number
  align?: string
  wordWrap?: boolean
  wordWrapWidth?: number

  constructor(opts: AnyObj = {}) {
    Object.assign(this, opts)
  }
}

class MockHTMLTextStyle extends MockTextStyle {}

const MockTexture = {
  EMPTY: { width: 0, height: 0, source: null, destroyed: false, destroy: vi.fn() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock source
  from: vi.fn((src: any) => {
    // Each from() call returns a distinct object so ResourceManager tests
    // can assert per-URL identity without aliasing across cache entries.
    // destroy() is a per-texture spy so refcount tests can verify
    // teardown happens at refCount === 0.
    return {
      width: 400,
      height: 225,
      source: src,
      destroyed: false,
      destroy: vi.fn(function (this: { destroyed: boolean }) {
        this.destroyed = true
      }),
    }
  }),
}

class MockVideoSource {
  resource: AnyObj
  autoPlay: boolean
  destroyed = false
  constructor(opts: AnyObj = {}) {
    this.resource = opts['resource']
    this.autoPlay = (opts['autoPlay'] as boolean | undefined) ?? false
  }
}

// ---------------------------------------------------------------------------
// Filter mocks — videoRenderer / imageRenderer apply them but tests don't
// inspect post-filter rendering. Plain class with destroy() is enough.
// ---------------------------------------------------------------------------

class MockFilter {
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}

class MockBlurFilter extends MockFilter {}

// ---------------------------------------------------------------------------
// Misc geometry / matrix
// ---------------------------------------------------------------------------

class MockPoint {
  x: number
  y: number
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }
  set(x: number, y: number): void {
    this.x = x
    this.y = y
  }
  copyTo(p: { x: number; y: number }): { x: number; y: number } {
    p.x = this.x
    p.y = this.y
    return p
  }
}

class MockMatrix {
  a = 1
  b = 0
  c = 0
  d = 1
  tx = 0
  ty = 0
  identity(): this {
    return this
  }
}

// ---------------------------------------------------------------------------
// Renderer / Application — tests rarely need a real renderer but do
// instantiate Application and read renderer.uid in HTMLText raster code.
// ---------------------------------------------------------------------------

const mockRenderer = {
  uid: 1,
  render: vi.fn(),
  resize: vi.fn(),
  extract: { base64: vi.fn().mockResolvedValue('data:image/png;base64,STUB') },
  destroy: vi.fn(),
}

const MockApplication = vi.fn().mockImplementation(() => ({
  init: vi.fn().mockResolvedValue(undefined),
  stage: new MockContainer(),
  renderer: mockRenderer,
  destroy: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

// HTMLText's font state (renderer/pixiFontSink.ts writes the face keys here).
const mockAssetCache = new Map<string, unknown>()
const MockCache = {
  has: (key: string) => mockAssetCache.has(key),
  get: (key: string) => mockAssetCache.get(key),
  set: (key: string, value: unknown) => void mockAssetCache.set(key, value),
  remove: (key: string) => void mockAssetCache.delete(key),
}
const MockFontStylePromiseCache = new Map<string, Promise<string>>()

export function pixiMock(): Record<string, unknown> {
  return {
    Cache: MockCache,
    FontStylePromiseCache: MockFontStylePromiseCache,
    Container: MockContainer,
    Graphics: MockGraphics,
    Text: MockText,
    HTMLText: MockHTMLText,
    Sprite: MockSprite,
    Texture: MockTexture,
    VideoSource: MockVideoSource,
    TextStyle: MockTextStyle,
    HTMLTextStyle: MockHTMLTextStyle,
    Application: MockApplication,
    Point: MockPoint,
    Matrix: MockMatrix,
    Filter: MockFilter,
    BlurFilter: MockBlurFilter,
    // Assets module — videoRenderer / imageRenderer sometimes call
    // Assets.load. Resolve to an empty texture so the call chain doesn't
    // throw; specific tests that care provide their own resolver.
    Assets: {
      load: vi.fn().mockResolvedValue(MockTexture.EMPTY),
      unload: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      add: vi.fn(),
    },
    // CanvasTextMetrics is consulted by the text-bounds path; the only
    // method exercised in source code is measureText.
    CanvasTextMetrics: {
      measureText: vi.fn(() => ({ width: 100, height: 20 })),
    },
    // BindGroup is referenced through Pixi internals; tests don't construct
    // one but the import must resolve.
    BindGroup: vi.fn(),
  }
}
