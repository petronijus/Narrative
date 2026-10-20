/**
 * renderer/SceneGraph.test.ts
 *
 * Unit testy pro SceneGraph diff logiku — add/update/remove.
 *
 * Pixi.js je mockován — testy běží v Node/jsdom bez GPU.
 * Testujeme ID-based diff logiku, ne Pixi rendering.
 *
 * vi.mock je hoistován na vrchol souboru — mock třídy musí být definovány
 * uvnitř factory callback nebo přes vi.hoisted() aby byly dostupné při hoistingu.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pixiMock } from '../test/pixiMock'

vi.mock('pixi.js', () => pixiMock())

import { SceneGraph } from './SceneGraph'
import type { SlideObjectData } from './types'
import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'

function makeApp() {
  const stage = new Container()
  return { stage } as unknown as Application
}

const rect1: SlideObjectData = {
  id: 'r1',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
}

const rect2: SlideObjectData = {
  id: 'r2',
  type: 'rectangle',
  x: 200,
  y: 200,
  width: 50,
  height: 50,
  fill: 0x00ff00,
  rotation: 0,
  opacity: 1,
}

describe('SceneGraph', () => {
  let sg: SceneGraph

  beforeEach(() => {
    sg = new SceneGraph(makeApp())
    vi.clearAllMocks()
  })

  it('render() přidá nové objekty', () => {
    sg.render([rect1, rect2])
    expect(sg.objectCount).toBe(2)
  })

  it('render() znovu s prázdným polem odstraní všechny objekty', () => {
    sg.render([rect1, rect2])
    sg.render([])
    expect(sg.objectCount).toBe(0)
  })

  it('render() odstraní objekt který chybí v nové sadě', () => {
    sg.render([rect1, rect2])
    sg.render([rect1])
    expect(sg.objectCount).toBe(1)
  })

  it('render() přidá nový objekt k existujícím', () => {
    sg.render([rect1])
    sg.render([rect1, rect2])
    expect(sg.objectCount).toBe(2)
  })

  it('render() aktualizuje existující objekt (stejné ID, změněná data)', () => {
    sg.render([rect1])

    const updated: SlideObjectData = { ...rect1, x: 999, fill: 0x0000ff }
    sg.render([updated])

    expect(sg.objectCount).toBe(1)
  })

  it('addObject ignoruje duplicitní ID (update místo crash)', () => {
    sg.addObject(rect1)
    expect(() => sg.addObject(rect1)).not.toThrow()
    expect(sg.objectCount).toBe(1)
  })

  it('removeObject na neexistující ID je no-op', () => {
    expect(() => sg.removeObject('nonexistent')).not.toThrow()
  })

  it('updateObject na neexistující ID je no-op (warning)', () => {
    expect(() => sg.updateObject('nonexistent', rect1)).not.toThrow()
  })

  it('destroy() vyprázdní všechny objekty', () => {
    sg.render([rect1, rect2])
    sg.destroy()
    expect(sg.objectCount).toBe(0)
  })
})

describe('SceneGraph — whole slide scenes (present mode)', () => {
  const objectsA = [rect1] as unknown as Parameters<SceneGraph['holdSlide']>[1] & object
  const objectsB = [rect2] as unknown as Parameters<SceneGraph['holdSlide']>[1] & object

  function sceneOf(slideId: string, objects: readonly SlideObjectData[]) {
    const root = new Container()
    const nodes = objects.map((data) => {
      const container = new Container()
      root.addChild(container)
      return { id: data.id, container, data }
    })
    return {
      slideId,
      root,
      background: null,
      nodes,
      paintedWith: null,
      objects,
    } as unknown as Parameters<SceneGraph['swapSlideScene']>[0]
  }

  it('holds a slide at a version until a change set is applied to it', () => {
    const sg = new SceneGraph(makeApp())
    sg.render([rect1])
    sg.holdSlide('A', objectsA)
    expect(sg.heldSlideId).toBe('A')
    expect(sg.holdsSlideAt('A', objectsA)).toBe(true)
    // Another version of the same slide (the deck store rebuilt its objects).
    expect(sg.holdsSlideAt('A', [...objectsA])).toBe(false)
    expect(sg.holdsSlideAt('B', objectsA)).toBe(false)
    sg.markHeldEdited()
    expect(sg.holdsSlideAt('A', objectsA)).toBe(false)
    sg.holdSlide(null)
    expect(sg.heldSlideId).toBeNull()
  })

  it('swaps a prepared scene in and hands the outgoing one back intact', () => {
    const app = makeApp()
    const sg = new SceneGraph(app)
    sg.render([rect1])
    sg.holdSlide('A', objectsA)
    const outgoingRoot = sg.getRoot()
    const outgoingNode = sg.getContainer('r1')!
    const incoming = sceneOf('B', [rect2])

    const outgoing = sg.swapSlideScene(incoming)

    // The scene graph is slide B now, at the version the scene was built from.
    expect(sg.getRoot()).toBe(incoming.root)
    expect(sg.getMountedIds()).toEqual(['r2'])
    expect(sg.getContainer('r2')).toBe(incoming.nodes[0]!.container)
    expect(sg.holdsSlideAt('B', objectsB as never)).toBe(false)
    expect(sg.holdsSlideAt('B', incoming.objects as never)).toBe(true)
    expect(app.stage.children).toContain(incoming.root)
    expect(app.stage.children).not.toContain(outgoingRoot)
    // Slide A comes back whole: its root off the stage, its node not destroyed.
    expect(outgoing.slideId).toBe('A')
    expect(outgoing.root).toBe(outgoingRoot)
    expect(outgoing.objects).toBe(objectsA)
    expect(outgoing.nodes.map((n) => n.id)).toEqual(['r1'])
    expect(outgoing.nodes[0]!.container).toBe(outgoingNode)
    expect(outgoingNode.destroyed).toBe(false)
  })

  it('hands back an edited slide without a version (it is rebuilt, not kept)', () => {
    const sg = new SceneGraph(makeApp())
    sg.swapSlideScene(sceneOf('A', [rect1]))
    sg.markHeldEdited()
    const outgoing = sg.swapSlideScene(sceneOf('B', [rect2]))
    expect(outgoing.slideId).toBe('A')
    expect(outgoing.objects).toBeNull()
  })

  it('puts a scene already on the stage (a transition drew it) in place without adding it twice', () => {
    const app = makeApp()
    const sg = new SceneGraph(app)
    const incoming = sceneOf('B', [rect2])
    app.stage.addChild(incoming.root)
    sg.swapSlideScene(incoming)
    expect(app.stage.children.filter((c) => c === incoming.root)).toHaveLength(1)
  })
})
