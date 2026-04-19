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

// Mock pixi.js — factory musí být self-contained (vi.mock je hoisted)
vi.mock('pixi.js', () => {
  class MockContainer {
    children: MockContainer[] = []
    destroyed = false
    x = 0
    y = 0
    rotation = 0
    alpha = 1
    pivot = { set: vi.fn() }

    addChild(child: MockContainer): MockContainer {
      this.children.push(child)
      return child
    }

    removeChild(child: MockContainer): MockContainer {
      this.children = this.children.filter((c) => c !== child)
      return child
    }

    destroy(): void {
      this.destroyed = true
    }
  }

  class MockGraphics extends MockContainer {
    clear = vi.fn().mockReturnThis()
    rect = vi.fn().mockReturnThis()
    fill = vi.fn().mockReturnThis()
  }

  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    Application: vi.fn(),
  }
})

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
