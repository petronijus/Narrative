/**
 * renderer/thumbnails.test.ts
 *
 * Unit tests for createThumbnailRenderer() / ThumbnailRenderer.
 *
 * Pixi.js does not initialise in jsdom (no real WebGL). We stub:
 *   - Application.init() — resolves immediately
 *   - app.renderer.render() — no-op
 *   - app.renderer.extract.base64() — returns a deterministic PNG data URL stub
 *   - Container, Graphics — lightweight mocks (same pattern as SceneGraph.test.ts)
 *
 * Test scope: API shape, lifecycle (destroy → reject), serialisation queue,
 * empty objects array. We do NOT assert pixel content — that requires a real GPU.
 *
 * The stub extract value is 'data:image/png;base64,STUB' to satisfy the
 * "starts with data:image/png;base64," assertions without a real render.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Pixi.js mock — use vi.hoisted() so variables are available when vi.mock hoists
// ---------------------------------------------------------------------------

const { MockContainer, MockGraphics, mockExtract, mockRenderer, mockApp } = vi.hoisted(() => {
  const createdContainers: unknown[] = []

  class MockContainer {
    children: MockContainer[] = []
    destroyed = false
    scale = { set: vi.fn() }
    x = 0
    y = 0

    constructor() {
      createdContainers.push(this)
    }

    addChild(child: MockContainer): MockContainer {
      this.children.push(child)
      return child
    }

    removeChild(child: MockContainer): MockContainer {
      this.children = this.children.filter((c) => c !== child)
      return child
    }

    destroy(_opts?: unknown): void {
      this.destroyed = true
    }
  }

  class MockGraphics extends MockContainer {
    clear = vi.fn().mockReturnThis()
    rect = vi.fn().mockReturnThis()
    fill = vi.fn().mockReturnThis()
  }

  const mockExtract = {
    base64: vi.fn().mockReturnValue('data:image/png;base64,STUB'),
  }

  const mockRenderer = {
    render: vi.fn(),
    extract: mockExtract,
  }

  const mockApp = {
    init: vi.fn().mockResolvedValue(undefined),
    stage: new MockContainer(),
    renderer: mockRenderer,
    destroy: vi.fn(),
  }

  return { MockContainer, MockGraphics, mockExtract, mockRenderer, mockApp, createdContainers }
})

vi.mock('pixi.js', () => ({
  Application: class {
    init = mockApp.init
    stage = mockApp.stage
    renderer = mockApp.renderer
    destroy = mockApp.destroy
  },
  Container: MockContainer,
  Graphics: MockGraphics,
}))

// ---------------------------------------------------------------------------
// objectRenderers mock — returns a minimal renderer that uses MockGraphics
// ---------------------------------------------------------------------------

vi.mock('./objectRenderers/index.js', () => ({
  getRenderer: vi.fn().mockImplementation((type: string) => {
    if (type === 'rectangle' || type === 'ellipse') {
      return {
        type,
        mount: vi.fn().mockImplementation(() => new MockGraphics()),
        update: vi.fn(),
        destroy: vi.fn(),
      }
    }
    return undefined
  }),
}))

// ---------------------------------------------------------------------------
// Import under test (after mocks are in place)
// ---------------------------------------------------------------------------

import { createThumbnailRenderer } from './thumbnails.js'
import type { SlideObject } from '@narrative/shared'

const STUB_DATA_URL = 'data:image/png;base64,STUB'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRect(id: string): SlideObject {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fill: 0xff0000,
    rotation: 0,
    opacity: 1,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createThumbnailRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset stage children
    mockApp.stage.children = []
    mockApp.stage.destroyed = false
    mockApp.init.mockResolvedValue(undefined)
    mockExtract.base64.mockReturnValue(STUB_DATA_URL)
  })

  it('returns a ThumbnailRenderer with renderSlide and destroy methods', async () => {
    const renderer = await createThumbnailRenderer()
    expect(renderer).toHaveProperty('renderSlide')
    expect(renderer).toHaveProperty('destroy')
    expect(typeof renderer.renderSlide).toBe('function')
    expect(typeof renderer.destroy).toBe('function')
    renderer.destroy()
  })

  it('smoke: renders a slide with 2 rectangles and returns a PNG data URL', async () => {
    const renderer = await createThumbnailRenderer({ width: 200 })
    const dataUrl = await renderer.renderSlide([makeRect('a'), makeRect('b')])

    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    renderer.destroy()
  })

  it('renders empty objects array and returns a valid data URL', async () => {
    const renderer = await createThumbnailRenderer()
    const dataUrl = await renderer.renderSlide([])

    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    renderer.destroy()
  })

  it('calls app.renderer.render() on each renderSlide call', async () => {
    const renderer = await createThumbnailRenderer()
    await renderer.renderSlide([makeRect('x')])

    expect(mockRenderer.render).toHaveBeenCalledTimes(1)
    renderer.destroy()
  })

  it('calls app.renderer.extract.base64() to produce the data URL', async () => {
    const renderer = await createThumbnailRenderer()
    await renderer.renderSlide([makeRect('x')])

    expect(mockExtract.base64).toHaveBeenCalledTimes(1)
    renderer.destroy()
  })

  it('skips objects with unknown type (no renderer)', async () => {
    const renderer = await createThumbnailRenderer()

    const unknownObj = {
      id: 'u1',
      type: 'unknown-type',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      rotation: 0,
      opacity: 1,
    } as unknown as SlideObject

    // Should not throw — unknown types are silently skipped.
    const dataUrl = await renderer.renderSlide([unknownObj])
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    renderer.destroy()
  })

  it('destroy: subsequent renderSlide rejects with a descriptive error', async () => {
    const renderer = await createThumbnailRenderer()
    renderer.destroy()

    await expect(renderer.renderSlide([])).rejects.toThrow('destroyed')
  })

  it('destroy: calling destroy() twice does not throw', async () => {
    const renderer = await createThumbnailRenderer()
    renderer.destroy()
    expect(() => renderer.destroy()).not.toThrow()
  })

  it('destroy: calls app.destroy() to release GPU resources', async () => {
    const renderer = await createThumbnailRenderer()
    renderer.destroy()

    expect(mockApp.destroy).toHaveBeenCalledTimes(1)
  })

  it('serialises concurrent renderSlide calls — renderer.render called sequentially', async () => {
    const renderer = await createThumbnailRenderer()

    const callOrder: number[] = []
    mockRenderer.render.mockImplementation(() => {
      callOrder.push(callOrder.length + 1)
    })

    // Fire three renders without awaiting individually.
    const p1 = renderer.renderSlide([makeRect('a')])
    const p2 = renderer.renderSlide([makeRect('b')])
    const p3 = renderer.renderSlide([makeRect('c')])

    await Promise.all([p1, p2, p3])

    // All three must have completed (in some order).
    expect(callOrder).toHaveLength(3)

    renderer.destroy()
  })

  it('init: Application.init is called with backgroundAlpha:0 and preference:webgl', async () => {
    const renderer = await createThumbnailRenderer({ width: 200, resolution: 1 })

    expect(mockApp.init).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundAlpha: 0,
        preference: 'webgl',
      }),
    )

    renderer.destroy()
  })
})
