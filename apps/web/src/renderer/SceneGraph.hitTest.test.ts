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
  /**
   * MockContainer implementuje toLocal() — klíčové pro rotovaný hit test (M7).
   *
   * toLocal(worldPoint, fromContainer?, outPoint?) transformuje world coords
   * do local object space, respektující pivot + rotaci.
   *
   * Matematika:
   *   1. Posun world pointu o střed objektu (container.x/y je střed díky pivot offsetu)
   *   2. Rotace o -θ (inverzní rotace)
   *   3. Výsledek je v local space (0,0) → (width, height)
   *
   * Implementujeme přímo (nepoužíváme Pixi interní getLocalTransform()),
   * protože mock nemusí znát celou Pixi transform chain.
   * Container.x/y odpovídá středu → toLocal vrátí coords relativně k TL rohu (0,0).
   */
  class MockContainer {
    children: MockContainer[] = []
    destroyed = false
    x = 0
    y = 0
    rotation = 0
    alpha = 1
    pivot = {
      x: 0,
      y: 0,
      set: vi.fn().mockImplementation(function (
        this: { x: number; y: number },
        px: number,
        py: number,
      ) {
        this.x = px
        this.y = py
      }),
    }

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

    /**
     * Transformuje worldPoint do local object space.
     * container.x/y = střed (pivot = width/2, height/2 nastavuje renderer).
     * Výstup: souřadnice v local space kde (0,0) = TL roh objektu.
     */
    toLocal(
      worldPoint: { x: number; y: number },
      _fromContainer?: unknown,
      outPoint?: { x: number; y: number },
    ): { x: number; y: number } {
      const dx = worldPoint.x - this.x
      const dy = worldPoint.y - this.y
      const θ = this.rotation
      const cosθ = Math.cos(-θ)
      const sinθ = Math.sin(-θ)
      // Rotace bodu zpět (inverzní rotace) a shift o pivot (střed → TL roh)
      const localX = dx * cosθ - dy * sinθ + this.pivot.x
      const localY = dx * sinθ + dy * cosθ + this.pivot.y
      const result = outPoint ?? { x: 0, y: 0 }
      result.x = localX
      result.y = localY
      return result
    }
  }

  class MockGraphics extends MockContainer {
    clear = vi.fn().mockReturnThis()
    rect = vi.fn().mockReturnThis()
    ellipse = vi.fn().mockReturnThis()
    fill = vi.fn().mockReturnThis()
  }

  class MockPoint {
    x = 0
    y = 0
    constructor(x = 0, y = 0) {
      this.x = x
      this.y = y
    }
    set(x: number, y: number): void {
      this.x = x
      this.y = y
    }
  }

  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    Text: vi.fn().mockImplementation(() => new MockContainer()),
    TextStyle: vi.fn(),
    Application: vi.fn(),
    Point: MockPoint,
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

/**
 * M7: Rotovaný hit test
 *
 * Objekt: rectangle 100×100, střed na (200, 150), rotation 45°.
 * Renderer nastaví container.x = data.x + w/2 = 200, container.y = data.y + h/2 = 150
 * a pivot = (50, 50).
 *
 * AABB (před rotací): data.x=150, data.y=100, w=100, h=100
 * AABB (po rotaci 45°, čtverec 100×100): bounding box = ≈ (129, 79) size ≈ 141×141
 *
 * Klíčové testovací body (pro 45° rotaci čtverce 100×100 se středem v (200,150)):
 *
 * Hit uvnitř rotovaného tvaru ale mimo původní AABB:
 *   - Roh rotovaného čtverce (45°) leží ve vzdálenosti 50√2 ≈ 70.7 od středu
 *   - Bod (200, 80) je 70 px nad středem → blízko horního rohu rotovaného čtverce
 *   - Bod (200, 220) je 70 px pod středem → blízko dolního rohu rotovaného čtverce
 *   Tyto body jsou MIMO původní AABB (100..200 y-osa), ale UVNITŘ rotovaného tvaru.
 *
 * Miss: bod mimo rotovaný tvar ale uvnitř původní AABB (neexistuje přesný případ
 *   pro čtverec s 45° rotací, protože AABB se zvětší → použijeme jiný angle).
 *   Pro dokázání miss: bod daleko od středu v rohu AABB rotovaného tvaru.
 *
 * Poznámka: rectangleRenderer nastaví container.x = data.x + width/2, container.y = data.y + height/2
 * a pivot.set(width/2, height/2). MockContainer.toLocal() to respektuje.
 */
