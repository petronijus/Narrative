/**
 * renderer/SceneGraph.bounds.test.ts
 *
 * Unit testy pro SceneGraph.getBounds() a SceneGraph.getMultiBounds() — M7.
 *
 * Testujeme:
 * - getBounds: správné world AABB pro rotation=0 (identity case)
 * - getBounds: správné corners a center pro rotovaný objekt
 * - getBounds: world AABB rozšíření pro 45° rotaci (AABB > object dims)
 * - getBounds: null pro neexistující ID
 * - getMultiBounds: union AABB ze 3 objektů
 * - getMultiBounds: ignoruje neexistující IDs, stále vrátí bounds platných objektů
 * - getMultiBounds: null pokud žádný ID neexistuje
 * - getMultiBounds: rotation je vždy 0
 * - getMultiBounds: center = střed merged AABB
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
import type { RectangleObject } from './types'
import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'

function makeApp(): Application {
  const stage = new Container()
  return { stage } as unknown as Application
}

/** Tolerance pro floating-point porovnání (1e-9). */
function approx(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) < tol
}

function expectApprox(received: number, expected: number, label = ''): void {
  if (!approx(received, expected)) {
    throw new Error(
      `${label}: expected ${expected}, got ${received} (diff=${Math.abs(received - expected)})`,
    )
  }
}

/**
 * Objekty:
 * - rectA: 200×100 na (50, 80), rotation=0
 * - rectB: 100×200 na (300, 50), rotation=0
 * - rectC: 100×100 na (150, 100), rotation=45° (Math.PI/4)
 *
 * Renderer nastavuje container.x = data.x + width/2, container.y = data.y + height/2.
 */
const rectA: RectangleObject = {
  id: 'a',
  type: 'rectangle',
  x: 50,
  y: 80,
  width: 200,
  height: 100,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
}

const rectB: RectangleObject = {
  id: 'b',
  type: 'rectangle',
  x: 300,
  y: 50,
  width: 100,
  height: 200,
  fill: 0x00ff00,
  rotation: 0,
  opacity: 1,
}

const rectC: RectangleObject = {
  id: 'c',
  type: 'rectangle',
  x: 150,
  y: 100,
  width: 100,
  height: 100,
  fill: 0x0000ff,
  rotation: Math.PI / 4, // 45°
  opacity: 1,
}

