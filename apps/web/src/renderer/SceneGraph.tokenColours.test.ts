/**
 * renderer/SceneGraph.tokenColours.test.ts
 *
 * The colour resolver is an input of the scene diff (colourResolver.ts):
 * when it changes, SceneGraph repaints exactly the mounted objects whose
 * token colours resolve differently — through each renderer's
 * `repaintColours` — and leaves every other object alone. These tests pin
 * that decision (which renderer is asked to repaint which node), not what
 * the renderer then draws: the pixels are the e2e specs'
 * (share-link-folder-tokens, folder-tokens).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pixiMock } from '../test/pixiMock'

vi.mock('pixi.js', () => pixiMock())

import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'
import type { SlideObject } from '@narrative/shared'
import { SceneGraph } from './SceneGraph'
import {
  setColourResolver,
  getColourResolver,
  setRenderingSurface,
  type ColourResolverFn,
} from './colourResolver'
import { rectangleRenderer } from './objectRenderers/rectangleRenderer'
import { ellipseRenderer } from './objectRenderers/ellipseRenderer'
import { textRenderer } from './objectRenderers/textRenderer'

function makeApp() {
  return { stage: new Container() } as unknown as Application
}

function palette(colours: Record<string, string>): ColourResolverFn {
  return (value) => {
    if (typeof value === 'object' && value !== null && '$token' in value) {
      return colours[value.$token] ?? 'transparent'
    }
    return 'transparent'
  }
}

const PINK = { $token: 'colors.pink' }
const INK = { $token: 'colors.ink' }

const base = { x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1 }
const tokenFill = { ...base, id: 'token-fill', type: 'rectangle', fill: PINK } as SlideObject
const literal = { ...base, id: 'literal', type: 'rectangle', fill: 0xff0000 } as SlideObject
const inkStroke = {
  ...base,
  id: 'ink-stroke',
  type: 'ellipse',
  fill: 0xffffff,
  stroke: INK,
  strokeWidth: 2,
} as SlideObject
const shadowedText = {
  ...base,
  id: 'shadowed-text',
  type: 'text',
  text: 'hi',
  fontSize: 18,
  fontWeight: 'normal',
  color: 0x111111,
  align: 'left',
  shadow: { color: PINK, blur: 4, offsetX: 2, offsetY: 2, opacity: 0.5 },
} as SlideObject

const initial = palette({ 'colors.pink': '#ff2bd6', 'colors.ink': '#111111' })

/** The ids each renderer was asked to repaint, in call order. */
function repainted(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => (call[1] as SlideObject).id)
}

describe('SceneGraph — colour resolver changes', () => {
  let sg: SceneGraph
  let rect: ReturnType<typeof vi.spyOn>
  let ellipse: ReturnType<typeof vi.spyOn>
  let text: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    sg = new SceneGraph(makeApp())
    rect = vi.spyOn(rectangleRenderer, 'repaintColours')
    ellipse = vi.spyOn(ellipseRenderer, 'repaintColours')
    text = vi.spyOn(textRenderer, 'repaintColours')
  })

  afterEach(() => {
    sg.destroy()
    setColourResolver(null)
    vi.restoreAllMocks()
  })

  it('objects painted before the tokens arrived are repainted when they do', () => {
    sg.render([tokenFill, literal, inkStroke])

    setColourResolver(initial)

    expect(repainted(rect)).toEqual(['token-fill'])
    expect(repainted(ellipse)).toEqual(['ink-stroke'])
  })

  it('a live token edit repaints only the objects linked to that token', () => {
    setColourResolver(initial)
    sg.render([tokenFill, literal, inkStroke])

    setColourResolver(palette({ 'colors.pink': '#00ffff', 'colors.ink': '#111111' }))

    expect(repainted(rect)).toEqual(['token-fill'])
    expect(repainted(ellipse)).toEqual([])
  })

  it('a new snapshot that resolves every colour the same repaints nothing', () => {
    setColourResolver(initial)
    sg.render([tokenFill, literal, inkStroke])

    // A text-style or font edit: new snapshot, new resolver, same colours.
    setColourResolver(palette({ 'colors.pink': '#ff2bd6', 'colors.ink': '#111111' }))

    expect(rect).not.toHaveBeenCalled()
    expect(ellipse).not.toHaveBeenCalled()
  })

  it('a token shadow alone does not re-rasterise the text it is on', () => {
    sg.render([shadowedText])

    setColourResolver(initial)

    expect(text).not.toHaveBeenCalled()
  })

  it('repaints from the data the patches left, not the data it was mounted with', () => {
    sg.render([literal])
    sg.applyChanges({
      added: [],
      removed: [],
      updated: [{ id: 'literal', patch: { fill: PINK } }],
      snapshot: [],
    })

    setColourResolver(initial)

    expect(rect).toHaveBeenCalledTimes(1)
    expect((rect.mock.calls[0]![1] as { fill: unknown }).fill).toEqual(PINK)
  })

  it('a destroyed scene graph is no longer told', () => {
    sg.render([tokenFill])
    sg.destroy()

    setColourResolver(initial)

    expect(rect).not.toHaveBeenCalled()
    // afterEach destroys again: unsubscribing twice must be harmless.
  })

  it('nodes adopted after a transition are brought up to the current resolver', () => {
    // The incoming slide was mounted before the tokens arrived…
    const paintedWith = getColourResolver()
    const nextRoot = new Container()
    const container = rectangleRenderer.mount(tokenFill as never)
    nextRoot.addChild(container)
    // …and they arrived while it was animating in.
    setColourResolver(initial)
    expect(rect).not.toHaveBeenCalled()

    sg.adoptSlideRoot(
      nextRoot,
      [{ id: tokenFill.id, container, data: tokenFill }],
      undefined,
      paintedWith,
    )

    expect(repainted(rect)).toEqual(['token-fill'])
  })

  it('a scene swapped in on another surface is not repainted for the surface it leaves', () => {
    // Pink resolves per surface (A4.2d): the incoming slide is a dark one.
    const bySurface: ColourResolverFn = (value, ctx) =>
      typeof value === 'object' && value !== null && '$token' in value
        ? ctx?.surface === 'dark'
          ? '#550033'
          : '#ff2bd6'
        : 'transparent'
    setColourResolver(bySurface)
    sg.render([literal])
    // Built off stage for the dark surface (renderer/presentSlides.ts).
    setRenderingSurface('dark')
    const paintedWith = getColourResolver()
    setRenderingSurface(undefined)
    const root = new Container()
    const container = rectangleRenderer.mount(tokenFill as never)
    root.addChild(container)

    sg.swapSlideScene({
      slideId: 'dark-slide',
      root,
      background: null,
      nodes: [{ id: tokenFill.id, container, data: tokenFill }],
      paintedWith,
      objects: [tokenFill],
      surface: 'dark',
    })

    expect(rect).not.toHaveBeenCalled()
    // The canvas resolves on the incoming slide's surface from now on.
    expect(getColourResolver()?.(PINK)).toBe('#550033')
    setRenderingSurface(undefined)
  })
})
