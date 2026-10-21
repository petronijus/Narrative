/**
 * renderer/presentSlides.test.ts — the present-mode slide cache's decisions
 * (ADR 0016): which slides it builds, when a scene that comes back from the
 * stage is kept and when it is dropped and rebuilt, what leaves with the
 * plan. Pixi is mocked; what a prepared scene draws is the e2e spec's
 * (e2e/present-smooth.spec.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pixiMock } from '../test/pixiMock'

vi.mock('pixi.js', () => ({
  ...pixiMock(),
  RenderTexture: { create: () => ({ destroy: vi.fn() }) },
}))

import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'
import type { Slide, SlideObject } from '@narrative/shared'
import { SceneGraph } from './SceneGraph'
import { ResourceManager, setDefaultResourceManager } from './ResourceManager'
import { PresentSlideCache, type PresentSlideSpec } from './presentSlides'
import { imageRenderer } from './objectRenderers/imageRenderer'
import { mountingPixelDensity, mountingVariantFloor } from './pixelDensityContext'

// Prepared roots are render groups of their own.
;(Container.prototype as unknown as { enableRenderGroup(): void }).enableRenderGroup = () => {}

function rect(id: string): SlideObject {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    fill: 0x336699,
  } as SlideObject
}

function spec(id: string, objects: SlideObject[] = [rect(`${id}-r`)]): PresentSlideSpec {
  const slide: Slide = { id, objects, animations: [], transition: { kind: 'none', durationMs: 0 } }
  return { slide, slideNumber: undefined, surface: undefined }
}

let render: ReturnType<typeof vi.fn>
let cache: PresentSlideCache
let sceneGraph: SceneGraph

beforeEach(() => {
  render = vi.fn()
  const app = { stage: new Container(), renderer: { uid: 1, render } } as unknown as Application
  sceneGraph = new SceneGraph(app)
  const rm = new ResourceManager()
  setDefaultResourceManager(rm)
  cache = new PresentSlideCache({ sceneGraph, resourceManager: rm, settleTimeoutMs: 1000 })
})

afterEach(() => {
  cache.destroy()
  sceneGraph.destroy()
})

describe('PresentSlideCache', () => {
  it("mounts pictures for the canvas's density at the deck's variants, display for a scaled-up build", async () => {
    const seen: Array<{ id: string; density: number | null; floor: string | undefined }> = []
    const mount = vi.spyOn(imageRenderer, 'mount').mockImplementation((data) => {
      seen.push({
        id: data.id,
        density: mountingPixelDensity(),
        floor: mountingVariantFloor()?.(data),
      })
      return new Container()
    })
    try {
      const picture = (id: string, assetId: string) =>
        ({ ...rect(id), type: 'image', assetId }) as unknown as SlideObject
      sceneGraph.setPixelDensity(2)
      cache.setVariantFloor(
        new Map([
          ['big', 'display'],
          ['small', 'medium'],
        ]),
      )
      const s1 = spec('s1', [picture('p1', 'big'), picture('p2', 'small'), picture('p3', 'small')])
      s1.slide.animations = [
        {
          id: 'a',
          objectId: 'p3',
          preset: 'zoomIn',
          trigger: 'onClick',
          duration: 0.5,
          delay: 0,
          easing: '',
        },
      ] as Slide['animations']
      cache.setPlan([s1], ['s1'])
      await cache.whenReady(['s1'])
      expect(seen).toEqual([
        { id: 'p1', density: 2, floor: 'display' },
        { id: 'p2', density: 2, floor: 'medium' },
        // zoomIn starts at 2×: display, whatever the deck's variant.
        { id: 'p3', density: 2, floor: 'display' },
      ])
    } finally {
      mount.mockRestore()
    }
  })

  it('builds every planned slide off stage and draws each into its warm-up target', async () => {
    const plan = [spec('s1'), spec('s2'), spec('s3')]
    cache.setPlan(plan, ['s1', 's2'])
    await cache.whenReady(['s1', 's2', 's3'])
    expect(cache.settledPlan()).toBe(true)
    expect(cache.progress()).toEqual({ prepared: 3, planned: 3, done: true })
    // Drawn into a texture of its own, never to the screen.
    expect(render).toHaveBeenCalled()
    for (const [opts] of render.mock.calls)
      expect((opts as { target?: unknown }).target).toBeDefined()
  })

  it('hands a scene out, does not build it again while it is on stage, and keeps it when it comes back', async () => {
    const plan = [spec('s1'), spec('s2')]
    cache.setPlan(plan, ['s1', 's2'])
    await cache.whenReady(['s1', 's2'])
    const builds = render.mock.calls.length
    const scene = cache.take('s1')!
    expect(scene.slideId).toBe('s1')
    expect(cache.isReady('s1')).toBe(false)
    expect(cache.settledPlan()).toBe(true)

    cache.give(scene)
    expect(cache.isReady('s1')).toBe(true)
    expect(scene.root.destroyed).toBe(false)
    await Promise.resolve()
    expect(render.mock.calls.length).toBe(builds)
  })

  it('drops a scene edited on stage and builds the slide again', async () => {
    cache.setPlan([spec('s1')], ['s1'])
    await cache.whenReady(['s1'])
    const scene = cache.take('s1')!
    cache.give({ ...scene, objects: null })
    expect(scene.root.destroyed).toBe(true)
    expect(cache.isReady('s1')).toBe(false)
    await cache.whenReady(['s1'])
    expect(cache.take('s1')!.root).not.toBe(scene.root)
  })

  it('rebuilds a slide whose objects changed, and destroys what leaves the plan', async () => {
    const s1 = spec('s1')
    const s2 = spec('s2')
    cache.setPlan([s1, s2], ['s1'])
    await cache.whenReady(['s1', 's2'])
    const old = cache.take('s2')!
    cache.give(old)

    // A live edit: the deck store hands a new objects array for s2.
    cache.setPlan([s1, spec('s2', [rect('s2-r'), rect('s2-new')])], ['s1'])
    expect(cache.isReady('s2')).toBe(false)
    await cache.whenReady(['s2'])
    expect(old.root.destroyed).toBe(true)

    cache.setPlan([s1], ['s1'])
    expect(cache.isReady('s2')).toBe(false)
  })

  it('does not keep a scene it did not build (the slide the canvas mounted itself)', () => {
    const root = new Container()
    cache.setPlan([spec('s1')], ['s1'])
    cache.give({ slideId: 's1', root, background: null, nodes: [], paintedWith: null, objects: [] })
    expect(root.destroyed).toBe(true)
  })
})