describe('SceneGraph.hitTest() — M7 rotated hit test', () => {
  let sg: SceneGraph

  beforeEach(() => {
    sg = new SceneGraph(makeApp())
    vi.clearAllMocks()
  })

  /**
   * Čtverec 100×100, data.x=150, data.y=100, střed=(200,150), rotation=45°.
   * Po addObject(): container.x=200, container.y=150, pivot=(50,50), rotation=PI/4.
   */
  const rotated45: RectangleObject = {
    id: 'rot45',
    type: 'rectangle',
    x: 150,
    y: 100,
    width: 100,
    height: 100,
    fill: 0xff0000,
    rotation: Math.PI / 4, // 45°
    opacity: 1,
  }

  it('rotation=0: backward compat — chování identické s AABB', () => {
    const noRot: RectangleObject = { ...rect1, id: 'norot' }
    sg.addObject(noRot)
    // Bod uvnitř AABB → hit
    expect(sg.hitTest(150, 150)).toBe('norot')
    // Bod mimo AABB → miss
    expect(sg.hitTest(50, 50)).toBeNull()
  })

  it('rotovaný 45°: hit uvnitř rotovaného tvaru (blízko horního rohu čtverce)', () => {
    sg.addObject(rotated45)
    // Střed = (200, 150). Horní roh čtverce 45° je na (200, 150 - 50√2) ≈ (200, 79.3)
    // Bod (200, 85) leží blízko horního rohu → uvnitř rotovaného čtverce
    // Původní AABB (rotation=0): y=100..200 → (200,85) by byl MIMO
    expect(sg.hitTest(200, 85)).toBe('rot45')
  })

  it('rotovaný 45°: hit uvnitř rotovaného tvaru (blízko dolního rohu)', () => {
    sg.addObject(rotated45)
    // Dolní roh čtverce 45° je na (200, 150 + 50√2) ≈ (200, 220.7)
    // Bod (200, 215) → uvnitř rotovaného čtverce, mimo původní AABB (y=100..200)
    expect(sg.hitTest(200, 215)).toBe('rot45')
  })

  it('rotovaný 45°: hit uvnitř rotovaného tvaru (pravý roh)', () => {
    sg.addObject(rotated45)
    // Pravý roh 45°: (200 + 50√2, 150) ≈ (270.7, 150)
    // Bod (265, 150) → uvnitř, mimo původní AABB (x=150..250)
    expect(sg.hitTest(265, 150)).toBe('rot45')
  })

  it('rotovaný 45°: miss mimo rotovaný tvar (roh AABB rotovaného tvaru)', () => {
    sg.addObject(rotated45)
    // World AABB po rotaci 45°: minX≈129, minY≈79, size≈141×141 → maxX≈271, maxY≈221
    // Bod (135, 85) je uvnitř world AABB ale mimo samotný rotovaný čtverec
    // (je v rohu AABB, ale mimo rotovaný tvar)
    expect(sg.hitTest(135, 85)).toBeNull()
  })

  it('rotovaný 45°: miss daleko od objektu', () => {
    sg.addObject(rotated45)
    expect(sg.hitTest(0, 0)).toBeNull()
    expect(sg.hitTest(500, 500)).toBeNull()
  })

  it('z-order zachován pro rotované objekty — topmost vyhrává', () => {
    const bottom: RectangleObject = {
      id: 'bottom',
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 200,
      height: 200,
      fill: 0x0000ff,
      rotation: 0,
      opacity: 1,
    }
    sg.addObject(bottom) // přidán jako první → nižší z-order
    sg.addObject(rotated45) // přidán jako druhý → vyšší z-order

    // Střed rotated45 = (200, 150) → uvnitř obou objektů
    // rotated45 byl přidán jako druhý → má vyšší z-order → vyhrává
    expect(sg.hitTest(200, 150)).toBe('rot45')
  })

  it('rotace 90°: hit v objektu otočeném o 90°', () => {
    // Obdélník 200×50, data.x=175, data.y=125, střed=(275,150), rotation=90°
    // Po rotaci 90°: efektivní šířka=50, výška=200 (prohodí se)
    const rot90: RectangleObject = {
      id: 'rot90',
      type: 'rectangle',
      x: 175,
      y: 125,
      width: 200,
      height: 50,
      fill: 0x00ff00,
      rotation: Math.PI / 2, // 90°
      opacity: 1,
    }
    sg.addObject(rot90)
    // Střed = (275, 150). Bod na (275, 200) je 50px pod středem
    // V local space po rotaci 90°: je to x=50 (v rozsahu 0..200), y=25 (v rozsahu 0..50) → hit
    expect(sg.hitTest(275, 200)).toBe('rot90')
    // Bod (320, 150) je 45px vpravo od středu — v local space je mimo (x>200 nebo y>50)
    // Pro 90° rotaci: dx=45, dy=0 → localX=0*45-(-1)*0=0+pivotX, localY=... → miss mimo
    expect(sg.hitTest(400, 150)).toBeNull()
  })
})
