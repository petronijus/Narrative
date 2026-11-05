/**
 * renderer/canvasRegionController.test.ts — who decides the canvas's pixel
 * ratio, and present mode's density switch through the region (ADR 0020 →
 * Present mode).
 *
 * The editor's canvas follows the window's devicePixelRatio; present mode's
 * is switched by its owner (present/densityHandover.ts) in the task a set
 * prepared for the new ratio takes over: laid out through the region (the
 * backing store the viewport's at the new ratio, the region that store
 * covers at the new resolution), the texts on stage pinned to their rasters
 * before the renderer's resolution changes, nothing restaged. Until then a
 * window resize lays the canvas out for the ratio it draws at.
 *
 * jsdom: the window is 1024 × 768 and nothing scrolls, so the viewport is the
 * window; the Pixi application is a double that sizes its canvas the way
 * Pixi's `renderer.resize(w, h, resolution)` with autoDensity does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Application } from 'pixi.js'
import type { SceneGraph } from './SceneGraph'
import { CanvasRegionController } from './canvasRegionController'
import { backingFor } from './canvasRegion'
import { drawnRegionOf, gridPhaseOf, pageGridFor } from './runText/placement'

const VIEWPORT = { width: 1024, height: 768 }

interface FakeApp {
  app: Application
  canvas: HTMLCanvasElement
  renderer: { resolution: number; canvas: HTMLCanvasElement }
  /** Every call into the doubles, in order. */
  calls: string[]
}

function makeApp(calls: string[], resolution = 1): FakeApp {
  const canvas = document.createElement('canvas')
  const renderer = {
    resolution,
    canvas,
    screen: { width: 1, height: 1 },
    resize(width: number, height: number, res: number): void {
      calls.push(`resize ${width}×${height} @${res}`)
      this.resolution = res
      this.screen = { width, height }
      const w = Math.round(width * res)
      const h = Math.round(height * res)
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
    },
  }
  const app = { canvas, renderer, stage: {} } as unknown as Application
  return { app, canvas, renderer, calls }
}

/**
 * A scene graph that records what the controller asks of it: the slide's
 * origin and pinning the texts. Anything else — a restage above all — throws.
 */
function makeSceneGraph(calls: string[]): SceneGraph {
  const known: Record<string, (...a: unknown[]) => void> = {
    setSlideOrigin: () => undefined,
    pinTextResolution: () => calls.push('pin'),
  }
  return new Proxy(
    {},
    {
      get: (_t, name: string) => {
        const fn = known[name]
        if (fn === undefined) throw new Error(`unexpected SceneGraph.${name}`)
        return fn
      },
    },
  ) as SceneGraph
}

function setWindowRatio(ratio: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true })
}

