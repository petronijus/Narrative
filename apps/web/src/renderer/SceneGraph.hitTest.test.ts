/**
 * renderer/SceneGraph.hitTest.test.ts
 *
 * Unit testy pro SceneGraph.hitTest() — AABB hit testing.
 *
 * Pixi.js je mockován — testy běží v Node/jsdom bez GPU.
 *
 * Testujeme:
 * - AABB hit — bod uvnitř objektu
 * - AABB miss — bod mimo objekt
 * - Z-order — poslední přidaný objekt vyhrává (highest z-order)
 * - Edge cases: hranice bounding boxu, prázdná scéna
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    ellipse = vi.fn().mockReturnThis()
    fill = vi.fn().mockReturnThis()
  }

  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    Text: vi.fn().mockImplementation(() => new MockContainer()),
    TextStyle: vi.fn(),
    Application: vi.fn(),
    Point: vi.fn(),
  }
})

import { SceneGraph } from './SceneGraph'
import type { RectangleObject, EllipseObject } from './types'
import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'

function makeApp() {
  const stage = new Container()
  return { stage } as unknown as Application
}

const rect1: RectangleObject = {
  id: 'r1',
  type: 'rectangle',
  x: 100,
  y: 100,
  width: 200,
  height: 150,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
}

const rect2: RectangleObject = {
  id: 'r2',
  type: 'rectangle',
  x: 150,
  y: 150,
  width: 100,
  height: 80,
  fill: 0x00ff00,
  rotation: 0,
  opacity: 1,
}

const ellipse1: EllipseObject = {
  id: 'e1',
  type: 'ellipse',
  x: 400,
  y: 300,
  width: 120,
  height: 80,
  fill: 0x0000ff,
  rotation: 0,
  opacity: 1,
}

describe('SceneGraph.hitTest()', () => {
  let sg: SceneGraph

  beforeEach(() => {
    sg = new SceneGraph(makeApp())
    vi.clearAllMocks()
  })

  it('vrátí null pro prázdnou scénu', () => {
    expect(sg.hitTest(100, 100)).toBeNull()
  })

  it('hit — bod uvnitř objektu', () => {
    sg.addObject(rect1)
    // rect1: x=100, y=100, w=200, h=150 → interior: (150, 150)
    expect(sg.hitTest(150, 150)).toBe('r1')
  })

  it('miss — bod mimo objekt', () => {
    sg.addObject(rect1)
    // Mimo rect1 vlevo
    expect(sg.hitTest(50, 150)).toBeNull()
  })

  it('miss — bod nad objektem (y < obj.y)', () => {
    sg.addObject(rect1)
    expect(sg.hitTest(150, 50)).toBeNull()
  })

  it('miss — bod pod objektem (y > obj.y + height)', () => {
    sg.addObject(rect1)
    // rect1 sahá do y = 100 + 150 = 250
    expect(sg.hitTest(150, 300)).toBeNull()
  })

  it('miss — bod napravo (x > obj.x + width)', () => {
    sg.addObject(rect1)
    // rect1 sahá do x = 100 + 200 = 300
    expect(sg.hitTest(350, 150)).toBeNull()
  })

  it('hit na hranici objektu (levý horní roh)', () => {
    sg.addObject(rect1)
    expect(sg.hitTest(100, 100)).toBe('r1')
  })

  it('hit na hranici objektu (pravý dolní roh)', () => {
    sg.addObject(rect1)
    // x = 100+200 = 300, y = 100+150 = 250
    expect(sg.hitTest(300, 250)).toBe('r1')
  })

  it('z-order: poslední přidaný objekt vyhrává při překryvu', () => {
    // rect2 překrývá rect1 (je uvnitř rect1 bounds)
    sg.addObject(rect1)
    sg.addObject(rect2)

    // Bod uvnitř obou: rect2 byl přidán jako druhý → vyšší z-order → vyhrává
    const hit = sg.hitTest(180, 180)
    expect(hit).toBe('r2')
  })

  it('z-order: pokud je první objekt nahoře (render order), stále vyhrává poslední', () => {
    sg.addObject(rect1)
    sg.addObject(rect2)

    // Bod uvnitř rect1 ale vně rect2
    // rect1: x=100-300, y=100-250; rect2: x=150-250, y=150-230
    // Bod (110, 110) je v rect1 ale ne v rect2
    const hit = sg.hitTest(110, 110)
    expect(hit).toBe('r1')
  })

  it('funguje pro EllipseObject (AABB, ne skutečná elipsa)', () => {
    sg.addObject(ellipse1)
    // ellipse1: x=400, y=300, w=120, h=80 → AABB interior: (450, 330)
    expect(sg.hitTest(450, 330)).toBe('e1')
  })

  it('vrátí null pokud scéna má objekty ale bod je mimo všechny', () => {
    sg.addObject(rect1)
    sg.addObject(rect2)
    // Daleko mimo oba objekty
    expect(sg.hitTest(0, 0)).toBeNull()
  })

  it('po removeObject hit test nenajde smazaný objekt', () => {
    sg.addObject(rect1)
    expect(sg.hitTest(150, 150)).toBe('r1')

    sg.removeObject('r1')
    expect(sg.hitTest(150, 150)).toBeNull()
  })

  it('po render() s novými objekty hit test reflektuje nový stav', () => {
    sg.render([rect1])
    expect(sg.hitTest(150, 150)).toBe('r1')

    sg.render([rect2])
    // rect1 smazán, rect2 přidán
    expect(sg.hitTest(150, 150)).toBe('r2')
    // Bod mimo rect2 ale v rect1 → miss
    expect(sg.hitTest(110, 110)).toBeNull()
  })
})