describe('SceneGraph.getBounds()', () => {
  let sg: SceneGraph

  beforeEach(() => {
    sg = new SceneGraph(makeApp())
    vi.clearAllMocks()
  })

  it('vrátí null pro neexistující ID', () => {
    expect(sg.getBounds('nonexistent')).toBeNull()
  })

  it('rotation=0: world bounds odpovídají data.x/y/width/height', () => {
    sg.addObject(rectA)
    const bounds = sg.getBounds('a')
    expect(bounds).not.toBeNull()

    // rectA: x=50, y=80, w=200, h=100 → world AABB = (50, 80, 200, 100)
    expectApprox(bounds!.world.x, 50, 'world.x')
    expectApprox(bounds!.world.y, 80, 'world.y')
    expectApprox(bounds!.world.width, 200, 'world.width')
    expectApprox(bounds!.world.height, 100, 'world.height')
  })

  it('rotation=0: center = střed objektu', () => {
    sg.addObject(rectA)
    const bounds = sg.getBounds('a')!
    // center = container.x/y = data.x + w/2, data.y + h/2
    expectApprox(bounds.center.x, 150, 'center.x') // 50 + 200/2
    expectApprox(bounds.center.y, 130, 'center.y') // 80 + 100/2
  })

  it('rotation=0: rotation field = 0', () => {
    sg.addObject(rectA)
    expect(sg.getBounds('a')!.rotation).toBe(0)
  })

  it('rotation=0: corners odpovídají 4 rohům objektu (TL, TR, BR, BL)', () => {
    sg.addObject(rectA)
    const bounds = sg.getBounds('a')!
    const [tl, tr, br, bl] = bounds.corners

    // TL = (50, 80), TR = (250, 80), BR = (250, 180), BL = (50, 180)
    expectApprox(tl!.x, 50, 'TL.x')
    expectApprox(tl!.y, 80, 'TL.y')
    expectApprox(tr!.x, 250, 'TR.x')
    expectApprox(tr!.y, 80, 'TR.y')
    expectApprox(br!.x, 250, 'BR.x')
    expectApprox(br!.y, 180, 'BR.y')
    expectApprox(bl!.x, 50, 'BL.x')
    expectApprox(bl!.y, 180, 'BL.y')
  })

  it('rotation=45°: world AABB je vetší než object dims', () => {
    sg.addObject(rectC)
    const bounds = sg.getBounds('c')!

    // rectC: 100×100 čtverec, střed=(200,150), rotation=45°
    // Rohy po rotaci 45°: vzdálenost od středu = 50√2 ≈ 70.71
    // World AABB: minX=200-70.71≈129.3, minY=150-70.71≈79.3, size≈141.4×141.4
    const halfDiag = (100 / 2) * Math.SQRT2 // 50√2

    expectApprox(bounds.world.x, 200 - halfDiag, 'world.x 45°')
    expectApprox(bounds.world.y, 150 - halfDiag, 'world.y 45°')
    expectApprox(bounds.world.width, halfDiag * 2, 'world.width 45°')
    expectApprox(bounds.world.height, halfDiag * 2, 'world.height 45°')
  })

  it('rotation=45°: center je střed objektu', () => {
    sg.addObject(rectC)
    const bounds = sg.getBounds('c')!
    // container.x = 150 + 50 = 200, container.y = 100 + 50 = 150
    expectApprox(bounds.center.x, 200, 'center.x 45°')
    expectApprox(bounds.center.y, 150, 'center.y 45°')
  })

  it('rotation=45°: rotation field = PI/4', () => {
    sg.addObject(rectC)
    expectApprox(sg.getBounds('c')!.rotation, Math.PI / 4, 'rotation field')
  })

  it('rotation=45°: corners jsou ve správných world pozicích', () => {
    sg.addObject(rectC)
    const bounds = sg.getBounds('c')!
    const [tl, tr, br, bl] = bounds.corners

    // Střed = (200, 150), halfW = halfH = 50, θ = 45°
    // cos(45°) = sin(45°) = 1/√2 ≈ 0.7071
    const cx = 200
    const cy = 150
    const h = 50
    const cos45 = Math.cos(Math.PI / 4)
    const sin45 = Math.sin(Math.PI / 4)

    // TL local: (-50, -50) → world: cx + (-50)*cos45 - (-50)*sin45, cy + (-50)*sin45 + (-50)*cos45
    const tlExpX = cx + -h * cos45 - -h * sin45
    const tlExpY = cy + -h * sin45 + -h * cos45
    expectApprox(tl!.x, tlExpX, 'TL.x 45°')
    expectApprox(tl!.y, tlExpY, 'TL.y 45°')

    // BR local: (50, 50) → symetrie k TL
    expectApprox(br!.x, cx + h * cos45 - h * sin45, 'BR.x 45°')
    expectApprox(br!.y, cy + h * sin45 + h * cos45, 'BR.y 45°')

    // TR local: (50, -50)
    expectApprox(tr!.x, cx + h * cos45 - -h * sin45, 'TR.x 45°')
    expectApprox(tr!.y, cy + h * sin45 + -h * cos45, 'TR.y 45°')

    // BL local: (-50, 50)
    expectApprox(bl!.x, cx + -h * cos45 - h * sin45, 'BL.x 45°')
    expectApprox(bl!.y, cy + -h * sin45 + h * cos45, 'BL.y 45°')
  })

  it('corners mají vždy 4 prvky', () => {
    sg.addObject(rectA)
    expect(sg.getBounds('a')!.corners).toHaveLength(4)
  })
})