describe('CanvasRegionController — the pixel ratio and present mode’s switch', () => {
  let container: HTMLElement

  beforeEach(() => {
    setWindowRatio(1)
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    setWindowRatio(1)
  })

  function make(mode: 'window' | 'owned'): {
    region: CanvasRegionController
    fake: FakeApp
  } {
    const calls: string[] = []
    const fake = makeApp(calls)
    const region = new CanvasRegionController(
      fake.app,
      makeSceneGraph(calls),
      container,
      null,
      () => 0,
      mode,
    )
    region.layout(1)
    return { region, fake }
  }

  it('the editor’s canvas lays out for the window’s ratio, and cannot be switched', () => {
    const { region, fake } = make('window')
    expect(fake.canvas.width).toBe(backingFor(VIEWPORT, 1).width)
    setWindowRatio(2)
    expect(region.pixelRatio).toBe(2)
    region.layout(2)
    expect([fake.canvas.width, fake.canvas.height]).toEqual([
      backingFor(VIEWPORT, 2).width,
      backingFor(VIEWPORT, 2).height,
    ])
    expect(() => region.switchPixelRatio(1, 1)).toThrow(/follows the window/)
  })

  it('an owned ratio stays until its owner switches it: a resize lays out for the drawn ratio', () => {
    const { region, fake } = make('owned')
    const before = { reallocations: region.reallocations, width: fake.canvas.width }
    // The window moved to a 2× screen; nothing is prepared for 2 yet.
    setWindowRatio(2)
    expect(region.pixelRatio).toBe(1)
    expect(region.layout()).toBe(false)
    expect(region.reallocations).toBe(before.reallocations)
    expect(fake.canvas.width).toBe(before.width)
    expect(fake.renderer.resolution).toBe(1)
  })

  it('switches through the region: the store at the new ratio, the region it covers, pinned first', () => {
    const { region, fake } = make('owned')
    const reallocations = region.reallocations
    fake.calls.length = 0
    setWindowRatio(2)

    expect(region.switchPixelRatio(2, 2)).toBe(true)

    const backing = backingFor(VIEWPORT, 2)
    expect(region.pixelRatio).toBe(2)
    expect(fake.renderer.resolution).toBe(2)
    expect([fake.canvas.width, fake.canvas.height]).toEqual([backing.width, backing.height])
    expect(region.reallocations).toBe(reallocations + 1)
    // The texts on stage keep their rasters: pinned before the resolution
    // changed under them, and nothing restaged (the double throws on it).
    expect(fake.calls[0]).toBe('pin')
    expect(fake.calls.slice(1)).toEqual([`resize ${backing.width / 2}×${backing.height / 2} @2`])
    // The region is what the store covers at the resolution, around the view.
    const state = region.debugState()
    expect(state.backing).toEqual(backing)
    expect(state.region.width).toBeCloseTo(backing.width / 2, 9)
    expect(state.region.height).toBeCloseTo(backing.height / 2, 9)
    expect(drawnRegionOf(fake.renderer)).toEqual(state.region)
    // The canvas element covers that region on the page, at the store's size on the device.
    expect(fake.canvas.style.width).toBe(`${Math.ceil(backing.width / 2)}px`)
    expect(fake.canvas.style.height).toBe(`${Math.ceil(backing.height / 2)}px`)
  })

  it('a switch to the ratio it has reallocates nothing', () => {
    const { region, fake } = make('owned')
    const reallocations = region.reallocations
    expect(region.switchPixelRatio(1, 1)).toBe(false)
    expect(region.reallocations).toBe(reallocations)
    expect(fake.renderer.resolution).toBe(1)
  })

  it('after a switch, a resize keeps the switched ratio', () => {
    const { region, fake } = make('owned')
    setWindowRatio(2)
    region.switchPixelRatio(2, 2)
    const width = fake.canvas.width
    // The window's ratio moves again (another screen); the owner has not switched.
    setWindowRatio(1)
    expect(region.layout()).toBe(false)
    expect(fake.canvas.width).toBe(width)
    expect(region.pixelRatio).toBe(2)
  })

  /** The world's origin at a fraction of a CSS px on the page (a centred slide). */
  function placeContainer(left: number, top: number): void {
    container.getBoundingClientRect = () => new DOMRect(left, top, 0, 0)
  }

  it('a page prepared for a ratio is the page the switch to it draws (the standby set’s grid)', () => {
    placeContainer(100.3, 50.7)
    const { region, fake } = make('owned')
    const atOne = { ...gridPhaseOf(fake.renderer) }
    setWindowRatio(2)
    let moved = 0
    region.prepareFor(2, 2, () => moved++)
    // Texts rasterised at 2 while the canvas draws at 1 are placed for the grid at 2.
    const prospective = structuredClone(pageGridFor(fake.renderer, 2))
    expect(prospective).not.toBeNull()
    expect(fake.renderer.resolution).toBe(1)
    // At 2 the grid lies elsewhere than at 1 (the origin at 200.6 device px, not 100.3).
    expect(prospective!.phase).not.toEqual(atOne)

    region.switchPixelRatio(2, 2)

    expect(pageGridFor(fake.renderer, 2)).toEqual(prospective)
    expect(moved).toBe(0)
  })

  it('a layout that moves the prospective grid tells its owner, once it is done', async () => {
    placeContainer(100.3, 50.7)
    const { region, fake } = make('owned')
    setWindowRatio(2)
    let moved = 0
    const release = region.prepareFor(2, 2, () => moved++)
    const before = structuredClone(pageGridFor(fake.renderer, 2))
    // A layout that leaves it where it was says nothing.
    region.layout()
    await Promise.resolve()
    expect(moved).toBe(0)
    // The slide moved by a fraction of a px (a resize centring it again).
    placeContainer(100.55, 50.7)
    region.layout()
    expect(moved).toBe(0) // after the layout, not inside it
    await Promise.resolve()
    expect(moved).toBe(1)
    const after = pageGridFor(fake.renderer, 2)
    expect(after?.phase).not.toEqual(before?.phase)
    // Released: no prospective page, nobody told.
    release()
    expect(pageGridFor(fake.renderer, 2)).toBeNull()
    placeContainer(100.8, 50.7)
    region.layout()
    await Promise.resolve()
    expect(moved).toBe(1)
  })

  it('an editor canvas (it follows the window) cannot prepare for a ratio', () => {
    const { region } = make('window')
    expect(() => region.prepareFor(2, 2, () => undefined)).toThrow(/follows the window/)
  })

  it('rejects a ratio that is not a positive number', () => {
    const { region } = make('owned')
    expect(() => region.switchPixelRatio(0, 1)).toThrow()
    expect(() => region.switchPixelRatio(Number.NaN, 1)).toThrow()
  })
})