describe('SceneGraph.getMultiBounds()', () => {
  let sg: SceneGraph

  beforeEach(() => {
    sg = new SceneGraph(makeApp())
    vi.clearAllMocks()
  })

  it('vrátí null pro prázdné pole IDs', () => {
    expect(sg.getMultiBounds([])).toBeNull()
  })

  it('vrátí null pokud žádné z IDs neexistuje', () => {
    expect(sg.getMultiBounds(['x', 'y', 'z'])).toBeNull()
  })

  it('ignoruje neexistující IDs a vrátí bounds platných objektů', () => {
    sg.addObject(rectA)
    const bounds = sg.getMultiBounds(['a', 'nonexistent'])
    expect(bounds).not.toBeNull()
    // Měl by vrátit bounds jen rectA
    expectApprox(bounds!.world.x, 50, 'world.x')
    expectApprox(bounds!.world.y, 80, 'world.y')
    expectApprox(bounds!.world.width, 200, 'world.width')
    expectApprox(bounds!.world.height, 100, 'world.height')
  })

  it('jeden objekt: getMultiBounds = getBounds', () => {
    sg.addObject(rectA)
    const multi = sg.getMultiBounds(['a'])
    const single = sg.getBounds('a')
    expect(multi).not.toBeNull()
    expectApprox(multi!.world.x, single!.world.x, 'world.x')
    expectApprox(multi!.world.y, single!.world.y, 'world.y')
    expectApprox(multi!.world.width, single!.world.width, 'world.width')
    expectApprox(multi!.world.height, single!.world.height, 'world.height')
  })

  it('dva objekty (rotation=0): union AABB pokrývá oba', () => {
    sg.addObject(rectA)
    sg.addObject(rectB)
    const bounds = sg.getMultiBounds(['a', 'b'])!

    // rectA: world (50, 80, 200, 100) → maxX=250, maxY=180
    // rectB: world (300, 50, 100, 200) → maxX=400, maxY=250
    // Union: minX=50, minY=50, maxX=400, maxY=250 → w=350, h=200
    expectApprox(bounds.world.x, 50, 'union.x')
    expectApprox(bounds.world.y, 50, 'union.y')
    expectApprox(bounds.world.width, 350, 'union.width')
    expectApprox(bounds.world.height, 200, 'union.height')
  })

  it('tři objekty: union AABB pokrývá všechny tři', () => {
    sg.addObject(rectA)
    sg.addObject(rectB)
    sg.addObject(rectC)
    const bounds = sg.getMultiBounds(['a', 'b', 'c'])!

    // rectA world: (50, 80) → (250, 180)
    // rectB world: (300, 50) → (400, 250)
    // rectC world (45°, střed 200,150, halfDiag≈70.71): (≈129.3, ≈79.3) → (≈270.7, ≈220.7)
    const halfDiag = (100 / 2) * Math.SQRT2
    const cMinX = 200 - halfDiag
    const cMinY = 150 - halfDiag

    const expectedMinX = Math.min(50, 300, cMinX)
    const expectedMinY = Math.min(80, 50, cMinY)
    const expectedMaxX = Math.max(250, 400, 200 + halfDiag)
    const expectedMaxY = Math.max(180, 250, 150 + halfDiag)

    expectApprox(bounds.world.x, expectedMinX, 'tri.x')
    expectApprox(bounds.world.y, expectedMinY, 'tri.y')
    expectApprox(bounds.world.width, expectedMaxX - expectedMinX, 'tri.width')
    expectApprox(bounds.world.height, expectedMaxY - expectedMinY, 'tri.height')
  })

  it('rotation je vždy 0 (multi-select nemá vlastní rotaci)', () => {
    sg.addObject(rectA)
    sg.addObject(rectC) // rotovaný objekt
    const bounds = sg.getMultiBounds(['a', 'c'])!
    expect(bounds.rotation).toBe(0)
  })

  it('center = střed merged AABB', () => {
    sg.addObject(rectA)
    sg.addObject(rectB)
    const bounds = sg.getMultiBounds(['a', 'b'])!
    // Union: x=50, y=50, w=350, h=200 → center=(225, 150)
    expectApprox(bounds.center.x, 225, 'center.x')
    expectApprox(bounds.center.y, 150, 'center.y')
  })

  it('corners odpovídají rohům merged AABB (TL, TR, BR, BL)', () => {
    sg.addObject(rectA)
    sg.addObject(rectB)
    const bounds = sg.getMultiBounds(['a', 'b'])!
    const [tl, tr, br, bl] = bounds.corners
    // Union: minX=50, minY=50, maxX=400, maxY=250
    expectApprox(tl!.x, 50, 'TL.x')
    expectApprox(tl!.y, 50, 'TL.y')
    expectApprox(tr!.x, 400, 'TR.x')
    expectApprox(tr!.y, 50, 'TR.y')
    expectApprox(br!.x, 400, 'BR.x')
    expectApprox(br!.y, 250, 'BR.y')
    expectApprox(bl!.x, 50, 'BL.x')
    expectApprox(bl!.y, 250, 'BL.y')
  })

  it('corners mají vždy 4 prvky', () => {
    sg.addObject(rectA)
    sg.addObject(rectB)
    expect(sg.getMultiBounds(['a', 'b'])!.corners).toHaveLength(4)
  })
})
